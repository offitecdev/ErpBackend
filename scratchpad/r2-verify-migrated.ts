import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { appointmentDocumentStorage } from '../src/infrastructure/services/LocalFileStorage';

/**
 * Der Beweis nach dem Umzug: eine echte, umgezogene Unterlage wird ueber den
 * normalen Weg der Anwendung gelesen — nicht ueber ein Sonderskript — und die
 * Byteanzahl mit der Spalte in der Datenbank verglichen.
 */
(async () => {
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
        "SELECT id, fileName, sizeBytes, fileRef FROM AppointmentDocument WHERE fileRef LIKE 'r2:%' ORDER BY createdAt DESC LIMIT 3",
    );
    if (rows.length === 0) { console.log('Keine umgezogene Unterlage gefunden.'); process.exit(1); }

    let bad = 0;
    for (const row of rows) {
        const body = await appointmentDocumentStorage.read(String(row.fileRef));
        const expected = Number(row.sizeBytes);
        const ok = body.length === expected;
        if (!ok) bad += 1;
        console.log(`${ok ? '  ok  ' : ' FEHL '} ${row.fileName}  ${body.length} Byte (erwartet ${expected})`);

        const url = await appointmentDocumentStorage.presignRead(String(row.fileRef), { downloadName: String(row.fileName) });
        const response = await fetch(String(url));
        const fetched = Buffer.from(await response.arrayBuffer());
        const same = response.ok && fetched.equals(body);
        if (!same) bad += 1;
        console.log(`${same ? '  ok  ' : ' FEHL '} ueber die presignte Adresse identisch (HTTP ${response.status})`);
    }

    console.log('');
    console.log(bad === 0 ? 'ALLES GRUEN — die Dateien liegen in Cloudflare und sind lesbar.' : `${bad} FEHLER`);
    process.exit(bad === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
