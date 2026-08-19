"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
/* CRM v2 surfaces: tenant-wide contact list (Ansprechpartner), unified
   communication history (phone/e-mail/meeting/note) and tasks & reminders.
   Tenant scoping matches the rest of the CRM module (exact tenantId, like
   /customers and /meetings). Permission keys are the existing CRM ones on
   purpose — a brand-new key would be unassigned on existing roles and 403
   for everyone (see dashboard.routes.ts).

   PERFORMANCE — why the lists are raw SQL and not findMany+include:
   the database is remote, so the cost is not the weight of a query but the
   number of SEQUENTIAL round trips (~60-100 ms each). Prisma resolves every
   `include`/nested `select` relation with its OWN follow-up statement, so the
   communication list alone cost five trips (rows + count + customer + contact +
   employee) and landed at 500-900 ms. Each list is now exactly TWO statements
   — the joined page and its count — issued in parallel, i.e. one round trip in
   practice. Same reasoning as TenderRepository.findLeanList. */
const router = (0, express_1.Router)();
/** JSON-Spalten kommen aus $queryRaw je nach Treiber als String oder Objekt. */
const parseJson = (value) => {
    if (value == null)
        return null;
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
};
const COMMUNICATION_CHANNELS = new Set(['PHONE', 'EMAIL', 'MEETING', 'NOTE']);
/* Interaktionsverlauf — die Typen der vereinten Sicht. Die Kundenakte schreibt
   Besuche vor Ort (SiteVisit) als CustomerActivity; die anderen vier sind die
   Kanäle von CrmCommunication. */
const INTERACTION_TYPES = new Set(['PHONE', 'EMAIL', 'MEETING', 'NOTE', 'VISIT']);
/* Welche Aktivitätsarten der Kundenakte im Verlauf erscheinen — nur echte
   Kundenkontakte, keine Systemereignisse (Angebot erstellt/importiert/…).
   Verschickte Angebots-/Auftragsmails SIND ein Kontakt und zählen als E-Mail. */
const ACTIVITY_TYPE_TO_INTERACTION = {
    Call: 'PHONE',
    Email: 'EMAIL',
    Meeting: 'MEETING',
    SiteVisit: 'VISIT',
    OFFER_MAIL_SENT: 'EMAIL',
    ORDER_MAIL_SENT: 'EMAIL',
};
/** The joined person block used by the list rows; null when the id is unset. */
const personOrNull = (id, first, last) => id ? { id: String(id), firstName: String(first ?? ''), lastName: String(last ?? '') } : null;
const parsePage = (req) => {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '25'), 10) || 25));
    return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};
