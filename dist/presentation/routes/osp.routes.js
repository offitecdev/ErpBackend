"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const tenantTree_1 = require("../../shared/tenantTree");
const documentNumber_1 = require("../../shared/documentNumber");
const customerAddress_1 = require("../../application/utils/customerAddress");
const OspClient_1 = require("../../infrastructure/services/OspClient");
const ospDatasheet_1 = require("../../infrastructure/services/ospDatasheet");
const LocalFileStorage_1 = require("../../infrastructure/services/LocalFileStorage");
/**
 * ── OSP-MODUL (Offitec Selection Platform, 04.09.2026) ──────────────────────
 * Eingehender Webhook der OSP-Offertanfragen, die Belegliste der OSP-Seite
 * (/sales/osp), Statuspflege mit Rückmeldung an die OSP und der Offerten-
 * Import ("Offerte aus OSP erzeugen").
 *
 * Grundsätze:
 *  • Der Feed hängt am WURZEL-Mandanten; welche Mandanten ihn sehen, sagt
 *    `OspSetting.tenantIds` (Einstellungen → Module → Verkauf → OSP).
 *  • OSP-Zeilen legen NIEMALS Artikel oder Bestand an — der Import erzeugt
 *    eine Offerte mit reinen Textpositionen (rowType CUSTOM), nur für diese
 *    eine Offerte.
 *  • Der Kunde des Imports darf ein CRM-Kunde sein ODER von Hand eingegeben
 *    werden (Tender.manualCustomer*) — von Hand heisst: NIRGENDS registriert.
 *  • Jede Meldung an die OSP ist Best-Effort; Ausgang + Fehler stehen an der
 *    Zeile (lastReport*).
 */
const router = (0, express_1.Router)();
const OSP_STATUSES = ['LISTED', 'IN_OFFER', 'SENT', 'APPROVED'];
const SETTINGS_MANAGE = ['tenders.manage', 'roles.manage', 'tenants.update'];
/** Standard-Seitengrösse der Liste — "in Gruppen von 15 ziehen" (Vorgabe). */
const PAGE_SIZE = 15;
/* ── kleine Helfer ──────────────────────────────────────────────────────── */
const asTrimmed = (value) => {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
};
/** Schlüsselvergleich in konstanter Zeit — es ist eine Authentifizierung. */
const keysMatch = (a, b) => {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length)
        return false;
    return crypto_1.default.timingSafeEqual(left, right);
};
/** "4820193-57" → { projectNumber: "4820193", documentId: "57" }. */
const parseReference = (reference) => {
    const splitAt = reference.lastIndexOf('-');
    if (splitAt <= 0)
        return { projectNumber: reference, documentId: null };
    return { projectNumber: reference.slice(0, splitAt), documentId: reference.slice(splitAt + 1) };
};
const parseTenantIds = (value) => {
    if (Array.isArray(value))
        return value.map(String).filter(Boolean);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
        }
        catch {
            return [];
        }
    }
    return [];
};
/** Wurzel + Einstellungen + Sichtbarkeit für den angemeldeten Mandanten. */
const loadFeedContext = async (tenantId) => {
    const rootId = await (0, tenantTree_1.findTenantRootIdCached)(tenantId);
    if (!rootId)
        return null;
    const setting = await prisma_client_1.default.ospSetting.findUnique({ where: { tenantId: rootId } });
    const selected = parseTenantIds(setting?.tenantIds);
    const visible = tenantId === rootId || selected.includes(tenantId);
    return { rootId, setting, visible };
};
/** Meldung an die OSP + Protokoll an der Zeile — Best-Effort, wirft nie. */
const reportDocumentStatus = async (setting, doc, internalStatus, salesmanEmail, 
// Mitgeschickt als §3-"salesman"-Objekt, damit die Kundschaft drüben einen
// Namen sieht, auch wenn die Adresse dort kein OSP-Konto hat.
salesmanName) => {
    const wireStatus = OspClient_1.OSP_WIRE_STATUS[internalStatus];
    if (!wireStatus || !setting)
        return;
    const result = await (0, OspClient_1.reportOspOfferStatus)(setting, doc.reference, wireStatus, salesmanEmail, salesmanName);
    await prisma_client_1.default.ospDocument.update({
        where: { id: doc.id },
        data: result.ok
            ? { lastReportedStatus: wireStatus, lastReportAt: new Date(), lastReportError: null }
            : {
                lastReportError: result.skipped
                    ? 'OSP-Zugang nicht konfiguriert (Basisadresse/Schlüssel fehlen).'
                    : result.error || 'Unbekannter Fehler.',
            },
    }).catch(() => undefined);
};
/**
 * Das Datenblatt einer Zeile holen, ablegen und auslesen — Best-Effort, wirft
 * nie. Erfolg wie Misserfolg stehen danach an der Zeile (datasheet*), genau
 * wie bei den Statusmeldungen: die Verkaufsseite sieht, WARUM nichts da ist.
 */
