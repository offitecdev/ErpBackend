"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const mailSignature_1 = require("../../infrastructure/services/mailSignature");
const ImapCaptureService_1 = require("../../infrastructure/services/ImapCaptureService");
const MailDispatchService_1 = require("../../infrastructure/services/outlook/MailDispatchService");
const mailCustomerMatcher_1 = require("../../infrastructure/services/outlook/mailCustomerMatcher");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
const mailText_1 = require("../../infrastructure/services/outlook/mailText");
/* FIRMENPOSTFACH IM ERP — HTTP-Schicht (18.08.2026).
     /mail/inbox/*     Zustand des Abrufs vom eigenen Mailserver + Abruf anstossen.
     /mail/messages*   Nachrichten (Grunddaten) lesen, Kunden zuordnen, senden.

   Ein Postfach für die ganze Firma: ausgehende Mail geht über den eigenen
   SMTP-Server, eingehende holt `ImapCaptureService` per IMAP von demselben
   Server. Microsoft/Outlook Online ist bewusst NICHT beteiligt — jenes
   Postfach ist mit dem Server-Postfach nicht abgeglichen.

   Sichtbarkeit: was hier liegt, IST Kundenkommunikation (der Abruf speichert
   nur Antworten auf ERP-Mails und Post bekannter Kundenadressen), darum ist es
   wie alle Kundendaten mandantenweit sichtbar.

   Rechte: lesen = crm.customers.view, senden = mail.send, Einstellungen =
   mail.manage. Bewusst keine neuen Rechte-Schlüssel (siehe crm.routes.ts). */
const router = (0, express_1.Router)();
const parseJson = (value) => {
    if (value == null)
        return null;
    if (typeof value !== "string")
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
};
/* ── Firmenpostfach: Zustand + Abruf ───────────────────────────────────── */
const inboxStatus = async (tenantId) => {
    const settings = await prisma_client_1.default.mailSetting.findUnique({
        where: { tenantId },
        select: {
            smtpHost: true, smtpPort: true, smtpUser: true, fromEmail: true,
            imapHost: true, imapPort: true, imapUser: true, imapPassword: true, smtpPassword: true,
            imapCaptureEnabled: true, imapInboxFolder: true, imapCaptureRepliesOnly: true, imapWindowMonths: true,
            imapLastSyncAt: true, imapLastSummary: true, imapLastError: true,
        },
    });
    const imapHost = settings?.imapHost?.trim() || null;
    const smtpHost = settings?.smtpHost?.trim() || null;
    return {
        // Versand
        smtpConfigured: Boolean(smtpHost && settings?.smtpPort),
        smtpHost,
        smtpPort: settings?.smtpPort ?? null,
        fromEmail: settings?.fromEmail ?? null,
        // Abruf
        imapConfigured: Boolean(imapHost),
        imapHost,
        imapPort: settings?.imapPort ?? null,
        mailbox: settings?.imapUser?.trim() || settings?.smtpUser?.trim() || settings?.fromEmail || null,
        folder: settings?.imapInboxFolder?.trim() || "INBOX",
        captureEnabled: Boolean(settings?.imapCaptureEnabled),
        repliesOnly: Boolean(settings?.imapCaptureRepliesOnly),
        // Wie weit das Postfach zurückreicht — die Seite schlägt denselben
        // Zeitraum auf, damit Sicht und Bestand dasselbe sagen.
        windowMonths: (0, ImapCaptureService_1.normalizeWindowMonths)(settings?.imapWindowMonths),
        hasCredentials: Boolean((settings?.imapPassword || settings?.smtpPassword)),
        lastSyncAt: settings?.imapLastSyncAt ?? null,
        lastSummary: settings?.imapLastSummary ?? null,
        lastError: settings?.imapLastError ?? null,
        running: (0, ImapCaptureService_1.isCaptureRunning)(tenantId),
    };
};
router.get("/inbox/status", AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        res.json(await inboxStatus(req.user.tenantId));
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Status konnte nicht gelesen werden." });
    }
});
/** Abruf jetzt ausführen (bis ~25 s warten, danach läuft er im Hintergrund weiter). */
router.post("/inbox/capture", AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)("crm.customers.view"), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId }, select: { imapHost: true } });
        if (!settings?.imapHost?.trim()) {
            return res.status(409).json({ error: "Kein IMAP-Server hinterlegt. Bitte in den Mail-Einstellungen eintragen.", code: "imap_missing" });
        }
        // `?dryRun=1` prüft Zugangsdaten, Ordner und Filter, ohne etwas zu
        // speichern — der Knopf "Testen" in den Mail-Einstellungen.
        const dryRun = String(req.query.dryRun || "") === "1";
        // `?reset=1` liest den Ordner erneut vom Anfang des Fensters (nach einem
        // Ordnerwechsel oder wenn ältere Post nachgeholt werden soll).
        const reset = String(req.query.reset || "") === "1";
        // Nur zusammen mit dryRun: einen anderen Ordner ansehen, ohne die
        // Einstellung anzufassen.
        const folder = String(req.query.folder || "").trim() || null;
        const summary = await Promise.race([
            (0, ImapCaptureService_1.captureInbox)(tenantId, { dryRun, reset, folder }),
            new Promise((resolve) => setTimeout(() => resolve(null), 25_000)),
        ]);
        res.json({ ...(await inboxStatus(tenantId)), summary });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Abruf fehlgeschlagen." });
    }
});
/** Ein-/Ausschalten des automatischen Abrufs (Schalter in der Leiste). */
router.patch("/inbox/settings", AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(["mail.manage", "crm.customers.view"]), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const data = {};
        if (req.body?.captureEnabled !== undefined)
            data.imapCaptureEnabled = Boolean(req.body.captureEnabled);
        if (req.body?.repliesOnly !== undefined)
            data.imapCaptureRepliesOnly = Boolean(req.body.repliesOnly);
        if (!Object.keys(data).length)
            return res.status(400).json({ error: "Nichts zu ändern." });
        await prisma_client_1.default.mailSetting.update({ where: { tenantId }, data });
        res.json(await inboxStatus(tenantId));
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Einstellung konnte nicht gespeichert werden." });
    }
});
/* ── Nachrichten ───────────────────────────────────────────────────────── */
const READ = (0, RbacMiddleware_1.requirePermission)("crm.customers.view");
/* ── Filter der Postfach-Seite (19.08.2026) ───────────────────────
   Vier Filter liegen über der Liste; sie werden mit UND verknüpft:

     scope        DAUERFILTER (die Seite merkt ihn sich über das Neuladen
                  hinweg): EINE Wahl aus all | customers | personnel |
                  calendar. Keine Mehrfachauswahl — man sieht eine Sicht auf
                  das Postfach, nicht eine Summe von Sichten.
     customerIds  Kundenauswahl (mehrfach)
     employeeIds  Personalauswahl (mehrfach)

   Beide Auswahlen treffen die Post in BEIDEN Richtungen (Vorgabe 19.08.2026):
   nicht nur, was wir geschrieben haben, sondern auch, was von dort kam. Die
   gespeicherte Zuordnung (`customerId`/`employeeId`) allein reicht dafür
   nicht — `employeeId` nennt die Person, der die Nachricht GEHÖRT (Absender
   bei interner Post, Senderin bei ERP-Mail), also nie die Empfängerin. Darum
   zählt zusätzlich die ADRESSE in Von, An und CC.
     from / to    Zeitraum über `sentAt`, tagesgenau (beide Tage inklusive).

   Alles ausser `scope` ist bewusst FLÜCHTIG — es lebt nur in der offenen
   Seite; nur der erste Filter bleibt stehen. */
