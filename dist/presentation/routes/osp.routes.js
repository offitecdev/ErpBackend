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
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
const documentNumber_1 = require("../../shared/documentNumber");
const customerAddress_1 = require("../../application/utils/customerAddress");
const OspClient_1 = require("../../infrastructure/services/OspClient");
const ospDatasheet_1 = require("../../infrastructure/services/ospDatasheet");
const LocalFileStorage_1 = require("../../infrastructure/services/LocalFileStorage");
const ospStatusSync_1 = require("../../infrastructure/services/ospStatusSync");
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
 *  • Zuständig ist EINE Person: die Verkäuferin/der Verkäufer. Ihre Wahl ist
 *    zugleich der Bearbeitungsstand — LISTED ohne, IN_OFFER mit (drüben
 *    "under review"). Der Stand wird nirgends von Hand gesetzt.
 *  • Jede Meldung an die OSP ist Best-Effort; Ausgang + Fehler stehen an der
 *    Zeile (lastReport*).
 */
const router = (0, express_1.Router)();
/** WITHDRAWN steht neben der Reihe: die anfragende Person hat zurückgezogen. */
const OSP_STATUSES = ['LISTED', 'IN_OFFER', 'SENT', 'APPROVED', 'WITHDRAWN'];
const SETTINGS_MANAGE = ['tenders.manage', 'roles.manage', 'tenants.update'];
/** Standard-Seitengrösse der Liste — "in Gruppen von 15 ziehen" (Vorgabe). */
const PAGE_SIZE = 15;
/**
 * Die Adressen, die der OSP für die drei eingehenden Aufrufe zu nennen sind
 * (§1, §1a, §1b). Drei statt einer, damit drüben auf die ADRESSE geroutet
 * werden kann und nicht aus dem Körper geraten werden muss, welcher Fall
 * vorliegt. `changeWebhookPath` ist die Adresse der zweiten Vertragsfassung
 * und bleibt stehen, solange sie drüben noch eingetragen ist.
 */
const OSP_WEBHOOK_PATHS = {
    webhookPath: '/backend/api/v1/osp/webhook',
    revisionWebhookPath: '/backend/api/v1/osp/webhook/revision',
    withdrawalWebhookPath: '/backend/api/v1/osp/webhook/withdrawal',
    changeWebhookPath: '/backend/api/v1/osp/webhook/change',
};
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
/** Die abzulegende Visitenkarte einer gewählten Person (§3-Form). */
const salesmanProfileOf = (employee) => ({
    email: employee.email || null,
    name: employee.firstName || null,
    surname: employee.lastName || null,
    phone: employee.phone || null,
});
/**
 * Das Datenblatt einer Zeile holen, ablegen und auslesen — Best-Effort, wirft
 * nie. Erfolg wie Misserfolg stehen danach an der Zeile (datasheet*), genau
 * wie bei den Statusmeldungen: die Verkaufsseite sieht, WARUM nichts da ist.
 */
