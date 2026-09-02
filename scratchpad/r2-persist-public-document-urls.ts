import 'dotenv/config';

import prisma from '../src/infrastructure/database/prisma.client';
import { appointmentDocumentStorage, type DocumentStorage } from '../src/infrastructure/services/LocalFileStorage';
import { tenderDocumentStorageService } from '../src/infrastructure/services/TenderDocumentStorageService';

/**
 * Takvim ve teklif belgelerindeki eski data:/local:/r2: degerlerini kalici
 * R2 public URL'lerine cevirir. Varsayilan davranis sadece rapordur;
 * gercek degisiklik icin --apply gerekir.
 */

const apply = process.argv.includes('--apply');

type Candidate = {
    id: string;
    tenantId: string;
    value: string;
    contentType: string;
    fileName: string;
};

const dataUriBody = (value: string): Buffer | null => {
    const match = /^data:[^;,]+;base64,([\s\S]+)$/i.exec(value);
    if (!match) return null;
    const body = Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64');
    return body.length ? body : null;
};

const publicUrlFor = async (row: Candidate, storage: DocumentStorage): Promise<{
    url: string;
    newlyStored: string | null;
}> => {
    const direct = storage.publicReadUrl(row.value);
    if (direct) return { url: direct, newlyStored: null };

    let body: Buffer | null = null;
    if (storage.isLocalReference(row.value)) body = await storage.read(row.value);
    else if (row.value.startsWith('data:')) body = dataUriBody(row.value);
    if (!body) throw new Error('Desteklenmeyen eski dosya degeri.');

    const stored = await storage.store(row.tenantId, body, row.contentType);
    const url = storage.publicReadUrl(stored);
    if (!url) {
        await storage.remove(stored).catch(() => undefined);
        throw new Error('R2_PUBLIC_URL ayarlanmamis.');
    }
    return { url, newlyStored: stored };
};

(async () => {
    if (!process.env.R2_PUBLIC_URL?.trim() && !process.env.OFFITEC_S3_PUBLIC_BASE_URL?.trim()) {
        throw new Error('R2_PUBLIC_URL ayarlanmamis.');
    }

    if (!apply) {
        const [appointmentCount, tenderCount] = await Promise.all([
            (prisma as any).appointmentDocument.count({
                where: {
                    OR: [
                        { fileRef: { startsWith: 'r2:' } },
                        { fileRef: { startsWith: 'local:' } },
                        { fileRef: { startsWith: 'data:' } },
                    ],
                },
            }),
            (prisma as any).document.count({
                where: {
                    entityType: 'TENDER',
                    OR: [
                        { fileUrl: { startsWith: 'r2:' } },
                        { fileUrl: { startsWith: 'local:' } },
                        { fileUrl: { startsWith: 'data:' } },
                    ],
                },
            }),
        ]);
        console.log(`Takvim: ${appointmentCount}, teklif: ${tenderCount} eski kayit.`);
        console.log('Probelauf: degisiklik yapilmadi. Uygulamak icin --apply kullanin.');
        process.exit(0);
    }

    console.log('Takvim kayitlari okunuyor...');
    const appointmentRows: any[] = await (prisma as any).appointmentDocument.findMany({
        where: {
            OR: [
                { fileRef: { startsWith: 'r2:' } },
                { fileRef: { startsWith: 'local:' } },
                { fileRef: { startsWith: 'data:' } },
            ],
        },
        select: { id: true, tenantId: true, fileRef: true, contentType: true, fileName: true },
    });
    console.log('Teklif kayitlari okunuyor...');
    const tenderRows: any[] = await (prisma as any).document.findMany({
        where: {
            entityType: 'TENDER',
            OR: [
                { fileUrl: { startsWith: 'r2:' } },
                { fileUrl: { startsWith: 'local:' } },
                { fileUrl: { startsWith: 'data:' } },
            ],
        },
        select: { id: true, tenantId: true, fileUrl: true, fileType: true, fileName: true },
    });

    console.log(`Takvim: ${appointmentRows.length}, teklif: ${tenderRows.length} eski kayit.`);
    let changed = 0;
    const failures: string[] = [];

    for (const raw of appointmentRows) {
        const row: Candidate = {
            id: raw.id,
            tenantId: raw.tenantId,
            value: raw.fileRef,
            contentType: raw.contentType,
            fileName: raw.fileName,
        };
        let newlyStored: string | null = null;
        try {
            const resolved = await publicUrlFor(row, appointmentDocumentStorage);
            newlyStored = resolved.newlyStored;
            const result = await (prisma as any).appointmentDocument.updateMany({
                where: { id: row.id, fileRef: row.value },
                data: { fileRef: resolved.url },
            });
            if (result.count !== 1) throw new Error('Kayit ayni anda degisti.');
            if (appointmentDocumentStorage.isLocalReference(row.value)) {
                await appointmentDocumentStorage.remove(row.value).catch(() => undefined);
            }
            changed += 1;
        } catch (error: any) {
            if (newlyStored) await appointmentDocumentStorage.remove(newlyStored).catch(() => undefined);
            failures.push(`Takvim ${row.id} (${row.fileName}): ${error?.message || error}`);
        }
    }

    for (const raw of tenderRows) {
        const row: Candidate = {
            id: raw.id,
            tenantId: raw.tenantId,
            value: raw.fileUrl,
            contentType: raw.fileType,
            fileName: raw.fileName,
        };
        let newlyStored: string | null = null;
        try {
            const resolved = await publicUrlFor(row, tenderDocumentStorageService);
            newlyStored = resolved.newlyStored;
            const result = await (prisma as any).document.updateMany({
                where: { id: row.id, fileUrl: row.value },
                data: { fileUrl: resolved.url },
            });
            if (result.count !== 1) throw new Error('Kayit ayni anda degisti.');
            if (tenderDocumentStorageService.isLocalReference(row.value)) {
                await tenderDocumentStorageService.remove(row.value).catch(() => undefined);
            }
            changed += 1;
        } catch (error: any) {
            if (newlyStored) await tenderDocumentStorageService.remove(newlyStored).catch(() => undefined);
            failures.push(`Teklif ${row.id} (${row.fileName}): ${error?.message || error}`);
        }
    }

    console.log(`${changed} kayit public URL'ye cevrildi.`);
    failures.forEach((line) => console.error(line));
    process.exit(failures.length ? 1 : 0);
})().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
});
