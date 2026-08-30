import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
(BigInt.prototype as any).toJSON = function () { return Number(this); };
import prisma from '../src/infrastructure/database/prisma.client';

/* Was die Migration 20260913090000_mail_one_mailbox_per_company tun WÜRDE —
   dieselben Abfragen, nur als SELECT. */
(async () => {
    const version = await prisma.$queryRaw<any[]>`SELECT VERSION() AS v`;
    console.log('MySQL:', version[0]?.v);

    const moves = await prisma.$queryRaw<any[]>`
        SELECT m.tenantId AS fromTenant, COALESCE(t4.id, t3.id, t2.id, t1.id) AS toTenant, COUNT(*) AS n
          FROM MailMessage m
          JOIN Tenant t1 ON t1.id = m.tenantId
          LEFT JOIN Tenant t2 ON t2.id = t1.parentTenantId
          LEFT JOIN Tenant t3 ON t3.id = t2.parentTenantId
          LEFT JOIN Tenant t4 ON t4.id = t3.parentTenantId
         GROUP BY fromTenant, toTenant`;
    console.log('messages moved:', JSON.stringify(moves.map((r) => ({ ...r, n: Number(r.n) }))));

    const catMoves = await prisma.$queryRaw<any[]>`
        SELECT c.tenantId AS fromTenant, COALESCE(t4.id, t3.id, t2.id, t1.id) AS toTenant, c.kind, COUNT(*) AS n
          FROM MailCategory c
          JOIN Tenant t1 ON t1.id = c.tenantId
          LEFT JOIN Tenant t2 ON t2.id = t1.parentTenantId
          LEFT JOIN Tenant t3 ON t3.id = t2.parentTenantId
          LEFT JOIN Tenant t4 ON t4.id = t3.parentTenantId
         GROUP BY fromTenant, toTenant, c.kind`;
    console.log('categories moved:', JSON.stringify(catMoves.map((r) => ({ ...r, n: Number(r.n) }))));

    // Doppelte NACH dem Umhängen (simuliert über den berechneten Kopf-Mandanten).
    const dupA = await prisma.$queryRaw<any[]>`
        SELECT COUNT(*) AS n FROM (
            SELECT id, ROW_NUMBER() OVER w AS rn FROM (
                SELECT m.id, COALESCE(t4.id, t3.id, t2.id, t1.id) AS root, m.providerMessageId,
                       m.categoryId, m.activityId, m.entityId, m.customerId, m.employeeId, m.deletedAt, m.createdAt
                  FROM MailMessage m
                  JOIN Tenant t1 ON t1.id = m.tenantId
                  LEFT JOIN Tenant t2 ON t2.id = t1.parentTenantId
                  LEFT JOIN Tenant t3 ON t3.id = t2.parentTenantId
                  LEFT JOIN Tenant t4 ON t4.id = t3.parentTenantId
                 WHERE m.providerMessageId IS NOT NULL
            ) z
            WINDOW w AS (PARTITION BY root, providerMessageId
                         ORDER BY (categoryId IS NULL), (activityId IS NULL), (entityId IS NULL),
                                  (customerId IS NULL), (employeeId IS NULL), (deletedAt IS NOT NULL),
                                  createdAt, id)
        ) r WHERE r.rn > 1`;
    console.log('duplicates by provider id (pass 4a):', Number(dupA[0]?.n || 0));

    const dupB = await prisma.$queryRaw<any[]>`
        SELECT COUNT(*) AS n FROM (
            SELECT internetMessageId, direction, root, COUNT(*) AS c FROM (
                SELECT m.internetMessageId, m.direction, COALESCE(t4.id, t3.id, t2.id, t1.id) AS root
                  FROM MailMessage m
                  JOIN Tenant t1 ON t1.id = m.tenantId
                  LEFT JOIN Tenant t2 ON t2.id = t1.parentTenantId
                  LEFT JOIN Tenant t3 ON t3.id = t2.parentTenantId
                  LEFT JOIN Tenant t4 ON t4.id = t3.parentTenantId
                 WHERE m.internetMessageId IS NOT NULL
            ) z GROUP BY internetMessageId, direction, root HAVING COUNT(*) > 1
        ) g`;
    console.log('message-id groups with >1 row (before 4a):', Number(dupB[0]?.n || 0));

    const enq = await prisma.$queryRaw<any[]>`SELECT COUNT(*) AS n FROM Enquiry WHERE mailMessageId IS NOT NULL`;
    console.log('enquiries pointing at a mail:', Number(enq[0]?.n || 0));

    const cursors = await prisma.mailSetting.findMany({
        select: { tenantId: true, imapUidValidity: true, imapLastUid: true, imapSentUidValidity: true, imapSentLastUid: true },
    });
    console.log('cursors:', JSON.stringify(cursors));
    await prisma.$disconnect();
})();