const parseDate = (raw) => {
    if (!raw)
        return null;
    const date = new Date(String(raw));
    return Number.isNaN(date.getTime()) ? null : date;
};
// ─────────────────────────── Contacts ───────────────────────────
// GET /crm/contacts?search=&customerId=&page=&pageSize= — tenant-wide list,
// served from the (tenantId, lastName, firstName) index with the company name
// joined in, so the page costs one round trip instead of one per relation.
router.get('/contacts', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), async (req, res) => {
    try {
        const user = req.user;
        const search = String(req.query.search || '').trim();
        const customerId = String(req.query.customerId || '').trim();
        const { page, pageSize, skip, take } = parsePage(req);
        const conditions = [client_1.Prisma.sql `ct.tenantId = ${user.tenantId}`];
        if (customerId)
            conditions.push(client_1.Prisma.sql `ct.customerId = ${customerId}`);
        if (search) {
            const like = `%${search}%`;
            conditions.push(client_1.Prisma.sql `(ct.firstName LIKE ${like} OR ct.lastName LIKE ${like} OR ct.email LIKE ${like} OR cu.companyName LIKE ${like})`);
        }
        const whereSql = client_1.Prisma.join(conditions, ' AND ');
        const [rows, countRows] = await Promise.all([
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT ct.id, ct.customerId, ct.firstName, ct.lastName, ct.title,
                       ct.phone, ct.mobilePhone, ct.email, ct.isPrimaryContact,
                       cu.companyName AS customerName
                FROM CustomerContact ct
                JOIN Customer cu ON cu.id = ct.customerId
                WHERE ${whereSql}
                ORDER BY ct.lastName ASC, ct.firstName ASC
                LIMIT ${take} OFFSET ${skip}
            `),
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT COUNT(*) AS total
                FROM CustomerContact ct
                JOIN Customer cu ON cu.id = ct.customerId
                WHERE ${whereSql}
            `),
        ]);
        const data = rows.map((row) => ({
            id: row.id,
            customerId: row.customerId,
            firstName: row.firstName,
            lastName: row.lastName,
            title: row.title ?? null,
            phone: row.phone ?? null,
            mobilePhone: row.mobilePhone ?? null,
            email: row.email ?? null,
            // MySQL hands TINYINT(1) back as a number through the raw path.
            isPrimaryContact: Boolean(row.isPrimaryContact),
            customer: { id: row.customerId, companyName: row.customerName },
        }));
        res.status(200).json({ data, total: Number(countRows[0]?.total ?? 0), page, pageSize });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// ─────────────────── Communication history ───────────────────
// GET /crm/communications?customerId=&channel=&employeeId=&from=&to=&page=&pageSize=
router.get('/communications', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), async (req, res) => {
    try {
        const user = req.user;
        const customerId = String(req.query.customerId || '').trim();
        const channel = String(req.query.channel || '').trim().toUpperCase();
        const employeeId = String(req.query.employeeId || '').trim();
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);
        const { page, pageSize, skip, take } = parsePage(req);
        const conditions = [client_1.Prisma.sql `cc.tenantId = ${user.tenantId}`];
        if (customerId)
            conditions.push(client_1.Prisma.sql `cc.customerId = ${customerId}`);
        if (COMMUNICATION_CHANNELS.has(channel))
            conditions.push(client_1.Prisma.sql `cc.channel = ${channel}`);
        if (employeeId)
            conditions.push(client_1.Prisma.sql `cc.createdByEmployeeId = ${employeeId}`);
        if (from)
            conditions.push(client_1.Prisma.sql `cc.occurredAt >= ${from}`);
        if (to)
            conditions.push(client_1.Prisma.sql `cc.occurredAt <= ${to}`);
        const whereSql = client_1.Prisma.join(conditions, ' AND ');
        const [rows, countRows] = await Promise.all([
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT cc.id, cc.customerId, cc.contactId, cc.channel, cc.note,
                       cc.occurredAt, cc.createdByEmployeeId, cc.createdAt,
                       cu.companyName AS customerName,
                       ct.firstName AS contactFirstName, ct.lastName AS contactLastName,
                       e.firstName AS byFirstName, e.lastName AS byLastName
                FROM CrmCommunication cc
                JOIN Customer cu ON cu.id = cc.customerId
                LEFT JOIN CustomerContact ct ON ct.id = cc.contactId
                JOIN Employee e ON e.id = cc.createdByEmployeeId
                WHERE ${whereSql}
                ORDER BY cc.occurredAt DESC
                LIMIT ${take} OFFSET ${skip}
            `),
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT COUNT(*) AS total FROM CrmCommunication cc WHERE ${whereSql}
            `),
        ]);
        const data = rows.map((row) => ({
            id: row.id,
            customerId: row.customerId,
            contactId: row.contactId ?? null,
            channel: row.channel,
            note: row.note,
            occurredAt: row.occurredAt,
            createdByEmployeeId: row.createdByEmployeeId,
            createdAt: row.createdAt,
            customer: { id: row.customerId, companyName: row.customerName },
            contact: personOrNull(row.contactId, row.contactFirstName, row.contactLastName),
            createdBy: personOrNull(row.createdByEmployeeId, row.byFirstName, row.byLastName),
        }));
        res.status(200).json({ data, total: Number(countRows[0]?.total ?? 0), page, pageSize });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// ─────────────────── Interaction history (unified) ───────────────────
/**
 * GET /crm/interactions?customerId=&type=&employeeId=&from=&to=&page=&pageSize=
 *
 * DER Interaktionsverlauf (Vorgabe 15.08.2026): Telefonate, E-Mails,
 * Besprechungen, Notizen und Besuche aus ALLEN drei Quellen in einer Liste,
 * jede Zeile mit ihrem Typ beschriftet —
 *   • CrmCommunication  (Schnellerfassung / Verlaufsseite; Kanal = Typ)
 *   • CustomerNote      (Reiter "Notizen" der Kundenakte → Typ NOTE)
 *   • CustomerActivity  (Reiter "Aktivitäten" der Kundenakte; nur echte
 *                        Kundenkontakte, siehe ACTIVITY_TYPE_TO_INTERACTION)
 * Was in der Kundenakte erfasst wird, steht damit auch hier, und umgekehrt
 * zeigt die Kundenakte (Reiter Kommunikation) dieselbe Sicht auf den Kunden
 * gefiltert — nichts muss abgeglichen werden, es IST dieselbe Abfrage.
 *
 * `source` + `id` sagen der Oberfläche, wohin ein Löschen geht (die drei
 * Quellen behalten ihre eigenen Endpunkte und Rechte).
 *
 * Aufbau: drei Teilabfragen per UNION ALL, dann sortiert und geblättert. Die
 * Filter werden in JEDEN Zweig geschoben (nicht erst aussen angewandt), damit
 * jeder Zweig über seinen Index liest statt die ganze Tabelle zu liefern.
 * Zwei Statements (Seite + Zähler) parallel, wie die übrigen Listen hier.
 */
router.get('/interactions', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), async (req, res) => {
    try {
        const user = req.user;
        const customerId = String(req.query.customerId || '').trim();
        const type = String(req.query.type || '').trim().toUpperCase();
        const typeFilter = INTERACTION_TYPES.has(type) ? type : '';
        const employeeId = String(req.query.employeeId || '').trim();
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);
        const { page, pageSize, skip, take } = parsePage(req);
        // Zweig 1 — CrmCommunication
        const commWhere = [client_1.Prisma.sql `cc.tenantId = ${user.tenantId}`];
        if (customerId)
            commWhere.push(client_1.Prisma.sql `cc.customerId = ${customerId}`);
        if (typeFilter)
            commWhere.push(typeFilter === 'VISIT' ? client_1.Prisma.sql `1 = 0` : client_1.Prisma.sql `cc.channel = ${typeFilter}`);
        if (employeeId)
            commWhere.push(client_1.Prisma.sql `cc.createdByEmployeeId = ${employeeId}`);
        if (from)
            commWhere.push(client_1.Prisma.sql `cc.occurredAt >= ${from}`);
        if (to)
            commWhere.push(client_1.Prisma.sql `cc.occurredAt <= ${to}`);
        // Zweig 2 — CustomerNote (kein tenantId an der Notiz: über den Kunden)
        const noteWhere = [client_1.Prisma.sql `cu.tenantId = ${user.tenantId}`];
        if (customerId)
            noteWhere.push(client_1.Prisma.sql `cn.customerId = ${customerId}`);
        if (typeFilter && typeFilter !== 'NOTE')
            noteWhere.push(client_1.Prisma.sql `1 = 0`);
        if (employeeId)
            noteWhere.push(client_1.Prisma.sql `cn.createdByEmployeeId = ${employeeId}`);
        if (from)
            noteWhere.push(client_1.Prisma.sql `cn.createdAt >= ${from}`);
        if (to)
            noteWhere.push(client_1.Prisma.sql `cn.createdAt <= ${to}`);
        // Zweig 3 — CustomerActivity (nur Kundenkontakte)
        const activityTypes = Object.entries(ACTIVITY_TYPE_TO_INTERACTION)
            .filter(([, interaction]) => !typeFilter || interaction === typeFilter)
            .map(([activityType]) => activityType);
        const actWhere = [client_1.Prisma.sql `cu.tenantId = ${user.tenantId}`];
        actWhere.push(activityTypes.length
            ? client_1.Prisma.sql `ca.activityType IN (${client_1.Prisma.join(activityTypes)})`
            : client_1.Prisma.sql `1 = 0`);
        if (customerId)
            actWhere.push(client_1.Prisma.sql `ca.customerId = ${customerId}`);
        if (employeeId)
            actWhere.push(client_1.Prisma.sql `ca.employeeId = ${employeeId}`);
        if (from)
            actWhere.push(client_1.Prisma.sql `ca.activityDate >= ${from}`);
        if (to)
            actWhere.push(client_1.Prisma.sql `ca.activityDate <= ${to}`);
        // Angebots-/Auftragsmails, die seit der Outlook-Anbindung als MailMessage
        // festgehalten sind (activityId zeigt her), erscheinen nur einmal — als Mail.
        actWhere.push(client_1.Prisma.sql `NOT EXISTS (SELECT 1 FROM MailMessage mm WHERE mm.activityId = ca.id)`);
        // Zweig 4 — MailMessage (Outlook-Sync + ERP-Sendungen), nur mit Kundenbezug.
        // Betreff + Vorschau als "note"; die Direction/den Outlook-Link tragen die
        // Zusatzspalten, die die anderen Zweige mit NULL füllen.
        const mailWhere = [client_1.Prisma.sql `m.tenantId = ${user.tenantId}`, client_1.Prisma.sql `m.customerId IS NOT NULL`];
        if (customerId)
            mailWhere.push(client_1.Prisma.sql `m.customerId = ${customerId}`);
        if (typeFilter && typeFilter !== 'EMAIL')
            mailWhere.push(client_1.Prisma.sql `1 = 0`);
        if (employeeId)
            mailWhere.push(client_1.Prisma.sql `m.employeeId = ${employeeId}`);
        if (from)
            mailWhere.push(client_1.Prisma.sql `m.sentAt >= ${from}`);
        if (to)
            mailWhere.push(client_1.Prisma.sql `m.sentAt <= ${to}`);
        const activityTypeCase = client_1.Prisma.sql `CASE ca.activityType ${client_1.Prisma.join(Object.entries(ACTIVITY_TYPE_TO_INTERACTION).map(([raw, interaction]) => client_1.Prisma.sql `WHEN ${raw} THEN ${interaction}`), ' ')} ELSE 'NOTE' END`;
        const unionSql = client_1.Prisma.sql `
            SELECT 'COMMUNICATION' AS source, cc.id AS id, cc.customerId AS customerId, cu.companyName AS customerName,
                   cc.contactId AS contactId, ct.firstName AS contactFirstName, ct.lastName AS contactLastName,
                   cc.channel AS type, cc.note AS note, cc.occurredAt AS occurredAt,
                   cc.createdByEmployeeId AS employeeId, e.firstName AS byFirstName, e.lastName AS byLastName,
                   0 AS isHighlight, NULL AS rawType,
                   NULL AS mailSubject, NULL AS mailDirection, NULL AS mailFrom, NULL AS mailHasWebLink, NULL AS mailEntityLabel
              FROM CrmCommunication cc
              JOIN Customer cu ON cu.id = cc.customerId
              LEFT JOIN CustomerContact ct ON ct.id = cc.contactId
              LEFT JOIN Employee e ON e.id = cc.createdByEmployeeId
             WHERE ${client_1.Prisma.join(commWhere, ' AND ')}
            UNION ALL
            SELECT 'CUSTOMER_NOTE', cn.id, cn.customerId, cu.companyName,
                   NULL, NULL, NULL,
                   'NOTE', cn.noteText, cn.createdAt,
                   cn.createdByEmployeeId, e.firstName, e.lastName,
                   cn.isHighlight, cn.noteType,
                   NULL, NULL, NULL, NULL, NULL
              FROM CustomerNote cn
              JOIN Customer cu ON cu.id = cn.customerId
              LEFT JOIN Employee e ON e.id = cn.createdByEmployeeId
             WHERE ${client_1.Prisma.join(noteWhere, ' AND ')}
            UNION ALL
            SELECT 'ACTIVITY', ca.id, ca.customerId, cu.companyName,
                   NULL, NULL, NULL,
                   ${activityTypeCase}, ca.description, ca.activityDate,
                   ca.employeeId, e.firstName, e.lastName,
                   0, ca.activityType,
                   NULL, NULL, NULL, NULL, NULL
              FROM CustomerActivity ca
              JOIN Customer cu ON cu.id = ca.customerId
              LEFT JOIN Employee e ON e.id = ca.employeeId
             WHERE ${client_1.Prisma.join(actWhere, ' AND ')}
            UNION ALL
            SELECT 'MAIL', m.id, m.customerId, cu.companyName,
                   m.contactId, ct.firstName, ct.lastName,
                   'EMAIL', COALESCE(m.bodyPreview, ''), m.sentAt,
                   m.employeeId, e.firstName, e.lastName,
                   0, m.origin,
                   m.subject, m.direction, COALESCE(m.fromName, m.fromAddress), (m.webLink IS NOT NULL), m.entityLabel
              FROM MailMessage m
              JOIN Customer cu ON cu.id = m.customerId
              LEFT JOIN CustomerContact ct ON ct.id = m.contactId
              LEFT JOIN Employee e ON e.id = m.employeeId
             WHERE ${client_1.Prisma.join(mailWhere, ' AND ')}
        `;
        /* Reihenfolge (Vorgabe 15.08.2026: "der neueste Eintrag steht ganz
           unten"): geblättert wird weiter vom NEUESTEN weg (Seite 1 = die
           jüngsten Einträge), INNERHALB der Seite stehen sie aber aufsteigend,
           also der jüngste zuunterst. Genau dafür die zweistufige Abfrage:
           innen absteigend schneiden, aussen aufsteigend sortieren. */
        const [rows, countRows] = await Promise.all([
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT p.* FROM (
                    SELECT u.* FROM (${unionSql}) u
                    ORDER BY u.occurredAt DESC, u.id DESC
                    LIMIT ${take} OFFSET ${skip}
                ) p
                ORDER BY p.occurredAt ASC, p.id ASC
            `),
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT COUNT(*) AS total FROM (${unionSql}) u
            `),
        ]);
        const data = rows.map((row) => ({
            key: `${row.source}:${row.id}`,
            source: row.source,
            id: row.id,
            customerId: row.customerId,
            type: row.type,
            note: row.note ?? '',
            occurredAt: row.occurredAt,
            isHighlight: Boolean(Number(row.isHighlight ?? 0)),
            rawType: row.rawType ?? null,
            customer: { id: row.customerId, companyName: row.customerName },
            contact: personOrNull(row.contactId, row.contactFirstName, row.contactLastName),
            createdBy: personOrNull(row.employeeId, row.byFirstName, row.byLastName),
            mail: row.source === 'MAIL' ? {
                subject: row.mailSubject ?? null,
                direction: row.mailDirection ?? null,
                from: row.mailFrom ?? null,
                hasWebLink: Boolean(Number(row.mailHasWebLink ?? 0)),
                entityLabel: row.mailEntityLabel ?? null,
            } : null,
        }));
        res.status(200).json({ data, total: Number(countRows[0]?.total ?? 0), page, pageSize });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * POST /crm/communications/bulk — { entries: [{ customerId, contactId?, channel, note, occurredAt? }] }
 *
 * Die Tabellen-Erfassung schickt ALLE Zeilen auf einmal. Die Prüfung kostet
 * dabei eine feste Anzahl Anfragen, NICHT eine pro Zeile: die vorkommenden
 * Kunden- und Ansprechpartner-Ids werden einmal gesammelt und in je einer
 * Abfrage geholt, danach folgt ein einziges createMany. Zwanzig Zeilen kosten
 * damit genauso viele Runden wie eine.
 *
 * Teilerfolg wie bei den Lager-Massenanlagen: gültige Zeilen werden
 * geschrieben, fehlerhafte kommen als `errors: [{ index, error }]` zurück —
 * `index` ist die Zeilennummer aus der Anfrage, damit die Oberfläche genau
 * die betroffene Zeile stehen lassen und markieren kann.
 */
router.post('/communications/bulk', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user;
        const rawEntries = Array.isArray(req.body?.entries) ? req.body.entries : [];
        if (rawEntries.length === 0)
            return res.status(400).json({ error: 'Keine Zeilen übergeben.' });
        if (rawEntries.length > 200)
            return res.status(400).json({ error: 'Höchstens 200 Zeilen pro Speicherung.' });
        const entries = rawEntries.map((row, index) => ({
            index,
            customerId: String(row?.customerId || '').trim(),
            contactId: String(row?.contactId || '').trim(),
            channel: String(row?.channel || '').trim().toUpperCase(),
            note: String(row?.note || '').trim(),
            occurredAt: parseDate(row?.occurredAt) || new Date(),
        }));
        const errors = [];
        const fail = (entry, error) => errors.push({ index: entry.index, error });
        const customerIds = [...new Set(entries.map((entry) => entry.customerId).filter(Boolean))];
        const contactIds = [...new Set(entries.map((entry) => entry.contactId).filter(Boolean))];
        const [customers, contacts] = await Promise.all([
            prisma_client_1.default.customer.findMany({
                where: { id: { in: customerIds }, tenantId: user.tenantId },
                select: { id: true },
            }),
            contactIds.length
                ? prisma_client_1.default.customerContact.findMany({
                    where: { id: { in: contactIds }, tenantId: user.tenantId },
                    select: { id: true, customerId: true },
                })
                : Promise.resolve([]),
        ]);
        const allowedCustomers = new Set(customers.map((customer) => customer.id));
        const contactOwner = new Map(contacts.map((contact) => [contact.id, contact.customerId]));
        const valid = entries.filter((entry) => {
            if (!entry.customerId) {
                fail(entry, 'Kunde fehlt.');
                return false;
            }
            if (!COMMUNICATION_CHANNELS.has(entry.channel)) {
                fail(entry, 'Ungültiger Typ.');
                return false;
            }
            if (!entry.note) {
                fail(entry, 'Notiz fehlt.');
                return false;
            }
            if (!allowedCustomers.has(entry.customerId)) {
                fail(entry, 'Kunde nicht gefunden.');
                return false;
            }
            if (entry.contactId && contactOwner.get(entry.contactId) !== entry.customerId) {
                fail(entry, 'Ansprechpartner gehört nicht zu diesem Kunden.');
                return false;
            }
            return true;
        });
        const result = valid.length
            ? await prisma_client_1.default.crmCommunication.createMany({
                data: valid.map((entry) => ({
                    id: (0, nanoid_1.nanoid)(12),
                    tenantId: user.tenantId,
                    customerId: entry.customerId,
                    contactId: entry.contactId || null,
                    channel: entry.channel,
                    note: entry.note,
                    occurredAt: entry.occurredAt,
                    createdByEmployeeId: user.id,
                })),
            })
            : { count: 0 };
        res.status(201).json({ createdCount: result.count, errors });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// POST /crm/communications — { customerId, contactId?, channel, note, occurredAt? }
router.post('/communications', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user;
        const customerId = String(req.body?.customerId || '').trim();
        const contactId = String(req.body?.contactId || '').trim();
        const channel = String(req.body?.channel || '').trim().toUpperCase();
        const note = String(req.body?.note || '').trim();
        if (!customerId)
            return res.status(400).json({ error: 'customerId gerekli.' });
        if (!COMMUNICATION_CHANNELS.has(channel)) {
            return res.status(400).json({ error: 'channel PHONE, EMAIL, MEETING oder NOTE olmalıdır.' });
        }
        if (!note)
            return res.status(400).json({ error: 'Notiz gerekli.' });
        const occurredAt = parseDate(req.body?.occurredAt) || new Date();
        const [customer, contact] = await Promise.all([
            prisma_client_1.default.customer.findFirst({ where: { id: customerId, tenantId: user.tenantId }, select: { id: true } }),
            contactId
                ? prisma_client_1.default.customerContact.findFirst({ where: { id: contactId, customerId }, select: { id: true } })
                : Promise.resolve(null),
        ]);
        if (!customer)
            return res.status(404).json({ error: 'Müşteri bulunamadı.' });
        if (contactId && !contact)
            return res.status(400).json({ error: 'Ansprechpartner gehört nicht zu diesem Kunden.' });
        const created = await prisma_client_1.default.crmCommunication.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId: user.tenantId,
                customerId,
                contactId: contact ? contactId : null,
                channel,
                note,
                occurredAt,
                createdByEmployeeId: user.id,
            },
        });
        res.status(201).json(created);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// PATCH /crm/communications/:id — partial update (channel, note, occurredAt, contactId).