const storeDatasheet = async (setting, documentId, url) => {
    if (!setting)
        return;
    const previous = await prisma_client_1.default.ospDocument.findUnique({
        where: { id: documentId },
        select: { datasheetFile: true },
    }).catch(() => null);
    const result = await (0, ospDatasheet_1.fetchOspDatasheet)(setting, setting.tenantId, url);
    await prisma_client_1.default.ospDocument.update({
        where: { id: documentId },
        data: result.ok
            ? {
                datasheetFile: result.file ?? null,
                datasheetSpecs: (result.specs ?? null),
                datasheetFetchedAt: new Date(),
                // Ein unlesbares, aber abgelegtes PDF behält seinen Hinweis.
                datasheetError: result.error ?? null,
            }
            : { datasheetError: result.error || 'Datenblatt konnte nicht geholt werden.' },
    }).catch(() => undefined);
    // Die alte Datei erst entfernen, wenn die neue sicher an der Zeile steht.
    const old = previous?.datasheetFile;
    if (result.ok && old && old !== result.file) {
        await LocalFileStorage_1.ospDatasheetStorage.remove(old).catch(() => undefined);
    }
};
const employeeDisplayName = (employee) => [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() || employee.email || '';
/* ── 1) Eingehender Webhook (OHNE JWT — gemeinsamer Schlüssel) ───────────── */
router.post('/webhook', async (req, res) => {
    try {
        const key = asTrimmed(req.header('x-osp-integration-key'));
        const settings = await prisma_client_1.default.ospSetting.findMany({
            where: { NOT: { webhookKey: null } },
        });
        const armed = settings.filter((row) => asTrimmed(row.webhookKey));
        // Kein konfigurierter Schlüssel → niemals offen durchfallen (wie die
        // OSP selbst: 503 statt offen).
        if (!armed.length) {
            return res.status(503).json({ message: 'OSP integration key is not configured.' });
        }
        const setting = key ? armed.find((row) => keysMatch(asTrimmed(row.webhookKey) || '', key)) : null;
        if (!setting)
            return res.status(401).json({ message: 'Missing or wrong X-OSP-Integration-Key.' });
        const body = Array.isArray(req.body) ? req.body : (req.body ? [req.body] : []);
        const entries = body.filter((entry) => entry && typeof entry === 'object');
        if (!entries.length)
            return res.status(400).json({ message: 'Empty payload.' });
        const created = [];
        /** Datenblätter, die nach der Quittung geholt werden (siehe unten). */
        const datasheetJobs = [];
        let updated = 0;
        for (const entry of entries) {
            const reference = asTrimmed(entry.projectNumber);
            if (!reference)
                continue;
            const { projectNumber, documentId } = parseReference(reference);
            const ospCreatedAtRaw = asTrimmed(entry.created_at);
            const ospCreatedAt = ospCreatedAtRaw && !Number.isNaN(Date.parse(ospCreatedAtRaw))
                ? new Date(ospCreatedAtRaw)
                : null;
            // Beschreibende Felder werden bei JEDER Lieferung aufgefrischt;
            // der Bearbeitungsstand und die Zuständigkeit bleiben unangetastet
            // (erneute Lieferung derselben Anfrage ist erlaubt und sicher).
            const descriptive = {
                projectNumber,
                documentId,
                projectName: asTrimmed(entry.projectName) || '',
                requesterFirstName: asTrimmed(entry.username),
                requesterLastName: asTrimmed(entry.surname),
                requesterEmail: asTrimmed(entry.email),
                company: asTrimmed(entry.company),
                country: asTrimmed(entry.country),
                city: asTrimmed(entry.city),
                address: asTrimmed(entry.address),
                postalCode: asTrimmed(entry.postalCode),
                userType: asTrimmed(entry.userType),
                category: asTrimmed(entry.category),
                unitType: asTrimmed(entry.type),
                model: asTrimmed(entry.model),
                ospCreatedAt,
                // Die Adresse des ECHTEN Datenblatt-PDF (nicht der Link auf die
                // Offerte drüben) — und der unveränderte Eintrag dazu, damit
                // später nachvollziehbar bleibt, was tatsächlich geliefert wurde.
                datasheetUrl: (0, ospDatasheet_1.pickDatasheetUrl)(entry),
                rawPayload: entry,
            };
            const existing = await prisma_client_1.default.ospDocument.findUnique({
                where: { tenantId_reference: { tenantId: setting.tenantId, reference } },
                select: { id: true, datasheetUrl: true, datasheetFile: true },
            });
            if (existing) {
                await prisma_client_1.default.ospDocument.update({ where: { id: existing.id }, data: descriptive });
                updated += 1;
                // Erneut geholt wird nur, wenn das Datenblatt fehlt oder die OSP
                // auf eine ANDERE Datei zeigt — sonst bliebe es bei jeder
                // Wiederholung derselben Anfrage beim Herunterladen.
                if (descriptive.datasheetUrl
                    && (!existing.datasheetFile || existing.datasheetUrl !== descriptive.datasheetUrl)) {
                    datasheetJobs.push({ id: existing.id, url: descriptive.datasheetUrl });
                }
            }
            else {
                const row = await prisma_client_1.default.ospDocument.create({
                    data: { id: (0, nanoid_1.nanoid)(12), tenantId: setting.tenantId, reference, status: 'LISTED', ...descriptive },
                    select: { id: true, reference: true },
                });
                created.push(row);
                if (descriptive.datasheetUrl)
                    datasheetJobs.push({ id: row.id, url: descriptive.datasheetUrl });
            }
        }
        // Antwort sofort — die "created"-Bestätigung an die OSP ist Kür und
        // läuft im Hintergrund (Best-Effort, §3: salesman dabei optional).
        res.status(200).json({
            received: entries.length,
            created: created.length,
            updated,
            datasheets: datasheetJobs.length,
        });
        for (const row of created) {
            void reportDocumentStatus(setting, row, 'LISTED').catch(() => undefined);
        }
        // Das Datenblatt wird ebenfalls im Hintergrund geholt: die OSP wartet
        // auf eine schnelle Quittung, nicht auf unseren Dateidownload.
        for (const job of datasheetJobs) {
            void storeDatasheet(setting, job.id, job.url).catch(() => undefined);
        }
    }
    catch (error) {
        res.status(500).json({ message: error?.message || 'Webhook failed.' });
    }
});
/* ── 1b) Änderungs-Webhook (Vertragsfassung (2), §1b) ────────────────────────
   Die Kundschaft arbeitet nach der Anfrage weiter (Neuberechnung, Optionen,
   Sprache …) — die OSP rendert das Datenblatt neu und meldet das hier als
   EINZELNES Objekt je Änderung: { projectNumber, projectName, model, change,
   offerStatus, pdfUrl, changed_at }. Wir holen das NEUE PDF und lesen die
   Angaben neu aus; Bearbeitungsstand, Zuständigkeit und die Angaben der
   anfragenden Person bleiben unangetastet (die stehen nur im §1-Webhook).
   Eigene Adresse (DOCUMENT_CHANGE_WEBHOOK_URL), derselbe Schlüssel wie §1. */
router.post('/webhook/change', async (req, res) => {
    try {
        const key = asTrimmed(req.header('x-osp-integration-key'));
        const settings = await prisma_client_1.default.ospSetting.findMany({
            where: { NOT: { webhookKey: null } },
        });
        const armed = settings.filter((row) => asTrimmed(row.webhookKey));
        if (!armed.length) {
            return res.status(503).json({ message: 'OSP integration key is not configured.' });
        }
        const setting = key ? armed.find((row) => keysMatch(asTrimmed(row.webhookKey) || '', key)) : null;
        if (!setting)
            return res.status(401).json({ message: 'Missing or wrong X-OSP-Integration-Key.' });
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
        const reference = asTrimmed(body?.projectNumber);
        if (!reference)
            return res.status(400).json({ message: 'projectNumber is required.' });
        const doc = await prisma_client_1.default.ospDocument.findUnique({
            where: { tenantId_reference: { tenantId: setting.tenantId, reference } },
            select: { id: true, datasheetUrl: true },
        });
        // Eine Änderung zu einem Beleg, den wir nie bekommen haben, ist kein
        // Fehler — die OSP wiederholt nicht, also freundlich quittieren.
        if (!doc)
            return res.status(200).json({ received: 1, matched: 0 });
        const url = (0, ospDatasheet_1.pickDatasheetUrl)(body);
        const data = {};
        const projectName = asTrimmed(body?.projectName);
        const model = asTrimmed(body?.model);
        if (projectName)
            data.projectName = projectName;
        if (model)
            data.model = model;
        if (url)
            data.datasheetUrl = url;
        if (Object.keys(data).length) {
            await prisma_client_1.default.ospDocument.update({ where: { id: doc.id }, data });
        }
        res.status(200).json({ received: 1, matched: 1, datasheets: url ? 1 : 0 });
        // Das NEUE Datenblatt ersetzt die abgelegte Kopie samt Angaben — im
        // Hintergrund, die OSP wartet nur auf die Quittung.
        if (url)
            void storeDatasheet(setting, doc.id, url).catch(() => undefined);
    }
    catch (error) {
        res.status(500).json({ message: error?.message || 'Change webhook failed.' });
    }
});
/* ── 2) Belegliste der OSP-Seite (Seiten zu 15) ──────────────────────────── */
router.get('/documents', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const feed = await loadFeedContext(tenantId);
        if (!feed)
            return res.status(403).json({ error: 'Kein aktiver Firmenbaum.' });
        if (!feed.visible)
            return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || PAGE_SIZE));
        const status = asTrimmed(req.query.status);
        const q = asTrimmed(req.query.q);
        const where = { tenantId: feed.rootId };
        if (status && OSP_STATUSES.includes(status))
            where.status = status;
        if (q) {
            where.OR = [
                { reference: { contains: q } },
                { projectName: { contains: q } },
                { model: { contains: q } },
                { requesterFirstName: { contains: q } },
                { requesterLastName: { contains: q } },
                { requesterEmail: { contains: q } },
                { company: { contains: q } },
                { country: { contains: q } },
            ];
        }
        const [items, total, grouped] = await Promise.all([
            prisma_client_1.default.ospDocument.findMany({
                where,
                orderBy: [{ ospCreatedAt: 'desc' }, { createdAt: 'desc' }],
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            prisma_client_1.default.ospDocument.count({ where }),
            prisma_client_1.default.ospDocument.groupBy({
                by: ['status'],
                where: { tenantId: feed.rootId },
                _count: { _all: true },
            }),
        ]);
        /* Selbstheilung verwaister Verknüpfungen (27.08.2026): wurde die
           Offerte einer Zeile gelöscht, ohne dass die Zeile freigegeben wurde
           (Löschung über einen älteren Serverstand), verliert sie ihre
           tenderId HIER — und bietet sofort wieder "Offerte erstellen" an. */
        const linked = items.filter((doc) => doc.tenderId);
        if (linked.length) {
            const existingTenders = new Set((await prisma_client_1.default.tender.findMany({
                where: { id: { in: linked.map((doc) => doc.tenderId) } },
                select: { id: true },
            })).map((t) => t.id));
            const orphaned = linked.filter((doc) => !existingTenders.has(doc.tenderId));
            if (orphaned.length) {
                await prisma_client_1.default.ospDocument.updateMany({
                    where: { id: { in: orphaned.map((doc) => doc.id) } },
                    data: { tenderId: null, tenderNumber: null },
                });
                for (const doc of orphaned) {
                    doc.tenderId = null;
                    doc.tenderNumber = null;
                }
            }
        }
        /* Selbstpflege des Standes: hängt an einer Zeile eine Offerte, deren
           Angebotsmail inzwischen HINAUS ist, rückt die Zeile von IN_OFFER auf
           SENT vor — und die OSP bekommt "offer has been sent" gemeldet. So
           braucht der Mailweg der Offerte keinen OSP-Haken. */
        const mailCandidates = items.filter((doc) => doc.status === 'IN_OFFER' && doc.tenderId);
        if (mailCandidates.length) {
            const tenders = await prisma_client_1.default.tender.findMany({
                where: { id: { in: mailCandidates.map((doc) => doc.tenderId) } },
                select: { id: true, offerMailSentAt: true },
            });
            const sentTenders = new Set(tenders.filter((t) => t.offerMailSentAt).map((t) => t.id));
            for (const doc of mailCandidates) {
                if (!sentTenders.has(doc.tenderId))
                    continue;
                doc.status = 'SENT';
                await prisma_client_1.default.ospDocument.update({ where: { id: doc.id }, data: { status: 'SENT' } });
                void reportDocumentStatus(feed.setting, doc, 'SENT', doc.salespersonEmail, doc.salespersonName).catch(() => undefined);
            }
        }
        const counts = { LISTED: 0, IN_OFFER: 0, SENT: 0, APPROVED: 0 };
        for (const row of grouped) {
            if (OSP_STATUSES.includes(row.status)) {
                counts[row.status] = row._count._all;
            }
        }
        res.json({
            items,
            total,
            page,
            pageSize,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            counts,
            configured: Boolean(feed.setting),
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'OSP-Liste fehlgeschlagen.' });
    }
});
/* ── 3) Zeile pflegen: Status / zuständige Person / Rolle ────────────────── */
router.patch('/documents/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const feed = await loadFeedContext(tenantId);
        if (!feed?.visible)
            return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        const doc = await prisma_client_1.default.ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
        });
        if (!doc)
            return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });
        const data = {};
        const body = req.body || {};
        if (body.status !== undefined) {
            const status = String(body.status || '').toUpperCase();
            if (!OSP_STATUSES.includes(status)) {
                return res.status(400).json({ error: 'Unbekannter Status.' });
            }
            data.status = status;
        }
        // Verkäufer:in und Projektleiter:in sind ZWEI eigene Zuständigkeiten,
        // die je direkt gewählt werden (bis 05.09.2026 war es eine Person mit
        // umschaltbarer Rolle). Beide werden gleich aufgelöst.
        for (const role of [
            { field: 'salespersonId', columns: ['salespersonId', 'salespersonEmail', 'salespersonName'] },
            { field: 'projectManagerId', columns: ['projectManagerId', 'projectManagerEmail', 'projectManagerName'] },
        ]) {
            const requested = body[role.field];
            if (requested === undefined)
                continue;
            const [idColumn, emailColumn, nameColumn] = role.columns;
            if (!requested) {
                data[idColumn] = null;
                data[emailColumn] = null;
                data[nameColumn] = null;
                continue;
            }
            // Person kommt aus dem Personalverzeichnis — Name und E-Mail
            // werden hier aufgelöst, nie vom Client übernommen.
            const treeIds = (0, tenantTree_1.collectDescendantIds)(await (0, tenantTree_1.getAllTenants)(), feed.rootId);
            const employee = await prisma_client_1.default.employee.findFirst({
                where: { id: String(requested), tenantId: { in: treeIds } },
                select: { id: true, firstName: true, lastName: true, email: true },
            });
            if (!employee)
                return res.status(404).json({ error: 'Mitarbeiter nicht gefunden.' });
            data[idColumn] = employee.id;
            data[emailColumn] = employee.email || null;
            data[nameColumn] = employeeDisplayName(employee);
        }
        const nextStatus = data.status ?? doc.status;
        const nextEmail = data.salespersonEmail !== undefined ? data.salespersonEmail : doc.salespersonEmail;
        // "under review" und "offer has been sent" sind ohne Verkäufer:in
        // bedeutungslos — die OSP lehnt sie ab (400), also lehnen wir zuerst ab.
        // (Die Projektleitung ist intern und wird nie gemeldet.) Geprüft wird
        // nur, wenn die Änderung Status oder Verkauf ANFASST: sonst könnte an
        // einer alten Zeile ohne Verkäufer-E-Mail nicht einmal mehr die
        // Projektleitung eingetragen werden.
        const touchesReported = body.status !== undefined || body.salespersonId !== undefined;
        if (touchesReported && (nextStatus === 'IN_OFFER' || nextStatus === 'SENT') && !nextEmail) {
            return res.status(400).json({ error: 'Für diesen Status muss zuerst eine Verkäuferin oder ein Verkäufer gewählt werden.' });
        }
        const updatedDoc = await prisma_client_1.default.ospDocument.update({ where: { id: doc.id }, data });
        // Nur eine ECHTE Änderung meldet an die OSP (erneute Zustellung wäre
        // drüben zwar sicher, hier aber sinnlos).
        const statusChanged = nextStatus !== doc.status;
        const personChanged = nextEmail !== doc.salespersonEmail;
        if ((statusChanged || personChanged) && (nextStatus === 'IN_OFFER' || nextStatus === 'SENT')) {
            await reportDocumentStatus(feed.setting, updatedDoc, nextStatus, nextEmail, updatedDoc.salespersonName);
        }
        res.json(await prisma_client_1.default.ospDocument.findUnique({ where: { id: doc.id } }));
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'OSP-Beleg konnte nicht gespeichert werden.' });
    }
});
/* ── 3b) Das Datenblatt: öffnen und (bei Bedarf) erneut holen ────────────── */
/**
 * Das abgelegte PDF ausliefern. Es geht durch UNSER Programm, nicht als Link
 * auf die OSP: die Adresse drüben ist zeitlich begrenzt, und die Datei soll
 * auch dann noch aufgehen, wenn die Anfrage längst erledigt ist.
 */
