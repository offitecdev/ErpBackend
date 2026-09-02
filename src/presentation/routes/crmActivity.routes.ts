import { Router } from "express";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middlewares/AuthMiddleware";
import { requirePermission } from "../middlewares/RbacMiddleware";
import prisma from "../../infrastructure/database/prisma.client";
import { getMailTenantId } from "../controllers/serviceTenantScope";
import { currentMailboxIdentity } from "../../infrastructure/services/mailboxIdentity";

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

   POST MIT KUNDENBEZUG (Vorgabe Samet, 01.09.2026 nachgeschaerft): die Quelle
   MAIL zieht NICHT das ganze Firmenpostfach, sondern die Nachrichten, die zu
   einem Kunden gehoeren — die Zuordnung der Nachricht selbst (`customerId`,
   vom Abruf ueber Adresse/Domain gesetzt oder von Hand gewaehlt) ODER das
   Etikett einer Kundenkategorie. Alles andere — Newsletter, Rundschreiben,
   Post von Lieferanten — ist zwar Post, aber kein Vorgang auf einem Datensatz
   des Hauses und haette die Zeitleiste nur zugeschuettet.

   BIS ZUM 01.09.2026 ZAEHLTE ALLEIN DAS ETIKETT — und weil im Haus keine
   einzige Kundenkategorie angelegt war, blieb der Reiter «E-Mail» LEER,
   obwohl der Abruf laengst Post von Kunden erkannt hatte. Das Etikett ist
   eine Ordnung von Hand; die Kundenpost darf nicht davon abhaengen, dass
   jemand sie vorher einsortiert.

   BESPRECHUNGEN (01.09.2026, Vorgabe Samet): eine Besprechung ist ebenfalls
   ein Vorgang und steht darum als eigene Quelle in der Leiste. Ihr Zeitpunkt
   ist der TERMIN (startTime), nicht die Erfassung — eine Besprechung von
   morgen steht deshalb ueber dem heutigen Tag. Wer sie sehen darf, entscheidet
   dieselbe Regel wie im Kalender (meeting.routes.ts, visibleMeetingWhere).

   BAUART wie /crm/interactions: ein UNION ALL ueber die Quellen, aussen einmal
   sortiert und geschnitten, Seite und Zaehlung parallel. Jede Quelle liefert
   dieselben Spalten, damit keine Nachlade-Runde noetig ist. */

const router = Router();

const READ = requirePermission("crm.customers.view");

/** Welche Quellen es gibt — der Filter der Leiste waehlt daraus. */
const KINDS = ["ENQUIRY", "QUOTE", "ORDER", "TASK", "MAIL", "MEETING", "CONTACT"] as const;
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

/** Ende des heutigen Tages — Besprechungen zaehlen nach ihrem TERMIN, und
    ohne obere Schranke stuende jede kuenftige Besprechung unter «heute». */
const startOfTomorrow = () => {
    const date = startOfToday();
    date.setDate(date.getDate() + 1);
    return date;
};

/**
 * WER WELCHE BESPRECHUNG SIEHT — dieselbe Regel wie im Kalender
 * (meeting.routes.ts, `visibleMeetingWhere`), hier in SQL:
 *   • im ERP angelegt        → gehoert der FIRMA (tenantId, ohne Herkunft),
 *   • von aussen uebernommen → gehoert der PERSON, die als Teilnehmerin darin
 *     steht (ihre Kennung bleibt ueber einen Firmenwechsel gleich),
 *   • an niemanden persoenlich adressiert → gehoert dem POSTFACH, also allen,
 *     die auf dem heute eingerichteten Konto sitzen.
 *
 * Zwei Regeln nachzubauen, die auseinanderlaufen koennen, ist nichts Gutes —
 * hier geht es aber nicht anders: die Zeitleiste ist EIN UNION und kann keinen
 * Prisma-Filter aufnehmen. Aendert sich die Regel dort, gehoert sie hier
 * nachgezogen; darum steht sie an EINER Stelle und nicht zweimal (Liste und
 * Zaehlung teilen sie sich).
 */
