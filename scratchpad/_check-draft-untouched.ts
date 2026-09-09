import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const rows = await (prisma as any).position.findMany({ where: { tenderId: '5druUBkPaB' }, select: { longDescription: true } });
    for (const r of rows) console.log(String(r.longDescription || '').slice(0, 30).replace(/\n/g, ' '));
    await prisma.$disconnect();
})();
