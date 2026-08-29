import { Router } from "express";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middlewares/AuthMiddleware";
import { requirePermission } from "../middlewares/RbacMiddleware";
import prisma from "../../infrastructure/database/prisma.client";

/* AKTIVITAETEN (10.09.2026, Vorgabe Samet) — «alles, was auf einem Datensatz
   passiert ist», in EINER Zeitleiste.

   ABGRENZUNG ZUM INTERAKTIONSVERLAUF (/crm/interactions): dort stehen KONTAKTE
   mit Kunden — Anrufe, Mails, Besprechungen, Notizen. Hier steht, was IM HAUS
   geschah: eine Anfrage kam herein, ein Angebot ging raus, ein Auftrag wurde
   erfasst, eine Aufgabe wurde erledigt. Der Verlauf beantwortet «was haben wir
   mit diesem Kunden besprochen», die Aktivitaeten «was ist passiert».

   Deshalb ist das hier eine EIGENE Abfrage und keine Fassung der bestehenden:
   sie zieht auch Zeilen OHNE Kunden (eine Anfrage aus dem Formular hat noch
   keinen) und laesst Notizen weg, die keine Handlung sind.

   BAUART wie /crm/interactions: ein UNION ALL ueber die Quellen, aussen einmal
   sortiert und geschnitten, Seite und Zaehlung parallel. Jede Quelle liefert
   dieselben Spalten, damit keine Nachlade-Runde noetig ist. */

const router = Router();

const READ = requirePermission("crm.customers.view");

/** Welche Quellen es gibt — der Filter der Leiste waehlt daraus. */
const KINDS = ["ENQUIRY", "QUOTE", "ORDER", "TASK", "MAIL", "CONTACT"] as const;
type Kind = (typeof KINDS)[number];
const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value);

const parsePage = (req: { query: Record<string, unknown> }) => {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || "30"), 10) || 30));
    return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

const parseDate = (raw: unknown): Date | null => {
    if (!raw) return null;
    const date = new Date(String(raw));
    return Number.isNaN(date.getTime()) ? null : date;
};

const personOrNull = (id: unknown, first: unknown, last: unknown) =>
    id ? { id: String(id), firstName: String(first ?? ""), lastName: String(last ?? "") } : null;

/** Beginn des heutigen Tages in der Zeit des Servers — der Zaehler «heute». */
const startOfToday = () => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
};

/**
 * GET /crm/activities — die Zeitleiste.
 *
 * Filter: kind (eine der Quellen), customerId, employeeId, from/to, search.
 * Antwort: `data` absteigend (das Neueste zuoberst — anders als der Verlauf,
 * der von unten waechst: hier liest man von oben, wie in einer Meldungsliste).
 */
