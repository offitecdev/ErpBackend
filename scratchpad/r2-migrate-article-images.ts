import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

import prisma from '../src/infrastructure/database/prisma.client';
import { objectStorageService } from '../src/infrastructure/services/ObjectStorageService';
import { articleImageStorage } from '../src/infrastructure/services/ImageStore';

/**
 * DIE PRODUKTBILDER ZIEHEN UM: Datenbank -> R2.
 *
 * Am 01.09.2026 standen 134 Produktbilder als Daten-URI in `Article.imageUrl`,
 * 8.4 MB LONGTEXT. Danach steht dort ein Verweis von etwa sechzig Zeichen und
 * der Browser holt die Bytes ueber die eigene Domain am Eimer
 * (`https://assets.demo.offitec.ch/article-image/...`) — genau wie die
 * Terminunterlagen im Kalender.
 *
 * Ohne `--apply` passiert nichts: das Skript liest, prueft und zaehlt.
 *
 * Vier Eigenschaften, auf die es ankommt — dieselben wie beim Umzug der
 * Plattendateien (r2-migrate-disk.ts):
 *
 * 1. WIEDERHOLBAR. Zeilen, die schon einen Verweis tragen, werden
 *    uebersprungen. Ein abgebrochener Lauf wird einfach neu gestartet.
 * 2. GEPRUEFT. Die Bytes werden nach dem Hochladen ZURUECKGELESEN und
 *    verglichen. Erst wenn sie stimmen, zeigt die Zeile nach R2.
 * 3. UMKEHRBAR OHNE SICHERUNG. Vor der ersten Zeile schreibt der Lauf ALLE
 *    Daten-URIs in eine Datei neben dem Skript. Waere R2 morgen weg, liesse
 *    sich die Spalte daraus Zeile fuer Zeile wiederherstellen — der Umzug
 *    haengt nicht daran, dass jemand rechtzeitig eine Sicherung gezogen hat.
 * 4. STILL fuer den Rest der Zeile. Geschrieben wird mit rohem SQL, damit
 *    `updatedAt` sich NICHT bewegt: dieses Feld ist der Zwischenspeicher-
 *    Schluessel des Bildes im Browser (`imageVersion`) und der Stempel am
 *    PDF-Vorschaubild. Ein Umzug ist keine Aenderung am Produkt.
 */

const APPLY = process.argv.includes('--apply');

const DATA_URI_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,/i;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;

(async () => {
    if (!objectStorageService.isConfigured()) {
        throw new Error('R2 ist nicht eingerichtet — ohne Zugangsdaten gibt es nichts umzuziehen.');
    }

    // Nur die Spalte selbst, und nur Zeilen, die wirklich ein Bild tragen.
    const rows: Array<{ id: string; tenantId: string; imageUrl: string }> =
        await (prisma as any).$queryRawUnsafe(`
            SELECT \`id\`, \`tenantId\`, \`imageUrl\`
            FROM \`Article\`
            WHERE \`imageUrl\` LIKE 'data:%'
        `);

    console.log(`${rows.length} Produktbilder stehen als Daten-URI in der Datenbank.`);
    if (!APPLY) console.log('PROBELAUF — nichts wird geschrieben. Mit --apply umziehen.\n');

    // DAS NETZ: die Originale liegen danach auch neben dem Skript.
    if (APPLY && rows.length > 0) {
        const backup = path.join(__dirname, `article-images-before-r2-${new Date().toISOString().slice(0, 10)}.json`);
        await fs.writeFile(backup, JSON.stringify(rows), 'utf-8');
        console.log(`Sicherung der Originale: ${backup}\n`);
    }

    let moved = 0;
    let skipped = 0;
    let failed = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;

    for (const row of rows) {
        const match = DATA_URI_PATTERN.exec(row.imageUrl);
        if (!match) {
            console.log(`  ? ${row.id}: keine erkennbare Bild-Daten-URI — bleibt liegen.`);
            skipped += 1;
            continue;
        }

        const contentType = (match[1] || 'image/jpeg').toLowerCase();
        const body = Buffer.from(row.imageUrl.slice(row.imageUrl.indexOf(',') + 1), 'base64');
        bytesBefore += row.imageUrl.length;

        if (body.length === 0) {
            console.log(`  ? ${row.id}: leeres Bild — bleibt liegen.`);
            skipped += 1;
            continue;
        }
        if (!articleImageStorage.accepts(contentType)) {
            console.log(`  ? ${row.id}: ${contentType} nimmt die Ablage nicht an — bleibt liegen.`);
            skipped += 1;
            continue;
        }

        if (!APPLY) {
            console.log(`  → ${row.id}: ${contentType}, ${mb(body.length)} würde nach R2 gehen.`);
            moved += 1;
            continue;
        }

        try {
            const reference = await articleImageStorage.store(row.tenantId, body, contentType);

            // GEPRUEFT: erst zurueckgelesen, dann die Zeile umgestellt.
            const readBack = await articleImageStorage.read(reference);
            if (!readBack.equals(body)) {
                throw new Error(`zurückgelesene Bytes weichen ab (${readBack.length} statt ${body.length})`);
            }

            await (prisma as any).$executeRawUnsafe(
                'UPDATE `Article` SET `imageUrl` = ? WHERE `id` = ?',
                reference,
                row.id,
            );
            bytesAfter += reference.length;
            moved += 1;
            console.log(`  ✓ ${row.id}: ${mb(body.length)} → ${reference}`);
        } catch (error: any) {
            failed += 1;
            console.log(`  ✗ ${row.id}: ${error.message}`);
        }
    }

    console.log('\n--------------------------------------------------------------');
    console.log(`umgezogen : ${moved}`);
    console.log(`übersprungen: ${skipped}`);
    console.log(`gescheitert : ${failed}`);
    if (APPLY) {
        console.log(`in der Datenbank: ${mb(bytesBefore)} → ${mb(bytesAfter)}`);
    }
    process.exit(failed > 0 ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
