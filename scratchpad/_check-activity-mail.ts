import { Prisma } from '@prisma/client';
import prisma from '../src/infrastructure/database/prisma.client';
import { getMailTenantId } from '../src/presentation/controllers/serviceTenantScope';

/* Probe der neuen MAIL-Quelle der Aktivitaeten: laeuft das SQL, und zieht es
   wirklich nur Post mit dem Etikett «Kunde»? */
(async () => {
    const tenants = await prisma.tenant.findMany({ where: { isActive: true }, select: { id: true, tenantName: true } });
    for (const tenant of tenants) {
        const tenantId = tenant.id;
        const mailTenantId = await getMailTenantId(tenantId);
        const since = new Date(Date.now() - 400 * 24 * 3600 * 1000);

        const mailWhere: Prisma.Sql[] = [
            Prisma.sql`m.tenantId = ${mailTenantId}`,
            Prisma.sql`cu.tenantId = ${tenantId}`,
            Prisma.sql`m.deletedAt IS NULL`,
        ];
        const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
            SELECT 'MAIL' AS kind, m.id AS id, m.sentAt AS occurredAt,
                   COALESCE(m.subject, '') AS title,
                   COALESCE(m.fromName, m.fromAddress, '') AS detail,
                   cu.id AS customerId, cu.companyName AS customerName,
                   m.employeeId AS employeeId, emp.firstName AS firstName, emp.lastName AS lastName,
                   m.direction AS statusText, m.id AS linkId, m.origin AS variant
              FROM MailMessage m
              JOIN MailCategory mc ON mc.id = m.categoryId AND mc.kind = 'CUSTOMER'
              JOIN Customer cu ON cu.id = COALESCE(m.customerId, mc.entityId)
              LEFT JOIN Employee emp ON emp.id = m.employeeId
             WHERE ${Prisma.join(mailWhere, ' AND ')}
             ORDER BY m.sentAt DESC LIMIT 5`);

        const stats = await prisma.$queryRaw<any[]>(Prisma.sql`
            SELECT
              (SELECT COUNT(*) FROM MailMessage m
                  JOIN MailCategory mc ON mc.id = m.categoryId AND mc.kind = 'CUSTOMER'
                  JOIN Customer cu ON cu.id = COALESCE(m.customerId, mc.entityId)
                 WHERE m.tenantId = ${mailTenantId} AND m.deletedAt IS NULL
                   AND cu.tenantId = ${tenantId} AND m.sentAt >= ${since}) AS mails`);

        const all = await prisma.mailMessage.count({ where: { tenantId: mailTenantId, deletedAt: null } });
        console.log(`${tenant.tenantName} (${tenantId}) | Postfach ${mailTenantId} | Post gesamt ${all} | mit Kunden-Etikett (Treffer) ${rows.length} | Zaehlung ${Number(stats[0]?.mails ?? 0)}`);
        for (const row of rows) console.log('   ', row.statusText, String(row.title).slice(0, 40), '->', row.customerName, '| linkId', row.linkId);
    }

    const labels = await prisma.mailCategory.groupBy({ by: ['kind'], _count: { _all: true } });
    console.log('\nKategorien im Haus:', labels);
    const labelled = await prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT mc.kind, COUNT(*) AS n FROM MailMessage m JOIN MailCategory mc ON mc.id = m.categoryId GROUP BY mc.kind`);
    console.log('Etikettierte Post je Art:', labelled.map((r) => `${r.kind}=${Number(r.n)}`).join(', ') || 'keine');
    await prisma.$disconnect();
})().catch(async (e) => { console.error('FEHLER', e); await prisma.$disconnect(); process.exit(1); });
