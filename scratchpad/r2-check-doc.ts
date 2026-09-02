import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { objectStorageService } from '../src/infrastructure/services/ObjectStorageService';

/** Wo liegt eine einzelne Unterlage? node ... r2-check-doc.ts <id> */
(async () => {
    const id = process.argv[2];
    console.log(`R2 eingerichtet: ${objectStorageService.isConfigured() ? 'JA' : 'NEIN'}\n`);

    const rows: any[] = await (prisma as any).$queryRawUnsafe(
        'SELECT id, fileName, contentType, sizeBytes, fileRef, createdAt FROM AppointmentDocument '
        + (id ? 'WHERE id = ? ' : '') + 'ORDER BY createdAt DESC LIMIT 5',
        ...(id ? [id] : []),
    );

    for (const row of rows) {
        const ref = String(row.fileRef || '');
        const place = ref.startsWith('r2:') ? 'CLOUDFLARE R2' : ref.startsWith('local:') ? 'PLATTE des Servers' : 'unbekannt';
        console.log(`${row.id}  ${row.fileName}  ${(Number(row.sizeBytes) / 1024 / 1024).toFixed(2)} MB`);
        console.log(`   angelegt: ${new Date(row.createdAt).toISOString()}`);
        console.log(`   Verweis:  ${ref}`);
        console.log(`   liegt:    ${place}\n`);
    }

    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