router.get("/activities", requireAuth, READ, async (req, res) => {
    try {
        const user = req.user!;
        const tenantId = user.tenantId;
        const { page, pageSize, skip, take } = parsePage(req);
        const kindRaw = String(req.query.kind || "").trim().toUpperCase();
        const kind = isKind(kindRaw) ? kindRaw : "";
        const customerId = String(req.query.customerId || "").trim();
        const employeeId = String(req.query.employeeId || "").trim();
        const search = String(req.query.search || "").trim();
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);
        const like = search ? `%${search}%` : "";

        /* Jeder Zweig traegt dieselben Spalten:
             kind | id | occurredAt | title | detail | customerId | customerName
             | employeeId | firstName | lastName | statusText | linkId
           `linkId` ist die Kennung, mit der die Oberflaeche springt (Angebot,
           Auftrag, Anfrage, Aufgabe); `statusText` faerbt die Zeile. */
        const branch = (wanted: Kind, sql: Prisma.Sql): Prisma.Sql[] =>
            (!kind || kind === wanted) ? [sql] : [];

        const enquiryWhere: Prisma.Sql[] = [Prisma.sql`e.tenantId = ${tenantId}`];
        if (customerId) enquiryWhere.push(Prisma.sql`e.customerId = ${customerId}`);
        if (employeeId) enquiryWhere.push(Prisma.sql`e.createdByEmployeeId = ${employeeId}`);
        if (from) enquiryWhere.push(Prisma.sql`e.createdAt >= ${from}`);
        if (to) enquiryWhere.push(Prisma.sql`e.createdAt <= ${to}`);
        if (search) enquiryWhere.push(Prisma.sql`(e.subject LIKE ${like} OR e.companyName LIKE ${like} OR e.email LIKE ${like})`);

        const quoteWhere: Prisma.Sql[] = [Prisma.sql`t.tenantId = ${tenantId}`];
        if (customerId) quoteWhere.push(Prisma.sql`t.customerId = ${customerId}`);
        if (from) quoteWhere.push(Prisma.sql`t.createdAt >= ${from}`);
        if (to) quoteWhere.push(Prisma.sql`t.createdAt <= ${to}`);
        if (employeeId) quoteWhere.push(Prisma.sql`1 = 0`); // Angebote tragen keine erfassende Person
        if (search) quoteWhere.push(Prisma.sql`(t.tenderNumber LIKE ${like} OR cu.companyName LIKE ${like})`);

        const orderWhere: Prisma.Sql[] = [Prisma.sql`so.tenantId = ${tenantId}`];
        if (customerId) orderWhere.push(Prisma.sql`so.customerId = ${customerId}`);
        if (employeeId) orderWhere.push(Prisma.sql`so.createdByEmployeeId = ${employeeId}`);
        if (from) orderWhere.push(Prisma.sql`so.createdAt >= ${from}`);
        if (to) orderWhere.push(Prisma.sql`so.createdAt <= ${to}`);
        if (search) orderWhere.push(Prisma.sql`(so.orderNumber LIKE ${like} OR cu.companyName LIKE ${like})`);

        const taskWhere: Prisma.Sql[] = [Prisma.sql`ct.tenantId = ${tenantId}`];
        if (customerId) taskWhere.push(Prisma.sql`ct.customerId = ${customerId}`);
        if (employeeId) taskWhere.push(Prisma.sql`(ct.assigneeEmployeeId = ${employeeId} OR ct.createdByEmployeeId = ${employeeId})`);
        if (from) taskWhere.push(Prisma.sql`ct.createdAt >= ${from}`);
        if (to) taskWhere.push(Prisma.sql`ct.createdAt <= ${to}`);
        if (search) taskWhere.push(Prisma.sql`ct.title LIKE ${like}`);

        const mailWhere: Prisma.Sql[] = [Prisma.sql`m.tenantId = ${tenantId}`, Prisma.sql`m.deletedAt IS NULL`];
        if (customerId) mailWhere.push(Prisma.sql`m.customerId = ${customerId}`);
        if (employeeId) mailWhere.push(Prisma.sql`m.employeeId = ${employeeId}`);
        if (from) mailWhere.push(Prisma.sql`m.sentAt >= ${from}`);
        if (to) mailWhere.push(Prisma.sql`m.sentAt <= ${to}`);
        if (search) mailWhere.push(Prisma.sql`(m.subject LIKE ${like} OR m.fromAddress LIKE ${like})`);

        const contactWhere: Prisma.Sql[] = [Prisma.sql`cc.tenantId = ${tenantId}`];
        if (customerId) contactWhere.push(Prisma.sql`cc.customerId = ${customerId}`);
        if (employeeId) contactWhere.push(Prisma.sql`cc.createdByEmployeeId = ${employeeId}`);
        if (from) contactWhere.push(Prisma.sql`cc.occurredAt >= ${from}`);
        if (to) contactWhere.push(Prisma.sql`cc.occurredAt <= ${to}`);
        if (search) contactWhere.push(Prisma.sql`(cc.note LIKE ${like} OR cu.companyName LIKE ${like})`);

        const branches: Prisma.Sql[] = [
            ...branch("ENQUIRY", Prisma.sql`
                SELECT 'ENQUIRY' AS kind, e.id AS id, e.createdAt AS occurredAt,
                       e.subject AS title,
                       COALESCE(e.companyName, e.contactName, e.email) AS detail,
                       e.customerId AS customerId, cu.companyName AS customerName,
                       e.createdByEmployeeId AS employeeId, emp.firstName AS firstName, emp.lastName AS lastName,
                       e.status AS statusText, e.id AS linkId, e.source AS variant
                  FROM Enquiry e
                  LEFT JOIN Customer cu ON cu.id = e.customerId
                  LEFT JOIN Employee emp ON emp.id = e.createdByEmployeeId
                 WHERE ${Prisma.join(enquiryWhere, " AND ")}`),
            ...branch("QUOTE", Prisma.sql`
                SELECT 'QUOTE', t.id, t.createdAt,
                       t.tenderNumber,
                       COALESCE(cu.companyName, ''),
                       t.customerId, cu.companyName,
                       NULL, NULL, NULL,
                       t.status, t.id, NULL
                  FROM Tender t
                  LEFT JOIN Customer cu ON cu.id = t.customerId
                 WHERE ${Prisma.join(quoteWhere, " AND ")}`),
            ...branch("ORDER", Prisma.sql`
                SELECT 'ORDER', so.id, so.createdAt,
                       so.orderNumber,
                       COALESCE(cu.companyName, ''),
                       so.customerId, cu.companyName,
                       so.createdByEmployeeId, emp.firstName, emp.lastName,
                       so.status, so.id, NULL
                  FROM SalesOrder so
                  LEFT JOIN Customer cu ON cu.id = so.customerId
                  LEFT JOIN Employee emp ON emp.id = so.createdByEmployeeId
                 WHERE ${Prisma.join(orderWhere, " AND ")}`),
            ...branch("TASK", Prisma.sql`
                SELECT 'TASK', ct.id, ct.createdAt,
                       ct.title,
                       COALESCE(cu.companyName, ''),
                       ct.customerId, cu.companyName,
                       ct.assigneeEmployeeId, emp.firstName, emp.lastName,
                       ct.status, ct.id, ct.kind
                  FROM CrmTask ct
                  LEFT JOIN Customer cu ON cu.id = ct.customerId
                  LEFT JOIN Employee emp ON emp.id = ct.assigneeEmployeeId
                 WHERE ${Prisma.join(taskWhere, " AND ")}`),
            ...branch("MAIL", Prisma.sql`
                SELECT 'MAIL', m.id, m.sentAt,
                       COALESCE(m.subject, ''),
                       COALESCE(m.fromName, m.fromAddress, ''),
                       m.customerId, cu.companyName,
                       m.employeeId, emp.firstName, emp.lastName,
                       m.direction, m.id, m.origin
                  FROM MailMessage m
                  LEFT JOIN Customer cu ON cu.id = m.customerId
                  LEFT JOIN Employee emp ON emp.id = m.employeeId
                 WHERE ${Prisma.join(mailWhere, " AND ")}`),
            ...branch("CONTACT", Prisma.sql`
                SELECT 'CONTACT', cc.id, cc.occurredAt,
                       LEFT(cc.note, 300),
                       COALESCE(cu.companyName, ''),
                       cc.customerId, cu.companyName,
                       cc.createdByEmployeeId, emp.firstName, emp.lastName,
                       cc.channel, cc.id, cc.channel
                  FROM CrmCommunication cc
                  JOIN Customer cu ON cu.id = cc.customerId
                  LEFT JOIN Employee emp ON emp.id = cc.createdByEmployeeId
                 WHERE ${Prisma.join(contactWhere, " AND ")}`),
        ];

        if (!branches.length) {
            return res.json({ data: [], total: 0, page, pageSize, totalPages: 1 });
        }
        const unionSql = Prisma.join(branches, " UNION ALL ");

        const [rows, countRows] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT u.* FROM (${unionSql}) u
                 ORDER BY u.occurredAt DESC, u.id DESC
                 LIMIT ${take} OFFSET ${skip}
            `),
            prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
                SELECT COUNT(*) AS total FROM (${unionSql}) u
            `),
        ]);

        const total = Number(countRows[0]?.total ?? 0);
        res.json({
            data: rows.map((row) => ({
                key: `${row.kind}:${row.id}`,
                kind: row.kind,
                id: row.id,
                occurredAt: row.occurredAt,
                title: row.title ?? "",
                detail: row.detail ?? "",
                statusText: row.statusText ?? null,
                variant: row.variant ?? null,
                linkId: row.linkId ?? null,
                customer: row.customerId ? { id: row.customerId, companyName: row.customerName ?? null } : null,
                employee: personOrNull(row.employeeId, row.firstName, row.lastName),
            })),
            total,
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
        });
    } catch (error: any) {
        res.status(400).json({ error: error?.message || "Aktivitaeten konnten nicht geladen werden." });
    }
});