const csvIds = (value) => {
    const seen = new Set();
    for (const part of String(value || "").split(",")) {
        const clean = part.trim();
        if (clean)
            seen.add(clean);
    }
    return Array.from(seen).slice(0, 200);
};
/* Die drei Bereiche schliessen einander AUS und ergeben zusammen «Alle» (bis
   auf noch unzugeordnete Post, die weder Kunde noch Person kennt). Was eine
   KALENDERMELDUNG von gewöhnlicher Post trennt, ist `entityType`
   (APPOINTMENT/MEETING, von calendarMailService gestempelt) — Termine und
   Besprechungen gehen ohnehin automatisch raus, darum liegen sie in EINEM
   Topf und nicht in vieren. */
const NOT_CALENDAR = client_1.Prisma.sql `(m.entityType IS NULL OR m.entityType NOT IN ('APPOINTMENT', 'MEETING'))`;
const SCOPE_SQL = {
    // Das Gespräch mit dem Kunden selbst.
    customers: client_1.Prisma.sql `(m.customerId IS NOT NULL AND ${NOT_CALENDAR})`,
    // Post unter Mitarbeitenden — kein Kunde, aber eine registrierte Person
    // dahinter: Technikerinnen und Techniker eingeschlossen, das ganze Haus.
    personnel: client_1.Prisma.sql `(m.customerId IS NULL AND m.employeeId IS NOT NULL AND ${NOT_CALENDAR})`,
    // Die automatischen Termin- und Besprechungsmeldungen.
    calendar: client_1.Prisma.sql `m.entityType IN ('APPOINTMENT', 'MEETING')`,
};
/** Tagesanfang aus «YYYY-MM-DD»; alles andere ergibt null. */
const dayStart = (value) => {
    const text = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
        return null;
    const date = new Date(`${text}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
};
const dayEnd = (value) => {
    const date = dayStart(value);
    if (date)
        date.setHours(23, 59, 59, 999);
    return date;
};
const cleanAddresses = (values) => {
    const seen = new Set();
    for (const value of values) {
        const address = (0, mailCustomerMatcher_1.normalizeAddress)(value || "");
        if (address.includes("@"))
            seen.add(address);
    }
    // Gedeckelt: aus jeder Adresse wird ein LIKE, und eine Kundenkartei mit 200
    // Ansprechpartnern soll keine Abfrage mit 600 ODER-Zweigen bauen.
    return Array.from(seen).slice(0, 60);
};
/** Die Adressen der gewählten Kunden — Hauptadresse und Ansprechpartner. */
const customerAddresses = async (ids, tenantId) => {
    const [customers, contacts] = await Promise.all([
        prisma_client_1.default.customer.findMany({ where: { id: { in: ids }, tenantId }, select: { mainEmail: true } }),
        prisma_client_1.default.customerContact.findMany({ where: { customerId: { in: ids }, tenantId }, select: { email: true } }),
    ]);
    return cleanAddresses([...customers.map((row) => row.mainEmail), ...contacts.map((row) => row.email)]);
};
const employeeAddresses = async (ids) => {
    const rows = await prisma_client_1.default.employee.findMany({ where: { id: { in: ids } }, select: { email: true } });
    return cleanAddresses(rows.map((row) => row.email));
};
/** «Kommt in dieser Nachricht vor»: als gespeicherte Zuordnung ODER als
    Adresse in Von, An oder CC. `toRecipients`/`ccRecipients` sind JSON-Spalten
    — dafür steht LIKE, wie schon in der Volltextsuche darüber. */
const partyCondition = (link, addresses) => {
    if (!addresses.length)
        return link;
    const parts = [link, client_1.Prisma.sql `m.fromAddress IN (${client_1.Prisma.join(addresses)})`];
    for (const address of addresses) {
        const like = `%${address}%`;
        parts.push(client_1.Prisma.sql `m.toRecipients LIKE ${like}`);
        parts.push(client_1.Prisma.sql `m.ccRecipients LIKE ${like}`);
    }
    return client_1.Prisma.sql `(${client_1.Prisma.join(parts, " OR ")})`;
};
/** Die Filterbedingungen der Postfach-Seite — Liste und Zählung teilen sie. */
const filterConditions = async (q, tenantId) => {
    const where = [];
    // Unbekannt oder 'all' = keine Einschränkung.
    const scope = SCOPE_SQL[String(q.scope || "").trim()];
    if (scope)
        where.push(scope);
    const customerIds = csvIds(q.customerIds);
    const employeeIds = csvIds(q.employeeIds);
    const [customerMails, employeeMails] = await Promise.all([
        customerIds.length ? customerAddresses(customerIds, tenantId) : Promise.resolve([]),
        employeeIds.length ? employeeAddresses(employeeIds) : Promise.resolve([]),
    ]);
    if (customerIds.length) {
        where.push(partyCondition(client_1.Prisma.sql `m.customerId IN (${client_1.Prisma.join(customerIds)})`, customerMails));
    }
    if (employeeIds.length) {
        where.push(partyCondition(client_1.Prisma.sql `m.employeeId IN (${client_1.Prisma.join(employeeIds)})`, employeeMails));
    }
    const from = dayStart(q.from);
    if (from)
        where.push(client_1.Prisma.sql `m.sentAt >= ${from}`);
    const to = dayEnd(q.to);
    if (to)
        where.push(client_1.Prisma.sql `m.sentAt <= ${to}`);
    return where;
};
router.get("/messages", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const user = req.user;
        const q = req.query;
        const page = Math.max(1, Number(q.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 50));
        const folder = q.folder || "inbox";
        const where = [client_1.Prisma.sql `m.tenantId = ${user.tenantId}`];
        if (folder === "inbox")
            where.push(client_1.Prisma.sql `m.direction = 'IN'`);
        else if (folder === "sent")
            where.push(client_1.Prisma.sql `m.direction = 'OUT'`);
        else if (folder === "customers")
            where.push(client_1.Prisma.sql `m.customerId IS NOT NULL`);
        else if (folder === "unlinked")
            where.push(client_1.Prisma.sql `m.customerId IS NULL`);
        if (q.customerId)
            where.push(client_1.Prisma.sql `m.customerId = ${String(q.customerId)}`);
        if (q.unread === "1")
            where.push(client_1.Prisma.sql `m.isRead = 0`);
        if (q.entityType && q.entityId) {
            where.push(client_1.Prisma.sql `m.entityType = ${String(q.entityType)} AND m.entityId = ${String(q.entityId)}`);
        }
        where.push(...await filterConditions(q, user.tenantId));
        const search = String(q.search || "").trim();
        if (search) {
            const like = `%${search}%`;
            where.push(client_1.Prisma.sql `(m.subject LIKE ${like} OR m.fromAddress LIKE ${like} OR m.fromName LIKE ${like}
                OR m.bodyPreview LIKE ${like} OR m.toRecipients LIKE ${like} OR cu.companyName LIKE ${like})`);
        }
        const whereSql = client_1.Prisma.join(where, " AND ");
        const from = client_1.Prisma.sql `
            FROM MailMessage m
            LEFT JOIN Customer cu ON cu.id = m.customerId
            LEFT JOIN CustomerContact ct ON ct.id = m.contactId
            LEFT JOIN Employee e ON e.id = m.employeeId
            WHERE ${whereSql}`;
        const [rows, countRows] = await Promise.all([
            prisma_client_1.default.$queryRaw `
                SELECT m.id, m.direction, m.origin, m.subject, m.fromName, m.fromAddress, m.toRecipients,
                       m.bodyPreview, m.sentAt, m.hasAttachments, m.isRead, m.customerId, cu.companyName AS customerName,
                       m.contactId, ct.firstName AS contactFirstName, ct.lastName AS contactLastName,
                       m.matchSource, m.entityType, m.entityId, m.entityLabel, m.employeeId,
                       e.firstName AS byFirstName, e.lastName AS byLastName,
                       (m.webLink IS NOT NULL) AS hasWebLink
                ${from}
                ORDER BY m.sentAt DESC, m.id DESC
                LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
            prisma_client_1.default.$queryRaw `SELECT COUNT(*) AS total ${from}`,
        ]);
        res.json({
            data: rows.map((row) => ({
                id: row.id,
                direction: row.direction,
                origin: row.origin,
                subject: row.subject,
                fromName: row.fromName,
                fromAddress: row.fromAddress,
                toRecipients: parseJson(row.toRecipients) || [],
                bodyPreview: row.bodyPreview,
                sentAt: row.sentAt,
                hasAttachments: Boolean(row.hasAttachments),
                isRead: Boolean(row.isRead),
                customer: row.customerId ? { id: row.customerId, companyName: row.customerName } : null,
                contact: row.contactId ? { id: row.contactId, firstName: row.contactFirstName, lastName: row.contactLastName } : null,
                matchSource: row.matchSource,
                entity: row.entityType ? { type: row.entityType, id: row.entityId, label: row.entityLabel } : null,
                owner: row.employeeId ? { id: row.employeeId, firstName: row.byFirstName, lastName: row.byLastName } : null,
                mine: row.employeeId === user.id,
                hasWebLink: Boolean(row.hasWebLink),
            })),
            total: Number(countRows[0]?.total || 0),
            page,
            pageSize,
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Nachrichten konnten nicht geladen werden." });
    }
});
router.get("/messages/stats", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const rows = await prisma_client_1.default.$queryRaw `
            SELECT
                SUM(m.direction = 'IN' AND m.isRead = 0) AS unreadInbox,
                SUM(m.direction = 'IN') AS inbox,
                SUM(m.direction = 'OUT') AS sent,
                SUM(m.customerId IS NULL) AS unlinked
            FROM MailMessage m WHERE m.tenantId = ${req.user.tenantId}`;
        const row = rows[0] || {};
        res.json({
            unreadInbox: Number(row.unreadInbox || 0),
            inbox: Number(row.inbox || 0),
            sent: Number(row.sent || 0),
            unlinked: Number(row.unlinked || 0),
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Statistik konnte nicht geladen werden." });
    }
});
/** Die Auswahl der beiden Suchfilter.

    OHNE Suchbegriff: nur, wer im Postfach wirklich vorkommt — mit der Zahl
    seiner Nachrichten. Das ist die Liste, die beim Öffnen etwas taugt.

    MIT Suchbegriff: dazu die übrigen Kunden und Mitarbeitenden, damit man auch
    nach jemandem filtern kann, von dem noch keine Post da ist (Vorgabe
    19.08.2026). Sie kommen mit `mails: 0` und stehen im Fenster unter den
    anderen. */