const meetingVisibilitySql = async (tenantId: string, employeeId: string): Promise<Prisma.Sql> => {
    const parts: Prisma.Sql[] = [
        Prisma.sql`(ma.tenantId = ${tenantId} AND ma.externalOrigin IS NULL)`,
        Prisma.sql`(ma.externalOrigin IS NOT NULL AND EXISTS (
            SELECT 1 FROM MeetingActivityParticipant mp
             WHERE mp.meetingId = ma.id AND mp.employeeId = ${employeeId}))`,
    ];
    const mailbox = await currentMailboxIdentity(tenantId).catch(() => "");
    if (mailbox) {
        parts.push(Prisma.sql`(ma.tenantId = ${await getMailTenantId(tenantId)}
            AND ma.externalMailbox = ${mailbox}
            AND ma.externalOrigin IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM MeetingActivityParticipant mp2
                 WHERE mp2.meetingId = ma.id AND mp2.participantType = 'EMPLOYEE'))`);
    }
    return Prisma.sql`(${Prisma.join(parts, " OR ")})`;
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

        /* NUR KUNDENPOST (Vorgabe Samet): in der Zeitleiste steht Post, die zu
           einem Kunden gehört — nicht das ganze Firmenpostfach. Ein
           Rundschreiben des Steuerberaters, der Newsletter eines Lieferanten,
           die Meldung der Bank: alles Post, aber nichts, was auf einem
           Datensatz des Hauses geschehen ist.

           ZWEI WEGE ZUM KUNDEN, und BEIDE zählen (01.09.2026): die Zuordnung
           an der Nachricht (`m.customerId` — der Abruf setzt sie über die
           Adresse des Kunden oder seines Ansprechpartners, siehe
           mailCustomerMatcher; von Hand gewählt zählt genauso) und das Etikett
           einer Kundenkategorie (`mc.entityId`). Vorher war das Etikett die
           EINZIGE Bedingung — und weil keines vergeben war, blieb der Reiter
           leer, obwohl 58 Nachrichten längst an einem Kunden hingen.

           Das Postfach hängt am Stamm des Firmenbaums, der Kunde an seiner
           Firma: gezeigt wird die Post DIESER Firma. */
        const mailWhere: Prisma.Sql[] = [
            Prisma.sql`m.tenantId = ${await getMailTenantId(tenantId)}`,
            Prisma.sql`cu.tenantId = ${tenantId}`,
            Prisma.sql`m.deletedAt IS NULL`,
        ];
        if (customerId) mailWhere.push(Prisma.sql`cu.id = ${customerId}`);
        if (employeeId) mailWhere.push(Prisma.sql`m.employeeId = ${employeeId}`);
        if (from) mailWhere.push(Prisma.sql`m.sentAt >= ${from}`);
        if (to) mailWhere.push(Prisma.sql`m.sentAt <= ${to}`);
        if (search) mailWhere.push(Prisma.sql`(m.subject LIKE ${like} OR m.fromAddress LIKE ${like})`);

        /* BESPRECHUNGEN — sichtbar nach derselben Regel wie im Kalender
           (`meetingVisibilitySql`). `kind` trennt sie von den Aufgaben, die in
           derselben Tabelle liegen und ihre eigene Quelle haben. */
        const meetingWhere: Prisma.Sql[] = [
            Prisma.sql`ma.kind = 'MEETING'`,
            await meetingVisibilitySql(tenantId, user.id),
        ];
        if (customerId) meetingWhere.push(Prisma.sql`ma.customerId = ${customerId}`);
        /* Die Person am Termin ist, wer ihn angelegt hat ODER darin sitzt —
           beim Kalender ist die Teilnahme die eigentliche Zugehörigkeit. */
        if (employeeId) meetingWhere.push(Prisma.sql`(ma.createdByEmployeeId = ${employeeId} OR EXISTS (
            SELECT 1 FROM MeetingActivityParticipant mp3
             WHERE mp3.meetingId = ma.id AND mp3.employeeId = ${employeeId}))`);
        if (from) meetingWhere.push(Prisma.sql`ma.startTime >= ${from}`);
        if (to) meetingWhere.push(Prisma.sql`ma.startTime <= ${to}`);
        if (search) meetingWhere.push(Prisma.sql`(ma.title LIKE ${like} OR ma.notes LIKE ${like} OR cu.companyName LIKE ${like})`);

        const contactWhere: Prisma.Sql[] = [Prisma.sql`cc.tenantId = ${tenantId}`];
        if (customerId) contactWhere.push(Prisma.sql`cc.customerId = ${customerId}`);
        if (employeeId) contactWhere.push(Prisma.sql`cc.createdByEmployeeId = ${employeeId}`);
        if (from) contactWhere.push(Prisma.sql`cc.occurredAt >= ${from}`);
        if (to) contactWhere.push(Prisma.sql`cc.occurredAt <= ${to}`);
        if (search) contactWhere.push(Prisma.sql`(cc.note LIKE ${like} OR cu.companyName LIKE ${like})`);

        /* JEDER Zweig benennt seine Spalten selbst. Bei einem UNION nimmt die
           abgeleitete Tabelle die Namen des ERSTEN Zweigs — steht aber nur EIN
           Zweig da (die Leiste filtert auf eine Quelle), gelten seine eigenen.
           Ohne Namen hiessen dort zwei Spalten `id` (der Datensatz und sein
           Sprungziel), und die Abfrage bricht mit «Duplicate column name 'id'»:
           bis heute lief nur die Auswahl «Anfragen», weil allein ihr Zweig
           Namen trug. */
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
                SELECT 'QUOTE' AS kind, t.id AS id, t.createdAt AS occurredAt,
                       t.tenderNumber AS title,
                       COALESCE(cu.companyName, '') AS detail,
                       t.customerId AS customerId, cu.companyName AS customerName,
                       NULL AS employeeId, NULL AS firstName, NULL AS lastName,
                       t.status AS statusText, t.id AS linkId, NULL AS variant
                  FROM Tender t
                  LEFT JOIN Customer cu ON cu.id = t.customerId
                 WHERE ${Prisma.join(quoteWhere, " AND ")}`),
            ...branch("ORDER", Prisma.sql`
                SELECT 'ORDER' AS kind, so.id AS id, so.createdAt AS occurredAt,
                       so.orderNumber AS title,
                       COALESCE(cu.companyName, '') AS detail,
                       so.customerId AS customerId, cu.companyName AS customerName,
                       so.createdByEmployeeId AS employeeId, emp.firstName AS firstName, emp.lastName AS lastName,
                       so.status AS statusText, so.id AS linkId, NULL AS variant
                  FROM SalesOrder so
                  LEFT JOIN Customer cu ON cu.id = so.customerId
                  LEFT JOIN Employee emp ON emp.id = so.createdByEmployeeId
                 WHERE ${Prisma.join(orderWhere, " AND ")}`),
            ...branch("TASK", Prisma.sql`
                SELECT 'TASK' AS kind, ct.id AS id, ct.createdAt AS occurredAt,
                       ct.title AS title,
                       COALESCE(cu.companyName, '') AS detail,
                       ct.customerId AS customerId, cu.companyName AS customerName,
                       ct.assigneeEmployeeId AS employeeId, emp.firstName AS firstName, emp.lastName AS lastName,
                       ct.status AS statusText, ct.id AS linkId, ct.kind AS variant
                  FROM CrmTask ct
                  LEFT JOIN Customer cu ON cu.id = ct.customerId
                  LEFT JOIN Employee emp ON emp.id = ct.assigneeEmployeeId
                 WHERE ${Prisma.join(taskWhere, " AND ")}`),
            /* Der JOIN auf den Kunden ist die Schranke: eine Nachricht ohne
               Kundenbezug — weder an der Nachricht noch über ein Etikett —
               fällt aus der Zeitleiste. Die Kategorie kommt darum als LEFT
               JOIN dazu: sie darf den Kunden LIEFERN, aber nicht mehr über die
               Aufnahme entscheiden. `linkId` ist die Kennung der Nachricht —
               die Oberfläche springt damit auf /crm/mail?id=… und öffnet genau
               diese Mail. */
            ...branch("MAIL", Prisma.sql`
                SELECT 'MAIL' AS kind, m.id AS id, m.sentAt AS occurredAt,
                       COALESCE(m.subject, '') AS title,
                       COALESCE(m.fromName, m.fromAddress, '') AS detail,
                       cu.id AS customerId, cu.companyName AS customerName,
                       m.employeeId AS employeeId, emp.firstName AS firstName, emp.lastName AS lastName,
                       m.direction AS statusText, m.id AS linkId, m.origin AS variant
                  FROM MailMessage m
                  LEFT JOIN MailCategory mc ON mc.id = m.categoryId AND mc.kind = 'CUSTOMER'
                  JOIN Customer cu ON cu.id = COALESCE(m.customerId, mc.entityId)
                  LEFT JOIN Employee emp ON emp.id = m.employeeId
                 WHERE ${Prisma.join(mailWhere, " AND ")}`),
            /* Die Besprechung steht mit ihrem TERMIN in der Leiste, nicht mit
               ihrer Erfassung. `linkId` ist ihre Kennung — die Oberfläche
               springt damit in den Kalender auf den Tag des Termins und
               schlägt die Karte auf. */
            ...branch("MEETING", Prisma.sql`
                SELECT 'MEETING' AS kind, ma.id AS id, ma.startTime AS occurredAt,
                       ma.title AS title,
                       COALESCE(cu.companyName, ma.externalOrganizer, '') AS detail,
                       ma.customerId AS customerId, cu.companyName AS customerName,
                       ma.createdByEmployeeId AS employeeId, emp.firstName AS firstName, emp.lastName AS lastName,
                       CASE WHEN ma.startTime > NOW() THEN 'PLANNED' ELSE 'DONE' END AS statusText,
                       ma.id AS linkId, ma.externalOrigin AS variant
                  FROM MeetingActivity ma
                  LEFT JOIN Customer cu ON cu.id = ma.customerId
                  LEFT JOIN Employee emp ON emp.id = ma.createdByEmployeeId
                 WHERE ${Prisma.join(meetingWhere, " AND ")}`),
            ...branch("CONTACT", Prisma.sql`
                SELECT 'CONTACT' AS kind, cc.id AS id, cc.occurredAt AS occurredAt,
                       LEFT(cc.note, 300) AS title,
                       COALESCE(cu.companyName, '') AS detail,
                       cc.customerId AS customerId, cu.companyName AS customerName,
                       cc.createdByEmployeeId AS employeeId, emp.firstName AS firstName, emp.lastName AS lastName,
                       cc.channel AS statusText, cc.id AS linkId, cc.channel AS variant
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
 * Aufschluesselung. EINE Abfrage: alle Zaehlungen in einer Zeile.
 */
router.get("/activities/stats", requireAuth, READ, async (req, res) => {
    try {
        const user = req.user!;
        const tenantId = user.tenantId;
        const since = startOfToday();
        /* Die Besprechung zaehlt nach ihrem TERMIN und braucht darum BEIDE
           Grenzen des Tages — die uebrigen Quellen zaehlen ihre Erfassung und
           koennen ohnehin nicht in der Zukunft liegen. */
        const until = startOfTomorrow();
        const meetingsVisible = await meetingVisibilitySql(tenantId, user.id);
        const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
            SELECT
              (SELECT COUNT(*) FROM Enquiry e WHERE e.tenantId = ${tenantId} AND e.createdAt >= ${since}) AS enquiries,
              (SELECT COUNT(*) FROM Tender t WHERE t.tenantId = ${tenantId} AND t.createdAt >= ${since}) AS quotes,
              (SELECT COUNT(*) FROM SalesOrder so WHERE so.tenantId = ${tenantId} AND so.createdAt >= ${since}) AS orders,
              (SELECT COUNT(*) FROM CrmTask ct WHERE ct.tenantId = ${tenantId} AND ct.createdAt >= ${since}) AS tasks,
              (SELECT COUNT(*) FROM MailMessage m
                  LEFT JOIN MailCategory mc ON mc.id = m.categoryId AND mc.kind = 'CUSTOMER'
                  JOIN Customer cu ON cu.id = COALESCE(m.customerId, mc.entityId)
                 WHERE m.tenantId = ${await getMailTenantId(tenantId)} AND m.deletedAt IS NULL
                   AND cu.tenantId = ${tenantId} AND m.sentAt >= ${since}) AS mails,
              (SELECT COUNT(*) FROM MeetingActivity ma
                 WHERE ma.kind = 'MEETING' AND ${meetingsVisible}
                   AND ma.startTime >= ${since} AND ma.startTime < ${until}) AS meetings,
              (SELECT COUNT(*) FROM CrmCommunication cc WHERE cc.tenantId = ${tenantId} AND cc.occurredAt >= ${since}) AS contacts
        `);
        const row = rows[0] || {};
        const byKind = {
            ENQUIRY: Number(row.enquiries ?? 0),
            QUOTE: Number(row.quotes ?? 0),
            ORDER: Number(row.orders ?? 0),
            TASK: Number(row.tasks ?? 0),
            MAIL: Number(row.mails ?? 0),
            MEETING: Number(row.meetings ?? 0),
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
