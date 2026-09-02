import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { objectStorageService } from '../src/infrastructure/services/ObjectStorageService';

/**
 * ABSOLUTE ADRESSEN ZURUECK IN REFERENZEN (01.09.2026).
 *
 * Zwei Terminunterlagen tragen die feste Adresse des Eimers (pub-*.r2.dev)
 * statt "r2:<schluessel>". Wechselt die Domain in der .env, erkennt
 * objectKeyFromPublicUrl() diese Zeilen nicht mehr — Lesen, Presignen und
 * Loeschen laufen dann ins Leere. Der Schluessel steht im Pfad; wir rechnen
 * ihn zurueck, pruefen mit HeadObject, dass die Datei wirklich dort liegt,
 * und schreiben die portable Form.
 *
 * Probelauf ohne Argument; echtes Schreiben mit --apply.
 */

const apply = process.argv.includes('--apply');
const KIND = 'appointment-document/';

/** "https://host/appointment-document/t/2026-08/x.pdf" -> "appointment-document/t/2026-08/x.pdf" */
const keyFromUrl = (value: string): string | null => {
    try {
        const url = new URL(value);
        if (url.search || url.hash) return null;
        const key = url.pathname.replace(/^\/+/, '')
            .split('/')
            .map((part) => decodeURIComponent(part))
            .join('/');
        return key.startsWith(KIND) ? key : null;
    } catch {
        return null;
    }
};

(async () => {
    const rows: Array<{ id: string; fileName: string; fileRef: string }> =
        await (prisma as any).$queryRawUnsafe(
            "SELECT id, fileName, fileRef FROM AppointmentDocument WHERE fileRef LIKE 'http%'",
        );

    console.log(`${rows.length} Zeile(n) mit absoluter Adresse.\n`);
    let fixed = 0;

    for (const row of rows) {
        const key = keyFromUrl(row.fileRef);
        console.log('---', row.id, row.fileName);
        console.log('  alt   :', row.fileRef);
        if (!key) {
            console.log('  UEBERSPRUNGEN: kein Schluessel dieser Ablage im Pfad.');
            continue;
        }
        const exists = await objectStorageService.objectExists(key);
        console.log('  neu   :', `r2:${key}`);
        console.log('  in R2 :', exists);
        if (!exists) {
            console.log('  UEBERSPRUNGEN: Objekt fehlt — die Zeile bleibt, wie sie ist.');
            continue;
        }
        if (!apply) {
            console.log('  (Probelauf)');
            continue;
        }
        await (prisma as any).$executeRawUnsafe(
            'UPDATE AppointmentDocument SET fileRef = ? WHERE id = ?',
            `r2:${key}`,
            row.id,
        );
        console.log('  GESCHRIEBEN');
        fixed += 1;
    }

    console.log(`\n${apply ? `${fixed} Zeile(n) geschrieben.` : 'Probelauf: nichts geaendert. Mit --apply anwenden.'}`);
    process.exit(0);
})().catch((error) => { console.error('FEHLGESCHLAGEN', error); process.exit(1); });
