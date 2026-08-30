import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
(BigInt.prototype as any).toJSON = function () { return Number(this); };
import prisma from '../src/infrastructure/database/prisma.client';

/* Die heiklen Teile der Migration als LESENDE Abfrage — prüft, dass MariaDB
   die Formulierungen versteht, bevor sie schreibend laufen. */
(async () => {
    const catDupes = await prisma.$queryRaw<any[]>`
        SELECT c.id AS dupId, k.keepId
          FROM MailCategory c
          JOIN (
                SELECT tenantId, kind, COALESCE(entityId, '') AS ent, MIN(id) AS keepId
                  FROM MailCategory
                 GROUP BY tenantId, kind, COALESCE(entityId, '')
               ) k
            ON k.tenantId = c.tenantId AND k.kind = c.kind AND k.ent = COALESCE(c.entityId, '')
         WHERE c.id <> k.keepId`;
    console.log('category merge (before the move — 0 expected today):', JSON.stringify(catDupes));

    // Nach dem Umhängen: dieselbe Gruppierung auf dem berechneten Kopf-Mandanten.
    const catDupesAfter = await prisma.$queryRaw<any[]>`
        SELECT c.id AS dupId, k.keepId, c.kind
          FROM (
                SELECT mc.id, mc.kind, mc.entityId, COALESCE(t4.id, t3.id, t2.id, t1.id) AS root
                  FROM MailCategory mc
                  JOIN Tenant t1 ON t1.id = mc.tenantId
                  LEFT JOIN Tenant t2 ON t2.id = t1.parentTenantId
                  LEFT JOIN Tenant t3 ON t3.id = t2.parentTenantId
                  LEFT JOIN Tenant t4 ON t4.id = t3.parentTenantId
               ) c
          JOIN (
                SELECT root, kind, COALESCE(entityId, '') AS ent, MIN(id) AS keepId FROM (
                    SELECT mc.id, mc.kind, mc.entityId, COALESCE(t4.id, t3.id, t2.id, t1.id) AS root
                      FROM MailCategory mc
                      JOIN Tenant t1 ON t1.id = mc.tenantId
                      LEFT JOIN Tenant t2 ON t2.id = t1.parentTenantId
                      LEFT JOIN Tenant t3 ON t3.id = t2.parentTenantId
                      LEFT JOIN Tenant t4 ON t4.id = t3.parentTenantId
                ) z GROUP BY root, kind, COALESCE(entityId, '')
               ) k
            ON k.root = c.root AND k.kind = c.kind AND k.ent = COALESCE(c.entityId, '')
         WHERE c.id <> k.keepId`;
    console.log('categories merged AFTER the move:', JSON.stringify(catDupesAfter));

    // Die NOT-EXISTS-Formulierung der Anfragen-Umhängung.
    const enq = await prisma.$queryRaw<any[]>`
        SELECT e.id
          FROM Enquiry e
         WHERE e.mailMessageId IS NOT NULL
           AND NOT EXISTS (
                SELECT 1 FROM (SELECT tenantId, mailMessageId FROM Enquiry) x
                 WHERE x.tenantId = e.tenantId AND x.mailMessageId = e.mailMessageId
           )`;
    console.log('enquiry NOT EXISTS form parses; rows:', enq.length);
    await prisma.$disconnect();
})();