router.patch('/communications/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user;
        const existing = await prisma_client_1.default.crmCommunication.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
            select: { id: true, customerId: true },
        });
        if (!existing)
            return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
        const data = {};
        if (req.body?.channel !== undefined) {
            const channel = String(req.body.channel).trim().toUpperCase();
            if (!COMMUNICATION_CHANNELS.has(channel))
                return res.status(400).json({ error: 'Ungültiger Typ.' });
            data.channel = channel;
        }
        if (req.body?.note !== undefined) {
            const note = String(req.body.note).trim();
            if (!note)
                return res.status(400).json({ error: 'Notiz gerekli.' });
            data.note = note;
        }
        if (req.body?.occurredAt !== undefined) {
            const occurredAt = parseDate(req.body.occurredAt);
            if (!occurredAt)
                return res.status(400).json({ error: 'Ungültiges Datum.' });
            data.occurredAt = occurredAt;
        }
        if (req.body?.contactId !== undefined) {
            const contactId = String(req.body.contactId || '').trim();
            if (contactId) {
                const contact = await prisma_client_1.default.customerContact.findFirst({
                    where: { id: contactId, customerId: existing.customerId },
                    select: { id: true },
                });
                if (!contact)
                    return res.status(400).json({ error: 'Ansprechpartner gehört nicht zu diesem Kunden.' });
            }
            data.contactId = contactId || null;
        }
        const updated = await prisma_client_1.default.crmCommunication.update({
            where: { id: existing.id },
            data,
        });
        res.status(200).json(updated);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// DELETE /crm/communications/:id
router.delete('/communications/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user;
        const existing = await prisma_client_1.default.crmCommunication.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
            select: { id: true },
        });
        if (!existing)
            return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
        await prisma_client_1.default.crmCommunication.delete({ where: { id: existing.id } });
        res.status(200).json({ message: 'Eintrag gelöscht.' });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/* Aufgaben & Erinnerungen: siehe crmTask.routes.ts (gleicher /crm-Pfad). */
exports.default = router;
//# sourceMappingURL=crm.routes.js.map