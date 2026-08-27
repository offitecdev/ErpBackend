import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';

/** Nur lesen: Datenblatt-Stand ALLER OSP-Zeilen, kompakt. */
(async () => {
    const rows = await (prisma as any).ospDocument.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
            reference: true, model: true, createdAt: true, tenderNumber: true,
            datasheetUrl: true, datasheetFile: true, datasheetError: true, datasheetSpecs: true,
            rawPayload: true,
        },
    });
    console.log('total rows:', rows.length);
    for (const r of rows) {
        console.log([
            r.createdAt?.toISOString?.().slice(0, 16),
            r.reference,
            r.model,
            `tender=${r.tenderNumber || '-'}`,
            `url=${r.datasheetUrl ? 'YES' : '-'}`,
            `file=${r.datasheetFile ? 'YES' : '-'}`,
            `specs=${r.datasheetSpecs ? Object.keys(r.datasheetSpecs).length : '-'}`,
            `raw=${r.rawPayload ? 'YES' : '-'}`,
            `err=${r.datasheetError ? String(r.datasheetError).slice(0, 60) : '-'}`,
        ].join(' | '));
    }
    await (prisma as any).$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
