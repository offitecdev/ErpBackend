import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { appointmentDocumentStorage } from '../src/infrastructure/services/LocalFileStorage';
import { objectStorageService } from '../src/infrastructure/services/ObjectStorageService';

/** Dieselbe Datei, zwei Adressen: presignt (S3-Endpunkt) und fest (Domain). */
(async () => {
    const row: any = (await (prisma as any).$queryRawUnsafe(
        "SELECT id, fileName, contentType, fileRef FROM AppointmentDocument WHERE contentType = 'application/pdf' ORDER BY createdAt DESC LIMIT 1",
    ))[0];
    const key = String(row.fileRef).startsWith('r2:')
        ? String(row.fileRef).slice(3)
        : objectStorageService.objectKeyFromPublicUrl(String(row.fileRef));

    console.log('DOC   :', row.id, row.fileName);
    console.log('REF   :', row.fileRef);
    console.log('');
    console.log('PRESIGNED:');
    console.log(await appointmentDocumentStorage.presignRead(row.fileRef, { contentType: row.contentType }));
    console.log('');
    console.log('PUBLIC:');
    console.log(objectStorageService.publicUrl(String(key)));
    process.exit(0);
})().catch((error) => { console.error('FEHLGESCHLAGEN', error); process.exit(1); });
