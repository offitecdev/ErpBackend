import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const tenMinutesAgo = new Date(Date.now() - 15 * 60_000);
    const rows = await prisma.mailMessage.findMany({
        where: { createdAt: { gte: tenMinutesAgo } },
        select: { tenantId: true, direction: true, origin: true, subject: true, fromAddress: true, sentAt: true, matchSource: true, customerId: true, employeeId: true, bodyHtml: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
    });
    for (const r of rows) {
        console.log(r.createdAt.toISOString(), r.tenantId, r.direction, r.origin, (r.subject || '').slice(0, 40), '|', r.fromAddress, '|', r.matchSource, '| html:', r.bodyHtml ? r.bodyHtml.length : 0, '| sentAt:', r.sentAt.toISOString().slice(0, 10));
    }
    console.log('rows:', rows.length);
    await prisma.$disconnect();
})();
