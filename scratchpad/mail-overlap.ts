import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
(BigInt.prototype as any).toJSON = function () { return Number(this); };
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const rows = await prisma.$queryRaw<any[]>`
        SELECT COUNT(*) AS bothTenants FROM (
            SELECT internetMessageId FROM MailMessage
            WHERE internetMessageId IS NOT NULL AND tenantId IN ('offitec-root','main-tenant')
            GROUP BY internetMessageId HAVING COUNT(DISTINCT tenantId) > 1
        ) x`;
    console.log('same message-id in both tenants:', JSON.stringify(rows));

    const perTenant = await prisma.$queryRaw<any[]>`
        SELECT tenantId, direction, origin, COUNT(*) AS n, MIN(sentAt) AS oldest, MAX(sentAt) AS newest
        FROM MailMessage GROUP BY tenantId, direction, origin`;
    console.log('per tenant/direction/origin:');
    for (const r of perTenant) console.log(r.tenantId, r.direction, r.origin, Number(r.n), String(r.oldest).slice(0,10), String(r.newest).slice(0,10));

    const nullIds = await prisma.$queryRaw<any[]>`
        SELECT tenantId, COUNT(*) AS n FROM MailMessage WHERE internetMessageId IS NULL GROUP BY tenantId`;
    console.log('null internetMessageId:', JSON.stringify(nullIds.map(r => ({ ...r, n: Number(r.n) }))));

    const dupWithin = await prisma.$queryRaw<any[]>`
        SELECT tenantId, COUNT(*) AS groups, SUM(c-1) AS extras FROM (
            SELECT tenantId, internetMessageId, COUNT(*) AS c FROM MailMessage
            WHERE internetMessageId IS NOT NULL GROUP BY tenantId, internetMessageId HAVING COUNT(*) > 1
        ) y GROUP BY tenantId`;
    console.log('duplicates WITHIN a tenant:', JSON.stringify(dupWithin.map(r => ({ tenantId: r.tenantId, groups: Number(r.groups), extras: Number(r.extras) }))));

    const cats = await prisma.mailCategory.findMany({ select: { id: true, tenantId: true, kind: true, entityId: true, name: true } });
    console.log('categories:', JSON.stringify(cats));

    const assigned = await prisma.$queryRaw<any[]>`SELECT tenantId, COUNT(*) AS n FROM MailMessage WHERE categoryId IS NOT NULL GROUP BY tenantId`;
    console.log('messages with category:', JSON.stringify(assigned.map(r => ({ ...r, n: Number(r.n) }))));

    const withEmp = await prisma.$queryRaw<any[]>`SELECT tenantId, COUNT(*) AS n FROM MailMessage WHERE employeeId IS NOT NULL GROUP BY tenantId`;
    console.log('messages with employee:', JSON.stringify(withEmp.map(r => ({ ...r, n: Number(r.n) }))));
    const withCust = await prisma.$queryRaw<any[]>`SELECT tenantId, COUNT(*) AS n FROM MailMessage WHERE customerId IS NOT NULL GROUP BY tenantId`;
    console.log('messages with customer:', JSON.stringify(withCust.map(r => ({ ...r, n: Number(r.n) }))));
    await prisma.$disconnect();
})();
