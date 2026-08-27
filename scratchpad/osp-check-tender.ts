import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';

/** Nur lesen: die Positionen der aus OSP erzeugten Offerte AN-2026-40021. */
(async () => {
    const tender = await prisma.tender.findFirst({
        where: { tenderNumber: 'AN-2026-40021' },
        select: { id: true, tenderNumber: true, customerReference: true, manualCustomerName: true, createdAt: true },
    });
    console.log('tender:', JSON.stringify(tender));
    if (tender) {
        const positions = await prisma.position.findMany({
            where: { tenderId: tender.id },
            select: { positionNumber: true, rowType: true, shortDescription: true, longDescription: true, quantity: true, unitPrice: true },
        });
        console.log(JSON.stringify(positions, null, 2));
    }
    await (prisma as any).$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
