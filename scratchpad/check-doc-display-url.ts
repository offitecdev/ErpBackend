import prisma from '../src/infrastructure/database/prisma.client';
import { appointmentDocumentStorage } from '../src/infrastructure/services/LocalFileStorage';

/**
 * Was bekommt der Browser fuer die letzten Terminunterlagen — und laesst sich
 * die Adresse wirklich abrufen? (01.09.2026, weisse Vorschau.)
 */
(async () => {
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
        'SELECT id, fileName, contentType, fileRef FROM AppointmentDocument ORDER BY createdAt DESC LIMIT 5',
    );
    for (const row of rows) {
        console.log('\n---', row.id, row.fileName, `(${row.contentType})`);
        console.log('  fileRef      :', String(row.fileRef).slice(0, 110));
        console.log('  isRemoteRef  :', appointmentDocumentStorage.isRemoteReference(row.fileRef));
        console.log('  isPublicRef  :', appointmentDocumentStorage.isPublicReference(row.fileRef));
        try {
            const url = await appointmentDocumentStorage.displayUrl(row.fileRef, { contentType: row.contentType });
            console.log('  displayUrl   :', url ? `${new URL(url).host}${new URL(url).pathname}` : null);
            if (url) {
                const res = await fetch(url, { method: 'GET' });
                console.log('  GET          :', res.status, res.headers.get('content-type'), res.headers.get('content-length'));
            }
        } catch (error: any) {
            console.log('  THREW        :', error.message);
        }
    }
    process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