/**
 * GET /crm/activities/stats — was HEUTE geschehen ist, je Quelle.
 * Der Menuepunkt traegt die Summe als Zahl; die Kacheln ueber der Liste die
 * Aufschluesselung. EINE Abfrage: fuenf Zaehlungen in einer Zeile.
 */
router.get("/activities/stats", requireAuth, READ, async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const since = startOfToday();
        const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
            SELECT
              (SELECT COUNT(*) FROM Enquiry e WHERE e.tenantId = ${tenantId} AND e.createdAt >= ${since}) AS enquiries,
              (SELECT COUNT(*) FROM Tender t WHERE t.tenantId = ${tenantId} AND t.createdAt >= ${since}) AS quotes,
              (SELECT COUNT(*) FROM SalesOrder so WHERE so.tenantId = ${tenantId} AND so.createdAt >= ${since}) AS orders,
              (SELECT COUNT(*) FROM CrmTask ct WHERE ct.tenantId = ${tenantId} AND ct.createdAt >= ${since}) AS tasks,
              (SELECT COUNT(*) FROM MailMessage m WHERE m.tenantId = ${tenantId} AND m.deletedAt IS NULL AND m.sentAt >= ${since}) AS mails,
              (SELECT COUNT(*) FROM CrmCommunication cc WHERE cc.tenantId = ${tenantId} AND cc.occurredAt >= ${since}) AS contacts
        `);
        const row = rows[0] || {};
        const byKind = {
            ENQUIRY: Number(row.enquiries ?? 0),
            QUOTE: Number(row.quotes ?? 0),
            ORDER: Number(row.orders ?? 0),
            TASK: Number(row.tasks ?? 0),
            MAIL: Number(row.mails ?? 0),
            CONTACT: Number(row.contacts ?? 0),
        };
        res.json({
            byKind,
            today: Object.values(byKind).reduce((sum, value) => sum + value, 0),
        });
    } catch (error: any) {
        res.status(400).json({ error: error?.message });
    }
});

export default router;