const storeDatasheet = async (setting, documentId, url, 
// Die Angaben, die §1 zu DIESER Lieferung selbst mitgeschickt hat. Sie
// gelten vor dem, was im PDF steht (dieselbe Momentaufnahme, aber ohne
// Umweg über den Fliesstext); das PDF füllt nur noch auf, was der Vertrag
// nicht kennt — vor allem das Medium.
webhookSpecs) => {
    if (!setting)
        return;
    const previous = await prisma_client_1.default.ospDocument.findUnique({
        where: { id: documentId },
        select: { datasheetFile: true },
    }).catch(() => null);
    const result = await (0, ospDatasheet_1.fetchOspDatasheet)(setting, setting.tenantId, url);
    const specs = (0, ospDatasheet_1.mergeSpecs)(result.specs, webhookSpecs);
    await prisma_client_1.default.ospDocument.update({
        where: { id: documentId },
        data: result.ok
            ? {
                datasheetFile: result.file ?? null,
                datasheetSpecs: (Object.keys(specs).length ? specs : null),
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
/**
 * Der Stand FOLGT der Arbeit, er wird nicht gewählt (Vertrag, "Required
 * workflow in the sales system"):
 *
 *  • niemand zuständig            → LISTED   (drüben "created", "Gelistet")
 *  • Verkäufer:in gewählt         → IN_OFFER (drüben "under review",
 *                                             bei uns "Verkäufer zugewiesen")
 *  • Angebotsmail hinaus          → SENT     (drüben "offer has been sent")
 *
 * SENT und APPROVED bleiben stehen: eine hinausgegangene Offerte fällt nicht
 * zurück, bloss weil jemand die Zuständigkeit tauscht. WITHDRAWN ebenso — die
 * OSP hat ihre Seite dort bereits abgeräumt.
 */
const statusForAssignment = (current, hasSalesperson) => {
    if (current === 'SENT' || current === 'APPROVED' || current === 'WITHDRAWN')
        return current;
    return hasSalesperson ? 'IN_OFFER' : 'LISTED';
};
const employeeDisplayName = (employee) => [employee.firstName, employee.lastName].filter(Boolean).join(' ').trim() || employee.email || '';
/** Leere Felder raus — was die OSP nicht nennt, darf nichts überschreiben. */
const withoutEmpty = (row) => {
    const kept = {};
    for (const [key, value] of Object.entries(row)) {
        if (value === null || value === undefined || value === '')
            continue;
        kept[key] = value;
    }
    return kept;
};
/* ── 1) Eingehende Webhooks (OHNE JWT — gemeinsamer Schlüssel) ───────────── */
/**
 * Den Schlüssel des eingehenden Aufrufs prüfen und die dazugehörige Firma
 * heraussuchen. Alle drei Webhooks (§1, §1a, §1b) hängen am SELBEN Schlüssel —
 * getrennt sind nur die Adressen, damit die OSP nicht aus dem Körper raten
 * muss, welcher der drei Fälle vorliegt.
 *
 * Ist nirgends ein Schlüssel hinterlegt, wird alles abgelehnt (503) — genau
 * wie die OSP es umgekehrt hält: NIE offen durchfallen.
 */
const authenticateWebhook = async (req, res) => {
    const key = asTrimmed(req.header('x-osp-integration-key'));
    const settings = await prisma_client_1.default.ospSetting.findMany({ where: { NOT: { webhookKey: null } } });
    const armed = settings.filter((row) => asTrimmed(row.webhookKey));
    if (!armed.length) {
        res.status(503).json({ message: 'OSP integration key is not configured.' });
        return null;
    }
    const setting = key ? armed.find((row) => keysMatch(asTrimmed(row.webhookKey) || '', key)) : null;
    if (!setting) {
        res.status(401).json({ message: 'Missing or wrong X-OSP-Integration-Key.' });
        return null;
    }
    return setting;
};
/**
 * Der gemeinsame Körper von §1 und §1a: ein JSON-Feld, ein Eintrag je Beleg.
 * Die beiden Fassungen sind Feld für Feld gleich und unterscheiden sich nur
 * darin, was sie bedeuten — deshalb EINE Auswertung mit einem Schalter:
 *
 *  • `NEW` (§1)       — eine Anfrage, die wir noch nie gesehen haben. Neue
 *                       Zeilen werden der OSP mit "created" quittiert.
 *  • `REVISION` (§1a) — dieselbe Anfrage, neu gerechnet. Die OSP hat drüben
 *                       bereits selbst auf "created" zurückgesetzt (die
 *                       Zuständigkeit bleibt), also wird NICHT zurückgemeldet;
 *                       hier wird nur festgehalten, dass die Einheit sich
 *                       geändert hat, damit niemand aus dem alten Datenblatt
 *                       offeriert.
 *
 * Was die OSP nicht mitschickt, überschreibt nichts: der Vertrag hat Felder
 * umbenannt und andere fallen gelassen (Kategorie, Modell, Kontotyp …), und
 * eine spätere Lieferung darf nicht löschen, was eine frühere gebracht hat.
 */
const ingestOfferEntries = async (setting, entries, mode) => {
    const out = { received: entries.length, created: 0, updated: 0, datasheetJobs: [], report: [] };
    for (const entry of entries) {
        const reference = asTrimmed(entry.projectNumber);
        if (!reference)
            continue;
        const { projectNumber, documentId } = parseReference(reference);
        const ospCreatedAtRaw = asTrimmed(entry.created_at);
        const ospCreatedAt = ospCreatedAtRaw && !Number.isNaN(Date.parse(ospCreatedAtRaw))
            ? new Date(ospCreatedAtRaw)
            : null;
        /* Die beschreibenden Felder. `companyName` und `projectAddress` sind
           die Namen der dritten Vertragsfassung; die alten bleiben als
           Rückfall stehen, weil ältere Zeilen und die Zusatzfelder der OSP sie
           noch führen. Die Adressen beschreiben den AUFTRAG, nicht das Konto:
           wo die anfragende Person "gleich wie Projekt" gewählt hat, wiederholt
           die OSP die Projektadresse bereits aufgelöst (§1). */
        const descriptive = withoutEmpty({
            projectNumber,
            documentId,
            projectName: asTrimmed(entry.projectName),
            requesterFirstName: asTrimmed(entry.username),
            requesterLastName: asTrimmed(entry.surname),
            requesterEmail: asTrimmed(entry.email),
            phone: asTrimmed(entry.phone),
            company: asTrimmed(entry.companyName) || asTrimmed(entry.company),
            country: asTrimmed(entry.country),
            city: asTrimmed(entry.city),
            address: asTrimmed(entry.projectAddress) || asTrimmed(entry.address),
            shippingAddress: asTrimmed(entry.shippingAddress),
            billingAddress: asTrimmed(entry.billingAddress),
            postalCode: asTrimmed(entry.postalCode),
            userType: asTrimmed(entry.userType),
            category: asTrimmed(entry.category),
            unitType: asTrimmed(entry.type),
            model: asTrimmed(entry.model),
            ospCreatedAt,
            datasheetUrl: (0, ospDatasheet_1.pickDatasheetUrl)(entry),
        });
        // Der unveränderte Eintrag geht IMMER mit — ohne ihn ist hinterher
        // nicht mehr feststellbar, was tatsächlich geliefert wurde.
        const data = { ...descriptive, rawPayload: entry };
        /* Die berechneten Angaben der Einheit stehen seit der dritten
           Vertragsfassung im Webhook selbst (§1 "The calculated unit"). Sie
           stehen damit sofort an der Zeile — auf das PDF wartet niemand. */
        const webhookSpecs = (0, ospDatasheet_1.specsFromOfferEntry)(entry);
        const existing = await prisma_client_1.default.ospDocument.findUnique({
            where: { tenantId_reference: { tenantId: setting.tenantId, reference } },
            select: {
                id: true, status: true, datasheetUrl: true, datasheetFile: true,
                datasheetSpecs: true, salespersonEmail: true,
            },
        });
        if (existing) {
            /** Eine Zeile, die nach einem Rückzug wieder auflebt (§1b → §1). */
            let revived = false;
            /** Eine Überarbeitung, die drüben wieder auf "under review" gehört. */
            let revisionReport = false;
            if (Object.keys(webhookSpecs).length) {
                data.datasheetSpecs = (0, ospDatasheet_1.mergeSpecs)(existing.datasheetSpecs, webhookSpecs);
            }
            if (mode === 'REVISION') {
                // Sichtbar machen, dass die Einheit sich geändert hat. Der
                // Bearbeitungsstand bleibt: die Offerte, die vielleicht schon
                // besteht, gehört weiterhin zu diesem Beleg.
                data.revisedAt = new Date();
                data.revisionCount = { increment: 1 };
                // Eine zur Kenntnis genommene frühere Überarbeitung deckt diese
                // hier nicht mit ab — die Warnung an der Offerte lebt auf.
                data.revisionSeenAt = null;
                // Drüben steht die Anfrage nach der Überarbeitung wieder auf
                // "created", die Zuständigkeit hier besteht aber fort. Also
                // wird sie zurück auf "under review" gesetzt (§1a).
                if (existing.salespersonEmail && existing.status === 'IN_OFFER') {
                    revisionReport = true;
                }
            }
            else if (existing.status === 'WITHDRAWN') {
                // Nach einem Rückzug darf neu angefragt werden — das kommt als
                // NEUE Anfrage (§1), nicht als Überarbeitung. Die Zeile lebt
                // damit wieder auf, mitsamt Offerte und Zuständigkeit.
                data.status = 'LISTED';
                data.withdrawnAt = null;
                data.withdrawnByName = null;
                data.withdrawnByEmail = null;
                data.withdrawnFromStatus = null;
                // Drüben ist es eine frische Anfrage, also wird sie auch wie
                // eine quittiert — nach dem Rückzug steht dort gar kein Stand
                // mehr, den unsere Meldung überschreiben könnte.
                revived = true;
            }
            await prisma_client_1.default.ospDocument.update({ where: { id: existing.id }, data });
            out.updated += 1;
            if (revived)
                out.report.push({ id: existing.id, status: 'LISTED' });
            else if (revisionReport)
                out.report.push({ id: existing.id, status: 'IN_OFFER' });
            // Erneut geholt wird nur, wenn das Datenblatt fehlt oder die OSP
            // auf eine ANDERE Datei zeigt — sonst bliebe es bei jeder
            // Wiederholung derselben Anfrage beim Herunterladen.
            if (data.datasheetUrl
                && (!existing.datasheetFile || existing.datasheetUrl !== data.datasheetUrl)) {
                out.datasheetJobs.push({ id: existing.id, url: data.datasheetUrl, specs: webhookSpecs });
            }
        }
        else {
            if (Object.keys(webhookSpecs).length)
                data.datasheetSpecs = webhookSpecs;
            const row = await prisma_client_1.default.ospDocument.create({
                data: { id: (0, nanoid_1.nanoid)(12), tenantId: setting.tenantId, reference, status: 'LISTED', ...data },
                select: { id: true },
            });
            out.created += 1;
            // Auch eine Überarbeitung zu einem Beleg, den wir nie bekommen
            // haben, wird angelegt und quittiert: lieber eine Anfrage zu viel
            // in der Liste als eine, die niemand je sieht — die OSP wiederholt
            // nicht.
            out.report.push({ id: row.id, status: 'LISTED' });
            if (data.datasheetUrl)
                out.datasheetJobs.push({ id: row.id, url: data.datasheetUrl, specs: webhookSpecs });
        }
    }
    return out;
};
/** Quittieren, dann in Ruhe arbeiten — die OSP wartet auf keine Datei. */
const finishIngest = (setting, res, result) => {
    res.status(200).json({
        received: result.received,
        created: result.created,
        updated: result.updated,
        datasheets: result.datasheetJobs.length,
    });
    for (const row of result.report) {
        // Gemeldet wird die Zeile, wie sie nach dem Einlesen dasteht: die
        // Visitenkarte gehört zur Meldung (§3), und bei einer Überarbeitung ist
        // genau sie es, die drüben erhalten bleiben soll.
        void (async () => {
            const doc = await prisma_client_1.default.ospDocument.findUnique({
                where: { id: row.id },
                select: {
                    id: true, reference: true, salespersonEmail: true,
                    salespersonName: true, salespersonProfile: true,
                },
            }).catch(() => null);
            if (doc)
                await (0, ospStatusSync_1.reportOspDocumentStatus)(setting, doc, row.status);
        })().catch(() => undefined);
    }
    for (const job of result.datasheetJobs) {
        void storeDatasheet(setting, job.id, job.url, job.specs).catch(() => undefined);
    }
};
const asEntryArray = (body) => {
    const rows = Array.isArray(body) ? body : (body ? [body] : []);
    return rows.filter((entry) => entry && typeof entry === 'object');
};
/* §1 — eine Anfrage, die wir noch nie gesehen haben (OFFER_WEBHOOK_URL). */
router.post('/webhook', async (req, res) => {
    try {
        const setting = await authenticateWebhook(req, res);
        if (!setting)
            return;
        const entries = asEntryArray(req.body);
        if (!entries.length)
            return res.status(400).json({ message: 'Empty payload.' });
        finishIngest(setting, res, await ingestOfferEntries(setting, entries, 'NEW'));
    }
    catch (error) {
        res.status(500).json({ message: error?.message || 'Webhook failed.' });
    }
});
/* ── §1a — die überarbeitete Anfrage (OFFER_REVISION_WEBHOOK_URL) ───────────
   Die anfragende Person hat den Beleg nach der Anfrage geändert (neu gerechnet,
   Optionen getauscht, Projektangaben korrigiert) und ihn ERNEUT angefragt. Der
   Körper ist Feld für Feld derselbe wie in §1 — nur die Adresse ist eine
   andere, damit klar ist, dass es kein zweiter Interessent ist, sondern ein
   Ersatz für eine Anfrage, die schon in Arbeit ist.

   Ein Druck auf "Get Offer" kann BEIDE Aufrufe auslösen, wenn die Auswahl neue
   und bereits gesendete Belege mischt; leer bleibt keiner der beiden.

   Für einen bereits beantworteten Beleg ("offer has been sent") kommt hier NIE
   etwas an — den schliesst die OSP für weitere Anfragen. Wieder zu öffnen ist
   er nur über §4b (Anfrage zurückziehen). */
router.post('/webhook/revision', async (req, res) => {
    try {
        const setting = await authenticateWebhook(req, res);
        if (!setting)
            return;
        const entries = asEntryArray(req.body);
        if (!entries.length)
            return res.status(400).json({ message: 'Empty payload.' });
        finishIngest(setting, res, await ingestOfferEntries(setting, entries, 'REVISION'));
    }
    catch (error) {
        res.status(500).json({ message: error?.message || 'Revision webhook failed.' });
    }
});
/* Die Adresse der zweiten Vertragsfassung (DOCUMENT_CHANGE_WEBHOOK_URL). Sie
   bleibt bestehen, solange die OSP sie noch eingetragen hat: dort hiess die
   Überarbeitung "Änderung" und kam als EINZELNES Objekt. Beide Formen landen
   auf derselben Auswertung — ein Feld ebenso wie ein einzelnes Objekt. */
router.post('/webhook/change', async (req, res) => {
    try {
        const setting = await authenticateWebhook(req, res);
        if (!setting)
            return;
        const entries = asEntryArray(req.body);
        if (!entries.length)
            return res.status(400).json({ message: 'Empty payload.' });
        finishIngest(setting, res, await ingestOfferEntries(setting, entries, 'REVISION'));
    }
    catch (error) {
        res.status(500).json({ message: error?.message || 'Change webhook failed.' });
    }
});
/* ── §1b — die Anfrage wurde zurückgezogen (OFFER_WITHDRAWAL_WEBHOOK_URL) ───
   Die anfragende Person nimmt ihre Anfrage im OSP zurück. EIN Objekt je Beleg:
   ein Rückzug ist eine Entscheidung über einen Beleg, nicht über einen Stapel.

   Zurückgezogen werden kann nur eine OFFENE Anfrage ("offer request sent" oder
   "under review") — ist die Offerte einmal draussen, verschwindet der Knopf
   drüben. Das Gegenstück in die andere Richtung ist §4b: dort sagen WIR der
   OSP, dass die Anfrage bei uns weg ist (das tut die Offertenlöschung).

   Gelöscht wird hier nichts. Die Zeile behält Offerte, Datenblatt und
   Zuständigkeit und wechselt auf WITHDRAWN — sichtbar, damit niemand
   weiterarbeitet, und rückholbar, falls neu angefragt wird. */
router.post('/webhook/withdrawal', async (req, res) => {
    try {
        const setting = await authenticateWebhook(req, res);
        if (!setting)
            return;
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
        const reference = asTrimmed(body?.projectNumber);
        if (!reference)
            return res.status(400).json({ message: 'projectNumber is required.' });
        const doc = await prisma_client_1.default.ospDocument.findUnique({
            where: { tenantId_reference: { tenantId: setting.tenantId, reference } },
            select: { id: true, status: true },
        });
        // Ein Rückzug zu einem Beleg, den wir nie bekommen haben, ist kein
        // Fehler — die OSP wiederholt nicht, also freundlich quittieren.
        if (!doc)
            return res.status(200).json({ received: 1, matched: 0 });
        const withdrawnAtRaw = asTrimmed(body?.withdrawn_at);
        const withdrawnAt = withdrawnAtRaw && !Number.isNaN(Date.parse(withdrawnAtRaw))
            ? new Date(withdrawnAtRaw)
            : new Date();
        await prisma_client_1.default.ospDocument.update({
            where: { id: doc.id },
            data: {
                status: 'WITHDRAWN',
                withdrawnAt,
                withdrawnByName: [asTrimmed(body?.username), asTrimmed(body?.surname)].filter(Boolean).join(' ') || null,
                withdrawnByEmail: asTrimmed(body?.email),
                // Der Stand, in dem zurückgezogen wurde — drüben gesehen.
                withdrawnFromStatus: asTrimmed(body?.offerStatus),
                // Der Rückzug beendet die Meldekette: was zuletzt gemeldet
                // wurde, gilt drüben nicht mehr, denn die OSP hat ihre Seite
                // bereits abgeräumt, bevor sie uns angerufen hat.
                lastReportedStatus: null,
                lastReportAt: null,
                lastReportError: null,
            },
        });
        // Zurückgemeldet wird NICHTS: die OSP räumt ihre Seite zuerst und
        // bedingungslos ab (§1b) — eine Statusmeldung darauf würde eine
        // Anfrage wiederbeleben, die es drüben nicht mehr gibt.
        res.status(200).json({ received: 1, matched: 1, status: 'WITHDRAWN' });
    }
    catch (error) {
        res.status(500).json({ message: error?.message || 'Withdrawal webhook failed.' });
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
        /* Sicherheitsnetz für den Stand: gemeldet wird "gesendet" am Mailweg
           der Offerte selbst (markOspOfferSent). Ging das damals daneben — der
           Serverstand war älter, der Aufruf brach ab —, holt die Liste es hier
           nach: hängt an einer Zeile eine Offerte, deren Angebotsmail HINAUS
           ist, rückt sie von IN_OFFER auf SENT vor und meldet es. */
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
                // Ohne Verkäufer:in lehnt die OSP "offer has been sent" mit 400
                // ab (§3) — der Stand bei uns stimmt trotzdem.
                if (doc.salespersonEmail) {
                    void (0, ospStatusSync_1.reportOspDocumentStatus)(feed.setting, doc, 'SENT').catch(() => undefined);
                }
            }
        }
        const counts = { LISTED: 0, IN_OFFER: 0, SENT: 0, APPROVED: 0, WITHDRAWN: 0 };
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
/* ── 3) Zeile pflegen: die zuständige Verkäuferin / der zuständige Verkäufer ─
   EINE Zuständigkeit, direkt gewählt (19.09.2026): die Projektleitung als
   zweites Feld ist weg — an der Anfrage steht die Person, die die Offerte
   macht, und genau die geht als `salesman` an die OSP.

   Der STAND wird dabei nicht gewählt, sondern folgt (siehe
   `statusForAssignment`): wer eine Person einträgt, setzt die Anfrage auf
   "Verkäufer zugewiesen" und meldet der OSP "under review"; wer sie
   herausnimmt, stellt sie zurück auf "Gelistet". */
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
        if (body.salespersonId !== undefined) {
            if (!body.salespersonId) {
                data.salespersonId = null;
                data.salespersonEmail = null;
                data.salespersonName = null;
                data.salespersonProfile = null;
            }
            else {
                // Person kommt aus dem Personalverzeichnis — Name und E-Mail
                // werden hier aufgelöst, nie vom Client übernommen. Und zwar
                // aus dem Verzeichnis der AUSGEWÄHLTEN Firma: die OSP-Liste
                // hängt zwar am Stamm, die Zuständigen sind aber Leute der
                // eigenen Firma.
                const employee = await prisma_client_1.default.employee.findFirst({
                    where: { id: String(body.salespersonId), ...(0, serviceTenantScope_1.employeeScopeWhere)(await (0, serviceTenantScope_1.getPersonnelTenantScope)(tenantId)) },
                    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
                });
                if (!employee)
                    return res.status(404).json({ error: 'Mitarbeiter nicht gefunden.' });
                data.salespersonId = employee.id;
                data.salespersonEmail = employee.email || null;
                data.salespersonName = employeeDisplayName(employee);
                // Die Visitenkarte, die §3 mitschickt.
                data.salespersonProfile = salesmanProfileOf(employee);
            }
        }
        const nextEmail = data.salespersonEmail !== undefined ? data.salespersonEmail : doc.salespersonEmail;
        // Der Stand folgt der Zuständigkeit — von Hand gesetzt wird er nicht.
        const nextStatus = statusForAssignment(doc.status, Boolean(nextEmail));
        if (nextStatus !== doc.status)
            data.status = nextStatus;
        // "under review" ist ohne Verkäufer:in bedeutungslos — die OSP lehnt es
        // mit 400 ab. Wer eine Person OHNE E-Mail-Adresse wählt, bekommt das
        // hier gesagt, statt dass die Meldung später still an der Zeile
        // scheitert.
        if (body.salespersonId && !nextEmail) {
            return res.status(400).json({ error: 'Diese Person hat keine E-Mail-Adresse — die OSP braucht sie, um die Zuweisung anzuzeigen.' });
        }
        const updatedDoc = await prisma_client_1.default.ospDocument.update({ where: { id: doc.id }, data });
        /* Gemeldet wird jede ECHTE Änderung der Zuweisung:
            • Person gewählt/gewechselt → "under review" mit ihrer Visitenkarte
              (auch beim Wechsel — die OSP ersetzt sonst die alte Karte nicht),
            • Person entfernt, solange die Offerte noch nicht hinaus ist →
              "created" ohne Karte, denn drüben stünde sonst weiterhin jemand,
              der die Anfrage gar nicht mehr bearbeitet. Eine GESENDETE Offerte
              rührt das nicht an: sie ist beim Kunden. */
        const personChanged = nextEmail !== doc.salespersonEmail;
        if (personChanged && (nextStatus === 'IN_OFFER' || nextStatus === 'LISTED')) {
            await (0, ospStatusSync_1.reportOspDocumentStatus)(feed.setting, updatedDoc, nextStatus);
        }
        res.json(await prisma_client_1.default.ospDocument.findUnique({ where: { id: doc.id } }));
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'OSP-Beleg konnte nicht gespeichert werden.' });
    }
});
/* ── 3a) Die Anfrage zu einer OFFERTE — für die Offertenseite ───────────────
   Die Offerte weiss von sich aus nichts über ihre Herkunft. Diese Adresse
   beantwortet die eine Frage, die sie stellt: "komme ich aus der OSP, und was
   ist seither passiert?" Ohne Zeile antwortet sie mit `null` — das ist der
   Normalfall und kein Fehler. */