router.get("/messages/filter-options", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const search = String(req.query.search || "").trim().slice(0, 80);
        const like = `%${search}%`;
        // Personal ist über den ganzen Firmenbaum sichtbar (siehe crm.routes.ts).
        const staffTenants = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId);
        const [customers, employees] = await Promise.all([
            /* Kunden zählen über die gespeicherte Zuordnung. Die reicht hier,
               weil `customerId` in BEIDEN Richtungen gesetzt wird (der Abruf
               ordnet eingehende Post über die Adresse zu, der Versand schreibt
               sie mit) — die Liste ist also vollständig.

               Die ZAHL bleibt dabei vorsichtig: der Filter findet zusätzlich
               Post über die Adressen der Ansprechpartner, und die hier
               mitzuzählen hiesse, Nachrichten × Ansprechpartner mit LIKE zu
               verbinden. Beim Personal ist das gefahrlos (eine Belegschaft),
               bei einer Kundenkartei mit Tausenden Kontakten wäre es eine
               langsame Abfrage bei jedem Tastendruck im Suchfeld. */
            prisma_client_1.default.$queryRaw `
                SELECT cu.id, cu.companyName, COUNT(*) AS mails
                FROM MailMessage m
                JOIN Customer cu ON cu.id = m.customerId
                WHERE m.tenantId = ${tenantId}
                GROUP BY cu.id, cu.companyName
                ORDER BY cu.companyName ASC`,
            /* Auch über die ADRESSE, nicht nur über `employeeId`: dieses Feld
               nennt die Person, der die Nachricht GEHÖRT (Absender bei interner
               Post, Senderin bei ERP-Mail) — nie die Empfängerin. Ohne den
               Adressteil stand im Personalfenster genau EIN Name, obwohl fünf
               Leute Post im Haus haben; die Zahl der Zeile wäre ausserdem
               kleiner als das, was der Filter danach findet.

               Kosten: eine Verbindung Nachricht × Personal mit LIKE, also ohne
               Index. Beide Seiten sind klein und wachsen langsam (ein Postfach,
               eine Belegschaft) — die Abfrage läuft einmal beim Öffnen des
               Fensters, nicht je Zeile. */
            prisma_client_1.default.$queryRaw `
                SELECT e.id, e.firstName, e.lastName, COUNT(DISTINCT m.id) AS mails
                FROM MailMessage m
                JOIN Employee e
                  ON e.tenantId IN (${client_1.Prisma.join(staffTenants)})
                 AND e.deletedAt IS NULL
                 AND (e.id = m.employeeId
                      OR m.fromAddress = e.email
                      OR m.toRecipients LIKE CONCAT('%', e.email, '%')
                      OR m.ccRecipients LIKE CONCAT('%', e.email, '%'))
                WHERE m.tenantId = ${tenantId}
                GROUP BY e.id, e.firstName, e.lastName
                ORDER BY e.firstName ASC, e.lastName ASC`,
        ]);
        const [moreCustomers, moreEmployees] = search
            ? await Promise.all([
                prisma_client_1.default.customer.findMany({
                    where: { tenantId, companyName: { contains: search } },
                    select: { id: true, companyName: true },
                    orderBy: { companyName: "asc" },
                    take: 25,
                }),
                prisma_client_1.default.$queryRaw `
                    SELECT e.id, e.firstName, e.lastName
                    FROM Employee e
                    WHERE e.tenantId IN (${client_1.Prisma.join(staffTenants)})
                      AND e.deletedAt IS NULL
                      AND (CONCAT(e.firstName, ' ', e.lastName) LIKE ${like} OR e.email LIKE ${like})
                    ORDER BY e.firstName ASC, e.lastName ASC
                    LIMIT 25`,
            ])
            : [[], []];
        const customerRows = customers.map((row) => ({ id: row.id, companyName: row.companyName, mails: Number(row.mails || 0) }));
        const seenCustomers = new Set(customerRows.map((row) => row.id));
        for (const row of moreCustomers) {
            if (!seenCustomers.has(row.id))
                customerRows.push({ id: row.id, companyName: row.companyName, mails: 0 });
        }
        const employeeRows = employees.map((row) => ({
            id: row.id, firstName: row.firstName, lastName: row.lastName, mails: Number(row.mails || 0),
        }));
        const seenEmployees = new Set(employeeRows.map((row) => row.id));
        for (const row of moreEmployees) {
            if (!seenEmployees.has(row.id)) {
                employeeRows.push({ id: row.id, firstName: row.firstName, lastName: row.lastName, mails: 0 });
            }
        }
        res.json({ customers: customerRows, employees: employeeRows });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Filter konnten nicht geladen werden." });
    }
});
const loadMessage = async (id, tenantId) => {
    const rows = await prisma_client_1.default.$queryRaw `
        SELECT m.*, cu.companyName AS customerName, ct.firstName AS contactFirstName, ct.lastName AS contactLastName,
               e.firstName AS byFirstName, e.lastName AS byLastName
        FROM MailMessage m
        LEFT JOIN Customer cu ON cu.id = m.customerId
        LEFT JOIN CustomerContact ct ON ct.id = m.contactId
        LEFT JOIN Employee e ON e.id = m.employeeId
        WHERE m.id = ${id} AND m.tenantId = ${tenantId}
        LIMIT 1`;
    return rows[0] || null;
};
const messageDetailDto = (row, employeeId) => ({
    id: row.id,
    direction: row.direction,
    origin: row.origin,
    subject: row.subject,
    fromName: row.fromName,
    fromAddress: row.fromAddress,
    toRecipients: parseJson(row.toRecipients) || [],
    ccRecipients: parseJson(row.ccRecipients) || [],
    bodyPreview: row.bodyPreview,
    bodyText: row.bodyText,
    sentAt: row.sentAt,
    hasAttachments: Boolean(row.hasAttachments),
    attachments: parseJson(row.attachments) || null,
    webLink: row.webLink,
    isRead: Boolean(row.isRead),
    conversationId: row.conversationId,
    customer: row.customerId ? { id: row.customerId, companyName: row.customerName } : null,
    contact: row.contactId ? { id: row.contactId, firstName: row.contactFirstName, lastName: row.contactLastName } : null,
    matchSource: row.matchSource,
    entity: row.entityType ? { type: row.entityType, id: row.entityId, label: row.entityLabel } : null,
    owner: row.employeeId ? { id: row.employeeId, firstName: row.byFirstName, lastName: row.byLastName } : null,
    mine: row.employeeId === employeeId,
    // Anhänge liegen auf dem Mailserver; abgerufen wird über Ordner+UID.
    canFetchAttachments: row.origin === "IMAP" && Boolean(row.providerMessageId),
});
router.get("/messages/:id", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const user = req.user;
        const row = await loadMessage(String(req.params.id), user.tenantId);
        if (!row)
            return res.status(404).json({ error: "Nachricht nicht gefunden." });
        if (!row.isRead) {
            await prisma_client_1.default.mailMessage.update({ where: { id: row.id }, data: { isRead: true } }).catch(() => undefined);
            row.isRead = 1;
        }
        res.json(messageDetailDto(row, user.id));
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Nachricht konnte nicht geladen werden." });
    }
});
/** Anhangs-METADATEN — beim Abruf aus der BODYSTRUCTURE mitgeschrieben. */
router.get("/messages/:id/attachments", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const row = await loadMessage(String(req.params.id), req.user.tenantId);
        if (!row)
            return res.status(404).json({ error: "Nachricht nicht gefunden." });
        const cached = parseJson(row.attachments);
        res.json({ attachments: Array.isArray(cached) ? cached : [], source: "cache" });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Anhänge konnten nicht gelesen werden." });
    }
});
/** Anhang-INHALT live vom Mailserver durchreichen — nichts wird gespeichert. */
router.get("/messages/:id/attachments/:part", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const row = await loadMessage(String(req.params.id), req.user.tenantId);
        if (!row)
            return res.status(404).json({ error: "Nachricht nicht gefunden." });
        if (row.origin !== "IMAP" || !row.providerMessageId) {
            return res.status(404).json({ error: "Anhang nicht verfügbar." });
        }
        const part = String(req.params.part);
        const meta = parseJson(row.attachments)
            ?.find((item) => item.id === part);
        const file = await (0, ImapCaptureService_1.fetchImapAttachment)(req.user.tenantId, String(row.providerMessageId), part);
        if (!file)
            return res.status(404).json({ error: "Anhang nicht gefunden." });
        const name = String(meta?.name || "anhang").replace(/[\\/\r\n"]+/g, "_");
        res.setHeader("Content-Type", meta?.contentType || file.contentType || "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
        res.setHeader("Cache-Control", "private, max-age=0");
        res.send(file.content);
    }
    catch (error) {
        res.status(502).json({ error: error?.message || "Anhang konnte nicht geladen werden." });
    }
});
/** Kunden zuordnen / Zuordnung lösen (manuell). */
router.patch("/messages/:id", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const user = req.user;
        const row = await loadMessage(String(req.params.id), user.tenantId);
        if (!row)
            return res.status(404).json({ error: "Nachricht nicht gefunden." });
        const body = req.body || {};
        const data = {};
        if (body.customerId !== undefined) {
            const customerId = body.customerId ? String(body.customerId) : null;
            if (customerId) {
                const customer = await prisma_client_1.default.customer.findFirst({ where: { id: customerId, tenantId: user.tenantId }, select: { id: true } });
                if (!customer)
                    return res.status(404).json({ error: "Kunde nicht gefunden." });
                let contactId = null;
                if (body.contactId) {
                    const contact = await prisma_client_1.default.customerContact.findFirst({ where: { id: String(body.contactId), customerId }, select: { id: true } });
                    if (!contact)
                        return res.status(400).json({ error: "Ansprechpartner gehört nicht zu diesem Kunden." });
                    contactId = contact.id;
                }
                Object.assign(data, { customerId, contactId, matchSource: "MANUAL" });
            }
            else {
                Object.assign(data, { customerId: null, contactId: null, matchSource: null });
            }
        }
        if (body.isRead !== undefined)
            data.isRead = Boolean(body.isRead);
        if (!Object.keys(data).length)
            return res.status(400).json({ error: "Nichts zu ändern." });
        await prisma_client_1.default.mailMessage.update({ where: { id: row.id }, data });
        // Optional: alle noch nicht zugeordneten Nachrichten derselben
        // Gegenstelle gleich mit zuordnen — "alle von dieser Adresse".
        let alsoLinked = 0;
        if (data.customerId && body.applyToSender) {
            const counterpart = row.direction === "IN"
                ? (0, mailCustomerMatcher_1.normalizeAddress)(row.fromAddress)
                : (0, mailCustomerMatcher_1.normalizeAddress)(parseJson(row.toRecipients)?.[0]?.address);
            if (counterpart) {
                const like = `%"address":"${counterpart}"%`;
                const result = await prisma_client_1.default.$executeRaw `
                    UPDATE MailMessage m
                       SET m.customerId = ${data.customerId}, m.contactId = ${data.contactId ?? null},
                           m.matchSource = 'MANUAL', m.updatedAt = NOW(3)
                     WHERE m.tenantId = ${user.tenantId} AND m.customerId IS NULL AND m.id <> ${row.id}
                       AND (m.fromAddress = ${counterpart} OR m.toRecipients LIKE ${like} OR m.ccRecipients LIKE ${like})`;
                alsoLinked = Number(result || 0);
            }
        }
        const fresh = await loadMessage(row.id, user.tenantId);
        res.json({ ...messageDetailDto(fresh, user.id), alsoLinked });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Zuordnung fehlgeschlagen." });
    }
});
router.delete("/messages/:id", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const row = await prisma_client_1.default.mailMessage.findFirst({
            where: { id: String(req.params.id), tenantId: req.user.tenantId },
            select: { id: true },
        });
        if (!row)
            return res.status(404).json({ error: "Nachricht nicht gefunden." });
        // Löscht nur den ERP-Eintrag — auf dem Mailserver bleibt die Nachricht.
        await prisma_client_1.default.mailMessage.delete({ where: { id: row.id } });
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Löschen fehlgeschlagen." });
    }
});
/** Vorschläge fürs Zuordnen: Kunden mit derselben Domain wie die Gegenstelle. */
router.get("/messages/:id/suggestions", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const user = req.user;
        const row = await loadMessage(String(req.params.id), user.tenantId);
        if (!row)
            return res.status(404).json({ error: "Nachricht nicht gefunden." });
        const addresses = row.direction === "IN"
            ? [(0, mailCustomerMatcher_1.normalizeAddress)(row.fromAddress)]
            : (parseJson(row.toRecipients) || []).map((p) => (0, mailCustomerMatcher_1.normalizeAddress)(p?.address));
        const domains = Array.from(new Set(addresses.map((a) => a.split("@")[1] || "").filter(Boolean)));
        if (!domains.length)
            return res.json({ customers: [] });
        const book = await (0, mailCustomerMatcher_1.getAddressBook)(user.tenantId);
        const ids = new Set();
        for (const domain of domains)
            for (const id of book.byDomain.get(domain) || [])
                ids.add(id);
        if (!ids.size)
            return res.json({ customers: [] });
        const customers = await prisma_client_1.default.customer.findMany({
            where: { id: { in: Array.from(ids).slice(0, 10) }, tenantId: user.tenantId },
            select: { id: true, companyName: true, mainEmail: true, city: true },
        });
        res.json({ customers });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Vorschläge konnten nicht geladen werden." });
    }
});
/**
 * ADRESSBUCH fürs Schreiben (Vorgabe 18.08.2026: "nur Adressen von im System
 * vorhandenen Benutzern vorschlagen"). Drei Quellen in EINER Liste, jede Zeile
 * mit ihrer Gruppe, damit die Vorschlagsliste sie getrennt zeigen kann:
 *
 *   CUSTOMER — Kunden mit Hauptadresse
 *   CONTACT  — Ansprechpartner der Kunden (zeigt den Kunden als Nebenzeile)
 *   EMPLOYEE — im System registrierte Personen (ganzer Firmenbaum)
 *
 * Es wird SERVERSEITIG gesucht und knapp begrenzt: wer den Treffer nicht
 * sieht, tippt zwei Buchstaben mehr — dieselbe Regel wie bei der Produktzelle.
 * Einträge ohne Adresse kommen gar nicht erst mit.
 */
