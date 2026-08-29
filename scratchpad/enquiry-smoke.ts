import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';

/* Rauchprobe fuer Anfragen + Aktivitaeten: die rohen Statements der beiden
   neuen Router einmal gegen die echte Datenbank fahren. Sie sind nicht
   typgeprueft — ein Tippfehler in einem Spaltennamen faellt sonst erst im
   Browser auf. Legt eine Testanfrage an und raeumt sie wieder weg. */

(async () => {
    const tenant = await prisma.tenant.findFirst({ select: { id: true, tenantName: true } });
    if (!tenant) throw new Error('kein Mandant');
    const tenantId = tenant.id;
    console.log('Mandant:', tenant.tenantName, tenantId);

    // ── 1. Formular anlegen/lesen
    let form = await prisma.enquiryForm.findUnique({ where: { tenantId } });
    if (!form) {
        form = await prisma.enquiryForm.create({
            data: { id: nanoid(12), tenantId, token: 'smoke-' + nanoid(16), active: true },
        });
    }
    console.log('Formular-Token:', form.token, 'aktiv:', form.active);

    // ── 2. Anfrage anlegen (wie das oeffentliche Formular)
    const id = nanoid(12);
    await prisma.enquiry.create({
        data: {
            id, tenantId, source: 'FORM', status: 'NEW',
            companyName: 'Rauchprobe AG', contactName: 'Anna Beispiel',
            email: 'anna@rauchprobe.example', phone: '+41 61 000 00 00',
            subject: 'Offertanfrage Rauchprobe', message: 'Bitte um ein Angebot.',
        },
    });
    console.log('Anfrage angelegt:', id);

    // ── 3. Das Listen-Statement des Routers
    const whereSql = Prisma.join([Prisma.sql`e.tenantId = ${tenantId}`], ' AND ');
    const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT e.*, cu.companyName AS customerName,
               a.firstName AS assigneeFirstName, a.lastName AS assigneeLastName,
               c.firstName AS creatorFirstName, c.lastName AS creatorLastName
          FROM Enquiry e
          LEFT JOIN Customer cu ON cu.id = e.customerId
          LEFT JOIN Employee a ON a.id = e.assignedEmployeeId
          LEFT JOIN Employee c ON c.id = e.createdByEmployeeId
         WHERE ${whereSql}
         ORDER BY e.createdAt DESC, e.id DESC
         LIMIT 5 OFFSET 0`);
    console.log('Liste:', rows.length, 'Zeilen; erste:', rows[0]?.subject);

    const stats = await prisma.enquiry.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } });
    console.log('Zaehler:', stats.map((row) => `${row.status}=${row._count._all}`).join(' '));

    // ── 4. Das Aktivitaeten-Statement (alle sechs Zweige)
    const branches: Prisma.Sql[] = [
        Prisma.sql`
            SELECT 'ENQUIRY' AS kind, e.id AS id, e.createdAt AS occurredAt,
                   e.subject AS title, COALESCE(e.companyName, e.contactName, e.email) AS detail,
                   e.customerId AS customerId, cu.companyName AS customerName,
                   e.createdByEmployeeId AS employeeId, emp.firstName AS firstName, emp.lastName AS lastName,
                   e.status AS statusText, e.id AS linkId, e.source AS variant
              FROM Enquiry e
              LEFT JOIN Customer cu ON cu.id = e.customerId
              LEFT JOIN Employee emp ON emp.id = e.createdByEmployeeId
             WHERE e.tenantId = ${tenantId}`,
        Prisma.sql`
            SELECT 'QUOTE', t.id, t.createdAt, t.tenderNumber, COALESCE(cu.companyName, ''),
                   t.customerId, cu.companyName, NULL, NULL, NULL, t.status, t.id, NULL
              FROM Tender t LEFT JOIN Customer cu ON cu.id = t.customerId
             WHERE t.tenantId = ${tenantId}`,
        Prisma.sql`
            SELECT 'ORDER', so.id, so.createdAt, so.orderNumber, COALESCE(cu.companyName, ''),
                   so.customerId, cu.companyName, so.createdByEmployeeId, emp.firstName, emp.lastName,
                   so.status, so.id, NULL
              FROM SalesOrder so
              LEFT JOIN Customer cu ON cu.id = so.customerId
              LEFT JOIN Employee emp ON emp.id = so.createdByEmployeeId
             WHERE so.tenantId = ${tenantId}`,
        Prisma.sql`
            SELECT 'TASK', ct.id, ct.createdAt, ct.title, COALESCE(cu.companyName, ''),
                   ct.customerId, cu.companyName, ct.assigneeEmployeeId, emp.firstName, emp.lastName,
                   ct.status, ct.id, ct.kind
              FROM CrmTask ct
              LEFT JOIN Customer cu ON cu.id = ct.customerId
              LEFT JOIN Employee emp ON emp.id = ct.assigneeEmployeeId
             WHERE ct.tenantId = ${tenantId}`,
        Prisma.sql`
            SELECT 'MAIL', m.id, m.sentAt, COALESCE(m.subject, ''), COALESCE(m.fromName, m.fromAddress, ''),
                   m.customerId, cu.companyName, m.employeeId, emp.firstName, emp.lastName,
                   m.direction, m.id, m.origin
              FROM MailMessage m
              LEFT JOIN Customer cu ON cu.id = m.customerId
              LEFT JOIN Employee emp ON emp.id = m.employeeId
             WHERE m.tenantId = ${tenantId} AND m.deletedAt IS NULL`,
        Prisma.sql`
            SELECT 'CONTACT', cc.id, cc.occurredAt, LEFT(cc.note, 300), COALESCE(cu.companyName, ''),
                   cc.customerId, cu.companyName, cc.createdByEmployeeId, emp.firstName, emp.lastName,
                   cc.channel, cc.id, cc.channel
              FROM CrmCommunication cc
              JOIN Customer cu ON cu.id = cc.customerId
              LEFT JOIN Employee emp ON emp.id = cc.createdByEmployeeId
             WHERE cc.tenantId = ${tenantId}`,
    ];
    const unionSql = Prisma.join(branches, ' UNION ALL ');
    const feed = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT u.* FROM (${unionSql}) u ORDER BY u.occurredAt DESC, u.id DESC LIMIT 8 OFFSET 0`);
    console.log('Aktivitaeten:', feed.length, 'Zeilen');
    for (const row of feed) console.log('  ', row.kind, String(row.title || '').slice(0, 42), '|', row.statusText);

    const countRows = await prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
        SELECT COUNT(*) AS total FROM (${unionSql}) u`);
    console.log('Aktivitaeten gesamt:', Number(countRows[0]?.total ?? 0));

    const since = new Date(); since.setHours(0, 0, 0, 0);
    const statRows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT
          (SELECT COUNT(*) FROM Enquiry e WHERE e.tenantId = ${tenantId} AND e.createdAt >= ${since}) AS enquiries,
          (SELECT COUNT(*) FROM Tender t WHERE t.tenantId = ${tenantId} AND t.createdAt >= ${since}) AS quotes,
          (SELECT COUNT(*) FROM SalesOrder so WHERE so.tenantId = ${tenantId} AND so.createdAt >= ${since}) AS orders,
          (SELECT COUNT(*) FROM CrmTask ct WHERE ct.tenantId = ${tenantId} AND ct.createdAt >= ${since}) AS tasks,
          (SELECT COUNT(*) FROM MailMessage m WHERE m.tenantId = ${tenantId} AND m.deletedAt IS NULL AND m.sentAt >= ${since}) AS mails,
          (SELECT COUNT(*) FROM CrmCommunication cc WHERE cc.tenantId = ${tenantId} AND cc.occurredAt >= ${since}) AS contacts`);
    console.log('Heute:', JSON.stringify(statRows[0], (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));

    // ── 5. Aufraeumen
    await prisma.enquiry.delete({ where: { id } });
    console.log('Testanfrage entfernt.');
    await prisma.$disconnect();
})().catch(async (error) => {
    console.error('FEHLER:', error);
    await prisma.$disconnect();
    process.exit(1);
});
