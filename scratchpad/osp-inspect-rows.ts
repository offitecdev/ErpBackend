import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';

/**
 * Nur lesen: Wie stehen die echten OSP-Zeilen da? (Datenblatt-Adresse, Datei,
 * Fehler, gelesene Angaben, Offerten-Verknüpfung) — um zu sehen, warum die
 * Beschreibung beim Direkt-Import leer bleibt.
 */
(async () => {
    const rows = await (prisma as any).ospDocument.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
            id: true,
            reference: true,
            model: true,
            category: true,
            status: true,
            tenderId: true,
            tenderNumber: true,
            datasheetUrl: true,
            datasheetFile: true,
            datasheetFetchedAt: true,
            datasheetError: true,
            datasheetSpecs: true,
            rawPayload: true,
        },
    });
    for (const row of rows) {
        const raw = row.rawPayload && typeof row.rawPayload === 'object' ? Object.keys(row.rawPayload) : [];
        console.log(JSON.stringify({
            id: row.id,
            reference: row.reference,
            model: row.model,
            category: row.category,
            status: row.status,
            tenderId: row.tenderId,
            tenderNumber: row.tenderNumber,
            datasheetUrl: row.datasheetUrl,
            datasheetFile: row.datasheetFile,
            datasheetFetchedAt: row.datasheetFetchedAt,
            datasheetError: row.datasheetError,
            datasheetSpecs: row.datasheetSpecs,
            rawPayloadKeys: raw,
        }, null, 2));
    }
    await (prisma as any).$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
