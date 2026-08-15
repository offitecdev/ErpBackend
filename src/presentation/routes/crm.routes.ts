import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import prisma from '../../infrastructure/database/prisma.client';
import { flipOverdueTasks } from '../../infrastructure/services/crmTaskMaintenance';

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

const router = Router();

/** JSON-Spalten kommen aus $queryRaw je nach Treiber als String oder Objekt. */
const parseJson = (value: unknown): unknown => {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
};

const COMMUNICATION_CHANNELS = new Set(['PHONE', 'EMAIL', 'MEETING', 'NOTE']);
// OPEN | DONE | INCOMPLETE ("Nicht erledigt" — per X-Knopf oder automatisch,
// sobald der Termin einer offenen Aufgabe verstrichen ist).
const TASK_STATUSES = new Set(['OPEN', 'DONE', 'INCOMPLETE']);

/* Interaktionsverlauf — die Typen der vereinten Sicht. Die Kundenakte schreibt
   Besuche vor Ort (SiteVisit) als CustomerActivity; die anderen vier sind die
   Kanäle von CrmCommunication. */
const INTERACTION_TYPES = new Set(['PHONE', 'EMAIL', 'MEETING', 'NOTE', 'VISIT']);
/* Welche Aktivitätsarten der Kundenakte im Verlauf erscheinen — nur echte
   Kundenkontakte, keine Systemereignisse (Angebot erstellt/importiert/…).
   Verschickte Angebots-/Auftragsmails SIND ein Kontakt und zählen als E-Mail. */
const ACTIVITY_TYPE_TO_INTERACTION: Record<string, string> = {
    Call: 'PHONE',
    Email: 'EMAIL',
    Meeting: 'MEETING',
    SiteVisit: 'VISIT',
    OFFER_MAIL_SENT: 'EMAIL',
    ORDER_MAIL_SENT: 'EMAIL',
};

/* The write endpoints answer with the BARE row (no relation include). Every
   caller reloads the list right after saving, so hydrating customer/contact/
   employee here would only buy three extra round trips nobody reads. */

/* Eine geprüfte Zeile der Tabellen-Erfassung. `index` ist die Zeilennummer aus
   der Anfrage — sie geht bei einem Fehler zurück, damit die Oberfläche genau
   die Zeile markieren kann, an der es scheitert. */
interface BulkCommunicationEntry {
    index: number;
    customerId: string;
    contactId: string;
    channel: string;
    note: string;
    occurredAt: Date;
}

interface BulkTaskEntry {
    index: number;
    title: string;
    customerId: string;
    contactId: string;
    assigneeId: string;
    kind: string;
    dueDate: Date | null;
}

/** The joined person block used by the list rows; null when the id is unset. */
const personOrNull = (id: unknown, first: unknown, last: unknown) =>
    id ? { id: String(id), firstName: String(first ?? ''), lastName: String(last ?? '') } : null;

const parsePage = (req: { query: Record<string, unknown> }) => {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '25'), 10) || 25));
    return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

const parseDate = (raw: unknown): Date | null => {
    if (!raw) return null;
    const date = new Date(String(raw));
    return Number.isNaN(date.getTime()) ? null : date;
};

// ─────────────────────────── Contacts ───────────────────────────

