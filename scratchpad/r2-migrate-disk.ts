import 'dotenv/config';
import path from 'path';

import prisma from '../src/infrastructure/database/prisma.client';
import { objectStorageService } from '../src/infrastructure/services/ObjectStorageService';
import {
    appointmentDocumentStorage,
    ospDatasheetStorage,
    taskDocumentStorage,
    staffDocumentStorage,
    DocumentStorage,
} from '../src/infrastructure/services/LocalFileStorage';
import { tenderDocumentStorageService } from '../src/infrastructure/services/TenderDocumentStorageService';

/**
 * DER UMZUG DER PLATTENDATEIEN NACH R2.
 *
 * Ohne `--apply` passiert nichts: das Skript liest, prueft und zaehlt, aber
 * schreibt weder nach Cloudflare noch in die Datenbank. So sieht man den
 * ganzen Umzug, bevor er stattfindet.
 *
 * Drei Eigenschaften, auf die es ankommt:
 *
 * 1. WIEDERHOLBAR. Liegt das Objekt schon in R2, wird es nicht neu
 *    hochgeladen. Ein abgebrochener Lauf wird einfach noch einmal gestartet.
 * 2. GEPRUEFT. Die Bytes werden nach dem Hochladen ZURUECKGELESEN und
 *    verglichen. Erst wenn sie stimmen, zeigt die Datenbankzeile nach R2.
 * 3. UMKEHRBAR. Die Datei auf der Platte bleibt liegen. Geht etwas schief,
 *    genuegt es, den Vorsatz der Zeile wieder auf "local:" zu drehen; die
 *    Bytes sind noch da. Erst wenn alles laeuft, wird aufgeraeumt.
 */

const APPLY = process.argv.includes('--apply');

/** Endung -> Dateiart. Der Schluessel traegt die Endung; sie ist die Wahrheit. */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    heic: 'image/heic',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    odt: 'application/vnd.oasis.opendocument.text',
    txt: 'text/plain',
};

/** Welche Spalte traegt welche Ablage? (Ermittelt mit r2-find-local-refs.ts.) */
const TARGETS: Array<{ table: string; column: string; storage: DocumentStorage }> = [
    { table: 'AppointmentDocument', column: 'fileRef', storage: appointmentDocumentStorage },
    { table: 'CrmTaskDocument', column: 'fileRef', storage: taskDocumentStorage },
    { table: 'Document', column: 'fileUrl', storage: tenderDocumentStorageService },
    { table: 'OspDocument', column: 'datasheetFile', storage: ospDatasheetStorage },
    // Noch leer, aber der Vollstaendigkeit halber — sobald eine Personalakte
    // hochgeladen wird, gehoert sie in denselben Umzug.
    { table: 'StaffDocument', column: 'fileRef', storage: staffDocumentStorage },
];

(async () => {
    if (!objectStorageService.isConfigured()) {
        console.error('R2 ist nicht eingerichtet — OFFITEC_S3_ENDPOINT und OFFITEC_S3_BUCKET fehlen.');
        process.exit(1);
    }

    console.log(APPLY
        ? 'ECHTLAUF: es wird nach R2 geschrieben und die Datenbank umgeschrieben.'
        : 'PROBELAUF: es wird nichts geschrieben. Mit --apply wird es ernst.');
    console.log('');

    let moved = 0;
    let already = 0;
    let missing = 0;
    let failed = 0;
    let bytesTotal = 0;

    for (const target of TARGETS) {
        let rows: any[];
        try {
            rows = await (prisma as any).$queryRawUnsafe(
                `SELECT id, \`${target.column}\` AS ref FROM \`${target.table}\` WHERE \`${target.column}\` LIKE 'local:%'`,
            );
        } catch (error: any) {
            console.log(`${target.table}.${target.column}: uebersprungen (${error.message.split('\n')[0]})`);
            continue;
        }
        if (rows.length === 0) {
            console.log(`${target.table}.${target.column}: nichts zu tun`);
            continue;
        }

        console.log(`${target.table}.${target.column}: ${rows.length} Verweise`);

        for (const row of rows) {
            const reference = String(row.ref);
            const id = String(row.id);

            if (!target.storage.isLocalReference(reference)) {
                console.log(`   ? ${id}: fremder Verweis, uebersprungen (${reference.slice(0, 40)})`);
                continue;
            }

            const remoteReference = target.storage.remoteReferenceFor(reference);
            const key = remoteReference.slice('r2:'.length);
            const extension = path.extname(key).slice(1).toLowerCase();
            const contentType = CONTENT_TYPE_BY_EXTENSION[extension] || 'application/octet-stream';

            // 1) Bytes von der Platte.
            let body: Buffer;
            try {
                body = await target.storage.read(reference);
            } catch (error: any) {
                console.log(`   ! ${id}: Datei fehlt auf der Platte — ${reference}`);
                missing += 1;
                continue;
            }

            // 2) Liegt sie schon drueben? Dann nicht noch einmal hochladen.
            const exists = await objectStorageService.objectExists(key);
            if (exists) already += 1;

            if (!APPLY) {
                console.log(`   . ${id}: ${(body.length / 1024).toFixed(0)} KB -> ${key}${exists ? ' (liegt schon dort)' : ''}`);
                bytesTotal += body.length;
                continue;
            }

            try {
                if (!exists) await objectStorageService.putObject(key, body, contentType);

                // 3) Zurueklesen und vergleichen — VOR dem Umschreiben der Zeile.
                const back = await objectStorageService.getObject(key);
                if (!back.equals(body)) {
                    console.log(`   ! ${id}: Bytes stimmen nach dem Hochladen NICHT — Zeile bleibt auf der Platte`);
                    failed += 1;
                    continue;
                }

                // 4) Erst jetzt zeigt die Zeile nach R2.
                await (prisma as any).$executeRawUnsafe(
                    `UPDATE \`${target.table}\` SET \`${target.column}\` = ? WHERE id = ?`,
                    remoteReference,
                    id,
                );

                moved += 1;
                bytesTotal += body.length;
                console.log(`   + ${id}: ${(body.length / 1024).toFixed(0)} KB -> ${key}`);
            } catch (error: any) {
                console.log(`   ! ${id}: ${error.message.split('\n')[0]}`);
                failed += 1;
            }
        }
    }

    console.log('');
    console.log(`umgezogen:      ${moved}`);
    console.log(`lag schon dort: ${already}`);
    console.log(`Datei fehlt:    ${missing}`);
    console.log(`fehlgeschlagen: ${failed}`);
    console.log(`Umfang:         ${(bytesTotal / 1024 / 1024).toFixed(2)} MB`);
    if (!APPLY) console.log('\n(Probelauf — mit --apply ausfuehren.)');

    process.exit(failed > 0 ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
