import { Prisma } from '@prisma/client';
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const t = await prisma.tender.groupBy({ by: ['tenantId'], _count: { _all: true } });
    console.log('Angebote je Mandant:', t.map((r) => r.tenantId + '=' + r._count._all).join(' '));
    const tenantId = t.sort((a, b) => b._count._all - a._count._all)[0]?.tenantId;
    if (!tenantId) return;
    const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT u.* FROM (
            SELECT 'QUOTE' AS kind, t.id AS id, t.createdAt AS occurredAt, t.tenderNumber AS title,
                   COALESCE(cu.companyName, '') AS detail, t.customerId AS customerId, cu.companyName AS customerName,
                   NULL AS employeeId, NULL AS firstName, NULL AS lastName, t.status AS statusText, t.id AS linkId, NULL AS variant
              FROM Tender t LEFT JOIN Customer cu ON cu.id = t.customerId WHERE t.tenantId = ${tenantId}
            UNION ALL
            SELECT 'ORDER', so.id, so.createdAt, so.orderNumber, COALESCE(cu.companyName, ''),
                   so.customerId, cu.companyName, so.createdByEmployeeId, emp.firstName, emp.lastName, so.status, so.id, NULL
              FROM SalesOrder so LEFT JOIN Customer cu ON cu.id = so.customerId
              LEFT JOIN Employee emp ON emp.id = so.createdByEmployeeId WHERE so.tenantId = ${tenantId}
            UNION ALL
            SELECT 'TASK', ct.id, ct.createdAt, ct.title, COALESCE(cu.companyName, ''),
                   ct.customerId, cu.companyName, ct.assigneeEmployeeId, emp.firstName, emp.lastName, ct.status, ct.id, ct.kind
              FROM CrmTask ct LEFT JOIN Customer cu ON cu.id = ct.customerId
              LEFT JOIN Employee emp ON emp.id = ct.assigneeEmployeeId WHERE ct.tenantId = ${tenantId}
            UNION ALL
            SELECT 'MAIL', m.id, m.sentAt, COALESCE(m.subject, ''), COALESCE(m.fromName, m.fromAddress, ''),
                   m.customerId, cu.companyName, m.employeeId, emp.firstName, emp.lastName, m.direction, m.id, m.origin
              FROM MailMessage m LEFT JOIN Customer cu ON cu.id = m.customerId
              LEFT JOIN Employee emp ON emp.id = m.employeeId WHERE m.tenantId = ${tenantId} AND m.deletedAt IS NULL
            UNION ALL
            SELECT 'CONTACT', cc.id, cc.occurredAt, LEFT(cc.note, 300), COALESCE(cu.companyName, ''),
                   cc.customerId, cu.companyName, cc.createdByEmployeeId, emp.firstName, emp.lastName, cc.channel, cc.id, cc.channel
              FROM CrmCommunication cc JOIN Customer cu ON cu.id = cc.customerId
              LEFT JOIN Employee emp ON emp.id = cc.createdByEmployeeId WHERE cc.tenantId = ${tenantId}
        ) u ORDER BY u.occurredAt DESC, u.id DESC LIMIT 10`);
    console.log('Zeilen:', rows.length);
    for (const r of rows) console.log(' ', r.kind, '|', String(r.title || '').slice(0, 34), '|', r.customerName, '|', r.statusText, '|', r.firstName);
    await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
