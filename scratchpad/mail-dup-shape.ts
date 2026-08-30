import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
(BigInt.prototype as any).toJSON = function () { return Number(this); };
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const groups = await prisma.$queryRaw<any[]>`
        SELECT internetMessageId, COUNT(*) c FROM MailMessage
        WHERE tenantId='offitec-root' AND internetMessageId IS NOT NULL
        GROUP BY internetMessageId HAVING COUNT(*) > 1 ORDER BY c DESC LIMIT 5`;
    for (const g of groups) {
        const rows = await prisma.mailMessage.findMany({
            where: { tenantId: 'offitec-root', internetMessageId: g.internetMessageId },
            select: { id: true, direction: true, origin: true, providerMessageId: true, subject: true, sentAt: true, createdAt: true, categoryId: true, customerId: true, employeeId: true, deletedAt: true, isRead: true },
        });
        console.log('--- group', g.internetMessageId, Number(g.c));
        for (const r of rows) console.log('   ', r.id, r.direction, r.origin, r.providerMessageId, '|', (r.subject||'').slice(0,40), '| created', r.createdAt.toISOString());
    }
    // direction split inside dup groups
    const split = await prisma.$queryRaw<any[]>`
        SELECT sameDir, COUNT(*) n FROM (
          SELECT internetMessageId, (COUNT(DISTINCT direction)=1) AS sameDir
          FROM MailMessage WHERE internetMessageId IS NOT NULL
          GROUP BY tenantId, internetMessageId HAVING COUNT(*)>1
        ) z GROUP BY sameDir`;
    console.log('dup groups by same-direction:', JSON.stringify(split));
    await prisma.$disconnect();
})();
