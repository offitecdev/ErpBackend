import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const rows = await (prisma as any).position.findMany({
        where: { tenderId: 'Z7x991dw_Q' },
        select: { id: true, rowType: true, shortDescription: true, longDescription: true, sourceArticleId: true },
        orderBy: { displayOrder: 'asc' },
    });
    for (const r of rows) console.log(r.rowType, '|', r.shortDescription, '| ld=', JSON.stringify((r.longDescription || '').slice(0, 60)), '| art=', r.sourceArticleId);
    const arts = await (prisma as any).article.findMany({
        where: { id: { in: rows.map((r: any) => r.sourceArticleId).filter(Boolean) } },
        select: { id: true, name: true, description: true },
    });
    for (const a of arts) console.log('ARTICLE', a.name, '| desc=', JSON.stringify((a.description || '').slice(0, 60)));
    // any Order/Approved tender positions with a longDescription at all?
    const n = await (prisma as any).position.count({ where: { longDescription: { not: null }, tender: { status: { not: 'Draft' } } } });
    const nd = await (prisma as any).position.count({ where: { longDescription: { not: null }, tender: { status: 'Draft' } } });
    console.log('positions with ld: non-draft=', n, ' draft=', nd);
    await prisma.$disconnect();
})();