router.get('/documents/by-tender/:tenderId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), async (req, res) => {
    try {
        const feed = await loadFeedContext(req.user.tenantId);
        // Ohne freigeschaltete OSP gibt es zu einer Offerte schlicht nichts zu
        // sagen — das ist keine Zugriffsverweigerung, sondern "keine Zeile".
        if (!feed?.visible)
            return res.json({ document: null });
        const doc = await prisma_client_1.default.ospDocument.findFirst({
            where: { tenderId: req.params.tenderId, tenantId: feed.rootId },
        });
        res.json({ document: doc || null });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'OSP-Beleg konnte nicht geladen werden.' });
    }
});
/* ── 3c) Die Überarbeitung zur Kenntnis nehmen (§1a) ─────────────────────────
   Die Warnung an der Offerte steht, solange die Überarbeitung jünger ist als
   dieser Stempel. Gelöscht wird dabei nichts: `revisedAt` bleibt stehen, die
   Zeile sagt weiterhin, dass und wann die Einheit neu gerechnet wurde. */
router.post('/documents/:id/revision-seen', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), async (req, res) => {
    try {
        const feed = await loadFeedContext(req.user.tenantId);
        if (!feed?.visible)
            return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        const doc = await prisma_client_1.default.ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
            select: { id: true },
        });
        if (!doc)
            return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });
        res.json(await prisma_client_1.default.ospDocument.update({
            where: { id: doc.id },
            data: { revisionSeenAt: new Date() },
        }));
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'Speichern fehlgeschlagen.' });
    }
});
/* ── 3d) Die Anfrage LÖSCHEN — und den Rückzug drüben melden (§4b) ───────────
   Der Vertrag verlangt für Zeilen aus der OSP einen Löschknopf, der
   `DELETE /integration/offer-status/{reference}` ruft: die Methode SELBST ist
   die Meldung "gelöscht", einen Status `deleted` gibt es nicht. Drüben wird
   dabei nichts gelöscht — Status und Zuständigkeit werden geleert, und die
   anfragende Person darf neu anfragen.

   Erst wenn die OSP mit 2xx quittiert hat, verschwindet die Zeile hier: sonst
   wüssten die beiden Seiten Verschiedenes, ohne dass es jemandem auffiele. Ist
   gar kein OSP-Zugang hinterlegt, gibt es nichts zu melden und die Zeile geht.

   Die Offerte, die aus der Anfrage entstanden ist, bleibt bestehen — sie ist
   ein eigener Beleg. Sie verliert nur ihre Herkunft. */
