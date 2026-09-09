import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const rows = await (prisma as any).tender.findMany({
        where: { status: 'Draft', tenantId: 'main-tenant', deletedAt: null },
        select: { id: true, tenderNumber: true, _count: { select: { positions: true } } },
        orderBy: { createdAt: 'desc' }, take: 8,
    }).catch(async () => (prisma as any).tender.findMany({
        where: { status: 'Draft', tenantId: 'main-tenant' },
        select: { id: true, tenderNumber: true, _count: { select: { positions: true } } },
        orderBy: { createdAt: 'desc' }, take: 8,
    }));
    for (const r of rows) console.log(r.id, r.tenderNumber, r._count.positions);
    await prisma.$disconnect();
})();
