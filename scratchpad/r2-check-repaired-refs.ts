import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { appointmentDocumentStorage } from '../src/infrastructure/services/LocalFileStorage';

/** Die zwei reparierten Zeilen: erkannt, presignt, abrufbar? (01.09.2026) */
const IDS = ['EA83c3TP6aZx', 'xV1LyfFzRiCu'];

(async () => {
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
        `SELECT id, fileName, contentType, fileRef FROM AppointmentDocument WHERE id IN ('${IDS.join("','")}')`,
    );
    for (const row of rows) {
        console.log('\n---', row.id, row.fileName);
        console.log('  fileRef    :', row.fileRef);
        console.log('  managed    :', appointmentDocumentStorage.isManagedReference(row.fileRef));
        console.log('  remote     :', appointmentDocumentStorage.isRemoteReference(row.fileRef));
        const url = await appointmentDocumentStorage.displayUrl(row.fileRef, { contentType: row.contentType });
        console.log('  displayUrl :', url ? new URL(url).host : null);
        if (url) {
            const res = await fetch(url);
            console.log('  GET        :', res.status, res.headers.get('content-type'), res.headers.get('content-length'));
        }
    }
    process.exit(0);
})().catch((error) => { console.error('FEHLGESCHLAGEN', error); process.exit(1); });