router.delete('/documents/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), async (req, res) => {
    try {
        const feed = await loadFeedContext(req.user.tenantId);
        if (!feed?.visible)
            return res.status(403).json({ error: 'OSP ist für diese Firma nicht freigeschaltet.' });
        const doc = await prisma_client_1.default.ospDocument.findFirst({
            where: { id: req.params.id, tenantId: feed.rootId },
            select: { id: true, reference: true, datasheetFile: true },
        });
        if (!doc)
            return res.status(404).json({ error: 'OSP-Beleg nicht gefunden.' });
        const result = feed.setting
            ? await (0, OspClient_1.withdrawOspOfferStatus)(feed.setting, doc.reference)
            : { ok: false, skipped: true, notFound: false, error: undefined };
        // Kennt die OSP den Beleg gar nicht (404), ist der Rückzug bereits
        // erreicht: dort steht nichts mehr, was unsere Zeile noch trüge. Sie
        // hier dann festzuhalten hiesse, sie nie mehr loszuwerden.
        if (!result.ok && !result.skipped && !result.notFound) {
            // Sichtbar stehen lassen und den Grund an die Zeile schreiben —
            // erneut versuchen kann man danach mit demselben Knopf.
            await prisma_client_1.default.ospDocument.update({
                where: { id: doc.id },
                data: { lastReportError: result.error || 'Rückzug bei der OSP fehlgeschlagen.' },
            }).catch(() => undefined);
            return res.status(502).json({ error: result.error || 'Die OSP hat den Rückzug nicht bestätigt — die Anfrage bleibt stehen.' });
        }
        await prisma_client_1.default.ospDocument.delete({ where: { id: doc.id } });
        // Das abgelegte Datenblatt gehörte zur Zeile und hat ohne sie keinen
        // Ort mehr. Best-Effort: eine Datei, die nicht wegzuräumen ist, darf
        // die Löschung nicht scheitern lassen.
        if (doc.datasheetFile)
            await LocalFileStorage_1.ospDatasheetStorage.remove(doc.datasheetFile).catch(() => undefined);
        res.json({ deleted: true, reference: doc.reference, reported: result.ok });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'OSP-Beleg konnte nicht gelöscht werden.' });
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
            select: { id: true, datasheetUrl: true, rawPayload: true },
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
        // Was §1 selbst mitgeschickt hat, gilt weiterhin vor dem PDF — sonst
        // würde ein erneutes Holen die genaueren Zahlen durch die aus dem
        // Fliesstext gelesenen ersetzen.
        await storeDatasheet(feed.setting, doc.id, url, (0, ospDatasheet_1.specsFromOfferEntry)(doc.rawPayload));
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
        // Zuständig ist EINE Person: die Verkäuferin/der Verkäufer. Gewählt
        // an der Zeile, im Aufruf mitgegeben — oder, wenn beides fehlt, die
        // Person, die den Import auslöst.
        const findEmployee = async (employeeId) => {
            const employee = await prisma_client_1.default.employee.findFirst({
                where: { id: employeeId, ...(0, serviceTenantScope_1.employeeScopeWhere)(await (0, serviceTenantScope_1.getPersonnelTenantScope)(user.tenantId)) },
                select: { id: true, firstName: true, lastName: true, email: true, phone: true },
            });
            return employee
                ? {
                    id: employee.id,
                    email: employee.email || null,
                    name: employeeDisplayName(employee),
                    profile: salesmanProfileOf(employee),
                }
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
            // Niemand gewählt: es ist die Person, die den Import auslöst.
            salesperson = await findEmployee(user.id)
                ?? { id: user.id, email: user.email || null, name: employeeDisplayName(user) };
        }
        /* Mehrzeilige manuelle Adresse: Strasse / PLZ Ort / Land.

           Die OSP schickt ihre Adressen seit der dritten Vertragsfassung als
           EINEN fertigen Satz ("Bahnhofstrasse 12, 8005 Zürich") statt in
           Bestandteilen. Was darin schon steht, wird deshalb nicht noch einmal
           angehängt — sonst stünde der Ort zweimal untereinander. */
        const streetLine = manual ? asTrimmed(manual.address) : null;
        const alreadyNamed = (value) => Boolean(value && streetLine && streetLine.toLowerCase().includes(value.toLowerCase()));
        const placeLine = manual
            ? [asTrimmed(manual.postalCode), asTrimmed(manual.city)].filter(Boolean).join(' ') || null
            : null;
        const countryLine = manual ? asTrimmed(manual.country) : null;
        const manualAddress = manual
            ? [
                streetLine,
                alreadyNamed(placeLine) ? null : placeLine,
                alreadyNamed(countryLine) ? null : countryLine,
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
                ...(salesperson.profile ? { salespersonProfile: salesperson.profile } : {}),
            },
        });
        // "under review" braucht die zuständige Person — ohne E-Mail-Adresse
        // wird gar nicht gemeldet (die OSP würde mit 400 ablehnen).
        if (salesperson.email) {
            await (0, ospStatusSync_1.reportOspDocumentStatus)(feed.setting, updatedDoc, 'IN_OFFER');
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
            select: {
                id: true, reference: true, projectNumber: true, status: true,
                salespersonEmail: true, salespersonName: true, salespersonProfile: true, lastReportedStatus: true,
            },
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
            // Eine zurückgezogene Anfrage bleibt zurückgezogen: die OSP hat
            // ihre Seite abgeräumt und meldet dazu gar keinen Stand mehr —
            // was hier ankäme, wäre der einer NEUEN Anfrage, und die kommt
            // ihrerseits über §1.
            if (doc.status === 'WITHDRAWN')
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
                // Die Karte, die die OSP führt — inklusive Rufnummer und Bild,
                // sofern die Adresse drüben ein Konto hat.
                data.salespersonProfile = { ...row.salesman, email: salesmanEmail };
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
            // Die drei Adressen, die der OSP zu nennen sind — relativ; die
            // Oberfläche stellt den eigenen Ursprung davor. Getrennt, damit
            // drüben auf die Adresse geroutet werden kann statt auf den Inhalt.
            ...OSP_WEBHOOK_PATHS,
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
            ...OSP_WEBHOOK_PATHS,
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || 'OSP-Einstellungen konnten nicht gespeichert werden.' });
    }
});
exports.default = router;
//# sourceMappingURL=osp.routes.js.map