// GET /crm/contacts?search=&customerId=&page=&pageSize= — tenant-wide list,
// served from the (tenantId, lastName, firstName) index with the company name
// joined in, so the page costs one round trip instead of one per relation.
router.get('/contacts', requireAuth, requirePermission('crm.customers.view'), async (req, res) => {
    try {
        const user = req.user!;
        const search = String(req.query.search || '').trim();
        const customerId = String(req.query.customerId || '').trim();
        const { page, pageSize, skip, take } = parsePage(req);

        const conditions: Prisma.Sql[] = [Prisma.sql`ct.tenantId = ${user.tenantId}`];
        if (customerId) conditions.push(Prisma.sql`ct.customerId = ${customerId}`);
        if (search) {
            const like = `%${search}%`;
            conditions.push(Prisma.sql`(ct.firstName LIKE ${like} OR ct.lastName LIKE ${like} OR ct.email LIKE ${like} OR cu.companyName LIKE ${like})`);
        }
        const whereSql = Prisma.join(conditions, ' AND ');

        const [rows, countRows] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT ct.id, ct.customerId, ct.firstName, ct.lastName, ct.title,
                       ct.phone, ct.mobilePhone, ct.email, ct.isPrimaryContact,
                       cu.companyName AS customerName
                FROM CustomerContact ct
                JOIN Customer cu ON cu.id = ct.customerId
                WHERE ${whereSql}
                ORDER BY ct.lastName ASC, ct.firstName ASC
                LIMIT ${take} OFFSET ${skip}
            `),
            prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
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
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// ─────────────────── Communication history ───────────────────

// GET /crm/communications?customerId=&channel=&employeeId=&from=&to=&page=&pageSize=
router.get('/communications', requireAuth, requirePermission('crm.customers.view'), async (req, res) => {
    try {
        const user = req.user!;
        const customerId = String(req.query.customerId || '').trim();
        const channel = String(req.query.channel || '').trim().toUpperCase();
        const employeeId = String(req.query.employeeId || '').trim();
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);
        const { page, pageSize, skip, take } = parsePage(req);

        const conditions: Prisma.Sql[] = [Prisma.sql`cc.tenantId = ${user.tenantId}`];
        if (customerId) conditions.push(Prisma.sql`cc.customerId = ${customerId}`);
        if (COMMUNICATION_CHANNELS.has(channel)) conditions.push(Prisma.sql`cc.channel = ${channel}`);
        if (employeeId) conditions.push(Prisma.sql`cc.createdByEmployeeId = ${employeeId}`);
        if (from) conditions.push(Prisma.sql`cc.occurredAt >= ${from}`);
        if (to) conditions.push(Prisma.sql`cc.occurredAt <= ${to}`);
        const whereSql = Prisma.join(conditions, ' AND ');

        const [rows, countRows] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
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
            prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
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
    } catch (error: any) {
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
router.get('/interactions', requireAuth, requirePermission('crm.customers.view'), async (req, res) => {
    try {
        const user = req.user!;
        const customerId = String(req.query.customerId || '').trim();
        const type = String(req.query.type || '').trim().toUpperCase();
        const typeFilter = INTERACTION_TYPES.has(type) ? type : '';
        const employeeId = String(req.query.employeeId || '').trim();
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to);
        const { page, pageSize, skip, take } = parsePage(req);

        // Zweig 1 — CrmCommunication
        const commWhere: Prisma.Sql[] = [Prisma.sql`cc.tenantId = ${user.tenantId}`];
        if (customerId) commWhere.push(Prisma.sql`cc.customerId = ${customerId}`);
        if (typeFilter) commWhere.push(typeFilter === 'VISIT' ? Prisma.sql`1 = 0` : Prisma.sql`cc.channel = ${typeFilter}`);
        if (employeeId) commWhere.push(Prisma.sql`cc.createdByEmployeeId = ${employeeId}`);
        if (from) commWhere.push(Prisma.sql`cc.occurredAt >= ${from}`);
        if (to) commWhere.push(Prisma.sql`cc.occurredAt <= ${to}`);

        // Zweig 2 — CustomerNote (kein tenantId an der Notiz: über den Kunden)
        const noteWhere: Prisma.Sql[] = [Prisma.sql`cu.tenantId = ${user.tenantId}`];
        if (customerId) noteWhere.push(Prisma.sql`cn.customerId = ${customerId}`);
        if (typeFilter && typeFilter !== 'NOTE') noteWhere.push(Prisma.sql`1 = 0`);
        if (employeeId) noteWhere.push(Prisma.sql`cn.createdByEmployeeId = ${employeeId}`);
        if (from) noteWhere.push(Prisma.sql`cn.createdAt >= ${from}`);
        if (to) noteWhere.push(Prisma.sql`cn.createdAt <= ${to}`);

        // Zweig 3 — CustomerActivity (nur Kundenkontakte)
        const activityTypes = Object.entries(ACTIVITY_TYPE_TO_INTERACTION)
            .filter(([, interaction]) => !typeFilter || interaction === typeFilter)
            .map(([activityType]) => activityType);
        const actWhere: Prisma.Sql[] = [Prisma.sql`cu.tenantId = ${user.tenantId}`];
        actWhere.push(activityTypes.length
            ? Prisma.sql`ca.activityType IN (${Prisma.join(activityTypes)})`
            : Prisma.sql`1 = 0`);
        if (customerId) actWhere.push(Prisma.sql`ca.customerId = ${customerId}`);
        if (employeeId) actWhere.push(Prisma.sql`ca.employeeId = ${employeeId}`);
        if (from) actWhere.push(Prisma.sql`ca.activityDate >= ${from}`);
        if (to) actWhere.push(Prisma.sql`ca.activityDate <= ${to}`);

        const activityTypeCase = Prisma.sql`CASE ca.activityType ${Prisma.join(
            Object.entries(ACTIVITY_TYPE_TO_INTERACTION).map(([raw, interaction]) => Prisma.sql`WHEN ${raw} THEN ${interaction}`),
            ' ',
        )} ELSE 'NOTE' END`;

        const unionSql = Prisma.sql`
            SELECT 'COMMUNICATION' AS source, cc.id AS id, cc.customerId AS customerId, cu.companyName AS customerName,
                   cc.contactId AS contactId, ct.firstName AS contactFirstName, ct.lastName AS contactLastName,
                   cc.channel AS type, cc.note AS note, cc.occurredAt AS occurredAt,
                   cc.createdByEmployeeId AS employeeId, e.firstName AS byFirstName, e.lastName AS byLastName,
                   0 AS isHighlight, NULL AS rawType
              FROM CrmCommunication cc
              JOIN Customer cu ON cu.id = cc.customerId
              LEFT JOIN CustomerContact ct ON ct.id = cc.contactId
              LEFT JOIN Employee e ON e.id = cc.createdByEmployeeId
             WHERE ${Prisma.join(commWhere, ' AND ')}
            UNION ALL
            SELECT 'CUSTOMER_NOTE', cn.id, cn.customerId, cu.companyName,
                   NULL, NULL, NULL,
                   'NOTE', cn.noteText, cn.createdAt,
                   cn.createdByEmployeeId, e.firstName, e.lastName,
                   cn.isHighlight, cn.noteType
              FROM CustomerNote cn
              JOIN Customer cu ON cu.id = cn.customerId
              LEFT JOIN Employee e ON e.id = cn.createdByEmployeeId
             WHERE ${Prisma.join(noteWhere, ' AND ')}
            UNION ALL
            SELECT 'ACTIVITY', ca.id, ca.customerId, cu.companyName,
                   NULL, NULL, NULL,
                   ${activityTypeCase}, ca.description, ca.activityDate,
                   ca.employeeId, e.firstName, e.lastName,
                   0, ca.activityType
              FROM CustomerActivity ca
              JOIN Customer cu ON cu.id = ca.customerId
              LEFT JOIN Employee e ON e.id = ca.employeeId
             WHERE ${Prisma.join(actWhere, ' AND ')}
        `;

        /* Reihenfolge (Vorgabe 15.08.2026: "der neueste Eintrag steht ganz
           unten"): geblättert wird weiter vom NEUESTEN weg (Seite 1 = die
           jüngsten Einträge), INNERHALB der Seite stehen sie aber aufsteigend,
           also der jüngste zuunterst. Genau dafür die zweistufige Abfrage:
           innen absteigend schneiden, aussen aufsteigend sortieren. */
        const [rows, countRows] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT p.* FROM (
                    SELECT u.* FROM (${unionSql}) u
                    ORDER BY u.occurredAt DESC, u.id DESC
                    LIMIT ${take} OFFSET ${skip}
                ) p
                ORDER BY p.occurredAt ASC, p.id ASC
            `),
            prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
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
        }));
        res.status(200).json({ data, total: Number(countRows[0]?.total ?? 0), page, pageSize });
    } catch (error: any) {
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
router.post('/communications/bulk', requireAuth, requirePermission('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user!;
        const rawEntries = Array.isArray(req.body?.entries) ? req.body.entries : [];
        if (rawEntries.length === 0) return res.status(400).json({ error: 'Keine Zeilen übergeben.' });
        if (rawEntries.length > 200) return res.status(400).json({ error: 'Höchstens 200 Zeilen pro Speicherung.' });

        const entries: BulkCommunicationEntry[] = rawEntries.map((row: any, index: number) => ({
            index,
            customerId: String(row?.customerId || '').trim(),
            contactId: String(row?.contactId || '').trim(),
            channel: String(row?.channel || '').trim().toUpperCase(),
            note: String(row?.note || '').trim(),
            occurredAt: parseDate(row?.occurredAt) || new Date(),
        }));

        const errors: Array<{ index: number; error: string }> = [];
        const fail = (entry: BulkCommunicationEntry, error: string) => errors.push({ index: entry.index, error });

        const customerIds = [...new Set(entries.map((entry) => entry.customerId).filter(Boolean))];
        const contactIds = [...new Set(entries.map((entry) => entry.contactId).filter(Boolean))];
        const [customers, contacts] = await Promise.all([
            prisma.customer.findMany({
                where: { id: { in: customerIds }, tenantId: user.tenantId },
                select: { id: true },
            }),
            contactIds.length
                ? prisma.customerContact.findMany({
                      where: { id: { in: contactIds }, tenantId: user.tenantId },
                      select: { id: true, customerId: true },
                  })
                : Promise.resolve([] as Array<{ id: string; customerId: string }>),
        ]);
        const allowedCustomers = new Set(customers.map((customer) => customer.id));
        const contactOwner = new Map(contacts.map((contact) => [contact.id, contact.customerId]));

        const valid = entries.filter((entry) => {
            if (!entry.customerId) { fail(entry, 'Kunde fehlt.'); return false; }
            if (!COMMUNICATION_CHANNELS.has(entry.channel)) { fail(entry, 'Ungültiger Typ.'); return false; }
            if (!entry.note) { fail(entry, 'Notiz fehlt.'); return false; }
            if (!allowedCustomers.has(entry.customerId)) { fail(entry, 'Kunde nicht gefunden.'); return false; }
            if (entry.contactId && contactOwner.get(entry.contactId) !== entry.customerId) {
                fail(entry, 'Ansprechpartner gehört nicht zu diesem Kunden.');
                return false;
            }
            return true;
        });

        const result = valid.length
            ? await prisma.crmCommunication.createMany({
                  data: valid.map((entry) => ({
                      id: nanoid(12),
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
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// POST /crm/communications — { customerId, contactId?, channel, note, occurredAt? }
router.post('/communications', requireAuth, requirePermission('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user!;
        const customerId = String(req.body?.customerId || '').trim();
        const contactId = String(req.body?.contactId || '').trim();
        const channel = String(req.body?.channel || '').trim().toUpperCase();
        const note = String(req.body?.note || '').trim();
        if (!customerId) return res.status(400).json({ error: 'customerId gerekli.' });
        if (!COMMUNICATION_CHANNELS.has(channel)) {
            return res.status(400).json({ error: 'channel PHONE, EMAIL, MEETING oder NOTE olmalıdır.' });
        }
        if (!note) return res.status(400).json({ error: 'Notiz gerekli.' });
        const occurredAt = parseDate(req.body?.occurredAt) || new Date();

        const [customer, contact] = await Promise.all([
            prisma.customer.findFirst({ where: { id: customerId, tenantId: user.tenantId }, select: { id: true } }),
            contactId
                ? prisma.customerContact.findFirst({ where: { id: contactId, customerId }, select: { id: true } })
                : Promise.resolve(null),
        ]);
        if (!customer) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
        if (contactId && !contact) return res.status(400).json({ error: 'Ansprechpartner gehört nicht zu diesem Kunden.' });

        const created = await prisma.crmCommunication.create({
            data: {
                id: nanoid(12),
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
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// PATCH /crm/communications/:id — partial update (channel, note, occurredAt, contactId).
router.patch('/communications/:id', requireAuth, requirePermission('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user!;
        const existing = await prisma.crmCommunication.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
            select: { id: true, customerId: true },
        });
        if (!existing) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });

        const data: Record<string, unknown> = {};
        if (req.body?.channel !== undefined) {
            const channel = String(req.body.channel).trim().toUpperCase();
            if (!COMMUNICATION_CHANNELS.has(channel)) return res.status(400).json({ error: 'Ungültiger Typ.' });
            data.channel = channel;
        }
        if (req.body?.note !== undefined) {
            const note = String(req.body.note).trim();
            if (!note) return res.status(400).json({ error: 'Notiz gerekli.' });
            data.note = note;
        }
        if (req.body?.occurredAt !== undefined) {
            const occurredAt = parseDate(req.body.occurredAt);
            if (!occurredAt) return res.status(400).json({ error: 'Ungültiges Datum.' });
            data.occurredAt = occurredAt;
        }
        if (req.body?.contactId !== undefined) {
            const contactId = String(req.body.contactId || '').trim();
            if (contactId) {
                const contact = await prisma.customerContact.findFirst({
                    where: { id: contactId, customerId: existing.customerId },
                    select: { id: true },
                });
                if (!contact) return res.status(400).json({ error: 'Ansprechpartner gehört nicht zu diesem Kunden.' });
            }
            data.contactId = contactId || null;
        }

        const updated = await prisma.crmCommunication.update({
            where: { id: existing.id },
            data,

        });
        res.status(200).json(updated);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// DELETE /crm/communications/:id
router.delete('/communications/:id', requireAuth, requirePermission('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user!;
        const existing = await prisma.crmCommunication.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
            select: { id: true },
        });
        if (!existing) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
        await prisma.crmCommunication.delete({ where: { id: existing.id } });
        res.status(200).json({ message: 'Eintrag gelöscht.' });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// ─────────────────────────── Reminders ───────────────────────────

/**
 * GET /crm/reminders/due — fällige Erinnerungen für die angemeldete Person.
 *
 * Der Wecker der Oberfläche fragt das im Minutentakt, deshalb ist es bewusst
 * die kleinstmögliche Abfrage: EIN Statement, nur die Zeilen, die gerade
 * wirklich dran sind, gedeckelt auf 20. "Für mich" heisst zugewiesen ODER
 * selbst erfasst und niemandem zugewiesen — sonst hätte eine Erinnerung ohne
 * Verantwortliche gar keinen Empfänger.
 *
 * Auth-only (kein requirePermission): es sind die eigenen Erinnerungen, und
 * ein Wecker, der an fehlenden Rechten scheitert, fällt lautlos aus.
 */
router.get('/reminders/due', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
            SELECT tk.id, tk.title, tk.dueDate, tk.customerId, tk.linkUrl, tk.meta,
                   cu.companyName AS customerName
            FROM CrmTask tk
            LEFT JOIN Customer cu ON cu.id = tk.customerId
            WHERE tk.tenantId = ${user.tenantId}
              AND tk.kind = 'REMINDER'
              AND tk.status = 'OPEN'
              AND tk.notifiedAt IS NULL
              AND tk.dueDate IS NOT NULL
              AND tk.dueDate <= NOW(3)
              AND (tk.assigneeEmployeeId = ${user.id}
                   OR (tk.assigneeEmployeeId IS NULL AND tk.createdByEmployeeId = ${user.id}))
            ORDER BY tk.dueDate ASC
            LIMIT 20
        `);

        res.status(200).json(rows.map((row) => ({
            id: row.id,
            title: row.title,
            dueDate: row.dueDate,
            customerId: row.customerId ?? null,
            customerName: row.customerName ?? null,
            linkUrl: row.linkUrl ?? null,
            meta: parseJson(row.meta),
        })));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /crm/reminders/ack — { ids: [] }. Stempelt die gezeigten Erinnerungen,
 * damit sie beim nächsten Takt nicht erneut aufpoppen. Die Oberfläche ruft das
 * SOFORT beim Einblenden auf, nicht erst beim Wegklicken: sonst zeigt ein
 * zweiter Browser-Tab dieselbe Erinnerung ein zweites Mal.
 */
router.post('/reminders/ack', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const ids = Array.isArray(req.body?.ids)
            ? req.body.ids.map((id: unknown) => String(id || '').trim()).filter(Boolean)
            : [];
        if (ids.length === 0) return res.status(200).json({ acknowledged: 0 });

        const result = await prisma.crmTask.updateMany({
            where: { id: { in: ids }, tenantId: user.tenantId, kind: 'REMINDER', notifiedAt: null },
            data: { notifiedAt: new Date() },
        });
        res.status(200).json({ acknowledged: result.count });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /crm/reminders/dismiss — { ids: [] }. Schliesst Erinnerungen ENDGÜLTIG
 * (Vorgabe 15.08.2026): eine geschlossene Erinnerung ist gelöscht, sie kommt
 * weder im Fenster noch in der Liste wieder. Auth-only wie /due und /ack — das
 * X am Einblendfenster muss auch ohne CRM-Rechte funktionieren; dafür nur die
 * EIGENEN Erinnerungen (zugewiesen oder selbst erfasst).
 */
router.post('/reminders/dismiss', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const ids = Array.isArray(req.body?.ids)
            ? req.body.ids.map((id: unknown) => String(id || '').trim()).filter(Boolean)
            : [];
        if (ids.length === 0) return res.status(200).json({ dismissed: 0 });

        const result = await prisma.crmTask.deleteMany({
            where: {
                id: { in: ids },
                tenantId: user.tenantId,
                kind: 'REMINDER',
                OR: [{ assigneeEmployeeId: user.id }, { createdByEmployeeId: user.id }],
            },
        });
        res.status(200).json({ dismissed: result.count });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// ─────────────────────── Tasks & reminders ───────────────────────

// GET /crm/tasks?status=&customerId=&assigneeId=&kind=&page=&pageSize=
router.get('/tasks', requireAuth, requirePermission('crm.customers.view'), async (req, res) => {
    try {
        const user = req.user!;
        const status = String(req.query.status || '').trim().toUpperCase();
        const kind = String(req.query.kind || '').trim().toUpperCase();
        const customerId = String(req.query.customerId || '').trim();
        const assigneeId = String(req.query.assigneeId || '').trim();
        const { page, pageSize, skip, take } = parsePage(req);

        const conditions: Prisma.Sql[] = [Prisma.sql`tk.tenantId = ${user.tenantId}`];
        if (TASK_STATUSES.has(status)) conditions.push(Prisma.sql`tk.status = ${status}`);
        if (kind === 'TASK' || kind === 'REMINDER') conditions.push(Prisma.sql`tk.kind = ${kind}`);
        if (customerId) conditions.push(Prisma.sql`tk.customerId = ${customerId}`);
        if (assigneeId) conditions.push(Prisma.sql`tk.assigneeEmployeeId = ${assigneeId}`);
        const whereSql = Prisma.join(conditions, ' AND ');

        // Verstrichene offene Aufgaben zuerst auf "Nicht erledigt" kippen, damit
        // die Liste den Stand von JETZT zeigt und nicht den des letzten Takts des
        // Hintergrunddienstes. Nur wenn Aufgaben überhaupt gefragt sind.
        if (kind !== 'REMINDER' && status !== 'DONE') await flipOverdueTasks(user.tenantId);

        const [rows, countRows] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT tk.id, tk.kind, tk.title, tk.customerId, tk.contactId, tk.assigneeEmployeeId,
                       tk.dueDate, tk.status, tk.completedAt, tk.createdByEmployeeId, tk.createdAt,
                       tk.linkUrl, tk.meta, tk.entityType, tk.entityId,
                       cu.companyName AS customerName,
                       ct.firstName AS contactFirstName, ct.lastName AS contactLastName,
                       a.firstName AS assigneeFirstName, a.lastName AS assigneeLastName,
                       e.firstName AS byFirstName, e.lastName AS byLastName
                FROM CrmTask tk
                LEFT JOIN Customer cu ON cu.id = tk.customerId
                LEFT JOIN CustomerContact ct ON ct.id = tk.contactId
                LEFT JOIN Employee a ON a.id = tk.assigneeEmployeeId
                JOIN Employee e ON e.id = tk.createdByEmployeeId
                WHERE ${whereSql}
                -- Reihenfolge (Vorgabe 15.08.2026): offene Arbeit zuerst
                -- (OPEN < INCOMPLETE < DONE — nach Sinn, nicht nach Alphabet),
                -- und INNERHALB einer Gruppe chronologisch: der zuletzt
                -- angelegte Eintrag steht ZUUNTERST. Der Termin sortiert
                -- bewusst NICHT mehr — verstrichene Aufgaben rutschen ohnehin
                -- in die Gruppe "Nicht erledigt", und die Spalte "Fällig"
                -- steht daneben.
                ORDER BY FIELD(tk.status, 'OPEN', 'INCOMPLETE', 'DONE') ASC,
                         tk.createdAt ASC, tk.id ASC
                LIMIT ${take} OFFSET ${skip}
            `),
            prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
                SELECT COUNT(*) AS total FROM CrmTask tk WHERE ${whereSql}
            `),
        ]);

        const data = rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            title: row.title,
            customerId: row.customerId ?? null,
            contactId: row.contactId ?? null,
            assigneeEmployeeId: row.assigneeEmployeeId ?? null,
            dueDate: row.dueDate ?? null,
            status: row.status,
            completedAt: row.completedAt ?? null,
            createdAt: row.createdAt,
            linkUrl: row.linkUrl ?? null,
            meta: parseJson(row.meta),
            entityType: row.entityType ?? null,
            entityId: row.entityId ?? null,
            customer: row.customerId ? { id: row.customerId, companyName: row.customerName } : null,
            contact: personOrNull(row.contactId, row.contactFirstName, row.contactLastName),
            assignee: personOrNull(row.assigneeEmployeeId, row.assigneeFirstName, row.assigneeLastName),
            createdBy: personOrNull(row.createdByEmployeeId, row.byFirstName, row.byLastName),
        }));
        res.status(200).json({ data, total: Number(countRows[0]?.total ?? 0), page, pageSize });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /crm/tasks/bulk — { entries: [{ title, customerId?, assigneeEmployeeId?, dueDate?, kind? }] }
 *
 * Gleiche Bauart wie /communications/bulk: feste Anzahl Prüfabfragen (Kunden
 * und Verantwortliche je einmal gesammelt), ein createMany, alles oder nichts.
 */
router.post('/tasks/bulk', requireAuth, requirePermission('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user!;
        const rawEntries = Array.isArray(req.body?.entries) ? req.body.entries : [];
        if (rawEntries.length === 0) return res.status(400).json({ error: 'Keine Zeilen übergeben.' });
        if (rawEntries.length > 200) return res.status(400).json({ error: 'Höchstens 200 Zeilen pro Speicherung.' });

        const entries: BulkTaskEntry[] = rawEntries.map((row: any, index: number) => ({
            index,
            title: String(row?.title || '').trim(),
            customerId: String(row?.customerId || '').trim(),
            contactId: String(row?.contactId || '').trim(),
            assigneeId: String(row?.assigneeEmployeeId || '').trim(),
            kind: row?.kind === 'REMINDER' ? 'REMINDER' : 'TASK',
            dueDate: parseDate(row?.dueDate),
        }));

        const errors: Array<{ index: number; error: string }> = [];
        const fail = (entry: BulkTaskEntry, error: string) => errors.push({ index: entry.index, error });

        const customerIds = [...new Set(entries.map((entry) => entry.customerId).filter(Boolean))];
        const contactIds = [...new Set(entries.map((entry) => entry.contactId).filter(Boolean))];
        const assigneeIds = [...new Set(entries.map((entry) => entry.assigneeId).filter(Boolean))];
        const [customers, contacts, assignees] = await Promise.all([
            customerIds.length
                ? prisma.customer.findMany({
                      where: { id: { in: customerIds }, tenantId: user.tenantId },
                      select: { id: true },
                  })
                : Promise.resolve([] as Array<{ id: string }>),
            contactIds.length
                ? prisma.customerContact.findMany({
                      where: { id: { in: contactIds }, tenantId: user.tenantId },
                      select: { id: true, customerId: true },
                  })
                : Promise.resolve([] as Array<{ id: string; customerId: string }>),
            assigneeIds.length
                ? prisma.employee.findMany({ where: { id: { in: assigneeIds } }, select: { id: true } })
                : Promise.resolve([] as Array<{ id: string }>),
        ]);
        const allowedCustomers = new Set(customers.map((customer) => customer.id));
        const contactOwner = new Map(contacts.map((contact) => [contact.id, contact.customerId]));
        const allowedAssignees = new Set(assignees.map((assignee) => assignee.id));

        const valid = entries.filter((entry) => {
            if (!entry.title) { fail(entry, 'Titel fehlt.'); return false; }
            if (entry.customerId && !allowedCustomers.has(entry.customerId)) {
                fail(entry, 'Kunde nicht gefunden.');
                return false;
            }
            if (entry.contactId && (!entry.customerId || contactOwner.get(entry.contactId) !== entry.customerId)) {
                fail(entry, 'Ansprechpartner gehört nicht zu diesem Kunden.');
                return false;
            }
            if (entry.assigneeId && !allowedAssignees.has(entry.assigneeId)) {
                fail(entry, 'Verantwortliche Person nicht gefunden.');
                return false;
            }
            return true;
        });

        const result = valid.length
            ? await prisma.crmTask.createMany({
                  data: valid.map((entry) => ({
                      id: nanoid(12),
                      tenantId: user.tenantId,
                      kind: entry.kind,
                      title: entry.title,
                      customerId: entry.customerId || null,
                      contactId: entry.contactId || null,
                      assigneeEmployeeId: entry.assigneeId || null,
                      dueDate: entry.dueDate,
                      createdByEmployeeId: user.id,
                  })),
              })
            : { count: 0 };
        res.status(201).json({ createdCount: result.count, errors });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// POST /crm/tasks — { title, customerId?, contactId?, assigneeEmployeeId?, dueDate?, kind? }
router.post('/tasks', requireAuth, requirePermission('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user!;
        const title = String(req.body?.title || '').trim();
        if (!title) return res.status(400).json({ error: 'Titel gerekli.' });
        const customerId = String(req.body?.customerId || '').trim();
        const contactId = String(req.body?.contactId || '').trim();
        const assigneeId = String(req.body?.assigneeEmployeeId || '').trim();
        const kind = req.body?.kind === 'REMINDER' ? 'REMINDER' : 'TASK';
        const dueDate = parseDate(req.body?.dueDate);

        const [customer, contact, assignee] = await Promise.all([
            customerId
                ? prisma.customer.findFirst({ where: { id: customerId, tenantId: user.tenantId }, select: { id: true } })
                : Promise.resolve(null),
            contactId && customerId
                ? prisma.customerContact.findFirst({ where: { id: contactId, customerId }, select: { id: true } })
                : Promise.resolve(null),
            assigneeId
                ? prisma.employee.findUnique({ where: { id: assigneeId }, select: { id: true, tenantId: true } })
                : Promise.resolve(null),
        ]);
        if (customerId && !customer) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
        if (contactId && !contact) return res.status(400).json({ error: 'Ansprechpartner gehört nicht zu diesem Kunden.' });
        if (assigneeId && !assignee) return res.status(400).json({ error: 'Verantwortliche Person nicht gefunden.' });

        const created = await prisma.crmTask.create({
            data: {
                id: nanoid(12),
                tenantId: user.tenantId,
                kind,
                title,
                customerId: customer ? customerId : null,
                contactId: contact ? contactId : null,
                assigneeEmployeeId: assignee ? assigneeId : null,
                dueDate,
                createdByEmployeeId: user.id,
            },

        });
        res.status(201).json(created);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// PATCH /crm/tasks/:id — partial update; status DONE stamps completedAt.
router.patch('/tasks/:id', requireAuth, requirePermission('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user!;
        const existing = await prisma.crmTask.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
            select: { id: true, status: true, customerId: true },
        });
        if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });

        const data: Record<string, unknown> = {};
        if (req.body?.title !== undefined) {
            const title = String(req.body.title).trim();
            if (!title) return res.status(400).json({ error: 'Titel gerekli.' });
            data.title = title;
        }
        if (req.body?.kind !== undefined) data.kind = req.body.kind === 'REMINDER' ? 'REMINDER' : 'TASK';
        if (req.body?.dueDate !== undefined) data.dueDate = parseDate(req.body.dueDate);
        if (req.body?.customerId !== undefined) {
            const customerId = String(req.body.customerId || '').trim();
            if (customerId) {
                const customer = await prisma.customer.findFirst({
                    where: { id: customerId, tenantId: user.tenantId },
                    select: { id: true },
                });
                if (!customer) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }
            data.customerId = customerId || null;
            // Ein Kundenwechsel löst den Ansprechpartner — er gehört zum alten Kunden.
            if (customerId !== existing.customerId) data.contactId = null;
        }
        if (req.body?.contactId !== undefined) {
            const contactId = String(req.body.contactId || '').trim();
            const ownerId = (data.customerId as string | null | undefined) ?? existing.customerId;
            if (contactId) {
                const contact = ownerId
                    ? await prisma.customerContact.findFirst({ where: { id: contactId, customerId: ownerId }, select: { id: true } })
                    : null;
                if (!contact) return res.status(400).json({ error: 'Ansprechpartner gehört nicht zu diesem Kunden.' });
            }
            data.contactId = contactId || null;
        }
        if (req.body?.assigneeEmployeeId !== undefined) {
            const assigneeId = String(req.body.assigneeEmployeeId || '').trim();
            if (assigneeId) {
                const assignee = await prisma.employee.findUnique({ where: { id: assigneeId }, select: { id: true } });
                if (!assignee) return res.status(400).json({ error: 'Verantwortliche Person nicht gefunden.' });
            }
            data.assigneeEmployeeId = assigneeId || null;
        }
        if (req.body?.status !== undefined) {
            const status = String(req.body.status).trim().toUpperCase();
            if (!TASK_STATUSES.has(status)) return res.status(400).json({ error: 'Status OPEN, DONE oder INCOMPLETE olmalıdır.' });
            data.status = status;
            data.completedAt = status === 'DONE' ? new Date() : null;
        }

        const updated = await prisma.crmTask.update({ where: { id: existing.id }, data });
        res.status(200).json(updated);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// DELETE /crm/tasks/:id
router.delete('/tasks/:id', requireAuth, requirePermission('crm.activities.create'), async (req, res) => {
    try {
        const user = req.user!;
        const existing = await prisma.crmTask.findFirst({
            where: { id: String(req.params.id || ''), tenantId: user.tenantId },
            select: { id: true },
        });
        if (!existing) return res.status(404).json({ error: 'Aufgabe nicht gefunden.' });
        await prisma.crmTask.delete({ where: { id: existing.id } });
        res.status(200).json({ message: 'Aufgabe gelöscht.' });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
