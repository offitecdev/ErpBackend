"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const client_1 = require("@prisma/client");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const enquiryFromMail_1 = require("../../infrastructure/services/enquiryFromMail");
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
/* Die Filterleiste (Bereich/Kunden/Personal/Zeitraum, 19.08.2026) ist
   ABGESCHAFFT (Vorgabe 08.09.2026: «die Filter nach Personal und Kunden
   entfernen wir»). Geordnet wird das Postfach jetzt über KATEGORIEN — siehe
   unten, /mail/categories. */
router.get("/messages", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const user = req.user;
        const q = req.query;
        const page = Math.max(1, Number(q.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 50));
        const folder = q.folder || "inbox";
        const where = [client_1.Prisma.sql `m.tenantId = ${user.tenantId}`];
        /* PAPIERKORB: Gelöschtes liegt in KEINEM Ordner und in KEINER
           Kategorie mehr — nur der Ordner `bin` zeigt es, bis es von dort
           endgültig entfernt wird. */
        if (folder === "bin")
            where.push(client_1.Prisma.sql `m.deletedAt IS NOT NULL`);
        else
            where.push(client_1.Prisma.sql `m.deletedAt IS NULL`);
        if (folder === "inbox")
            where.push(client_1.Prisma.sql `m.direction = 'IN'`);
        else if (folder === "sent")
            where.push(client_1.Prisma.sql `m.direction = 'OUT'`);
        // Eine KATEGORIE zeigt beide Richtungen — das Gespräch, nicht die Hälfte.
        if (q.categoryId)
            where.push(client_1.Prisma.sql `m.categoryId = ${String(q.categoryId)}`);
        if (q.customerId)
            where.push(client_1.Prisma.sql `m.customerId = ${String(q.customerId)}`);
        if (q.unread === "1")
            where.push(client_1.Prisma.sql `m.isRead = 0`);
        if (q.entityType && q.entityId) {
            where.push(client_1.Prisma.sql `m.entityType = ${String(q.entityType)} AND m.entityId = ${String(q.entityId)}`);
        }
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
            LEFT JOIN MailCategory mc ON mc.id = m.categoryId
            WHERE ${whereSql}`;
        const [rows, countRows] = await Promise.all([
            prisma_client_1.default.$queryRaw `
                SELECT m.id, m.direction, m.origin, m.subject, m.fromName, m.fromAddress, m.toRecipients,
                       m.bodyPreview, m.sentAt, m.hasAttachments, m.isRead, m.customerId, cu.companyName AS customerName,
                       m.contactId, ct.firstName AS contactFirstName, ct.lastName AS contactLastName,
                       m.matchSource, m.entityType, m.entityId, m.entityLabel, m.employeeId,
                       e.firstName AS byFirstName, e.lastName AS byLastName,
                       m.categoryId, mc.name AS categoryName, mc.color AS categoryColor,
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
                category: row.categoryId ? { id: row.categoryId, name: row.categoryName, color: row.categoryColor } : null,
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
                SUM(m.deletedAt IS NULL AND m.direction = 'IN' AND m.isRead = 0) AS unreadInbox,
                SUM(m.deletedAt IS NULL AND m.direction = 'IN') AS inbox,
                SUM(m.deletedAt IS NULL AND m.direction = 'OUT') AS sent,
                SUM(m.deletedAt IS NOT NULL) AS bin
            FROM MailMessage m WHERE m.tenantId = ${req.user.tenantId}`;
        const row = rows[0] || {};
        res.json({
            unreadInbox: Number(row.unreadInbox || 0),
            inbox: Number(row.inbox || 0),
            sent: Number(row.sent || 0),
            bin: Number(row.bin || 0),
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Statistik konnte nicht geladen werden." });
    }
});
/* ── KATEGORIEN (08.09.2026) ────────────────────────────────────────────────
   Die persönliche Ordnung des Postfachs. Eine Kategorie hängt an einem
   Datensatz des Hauses (Person, Kunde, Angebot, Auftrag, Projekt, Rechnung)
   oder ist die eingebaute Sammelkategorie «Anfragen» (REQUESTS — je Mandant
   genau eine, wird beim ersten Lesen angelegt und lässt sich nicht löschen).
   Nachrichten werden per Klick (Sammelmodus) oder Ziehen zugeordnet;
   `displayOrder` ist die von Hand gezogene Reihenfolge der Leiste. */
const CATEGORY_KINDS = new Set(["STAFF", "CUSTOMER", "TENDER", "ORDER", "PROJECT", "INVOICE"]);
/* Die Randfarben der Zuordnung (Google-Palette wie die Kalenderkarten) —
   reihum vergeben, damit nebeneinanderliegende Kategorien verschieden sind. */
const CATEGORY_COLORS = ["#039be5", "#0b8043", "#8e24aa", "#f4511e", "#3f51b5", "#e67c73", "#f6bf26", "#33b679", "#7986cb", "#d81b60"];
const REQUESTS_COLOR = "#e8710a";
const nextCategoryColor = async (tenantId) => {
    const count = await prisma_client_1.default.mailCategory.count({ where: { tenantId, NOT: { kind: "REQUESTS" } } });
    return CATEGORY_COLORS[count % CATEGORY_COLORS.length];
};
/** «Anfragen» steht immer da — angelegt beim ersten Lesen der Liste. */
const ensureRequestsCategory = async (tenantId) => {
    const existing = await prisma_client_1.default.mailCategory.findFirst({ where: { tenantId, kind: "REQUESTS" }, select: { id: true } });
    if (existing)
        return;
    await prisma_client_1.default.mailCategory.create({
        data: { id: (0, nanoid_1.nanoid)(10), tenantId, kind: "REQUESTS", entityId: null, name: "Anfragen", color: REQUESTS_COLOR, displayOrder: 0 },
    }).catch(() => undefined); // Wettlauf zweier Reiter: einer gewinnt, gut so.
};
/**
 * Den Datensatz hinter einer neuen Kategorie auflösen: gibt Namen zurück oder
 * null, wenn er im Mandanten nicht existiert. Personal gilt firmenbaumweit
 * (wie überall sonst); alles andere ist mandanteneigen.
 */
const resolveCategoryEntity = async (tenantId, kind, entityId) => {
    if (kind === "STAFF") {
        const staffTenants = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId);
        const row = await prisma_client_1.default.employee.findFirst({
            where: { id: entityId, tenantId: { in: staffTenants }, deletedAt: null },
            select: { firstName: true, lastName: true },
        });
        return row ? `${row.firstName} ${row.lastName}`.trim() : null;
    }
    if (kind === "CUSTOMER") {
        const row = await prisma_client_1.default.customer.findFirst({ where: { id: entityId, tenantId }, select: { companyName: true } });
        return row?.companyName || null;
    }
    if (kind === "TENDER") {
        const row = await prisma_client_1.default.tender.findFirst({ where: { id: entityId, tenantId }, select: { tenderNumber: true } });
        return row?.tenderNumber || null;
    }
    if (kind === "ORDER") {
        const row = await prisma_client_1.default.salesOrder.findFirst({ where: { id: entityId, tenantId }, select: { orderNumber: true } });
        return row?.orderNumber || null;
    }
    if (kind === "PROJECT") {
        const row = await prisma_client_1.default.project.findFirst({ where: { id: entityId, tenantId }, select: { projectNumber: true, projectName: true } });
        return row ? `${row.projectNumber} · ${row.projectName}`.slice(0, 160) : null;
    }
    if (kind === "INVOICE") {
        const row = await prisma_client_1.default.invoice.findFirst({ where: { id: entityId, tenantId }, select: { invoiceNumber: true } });
        return row?.invoiceNumber || null;
    }
    return null;
};
router.get("/categories", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        await ensureRequestsCategory(tenantId);
        const [categories, counts] = await Promise.all([
            prisma_client_1.default.mailCategory.findMany({
                where: { tenantId },
                orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
            }),
            prisma_client_1.default.$queryRaw `
                SELECT m.categoryId, COUNT(*) AS mails
                FROM MailMessage m
                WHERE m.tenantId = ${tenantId} AND m.categoryId IS NOT NULL AND m.deletedAt IS NULL
                GROUP BY m.categoryId`,
        ]);
        const countById = new Map(counts.map((row) => [row.categoryId, Number(row.mails || 0)]));
        res.json({
            categories: categories.map((row) => ({
                id: row.id,
                kind: row.kind,
                entityId: row.entityId,
                name: row.name,
                color: row.color,
                displayOrder: row.displayOrder,
                count: countById.get(row.id) || 0,
            })),
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Kategorien konnten nicht geladen werden." });
    }
});
/**
 * Die Auswahlliste des Anlegen-Fensters: welche Datensätze es zur gewählten
 * Art gibt. Serverseitig gesucht und knapp begrenzt — wer den Treffer nicht
 * sieht, tippt zwei Buchstaben mehr (dieselbe Regel wie beim Adressbuch).
 */
router.get("/categories/options", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const kind = String(req.query.kind || "").trim().toUpperCase();
        const search = String(req.query.search || "").trim().slice(0, 80);
        const take = 25;
        if (!CATEGORY_KINDS.has(kind))
            return res.status(400).json({ error: "Unbekannte Kategorie-Art." });
        let options = [];
        if (kind === "STAFF") {
            const staffTenants = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId);
            const rows = await prisma_client_1.default.employee.findMany({
                where: {
                    tenantId: { in: staffTenants },
                    deletedAt: null,
                    isActive: true,
                    ...(search ? { OR: [{ firstName: { contains: search } }, { lastName: { contains: search } }, { email: { contains: search } }] } : {}),
                },
                select: { id: true, firstName: true, lastName: true, email: true },
                orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
                take,
            });
            options = rows.map((row) => ({ id: row.id, label: `${row.firstName} ${row.lastName}`.trim(), sublabel: row.email }));
        }
        else if (kind === "CUSTOMER") {
            const rows = await prisma_client_1.default.customer.findMany({
                where: { tenantId, ...(search ? { OR: [{ companyName: { contains: search } }, { mainEmail: { contains: search } }] } : {}) },
                select: { id: true, companyName: true, city: true },
                orderBy: { companyName: "asc" },
                take,
            });
            options = rows.map((row) => ({ id: row.id, label: row.companyName, sublabel: row.city || null }));
        }
        else if (kind === "TENDER") {
            /* Alle Fassungen eines Angebots teilen die Nummer — gezeigt wird
               je Nummer die jüngste Fassung. */
            const rows = await prisma_client_1.default.tender.findMany({
                where: { tenantId, ...(search ? { OR: [{ tenderNumber: { contains: search } }, { legacyNumber: { contains: search } }] } : {}) },
                select: { id: true, tenderNumber: true, version: true, customer: { select: { companyName: true } } },
                orderBy: [{ tenderNumber: "desc" }, { version: "desc" }],
                take: take * 3,
            });
            const seen = new Set();
            for (const row of rows) {
                if (seen.has(row.tenderNumber) || options.length >= take)
                    continue;
                seen.add(row.tenderNumber);
                options.push({ id: row.id, label: row.tenderNumber, sublabel: row.customer?.companyName || null });
            }
        }
        else if (kind === "ORDER") {
            const rows = await prisma_client_1.default.salesOrder.findMany({
                where: { tenantId, ...(search ? { OR: [{ orderNumber: { contains: search } }, { legacyNumber: { contains: search } }] } : {}) },
                select: { id: true, orderNumber: true, customer: { select: { companyName: true } } },
                orderBy: { orderNumber: "desc" },
                take,
            });
            options = rows.map((row) => ({ id: row.id, label: row.orderNumber, sublabel: row.customer?.companyName || null }));
        }
        else if (kind === "PROJECT") {
            const rows = await prisma_client_1.default.project.findMany({
                where: { tenantId, ...(search ? { OR: [{ projectNumber: { contains: search } }, { projectName: { contains: search } }] } : {}) },
                select: { id: true, projectNumber: true, projectName: true },
                orderBy: { projectNumber: "desc" },
                take,
            });
            options = rows.map((row) => ({ id: row.id, label: row.projectNumber, sublabel: row.projectName }));
        }
        else if (kind === "INVOICE") {
            const rows = await prisma_client_1.default.invoice.findMany({
                where: { tenantId, ...(search ? { OR: [{ invoiceNumber: { contains: search } }, { legacyNumber: { contains: search } }] } : {}) },
                select: { id: true, invoiceNumber: true, customer: { select: { companyName: true } } },
                orderBy: { invoiceNumber: "desc" },
                take,
            });
            options = rows.map((row) => ({ id: row.id, label: row.invoiceNumber, sublabel: row.customer?.companyName || null }));
        }
        res.json({ options });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Auswahl konnte nicht geladen werden." });
    }
});
router.post("/categories", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const kind = String(req.body?.kind || "").trim().toUpperCase();
        const entityId = String(req.body?.entityId || "").trim();
        if (!CATEGORY_KINDS.has(kind))
            return res.status(400).json({ error: "Unbekannte Kategorie-Art." });
        if (!entityId)
            return res.status(400).json({ error: "Kein Datensatz gewählt." });
        const name = await resolveCategoryEntity(tenantId, kind, entityId);
        if (!name)
            return res.status(404).json({ error: "Datensatz nicht gefunden." });
        const existing = await prisma_client_1.default.mailCategory.findFirst({ where: { tenantId, kind, entityId }, select: { id: true } });
        if (existing)
            return res.status(409).json({ error: "Diese Kategorie gibt es schon.", id: existing.id });
        const last = await prisma_client_1.default.mailCategory.aggregate({ where: { tenantId }, _max: { displayOrder: true } });
        const row = await prisma_client_1.default.mailCategory.create({
            data: {
                id: (0, nanoid_1.nanoid)(10),
                tenantId,
                kind,
                entityId,
                name: name.slice(0, 160),
                color: await nextCategoryColor(tenantId),
                displayOrder: (last._max.displayOrder ?? 0) + 1,
            },
        });
        res.status(201).json({ id: row.id, kind: row.kind, entityId: row.entityId, name: row.name, color: row.color, displayOrder: row.displayOrder, count: 0 });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Kategorie konnte nicht angelegt werden." });
    }
});
/** Die von Hand gezogene Reihenfolge der Leiste — ein Zug, ein Patch. */
router.patch("/categories/order", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : [];
        if (!ids.length)
            return res.status(400).json({ error: "Keine Reihenfolge übergeben." });
        const rows = await prisma_client_1.default.mailCategory.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } });
        const known = new Set(rows.map((row) => row.id));
        await prisma_client_1.default.$transaction(ids.filter((id) => known.has(id)).map((id, index) => prisma_client_1.default.mailCategory.update({ where: { id }, data: { displayOrder: index } })));
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Reihenfolge konnte nicht gespeichert werden." });
    }
});
router.delete("/categories/:id", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const row = await prisma_client_1.default.mailCategory.findFirst({ where: { id: String(req.params.id), tenantId }, select: { id: true, kind: true } });
        if (!row)
            return res.status(404).json({ error: "Kategorie nicht gefunden." });
        if (row.kind === "REQUESTS")
            return res.status(400).json({ error: "«Anfragen» ist fest eingebaut und lässt sich nicht löschen." });
        // Die Nachrichten bleiben — sie verlieren nur die Zuordnung (FK SetNull).
        await prisma_client_1.default.mailCategory.delete({ where: { id: row.id } });
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Kategorie konnte nicht gelöscht werden." });
    }
});
/** Nachrichten einer Kategorie zuordnen (oder mit null herausnehmen) — der
    Sammelmodus schickt jede Auswahl einzeln, das Ziehen genau eine. */
router.post("/messages/assign", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : [];
        if (!ids.length)
            return res.status(400).json({ error: "Keine Nachrichten gewählt." });
        const categoryId = req.body?.categoryId ? String(req.body.categoryId) : null;
        let categoryKind = null;
        if (categoryId) {
            const category = await prisma_client_1.default.mailCategory.findFirst({ where: { id: categoryId, tenantId }, select: { id: true, kind: true } });
            if (!category)
                return res.status(404).json({ error: "Kategorie nicht gefunden." });
            categoryKind = category.kind;
        }
        const result = await prisma_client_1.default.mailMessage.updateMany({
            where: { id: { in: ids }, tenantId },
            data: { categoryId },
        });
        /* «ANFRAGEN» IST MEHR ALS EIN ORDNER (10.09.2026, Vorgabe Samet): was
           hier hineinkommt, ist die Post von jemandem, der uns erreichen will
           und meistens noch nicht im System steht. Aus jeder EINGEHENDEN
           Nachricht wird darum eine Anfrage — mit Absender, Betreff und Text,
           ohne Kunden. Nebenzweig: schlaegt er fehl, bleibt die Zuordnung. */
        let enquiries = 0;
        if (categoryKind === "REQUESTS") {
            enquiries = await (0, enquiryFromMail_1.createEnquiriesFromMails)(tenantId, ids, req.user.id)
                .then((outcome) => outcome.created)
                .catch(() => 0);
        }
        res.json({ assigned: result.count, enquiries });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Zuordnung fehlgeschlagen." });
    }
});
const loadMessage = async (id, tenantId) => {
    const rows = await prisma_client_1.default.$queryRaw `
        SELECT m.*, cu.companyName AS customerName, ct.firstName AS contactFirstName, ct.lastName AS contactLastName,
               e.firstName AS byFirstName, e.lastName AS byLastName,
               mc.name AS categoryName, mc.color AS categoryColor
        FROM MailMessage m
        LEFT JOIN Customer cu ON cu.id = m.customerId
        LEFT JOIN CustomerContact ct ON ct.id = m.contactId
        LEFT JOIN Employee e ON e.id = m.employeeId
        LEFT JOIN MailCategory mc ON mc.id = m.categoryId
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
    bodyHtml: row.bodyHtml,
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
    category: row.categoryId ? { id: row.categoryId, name: row.categoryName, color: row.categoryColor } : null,
    deleted: Boolean(row.deletedAt),
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
        // Kategorie setzen oder (null) herausnehmen.
        if (body.categoryId !== undefined) {
            const categoryId = body.categoryId ? String(body.categoryId) : null;
            if (categoryId) {
                const category = await prisma_client_1.default.mailCategory.findFirst({ where: { id: categoryId, tenantId: user.tenantId }, select: { id: true } });
                if (!category)
                    return res.status(404).json({ error: "Kategorie nicht gefunden." });
            }
            data.categoryId = categoryId;
        }
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
/** Löschen = in den PAPIERKORB; aus dem Papierkorb heraus = endgültig.
    Beides betrifft nur den ERP-Eintrag — auf dem Mailserver bleibt die
    Nachricht unangetastet. */
router.delete("/messages/:id", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const row = await prisma_client_1.default.mailMessage.findFirst({
            where: { id: String(req.params.id), tenantId: req.user.tenantId },
            select: { id: true, deletedAt: true },
        });
        if (!row)
            return res.status(404).json({ error: "Nachricht nicht gefunden." });
        if (row.deletedAt)
            await prisma_client_1.default.mailMessage.delete({ where: { id: row.id } });
        else
            await prisma_client_1.default.mailMessage.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Löschen fehlgeschlagen." });
    }
});
/** Aus dem Papierkorb zurücklegen — die Nachricht steht wieder in ihrem
    Ordner und in ihrer Kategorie, als wäre nichts gewesen. */
router.post("/messages/:id/restore", AuthMiddleware_1.requireAuth, READ, async (req, res) => {
    try {
        const user = req.user;
        const row = await prisma_client_1.default.mailMessage.findFirst({
            where: { id: String(req.params.id), tenantId: user.tenantId },
            select: { id: true, deletedAt: true },
        });
        if (!row)
            return res.status(404).json({ error: "Nachricht nicht gefunden." });
        if (row.deletedAt)
            await prisma_client_1.default.mailMessage.update({ where: { id: row.id }, data: { deletedAt: null } });
        const fresh = await loadMessage(row.id, user.tenantId);
        res.json(messageDetailDto(fresh, user.id));
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Wiederherstellen fehlgeschlagen." });
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