router.get('/documents/:id/datasheet', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), async (req, res) => {
    try {
        const feed = await loadFeedContext(req.user.tenantId);
        if (!feed?.visible)
            return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        const doc = await prisma_client_1.default.ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
            select: { reference: true, datasheetFile: true },
        });
        if (!doc)
            return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });
        if (!doc.datasheetFile)
            return res.status(404).json({ error: 'Zu diesem Beleg liegt kein Datenblatt.' });
        const body = await LocalFileStorage_1.ospDatasheetStorage.read(doc.datasheetFile);
        res.setHeader('Content-Type', 'application/pdf');
        // `inline`: das Datenblatt gehört angeschaut, nicht heruntergeladen.
        res.setHeader('Content-Disposition', `inline; filename="Datenblatt-${doc.reference}.pdf"`);
        res.setHeader('Content-Length', String(body.length));
        res.end(body);
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'Datenblatt konnte nicht geladen werden.' });
    }
});
/** Erneut holen — für den Fall, dass die OSP beim ersten Versuch schwieg. */
router.post('/documents/:id/datasheet', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), async (req, res) => {
    try {
        const feed = await loadFeedContext(req.user.tenantId);
        if (!feed?.visible)
            return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        if (!feed.setting)
            return res.status(400).json({ error: 'OSP ist noch nicht konfiguriert.' });
        const doc = await prisma_client_1.default.ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
            select: { id: true, datasheetUrl: true },
        });
        if (!doc)
            return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });
        // Die Adresse darf auch von Hand kommen — dann steht sie danach an der
        // Zeile und gilt als das Datenblatt dieses Belegs.
        const url = asTrimmed(req.body?.datasheetUrl) || doc.datasheetUrl;
        if (!url)
            return res.status(400).json({ error: 'Die OSP hat zu diesem Beleg keine Datenblatt-Adresse geliefert.' });
        if (url !== doc.datasheetUrl) {
            await prisma_client_1.default.ospDocument.update({ where: { id: doc.id }, data: { datasheetUrl: url } });
        }
        await storeDatasheet(feed.setting, doc.id, url);
        res.json(await prisma_client_1.default.ospDocument.findUnique({ where: { id: doc.id } }));
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'Datenblatt konnte nicht geholt werden.' });
    }
});
/* ── 4) Import: Offerte aus einem OSP-Beleg erzeugen ─────────────────────── */
router.post('/documents/:id/import', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), async (req, res) => {
    try {
        const user = req.user;
        const feed = await loadFeedContext(user.tenantId);
        if (!feed?.visible)
            return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        const doc = await prisma_client_1.default.ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
        });
        if (!doc)
            return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });
        if (doc.tenderId) {
            const existing = await prisma_client_1.default.tender.findFirst({ where: { id: doc.tenderId }, select: { id: true } });
            if (existing)
                return res.status(409).json({ error: 'Zu diesem Beleg besteht bereits eine Offerte.', tenderId: doc.tenderId });
        }
        const body = req.body || {};
        const customerId = asTrimmed(body.customerId);
        const manual = body.manualCustomer && typeof body.manualCustomer === 'object' ? body.manualCustomer : null;
        const manualName = manual ? asTrimmed(manual.name) : null;
        // Kein Name ist KEIN Fehler mehr (27.08.2026): der Import läuft ohne
        // Fenster durch, und der Kundenname ist an der Offerte frei tippbar —
        // eine Anfrage ohne Firmennamen erzeugt schlicht eine Offerte ohne
        // Kundschaft, die danach dort erfasst wird.
        let crmCustomer = null;
        if (customerId) {
            crmCustomer = await prisma_client_1.default.customer.findFirst({
                where: { id: customerId, tenantId: user.tenantId },
                select: {
                    id: true, companyName: true, mainEmail: true,
                    address: true, postalCode: true, city: true, country: true,
                },
            });
            if (!crmCustomer)
                return res.status(404).json({ error: 'Kunde nicht gefunden.' });
        }
        const rawPositions = Array.isArray(body.positions) ? body.positions : [];
        const positions = rawPositions
            .map((row) => ({
            title: asTrimmed(row?.title),
            descriptionHtml: typeof row?.descriptionHtml === 'string' ? row.descriptionHtml : null,
            quantity: Number.isFinite(Number(row?.quantity)) ? Math.max(0, Number(row.quantity)) : 1,
            unit: asTrimmed(row?.unit) || 'Stk',
            unitPrice: Number.isFinite(Number(row?.unitPrice)) ? Math.max(0, Number(row.unitPrice)) : 0,
            taxRate: Number.isFinite(Number(row?.taxRate)) ? Math.max(0, Number(row.taxRate)) : 8.1,
        }))
            .filter((row) => row.title);
        if (!positions.length)
            return res.status(400).json({ error: 'Mindestens eine Position angeben.' });
        // Zuständige Personen: gewählt oder (bei der Verkaufsseite) die
        // anlegende Person selbst. Die Projektleitung bleibt leer, wenn sie
        // niemand gewählt hat — sie wird nie stillschweigend gesetzt.
        const findEmployee = async (employeeId) => {
            const treeIds = (0, tenantTree_1.collectDescendantIds)(await (0, tenantTree_1.getAllTenants)(), feed.rootId);
            const employee = await prisma_client_1.default.employee.findFirst({
                where: { id: employeeId, tenantId: { in: treeIds } },
                select: { id: true, firstName: true, lastName: true, email: true },
            });
            return employee
                ? { id: employee.id, email: employee.email || null, name: employeeDisplayName(employee) }
                : null;
        };
        let salesperson = doc.salespersonId
            ? { id: doc.salespersonId, email: doc.salespersonEmail, name: doc.salespersonName }
            : null;
        const requestedSalespersonId = asTrimmed(body.salespersonId);
        if (requestedSalespersonId) {
            salesperson = await findEmployee(requestedSalespersonId);
            if (!salesperson)
                return res.status(404).json({ error: 'Mitarbeiter nicht gefunden.' });
        }
        if (!salesperson) {
            salesperson = { id: user.id, email: user.email || null, name: employeeDisplayName(user) };
        }
        let projectManager = doc.projectManagerId
            ? { id: doc.projectManagerId, email: doc.projectManagerEmail, name: doc.projectManagerName }
            : null;
        const requestedProjectManagerId = asTrimmed(body.projectManagerId);
        if (requestedProjectManagerId) {
            projectManager = await findEmployee(requestedProjectManagerId);
            if (!projectManager)
                return res.status(404).json({ error: 'Mitarbeiter nicht gefunden.' });
        }
        // Mehrzeilige manuelle Adresse: Strasse / PLZ Ort / Land.
        const manualAddress = manual
            ? [
                asTrimmed(manual.address),
                [asTrimmed(manual.postalCode), asTrimmed(manual.city)].filter(Boolean).join(' ') || null,
                asTrimmed(manual.country),
            ].filter(Boolean).join('\n') || null
            : null;
        const manualEmail = manual ? asTrimmed(manual.email) : null;
        // Die manuellen Felder sind die OFFERTEN-EIGENEN Angaben und gelten vor
        // dem Kundenstamm (siehe TenderRepository). Bei einem CRM-Kunden wird
        // deshalb nur festgehalten, was von seiner Karte ABWEICHT — sonst fröre
        // die Offerte eine Kopie ein, die spätere Korrekturen am Kunden nicht
        // mehr mitbekäme. Geschrieben wird in KEINEM Fall zurück in den Stamm.
        const deviating = (value, ofCustomer) => {
            if (!value)
                return null;
            if (!crmCustomer)
                return value;
            return value.trim() === String(ofCustomer ?? '').trim() ? null : value;
        };
        const crmAddress = crmCustomer ? (0, customerAddress_1.formatCustomerAddress)(crmCustomer) : null;
        const tenderNumber = await (0, documentNumber_1.nextDocumentNumber)(user.tenantId, 'QUOTE');
        const validUntil = new Date();
        validUntil.setDate(validUntil.getDate() + 30);
        const tender = await prisma_client_1.default.tender.create({
            data: {
                id: (0, nanoid_1.nanoid)(10),
                tenantId: user.tenantId,
                customerId: customerId || null,
                tenderNumber,
                version: 1,
                format: 'SIA451',
                status: 'Draft',
                validUntil,
                // Die OSP-Referenz ist die "Referenz" der Offerte — so findet
                // man den Beleg auf dem PDF und in der OSP wieder.
                customerReference: doc.reference,
                salespersonName: salesperson.name || null,
                manualCustomerName: deviating(manualName, crmCustomer?.companyName),
                manualCustomerEmail: deviating(manualEmail, crmCustomer?.mainEmail),
                manualCustomerAddress: deviating(manualAddress, crmAddress),
                // Popup'ta düzenlenen adres yalnız bu teklifin adresidir.
                // Bir CRM müşterisi seçilmiş olsa da müşteri kartına yazılmaz.
                billingAddress: manualAddress,
                createdByEmployeeId: user.id,
            },
        });
        // Reine Textpositionen — bewusst OHNE Artikelbezug: nichts davon
        // erscheint je im Lager oder im Artikelstamm.
        await prisma_client_1.default.position.createMany({
            data: positions.map((row, index) => ({
                id: (0, nanoid_1.nanoid)(10),
                tenantId: user.tenantId,
                tenderId: tender.id,
                rowType: 'CUSTOM',
                positionNumber: String(index + 1),
                shortDescription: row.title,
                longDescription: row.descriptionHtml,
                quantity: row.quantity,
                unit: row.unit,
                unitPrice: row.unitPrice,
                taxRate: row.taxRate,
                displayOrder: index,
                hierarchyLevel: 0,
            })),
        });
        await prisma_client_1.default.tenderActivityLog.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId: user.tenantId,
                tenderId: tender.id,
                employeeId: user.id,
                actionType: 'TENDER_CREATED',
                newValue: tenderNumber,
                description: `${tenderNumber} aus OSP-Beleg ${doc.reference} erzeugt.`,
            },
        }).catch(() => undefined);
        const updatedDoc = await prisma_client_1.default.ospDocument.update({
            where: { id: doc.id },
            data: {
                status: 'IN_OFFER',
                tenderId: tender.id,
                tenderNumber,
                salespersonId: salesperson.id,
                salespersonEmail: salesperson.email,
                salespersonName: salesperson.name,
                ...(projectManager
                    ? {
                        projectManagerId: projectManager.id,
                        projectManagerEmail: projectManager.email,
                        projectManagerName: projectManager.name,
                    }
                    : {}),
            },
        });
        // "under review" braucht die zuständige Person — ohne E-Mail-Adresse
        // wird gar nicht gemeldet (die OSP würde mit 400 ablehnen).
        if (salesperson.email) {
            await reportDocumentStatus(feed.setting, updatedDoc, 'IN_OFFER', salesperson.email, salesperson.name);
        }
        res.status(201).json({ tenderId: tender.id, tenderNumber, document: updatedDoc });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'OSP-Import fehlgeschlagen.' });
    }
});
/* ── 5) Abgleich mit der OSP ("Transfer") — in Gruppen von 15 ────────────── */
router.post('/sync', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const feed = await loadFeedContext(tenantId);
        if (!feed?.visible)
            return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        if (!feed.setting)
            return res.status(400).json({ error: 'OSP ist noch nicht konfiguriert.' });
        const docs = await prisma_client_1.default.ospDocument.findMany({
            where: { tenantId: feed.rootId },
            select: { id: true, reference: true, projectNumber: true, status: true, salespersonEmail: true, salespersonName: true },
        });
        if (!docs.length)
            return res.json({ checked: 0, updated: 0, failed: 0 });
        // EINE Abfrage je Projektnummer holt alle Belege des Projekts (§4) —
        // und gezogen wird in Gruppen von 15 (Vorgabe).
        const projectNumbers = Array.from(new Set(docs.map((d) => String(d.projectNumber)).filter(Boolean)));
        const byReference = new Map();
        let failed = 0;
        for (let start = 0; start < projectNumbers.length; start += 15) {
            const chunk = projectNumbers.slice(start, start + 15);
            const results = await Promise.all(chunk.map((projectNumber) => (0, OspClient_1.fetchOspOfferStatus)(feed.setting, projectNumber)));
            for (const result of results) {
                if (!result.ok) {
                    failed += 1;
                    continue;
                }
                for (const row of result.rows || []) {
                    if (row?.reference)
                        byReference.set(String(row.reference), row);
                }
            }
        }
        let updated = 0;
        for (const doc of docs) {
            const row = byReference.get(doc.reference);
            if (!row)
                continue;
            const mapped = OspClient_1.OSP_ENUM_TO_INTERNAL[String(row.status || '').toUpperCase()] || null;
            const data = {};
            // Der Abgleich bewegt den Stand nur VORWÄRTS — was hier weiter ist
            // (z. B. APPROVED, das die OSP nicht kennt), bleibt stehen.
            if (mapped && (OspClient_1.OSP_STATUS_RANK[mapped] ?? -1) > (OspClient_1.OSP_STATUS_RANK[doc.status] ?? 0)) {
                data.status = mapped;
            }
            if (mapped)
                data.lastReportedStatus = OspClient_1.OSP_WIRE_STATUS[mapped] ?? doc.lastReportedStatus;
            const salesmanEmail = asTrimmed(row.salesman?.email);
            if (salesmanEmail && !doc.salespersonEmail) {
                data.salespersonEmail = salesmanEmail;
                data.salespersonName = [row.salesman?.name, row.salesman?.surname].filter(Boolean).join(' ') || doc.salespersonName;
            }
            if (Object.keys(data).length) {
                await prisma_client_1.default.ospDocument.update({ where: { id: doc.id }, data });
                updated += 1;
            }
        }
        res.json({ checked: docs.length, updated, failed });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'OSP-Abgleich fehlgeschlagen.' });
    }
});
/* ── 6) Einstellungen (Einstellungen → Module → Verkauf → OSP) ───────────── */
router.get('/settings', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(SETTINGS_MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const rootId = await (0, tenantTree_1.findTenantRootIdCached)(tenantId);
        if (!rootId)
            return res.status(403).json({ error: 'Kein aktiver Firmenbaum.' });
        const setting = await prisma_client_1.default.ospSetting.findUnique({ where: { tenantId: rootId } });
        res.json({
            rootTenantId: rootId,
            tenantIds: parseTenantIds(setting?.tenantIds),
            webhookKey: setting?.webhookKey || '',
            ospBaseUrl: setting?.ospBaseUrl || '',
            hasApiKey: Boolean(asTrimmed(setting?.ospApiKey)),
            // Die Adresse, die der OSP als OFFER_WEBHOOK_URL zu nennen ist —
            // relativ; die Oberfläche stellt den eigenen Ursprung davor.
            webhookPath: '/backend/api/v1/osp/webhook',
            // … und die DOCUMENT_CHANGE_WEBHOOK_URL für §1b (eigene Adresse,
            // weil die beiden Körper verschieden geformt sind).
            changeWebhookPath: '/backend/api/v1/osp/webhook/change',
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'OSP-Einstellungen fehlgeschlagen.' });
    }
});
router.put('/settings', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(SETTINGS_MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const rootId = await (0, tenantTree_1.findTenantRootIdCached)(tenantId);
        if (!rootId)
            return res.status(403).json({ error: 'Kein aktiver Firmenbaum.' });
        const body = req.body || {};
        const data = {};
        if (body.tenantIds !== undefined) {
            const requested = parseTenantIds(body.tenantIds);
            const treeIds = new Set((0, tenantTree_1.collectDescendantIds)(await (0, tenantTree_1.getAllTenants)(), rootId));
            data.tenantIds = requested.filter((id) => treeIds.has(id));
        }
        if (body.webhookKey !== undefined)
            data.webhookKey = asTrimmed(body.webhookKey);
        if (body.ospBaseUrl !== undefined)
            data.ospBaseUrl = asTrimmed(body.ospBaseUrl);
        // Schlüssel wie beim Mailkonto: leer = behalten, null = löschen.
        if (body.ospApiKey === null)
            data.ospApiKey = null;
        else if (asTrimmed(body.ospApiKey))
            data.ospApiKey = asTrimmed(body.ospApiKey);
        const setting = await prisma_client_1.default.ospSetting.upsert({
            where: { tenantId: rootId },
            create: { id: (0, nanoid_1.nanoid)(12), tenantId: rootId, ...data },
            update: data,
        });
        res.json({
            rootTenantId: rootId,
            tenantIds: parseTenantIds(setting.tenantIds),
            webhookKey: setting.webhookKey || '',
            ospBaseUrl: setting.ospBaseUrl || '',
            hasApiKey: Boolean(asTrimmed(setting.ospApiKey)),
            webhookPath: '/backend/api/v1/osp/webhook',
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'OSP-Einstellungen konnten nicht gespeichert werden.' });
    }
});
exports.default = router;
//# sourceMappingURL=osp.routes.js.map