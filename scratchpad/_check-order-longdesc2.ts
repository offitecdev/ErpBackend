import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const rows = await (prisma as any).position.findMany({
        where: { longDescription: { not: null }, tender: { status: { not: 'Draft' } } },
        select: { tenderId: true, longDescription: true, tender: { select: { tenderNumber: true, status: true, tenantId: true } } },
    });
    const byTender: Record<string, any> = {};
    for (const r of rows) { if (!r.longDescription?.trim()) continue; const k = r.tenderId; byTender[k] = byTender[k] || { n: 0, ...r.tender }; byTender[k].n++; }
    console.log(JSON.stringify(byTender, null, 0));
    // this order: who created & how? look at tender fields
    const t = await (prisma as any).tender.findUnique({ where: { id: 'Z7x991dw_Q' }, select: { tenderNumber: true, status: true, source: true, createdAt: true, sourceStatus: true } }).catch((e: any) => String(e.message).slice(0, 200));
    console.log(t);
    await prisma.$disconnect();
})();