router.get("/address-book", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const user = req.user;
        const search = String(req.query.search || "").trim();
        const take = Math.min(30, Math.max(1, Number(req.query.limit) || 8));
        const like = `%${search}%`;
        const employeeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(user.tenantId);
        const [customers, contacts, employees] = await Promise.all([
            prisma_client_1.default.customer.findMany({
                where: {
                    tenantId: user.tenantId,
                    isActive: true,
                    NOT: { mainEmail: null },
                    ...(search ? { OR: [{ companyName: { contains: search } }, { mainEmail: { contains: search } }] } : {}),
                },
                select: { id: true, companyName: true, mainEmail: true },
                orderBy: { companyName: "asc" },
                take,
            }),
            prisma_client_1.default.$queryRaw `
                SELECT ct.id, ct.firstName, ct.lastName, ct.email, ct.customerId, cu.companyName
                  FROM CustomerContact ct
                  JOIN Customer cu ON cu.id = ct.customerId
                 WHERE ct.tenantId = ${user.tenantId} AND ct.email IS NOT NULL AND ct.email <> ''
                   ${search ? client_1.Prisma.sql `AND (ct.firstName LIKE ${like} OR ct.lastName LIKE ${like} OR ct.email LIKE ${like} OR cu.companyName LIKE ${like})` : client_1.Prisma.empty}
                 ORDER BY ct.lastName ASC, ct.firstName ASC
                 LIMIT ${take}`,
            employeeTenantIds.length
                ? prisma_client_1.default.employee.findMany({
                    where: {
                        tenantId: { in: employeeTenantIds },
                        isActive: true,
                        deletedAt: null,
                        ...(search
                            ? { OR: [{ firstName: { contains: search } }, { lastName: { contains: search } }, { email: { contains: search } }] }
                            : {}),
                    },
                    select: { id: true, firstName: true, lastName: true, email: true },
                    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
                    take,
                })
                : Promise.resolve([]),
        ]);
        const entries = [
            ...customers
                .filter((row) => (0, mailText_1.isValidEmail)(String(row.mainEmail || "").trim()))
                .map((row) => ({
                kind: "CUSTOMER",
                id: row.id,
                name: row.companyName,
                email: String(row.mainEmail).trim(),
                subtitle: null,
                customerId: row.id,
            })),
            ...contacts
                .filter((row) => (0, mailText_1.isValidEmail)(String(row.email || "").trim()))
                .map((row) => ({
                kind: "CONTACT",
                id: row.id,
                name: `${row.firstName} ${row.lastName}`.trim(),
                email: String(row.email).trim(),
                subtitle: row.companyName,
                customerId: row.customerId,
            })),
            ...employees
                .filter((row) => (0, mailText_1.isValidEmail)(String(row.email || "").trim()))
                .map((row) => ({
                kind: "EMPLOYEE",
                id: row.id,
                name: `${row.firstName} ${row.lastName}`.trim(),
                email: String(row.email).trim(),
                subtitle: null,
                customerId: null,
            })),
        ];
        // Dieselbe Adresse kann Kunde UND Ansprechpartner sein; der genauere
        // Treffer (Ansprechpartner) steht dann nur einmal drin.
        const seen = new Set();
        const unique = entries.filter((entry) => {
            const key = entry.email.toLowerCase();
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
        res.json({ entries: unique });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Adressbuch konnte nicht geladen werden." });
    }
});
/** Empfänger-Vorschläge fürs Schreiben: Hauptadresse + Ansprechpartner eines Kunden. */
router.get("/recipients", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const user = req.user;
        const customerId = String(req.query.customerId || "").trim();
        if (!customerId)
            return res.status(400).json({ error: "customerId fehlt." });
        const [customer, contacts] = await Promise.all([
            prisma_client_1.default.customer.findFirst({ where: { id: customerId, tenantId: user.tenantId }, select: { id: true, companyName: true, mainEmail: true } }),
            prisma_client_1.default.customerContact.findMany({
                where: { customerId, tenantId: user.tenantId },
                select: { id: true, firstName: true, lastName: true, email: true, isPrimaryContact: true },
                orderBy: [{ isPrimaryContact: "desc" }, { lastName: "asc" }],
            }),
        ]);
        if (!customer)
            return res.status(404).json({ error: "Kunde nicht gefunden." });
        res.json({
            customer: { id: customer.id, companyName: customer.companyName, mainEmail: customer.mainEmail },
            contacts: contacts.filter((c) => c.email && (0, mailText_1.isValidEmail)(String(c.email).trim())),
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Empfänger konnten nicht geladen werden." });
    }
});
/* ── Senden aus dem ERP (eigener SMTP-Server) ──────────────────────────── */
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
    "application/pdf", "image/png", "image/jpeg", "image/webp",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/csv", "text/plain", "application/zip",
]);
router.post("/messages/send", AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)("mail.send"), async (req, res) => {
    try {
        const user = req.user;
        const body = req.body || {};
        const to = (0, mailText_1.stripHeaderValue)(body.to);
        if (!to || !(0, mailText_1.isValidEmail)(to))
            return res.status(400).json({ error: "Empfängeradresse fehlt oder ist ungültig." });
        const ccRaw = Array.isArray(body.cc) ? body.cc : String(body.cc || "").split(",");
        const seen = new Set([to.toLowerCase()]);
        const cc = [];
        for (const value of ccRaw) {
            const address = (0, mailText_1.stripHeaderValue)(value);
            if (!address)
                continue;
            if (!(0, mailText_1.isValidEmail)(address))
                return res.status(400).json({ error: `Ungültige CC-Adresse: ${address}` });
            const key = address.toLowerCase();
            if (seen.has(key))
                continue;
            seen.add(key);
            cc.push(address);
            if (cc.length >= 10)
                break;
        }
        const subject = (0, mailText_1.stripHeaderValue)(body.subject).slice(0, 200);
        if (!subject)
            return res.status(400).json({ error: "Betreff fehlt." });
        const message = String(body.html || body.text || body.message || "").trim();
        if (!message)
            return res.status(400).json({ error: "Nachricht fehlt." });
        if (message.length > 60_000)
            return res.status(400).json({ error: "Nachricht zu lang." });
        const isHtml = Boolean(body.html) || (0, mailText_1.looksLikeHtml)(message);
        const messageHtml = isHtml ? (0, mailText_1.sanitizeMailHtml)(message) : (0, mailText_1.escapeHtml)(message).replace(/\n/g, "<br />");
        const messageText = isHtml ? (0, mailText_1.htmlToText)(message) : message;
        const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
        if (rawAttachments.length > 5)
            return res.status(400).json({ error: "Höchstens 5 Anhänge." });
        const attachments = [];
        let total = 0;
        for (const item of rawAttachments) {
            const contentType = String(item?.contentType || "").trim().toLowerCase();
            const contentBase64 = typeof item?.contentBase64 === "string" ? item.contentBase64 : "";
            const rawName = String(item?.filename || "").trim();
            if (!rawName || !contentBase64)
                return res.status(400).json({ error: "Anhang ohne Namen oder Inhalt." });
            if (!ALLOWED_ATTACHMENT_TYPES.has(contentType))
                return res.status(400).json({ error: `Dateityp nicht erlaubt: ${contentType || "?"}` });
            total += Math.floor(contentBase64.replace(/\s+/g, "").length * 3 / 4);
            attachments.push({ filename: rawName.replace(/[\\/\r\n"]+/g, "_").slice(0, 120), contentType, contentBase64 });
        }
        if (total > MAX_TOTAL_ATTACHMENT_BYTES)
            return res.status(400).json({ error: "Anhänge überschreiten 12 MB." });
        let customerId = null;
        let contactId = null;
        if (body.customerId) {
            const customer = await prisma_client_1.default.customer.findFirst({ where: { id: String(body.customerId), tenantId: user.tenantId }, select: { id: true } });
            if (!customer)
                return res.status(404).json({ error: "Kunde nicht gefunden." });
            customerId = customer.id;
            if (body.contactId) {
                const contact = await prisma_client_1.default.customerContact.findFirst({ where: { id: String(body.contactId), customerId }, select: { id: true } });
                contactId = contact?.id || null;
            }
        }
        const entityType = body.entityType ? String(body.entityType).toUpperCase().slice(0, 24) : null;
        const entityId = entityType && body.entityId ? String(body.entityId) : null;
        const entityLabel = entityType && body.entityLabel ? (0, mailText_1.stripHeaderValue)(body.entityLabel).slice(0, 64) : null;
        const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId: user.tenantId } });
        if (!settings?.smtpHost?.trim() || !settings?.smtpPort) {
            return res.status(400).json({
                error: "Kein SMTP-Server eingerichtet: bitte in den Mail-Einstellungen Server, Port und Zugangsdaten hinterlegen.",
                code: "no_transport",
            });
        }
        const signature = (0, mailSignature_1.buildSignatureParts)(settings);
        const fromEmail = (0, mailText_1.stripHeaderValue)(settings?.fromEmail || user.email);
        const fromName = (0, mailText_1.stripHeaderValue)(settings?.fromName || "").slice(0, 100) || null;
        const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">${messageHtml}${signature.html}</div>`;
        const result = await (0, MailDispatchService_1.dispatchMail)({ tenantId: user.tenantId, employeeId: user.id }, settings, {
            fromEmail,
            fromName,
            to,
            cc,
            subject,
            text: `${messageText}${signature.text}`,
            html,
            replyTo: settings?.replyTo || null,
            attachments,
            inlineImages: signature.inlineImages,
        }, { record: { customerId, contactId, entityType, entityId, entityLabel } });
        res.json({ ok: true, transport: result.transport, accepted: result.accepted, mailMessageId: result.mailMessageId, fromEmail: result.fromEmail });
    }
    catch (error) {
        if (typeof error?.message === "string" && error.message.startsWith("SMTP")) {
            return res.status(502).json({ error: "E-Mail konnte nicht gesendet werden: SMTP-Server nicht erreichbar oder Anmeldung fehlgeschlagen." });
        }
        console.error("[mail/messages/send]", error);
        res.status(500).json({ error: error?.message || "Senden fehlgeschlagen." });
    }
});
/* ── Adressbuch-Cache: Kundenänderungen sollen den nächsten Abruf sofort treffen ── */
router.post("/inbox/refresh-addressbook", AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(["crm.customers.view", "mail.manage"]), (req, res) => {
    (0, mailCustomerMatcher_1.invalidateAddressBook)(req.user.tenantId);
    res.status(204).send();
});
exports.default = router;
//# sourceMappingURL=mailbox.routes.js.map