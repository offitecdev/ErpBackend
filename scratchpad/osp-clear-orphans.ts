import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';

/** Einmalige Reparatur: OSP-Zeilen, deren Offerte nicht mehr existiert,
 *  geben tenderId/tenderNumber frei — "Offerte erstellen" kommt zurück.
 *  (Dasselbe macht die Belegliste seit heute selbst; das hier räumt sofort.) */
(async () => {
    const linked = await (prisma as any).ospDocument.findMany({
        where: { NOT: { tenderId: null } },
        select: { id: true, reference: true, tenderId: true, tenderNumber: true },
    });
    if (!linked.length) { console.log('no linked rows'); process.exit(0); }
    const tenders = await prisma.tender.findMany({
        where: { id: { in: linked.map((r: any) => r.tenderId) } },
        select: { id: true },
    });
    const existing = new Set(tenders.map((t) => t.id));
    const orphaned = linked.filter((r: any) => !existing.has(r.tenderId));
    console.log('linked:', linked.length, 'orphaned:', orphaned.length);
    for (const row of orphaned) {
        console.log('clearing', row.reference, '->', row.tenderNumber);
    }
    if (orphaned.length) {
        const result = await (prisma as any).ospDocument.updateMany({
            where: { id: { in: orphaned.map((r: any) => r.id) } },
            data: { tenderId: null, tenderNumber: null },
        });
        console.log('cleared rows:', result.count);
    }
    await (prisma as any).$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
