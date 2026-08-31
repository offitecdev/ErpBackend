"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startImapCaptureService = exports.fetchImapAttachment = exports.isCaptureRunning = exports.captureInbox = exports.buildImapClient = exports.normalizeWindowMonths = exports.DEFAULT_WINDOW_MONTHS = void 0;
const imapflow_1 = require("imapflow");
const nanoid_1 = require("nanoid");
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const mailCustomerMatcher_1 = require("./outlook/mailCustomerMatcher");
const mailAutoCategory_1 = require("./outlook/mailAutoCategory");
const mailText_1 = require("./outlook/mailText");
const mailBodyParts_1 = require("./outlook/mailBodyParts");
const calendarImportService_1 = require("./calendarImportService");
const serviceTenantScope_1 = require("../../presentation/controllers/serviceTenantScope");
const mailboxIdentity_1 = require("./mailboxIdentity");
/**
 * POSTEINGANG DES EIGENEN MAILSERVERS → ERP (18.08.2026; umgebaut 08.09.2026).
 *
 * Ein Dienst liest per IMAP (imapflow) den Posteingang und den Gesendet-Ordner
 * des Firmenpostfachs und legt JEDE Nachricht als `MailMessage` ab (Vorgabe
 * 08.09.2026: "alles, wirklich alles, die letzten zwei Monate"). Die frühere
 * Schranke «nur Post bekannter Adressen» ist aufgehoben — das Adressbuch dient
 * nur noch der ZUORDNUNG, nicht mehr der Auswahl:
 *
 *   • Adresse eines Kunden oder Ansprechpartners  → AUTO_ADDRESS
 *   • eindeutige Firmendomain eines Kunden        → AUTO_DOMAIN
 *   • Adresse einer registrierten Person          → AUTO_EMPLOYEE
 *   • Antwort auf eine ERP-Mail (In-Reply-To)     → REPLY (erbt Kunde + Beleg)
 *   • sonst                                        → ohne Zuordnung gespeichert
 *
 * Enthält eine Nachricht eine KALENDER-EINLADUNG (`text/calendar`), wandert
 * der Termin zusätzlich in den ERP-Kalender (calendarImportService) — so
 * kommen auch die in Outlook angesetzten Besprechungen ins System.
 *
 * Gespeichert werden die Grunddaten (Absender, Empfänger, Betreff, Zeitpunkt,
 * Text) plus das BEREINIGTE HTML des Rumpfs (nur Formatierung — fett, Listen,
 * Tabellen), damit die Post im ERP wie im Mailprogramm liest. Anhänge bleiben
 * auf dem Mailserver; abgelegt werden nur ihre Namen/Grössen.
 *
 * ABLAUF PRO DURCHGANG: UID-Fenster bestimmen → Kopfzeilen holen → Rumpf
 * nachladen → speichern; in Schüben von 200, so lange das Zeitbudget reicht —
 * der ERSTABRUF (die letzten zwei Monate, komplett) soll in wenigen
 * Durchgängen stehen, danach liest der Lesestand nur noch das Neue.
 *
 * Der Lesestand steht in `MailSetting.imapLastUid` (+ `imapUidValidity`, damit
 * ein neu aufgebauter Ordner nicht mit alten UIDs verwechselt wird). Nichts
 * wird auf dem Server verändert: keine Flags, keine Verschiebungen, kein
 * Löschen — das Postfach bleibt so, wie der Benutzer es in Outlook sieht.
 * Im ERP GELÖSCHTE Nachrichten (Papierkorb/endgültig) kommen nicht wieder:
 * endgültig Gelöschtes wäre zwar erneut übernehmbar, liegt aber hinter dem
 * Lesestand und wird darum nie mehr angesehen.
 */
/* Alle drei Minuten (Vorgabe 19.08.2026). Der Durchgang ist billig gehalten —
   er holt nur die Kopfzeilen der Nachrichten hinter dem Lesestand. */
const TICK_MS = 3 * 60_000;
/** Schubgrösse: so viele Nachrichten je Schub; Schübe laufen, bis das
    Zeitbudget des Durchgangs erschöpft ist (Rest im nächsten Lauf). */
const MAX_PER_RUN = 200;
/**
 * ZEITBUDGET EINES DURCHGANGS — knapp unter dem Takt (drei Minuten), damit
 * sich zwei Durchgänge nicht überholen; `running` würde den zweiten ohnehin
 * abweisen, aber dann stünde der Abruf still, statt weiterzuarbeiten.
 *
 * Es war einmal 20 s, "knapp unter den 25 s, die die HTTP-Schicht wartet" —
 * das war ein Trugschluss: EIN Schub von 200 Nachrichten dauert mit dem
 * Nachladen der Rümpfe 40–60 s, die 25 s der HTTP-Antwort sind also nie
 * einzuhalten (der Abruf läuft nach der Antwort im Hintergrund weiter, genau
 * dafür ist er gebaut). Gebracht hat das Budget nur, dass je Durchgang EIN
 * Schub lief: der Erstabruf über zwei Monate — gut 4000 Nachrichten in beiden
 * Ordnern — hätte so zwanzig Takte, also eine Stunde gedauert. Im
 * eingeschwungenen Zustand kostet das grössere Budget nichts: liegt nichts
 * an, ist der Durchgang nach einer Sekunde vorbei.
 */
const RUN_TIME_BUDGET_MS = 150_000;
/**
 * DAS FENSTER DES POSTFACHS: die letzten ZWEI Monate (Vorgabe 19.08.2026).
 *
 * Es wandert mit dem Tag — am 19.08. reicht es bis zum 19.06., am 20.08. bis
 * zum 20.06. Darum KALENDERMONATE und keine 60 Tage: sonst rutschte die Grenze
 * je nach Monatslänge, und die Angabe im Postfach («letzte 2 Monate») wäre
 * eine andere als die des Abrufs.
 *
 * Es gilt beim ERSTEN Durchgang und nach jedem Zurücksetzen des Lesestands —
 * also auch, nachdem das Postfach gewechselt wurde. Danach läuft der Abruf am
 * Lesestand weiter und sieht nur noch das Neue an; schon durchsuchte
 * Nachrichten kosten keinen zweiten Blick.
 */
exports.DEFAULT_WINDOW_MONTHS = 2;
/** Erlaubt sind 1 und 2 — alles andere fällt auf die Vorgabe zurück. */
const normalizeWindowMonths = (value) => (Number(value) === 1 ? 1 : exports.DEFAULT_WINDOW_MONTHS);
exports.normalizeWindowMonths = normalizeWindowMonths;
const lookbackStart = (months) => {
    const since = new Date();
    since.setMonth(since.getMonth() - (0, exports.normalizeWindowMonths)(months));
    return since;
};
const running = new Set();
/** `<id@host>`-Liste aus einer Kopfzeile (In-Reply-To / References). */
const messageIds = (value) => {
    if (!value)
        return [];
    return (String(value).match(/<[^>\s]+>/g) || []).map((id) => id.trim());
};
const headerValue = (headers, name) => {
    // Kopfzeilen dürfen umbrechen (Folding): Folgezeilen beginnen mit Leerraum.
    const pattern = new RegExp(`^${name}:[ \\t]*([\\s\\S]*?)(?=\\r?\\n[^ \\t]|$)`, "im");
    const match = pattern.exec(headers);
    return match ? match[1].replace(/\r?\n[ \t]+/g, " ").trim() : undefined;
};
const partyOf = (raw) => {
    const address = (0, mailCustomerMatcher_1.normalizeAddress)(raw?.address);
    if (!address)
        return null;
    return { name: String(raw?.name || "").trim() || null, address };
};
const partiesOf = (raw) => (Array.isArray(raw) ? raw.map(partyOf).filter((p) => Boolean(p)) : []);
/**
 * Anhangs-METADATEN aus der BODYSTRUCTURE (keine Inhalte). `node.type` ist bei
 * imapflow bereits der volle Typ ("application/pdf"), und `node.id` ist die
 * Content-ID: Teile MIT Content-ID sind im HTML eingebettete Bilder (die
 * Signaturgrafiken von Outlook) — die gehören nicht in die Anhangsliste,
 * sonst hinge an jeder Antwort ein "image001.gif".
 */
const attachmentsOf = (node, out = []) => {
    if (!node)
        return out;
    const children = node.childNodes || node.children || [];
    for (const child of children)
        attachmentsOf(child, out);
    const disposition = String(node.disposition || "").toLowerCase();
    const filename = node.dispositionParameters?.filename || node.parameters?.name;
    const isInline = disposition === "inline" || Boolean(node.id);
    if (filename && !isInline) {
        out.push({
            id: String(node.part || ""),
            name: String(filename),
            // BODYSTRUCTURE meldet die KODIERTE Grösse; base64 bläht um 4/3 auf.
            // Angezeigt wird die tatsächliche Dateigrösse (wie im Mailprogramm).
            size: Number.isFinite(node.size)
                ? (String(node.encoding || "").toLowerCase() === "base64" ? Math.floor(Number(node.size) * 3 / 4) : Number(node.size))
                : null,
            contentType: node.type ? String(node.type).toLowerCase() : null,
        });
    }
    return out;
};
const collectBodyParts = (node, out = []) => {
    if (!node)
        return out;
    const children = node.childNodes || node.children || [];
    if (children.length) {
        for (const child of children)
            collectBodyParts(child, out);
        return out;
    }
    const type = String(node.type || "").toLowerCase();
    // Nur die beiden Rumpf-Typen — text/calendar u. Ä. sind kein Nachrichtentext.
    if (type !== "text/plain" && type !== "text/html")
        return out;
    // Angehängte .txt/.html-Dateien sind kein Nachrichtentext.
    const disposition = String(node.disposition || "").toLowerCase();
    if (disposition === "attachment")
        return out;
    out.push({
        part: String(node.part || "1"),
        encoding: String(node.encoding || "").toLowerCase(),
        charset: String(node.parameters?.charset || "utf-8").toLowerCase(),
        isHtml: type === "text/html",
    });
    return out;
};
/** Der `text/calendar`-Abschnitt einer Einladung, falls vorhanden. */
const findCalendarPart = (node) => {
    if (!node)
        return null;
    const children = node.childNodes || node.children || [];
    for (const child of children) {
        const found = findCalendarPart(child);
        if (found)
            return found;
    }
    const type = String(node.type || "").toLowerCase();
    const filename = String(node.dispositionParameters?.filename || node.parameters?.name || "").toLowerCase();
    if (type === "text/calendar" || filename.endsWith(".ics"))
        return { part: String(node.part || "1") };
    return null;
};
/* Bekannte Namen des Gesendet-Ordners, falls der Server sein `\\Sent`-Merkmal
   nicht meldet (dieselbe Liste wie in ImapMailService, um Mehrsprachigkeit
   erweitert). */
const SENT_FOLDER_NAMES = [
    "sent", "sent items", "sent messages", "sent mail",
    "inbox.sent", "inbox.sent items",
    "gesendet", "gesendete elemente", "gesendete objekte",
    "g\u00f6nderilmi\u015f \u00f6\u011feler", "giden",
];
/**
 * Der Ordner mit der gesendeten Post. Reihenfolge: eingetragener Name →
 * `\\Sent`-Merkmal des Servers → bekannte Namen. Nichts gefunden = null; der
 * Durchgang liest dann eben nur den Posteingang.
 */
const resolveSentFolder = async (client, configured) => {
    const wanted = String(configured || "").trim();
    if (wanted)
        return wanted;
    try {
        const boxes = (await client.list());
        const special = boxes.find((box) => String(box.specialUse || "") === "\\Sent");
        if (special?.path)
            return special.path;
        const known = boxes.find((box) => SENT_FOLDER_NAMES.includes(String(box.path || "").toLowerCase()));
        return known?.path || null;
    }
    catch {
        return null;
    }
};
const buildImapClient = (settings) => {
    const port = Number(settings.imapPort || 993);
    return new imapflow_1.ImapFlow({
        host: settings.imapHost.trim(),
        port,
        secure: settings.imapSecure ?? port === 993,
        auth: {
            // Leere IMAP-Zugangsdaten = dieselben wie SMTP (meist dasselbe Konto).
            user: (settings.imapUser?.trim() || settings.smtpUser?.trim() || ""),
            pass: (settings.imapPassword || settings.smtpPassword || ""),
        },
        logger: false,
        tls: { rejectUnauthorized: false },
        socketTimeout: 60_000,
        greetingTimeout: 20_000,
        connectionTimeout: 20_000,
    });
};
exports.buildImapClient = buildImapClient;
/**
 * Ein Durchgang für EIN POSTFACH. Wirft nicht: Fehler landen in
 * `MailSetting.imapLastError` und im Rückgabewert.
 *
 * EIN POSTFACH JE FIRMENBAUM (13.09.2026): der übergebene Mandant wird auf den
 * Stamm seines Baums aufgelöst (`getMailTenantId`) — Zugangsdaten, Lesestand
 * und Nachrichten gehören dorthin. Vorher lief der Abruf je Mandant: standen
 * dieselben IMAP-Daten in zwei Firmen desselben Baums, holten ZWEI Abrufe
 * dasselbe Serverpostfach in zwei getrennte Bestände, jeder mit eigenem,
 * NUR VORWÄRTS laufendem Lesestand — der später gestartete zeigte für immer
 * nur, was seit seinem Beginn ankam.
 */
const captureInbox = async (selectedTenantId, options = {}) => {
    const startedAt = Date.now();
    const dryRun = Boolean(options.dryRun);
    // Fällt die Auflösung aus (Mandantenbaum nicht lesbar), bleibt es bei der
    // übergebenen Firma — der Abruf soll deswegen nicht ausfallen.
    const tenantId = await (0, serviceTenantScope_1.getMailTenantId)(selectedTenantId).catch(() => selectedTenantId);
    const summary = { tenantId, examined: 0, stored: 0, replies: 0, byAddress: 0, labelled: 0, calendar: 0, skipped: 0, skippedRepliesOnly: 0, durationMs: 0 };
    if (dryRun)
        summary.preview = [];
    if (running.has(tenantId)) {
        summary.error = "Abruf läuft bereits.";
        return summary;
    }
    running.add(tenantId);
    let client = null;
    try {
        const select = {
            tenantId: true, imapHost: true, imapPort: true, imapSecure: true, imapUser: true, imapPassword: true,
            smtpUser: true, smtpPassword: true, fromEmail: true, imapInboxFolder: true,
            imapCaptureRepliesOnly: true, imapUidValidity: true, imapLastUid: true, imapWindowMonths: true,
            sentFolder: true, imapSentUidValidity: true, imapSentLastUid: true,
        };
        /* DIE ZUGANGSDATEN STEHEN AM STAMM — aber nicht überall schon: eine
           Einrichtung, die vor dem Umbau in einer Untergesellschaft eingetragen
           wurde, liegt weiterhin dort. Dann wird SIE benutzt, und der Lesestand
           bleibt in ihrer Zeile (`settingsTenantId`); die NACHRICHTEN gehen
           trotzdem an den Stamm. Sonst stünde der Abruf still, ohne dass
           irgendwo etwas anderes stünde als «Kein IMAP-Server hinterlegt». */
        let settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId }, select });
        if (!settings?.imapHost?.trim()) {
            const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId).catch(() => []);
            settings = await prisma_client_1.default.mailSetting.findFirst({
                where: { tenantId: { in: treeTenantIds }, NOT: { imapHost: null } },
                orderBy: { imapLastSyncAt: "desc" },
                select,
            });
        }
        if (!settings?.imapHost?.trim()) {
            summary.error = "Kein IMAP-Server hinterlegt.";
            return summary;
        }
        // Wessen Zeile den Lesestand führt: fast immer der Stamm selbst.
        const settingsTenantId = settings.tenantId;
        // Der Ordner-Umweg gilt NUR im Probelauf: sonst liefe der Lesestand
        // eines fremden Ordners in die Einstellung des Posteingangs.
        const inboxFolder = (dryRun && options.folder?.trim()) || settings.imapInboxFolder?.trim() || "INBOX";
        client = (0, exports.buildImapClient)(settings);
        await client.connect();
        const jobs = [{
                folder: inboxFolder,
                direction: "IN",
                uidValidity: settings.imapUidValidity ?? null,
                lastUid: settings.imapLastUid ?? null,
                cursorFields: (validity, uid) => ({ imapUidValidity: validity, imapLastUid: uid }),
            }];
        const sentFolder = (dryRun && options.folder?.trim())
            ? null
            : await resolveSentFolder(client, settings.sentFolder);
        if (sentFolder && sentFolder.toLowerCase() !== inboxFolder.toLowerCase()) {
            jobs.push({
                folder: sentFolder,
                direction: "OUT",
                uidValidity: settings.imapSentUidValidity ?? null,
                lastUid: settings.imapSentLastUid ?? null,
                cursorFields: (validity, uid) => ({ imapSentUidValidity: validity, imapSentLastUid: uid }),
            });
        }
        for (const job of jobs) {
            // Nur lesen: der Ordner wird schreibgeschützt geöffnet, damit der Abruf
            // keine Gelesen-Markierungen im Postfach des Benutzers setzt.
            let lock;
            try {
                lock = await client.getMailboxLock(job.folder, { readOnly: true });
            }
            catch (error) {
                // Ein fehlender oder anders benannter Ordner darf den anderen
                // Durchgang nicht mitreißen — gemeldet, nicht geworfen.
                console.error(`[MAIL-IN] Ordner ${job.folder} nicht lesbar:`, error?.message || error);
                continue;
            }
            try {
                const mailbox = client.mailbox;
                const uidValidity = BigInt(mailbox?.uidValidity ?? 0);
                const knownValidity = job.uidValidity;
                // Ordner neu aufgebaut (UIDVALIDITY geändert) → Lesestand verwerfen.
                const resetCursor = Boolean(options.reset) || (knownValidity !== null && knownValidity !== uidValidity);
                let lastUid = resetCursor ? 0n : (job.lastUid ?? 0n);
                let uids = [];
                if (lastUid > 0n) {
                    uids = await client.search({ uid: `${Number(lastUid) + 1}:*` }, { uid: true });
                    // Manche Server geben bei `n:*` immer die letzte Nachricht zurück.
                    uids = (uids || []).filter((uid) => BigInt(uid) > lastUid);
                }
                else {
                    // Erstlauf: nur das eingestellte Fenster, nicht das ganze Postfach.
                    const since = lookbackStart(settings.imapWindowMonths);
                    uids = await client.search({ since }, { uid: true });
                    uids = uids || [];
                }
                uids.sort((a, b) => a - b);
                /* WAS DER DURCHGANG VOR SICH HAT — ins Protokoll, sobald etwas
                   anliegt. Ohne diese Zeile ist eine Lücke im Postfach nicht
                   nachvollziehbar: die Zusammenfassung sagt nur, WIE VIELE
                   Nachrichten angesehen wurden, nicht WELCHE. Erst Lesestand und
                   UID-Bereich zeigen, ob der Abruf lückenlos weiterrückt. */
                if (!dryRun && uids.length) {
                    console.log(`[MAIL-IN] ${job.folder}: Lesestand ${lastUid}, ${uids.length} UIDs zu prüfen`
                        + ` (${uids[0]} … ${uids[uids.length - 1]})`);
                }
                if (!uids.length && !dryRun && (resetCursor || job.uidValidity === null)) {
                    await prisma_client_1.default.mailSetting.update({
                        where: { tenantId: settingsTenantId },
                        data: job.cursorFields(uidValidity, 0n),
                    });
                }
                const own = (0, mailCustomerMatcher_1.normalizeAddress)(settings.fromEmail);
                /* Adressbuch = WEM die Nachricht gehört, Kategorienleiste = WOHIN
                   sie gehört. Steht die erkannte Gegenstelle schon in der Leiste,
                   trägt die Nachricht das Etikett gleich beim Speichern. */
                const [book, categories] = await Promise.all([(0, mailCustomerMatcher_1.getAddressBook)(tenantId), (0, mailAutoCategory_1.getCategoryIndex)(tenantId)]);
                /* In SCHÜBEN durcharbeiten, bis das Zeitbudget erschöpft ist: der
                   ERSTABRUF liest zwei volle Monate, und mit einem Schub je
                   Durchgang stünde das Postfach erst nach Stunden. Der Lesestand
                   rückt nach JEDEM Schub nach — ein Abbruch verliert nichts. */
                let offset = 0;
                while (offset < uids.length) {
                    const batch = uids.slice(offset, offset + MAX_PER_RUN);
                    offset += batch.length;
                    const candidates = [];
                    for await (const message of client.fetch(batch.map(String).join(","), { uid: true, envelope: true, bodyStructure: true, internalDate: true, headers: ["in-reply-to", "references", "message-id"] }, { uid: true })) {
                        summary.examined += 1;
                        const headers = message.headers ? message.headers.toString() : "";
                        const refs = [
                            ...messageIds(headerValue(headers, "in-reply-to")),
                            ...messageIds(headerValue(headers, "references")),
                        ];
                        const messageId = (message.envelope?.messageId
                            || messageIds(headerValue(headers, "message-id"))[0]
                            || null);
                        candidates.push({
                            uid: Number(message.uid),
                            envelope: message.envelope,
                            refs,
                            messageId,
                            bodyStructure: message.bodyStructure,
                            internalDate: message.internalDate ? new Date(message.internalDate) : new Date(),
                        });
                    }
                    // Schon vorhandene Nachrichten (z. B. nach UIDVALIDITY-Wechsel)
                    // und die von UNS verschickten Mails in EINEM Zug nachschlagen.
                    const ownIds = candidates.map((c) => c.messageId).filter(Boolean);
                    const providerIds = candidates.map((c) => `${job.folder}:${uidValidity}:${c.uid}`);
                    const refIds = Array.from(new Set(candidates.flatMap((c) => c.refs)));
                    const [existing, parents] = await Promise.all([
                        ownIds.length || providerIds.length
                            ? prisma_client_1.default.mailMessage.findMany({
                                where: {
                                    tenantId,
                                    OR: [
                                        ...(ownIds.length ? [{ internetMessageId: { in: ownIds } }] : []),
                                        { providerMessageId: { in: providerIds } },
                                    ],
                                },
                                select: { internetMessageId: true, providerMessageId: true },
                            })
                            : Promise.resolve([]),
                        refIds.length
                            ? prisma_client_1.default.mailMessage.findMany({
                                where: { tenantId, internetMessageId: { in: refIds } },
                                select: {
                                    internetMessageId: true, customerId: true, contactId: true,
                                    entityType: true, entityId: true, entityLabel: true, employeeId: true,
                                    categoryId: true,
                                },
                            })
                            : Promise.resolve([]),
                    ]);
                    const known = new Set(existing.map((row) => row.internetMessageId).filter(Boolean));
                    const knownProviders = new Set(existing.map((row) => row.providerMessageId).filter(Boolean));
                    const parentById = new Map(parents.map((row) => [row.internetMessageId, row]));
                    const keepers = [];
                    /* Nur im Probelauf: Absender, deren Adresse nicht im System
                       steht — sie werden zwar TROTZDEM übernommen (Vorgabe
                       08.09.2026: alles), aber die Liste zeigt beim Testen, was
                       ohne Kundenzuordnung ankommen wird. */
                    const unknown = new Map();
                    for (const candidate of candidates) {
                        const providerId = `${job.folder}:${uidValidity}:${candidate.uid}`;
                        const alreadyStored = Boolean((candidate.messageId && known.has(candidate.messageId))
                            || knownProviders.has(providerId));
                        const calendarPart = findCalendarPart(candidate.bodyStructure)?.part ?? null;
                        // A reset/backfill must revisit existing calendar mails so
                        // their personal recipient ownership can be repaired.
                        if (alreadyStored && !calendarPart) {
                            summary.skipped += 1;
                            continue;
                        }
                        /* Die GEGENSTELLE — nur noch für die ZUORDNUNG, keine
                           Schranke mehr: gespeichert wird jede Nachricht.
                           Im Posteingang ist die Gegenstelle der ABSENDER, im
                           Gesendet-Ordner sind es die EMPFÄNGER: dort sind WIR der
                           Absender, und «schreibt uns jemand Bekanntes» hiesse dort
                           «schreiben wir uns selbst». */
                        const counterparts = (job.direction === "OUT"
                            ? [...partiesOf(candidate.envelope?.to), ...partiesOf(candidate.envelope?.cc)]
                            : [...partiesOf(candidate.envelope?.from), ...partiesOf(candidate.envelope?.replyTo)]).map((p) => p.address).filter((address) => address && address !== own);
                        const hit = (0, mailCustomerMatcher_1.matchAddresses)(book, counterparts);
                        if (!hit && dryRun) {
                            const address = counterparts[0] || "(ohne Absender)";
                            unknown.set(address, (unknown.get(address) || 0) + 1);
                        }
                        // (1) Antwort auf eine ERP-Mail? Dann erbt sie deren
                        // Zuordnung — genauer als der reine Adresstreffer.
                        const parent = candidate.refs.map((id) => parentById.get(id)).find(Boolean);
                        if (parent) {
                            keepers.push({
                                ...candidate,
                                customerId: parent.customerId,
                                contactId: parent.contactId,
                                matchSource: "REPLY",
                                entityType: parent.entityType,
                                entityId: parent.entityId,
                                entityLabel: parent.entityLabel,
                                employeeId: parent.employeeId,
                                /* Die Antwort bleibt im Fach des Gesprächs: erst das
                                   Etikett der ERP-Mail, sonst das des Kunden. Die
                                   Person aus `employeeId` zählt hier NICHT — bei
                                   einer ERP-Sendung ist das unsere eigene Absenderin. */
                                categoryId: parent.categoryId ?? (0, mailAutoCategory_1.autoCategoryId)(categories, { customerId: parent.customerId }),
                                calendarPart,
                                alreadyStored,
                            });
                            summary.replies += 1;
                            continue;
                        }
                        // (2) Sonst zählt der Adresstreffer für die Zuordnung —
                        // ohne Treffer wird ohne Kunde/Person gespeichert.
                        keepers.push({
                            ...candidate,
                            customerId: hit?.customerId ?? null,
                            contactId: hit?.contactId ?? null,
                            matchSource: hit?.source ?? null,
                            entityType: null,
                            entityId: null,
                            entityLabel: null,
                            // Post einer registrierten Person: sie "gehört" ihr, damit
                            // sie im Postfach als eigene Zeile erkennbar ist.
                            employeeId: hit?.employeeId ?? null,
                            // Kunde oder Person hat eine Kategorie? Dann liegt die
                            // Nachricht ohne Zutun darin.
                            categoryId: (0, mailAutoCategory_1.autoCategoryId)(categories, { customerId: hit?.customerId, employeeId: hit?.employeeId }),
                            calendarPart,
                            alreadyStored,
                        });
                        if (hit)
                            summary.byAddress += 1;
                    }
                    if (dryRun) {
                        summary.preview = keepers.map((keeper) => ({
                            subject: String(keeper.envelope?.subject || "(kein Betreff)").slice(0, 120),
                            from: partiesOf(keeper.envelope?.from)[0]?.address || "",
                            reason: keeper.matchSource || "OHNE_ZUORDNUNG",
                            customerId: keeper.customerId,
                        })).slice(0, 25);
                        summary.unknownSenders = Array.from(unknown.entries())
                            .map(([address, count]) => ({ address, count }))
                            .sort((a, b) => b.count - a.count)
                            .slice(0, 40);
                        summary.stored = keepers.length;
                        summary.labelled = keepers.filter((keeper) => keeper.categoryId).length;
                        summary.durationMs = Date.now() - startedAt;
                        return summary;
                    }
                    // ── 2. Für jede Nachricht den Rumpf holen ─────────────────────
                    const inserts = [];
                    for (const keeper of keepers) {
                        if (keeper.alreadyStored)
                            continue;
                        let bodyText = null;
                        let bodyHtml = null;
                        const bodyParts = collectBodyParts(keeper.bodyStructure);
                        const textPart = bodyParts.find((item) => !item.isHtml) || bodyParts[0] || null;
                        const htmlPart = bodyParts.find((item) => item.isHtml) || null;
                        try {
                            // Nur DIESEN Abschnitt holen — nicht die ganze Nachricht:
                            // ein 20-MB-Anhang muss für eine Textvorschau nicht über
                            // die Leitung. `maxBytes` deckelt im Strom selbst; imapflow
                            // dekodiert dabei bereits Transportkodierung UND Zeichensatz
                            // nach UTF-8 (ein zweites Dekodieren zerstörte base64-Teile).
                            const download = await client.download(String(keeper.uid), textPart?.part || "1", { uid: true, maxBytes: 512 * 1024 });
                            const chunks = [];
                            for await (const chunk of download.content)
                                chunks.push(chunk);
                            const decoded = Buffer.concat(chunks).toString("utf8");
                            // Bildplatzhalter ("[cid:…]", "[image: …]") sind Reste der
                            // Umwandlung und sagen nichts — sie stünden sonst mitten im Satz.
                            bodyText = (0, mailText_1.clampBody)((0, mailBodyParts_1.stripImagePlaceholders)(textPart?.isHtml ? (0, mailText_1.htmlToText)(decoded) : decoded.trim()));
                            if (textPart?.isHtml)
                                bodyHtml = (0, mailText_1.clampHtml)((0, mailText_1.sanitizeMailHtml)(decoded));
                        }
                        catch (error) {
                            console.error(`[MAIL-IN] Rumpf ${keeper.uid} nicht lesbar:`, error?.message || error);
                        }
                        /* Die HTML-Fassung zusätzlich, wenn es sie gibt: fette Stellen,
                           Absätze und Tabellen sollen im Lesebereich stehen wie im
                           Mailprogramm. Bereinigt wird SOFORT (sanitizeMailHtml lässt
                           nur Formatierung durch) — gespeichert wird nie rohes HTML. */
                        if (htmlPart && !bodyHtml) {
                            try {
                                const download = await client.download(String(keeper.uid), htmlPart.part, { uid: true, maxBytes: 512 * 1024 });
                                const chunks = [];
                                for await (const chunk of download.content)
                                    chunks.push(chunk);
                                bodyHtml = (0, mailText_1.clampHtml)((0, mailText_1.sanitizeMailHtml)(Buffer.concat(chunks).toString("utf8")));
                            }
                            catch (error) {
                                console.error(`[MAIL-IN] HTML-Rumpf ${keeper.uid} nicht lesbar:`, error?.message || error);
                            }
                        }
                        const from = partiesOf(keeper.envelope?.from)[0] || null;
                        const to = partiesOf(keeper.envelope?.to);
                        const cc = partiesOf(keeper.envelope?.cc);
                        const attachments = attachmentsOf(keeper.bodyStructure);
                        const sentAt = keeper.envelope?.date ? new Date(keeper.envelope.date) : keeper.internalDate;
                        inserts.push({
                            id: (0, nanoid_1.nanoid)(12),
                            tenantId,
                            // Firmenpostfach: kein persönliches Konto, kein Besitzer —
                            // die Zeile gehört dem Kunden, nicht einer Person.
                            accountId: null,
                            employeeId: keeper.employeeId,
                            direction: job.direction,
                            origin: "IMAP",
                            // Ordner + UID: damit ein Anhang später gezielt vom Server
                            // geladen werden kann, ohne ihn je zu speichern.
                            providerMessageId: `${job.folder}:${uidValidity}:${keeper.uid}`,
                            internetMessageId: keeper.messageId,
                            conversationId: keeper.refs[0] || keeper.messageId,
                            subject: String(keeper.envelope?.subject || "").slice(0, 500) || null,
                            fromName: from?.name?.slice(0, 255) || null,
                            fromAddress: from?.address?.slice(0, 255) || null,
                            toRecipients: to,
                            ccRecipients: cc.length ? cc : client_1.Prisma.JsonNull,
                            /* Die VORSCHAU kommt aus dem neuen Teil der Nachricht:
                               bei einem "RE:" hängt der ganze Verlauf mit dran, und
                               in der Liste stünde sonst der Anfang eines alten
                               Zitats statt dessen, was gerade geschrieben wurde.
                               Der volle Text bleibt gespeichert — der Lesebereich
                               zerlegt ihn beim Anzeigen. */
                            bodyPreview: (0, mailText_1.previewOf)((0, mailBodyParts_1.mainBodyOf)(bodyText) || bodyText, 500),
                            bodyText,
                            bodyHtml,
                            sentAt: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
                            hasAttachments: attachments.length > 0,
                            attachments: attachments.length ? attachments : client_1.Prisma.JsonNull,
                            webLink: null,
                            // Was wir selbst verschickt haben, ist gelesen.
                            isRead: job.direction === "OUT",
                            customerId: keeper.customerId,
                            contactId: keeper.contactId,
                            matchSource: keeper.matchSource === "REPLY" ? "REPLY" : keeper.matchSource,
                            entityType: keeper.entityType,
                            entityId: keeper.entityId,
                            entityLabel: keeper.entityLabel,
                            categoryId: keeper.categoryId,
                        });
                        if (keeper.categoryId)
                            summary.labelled += 1;
                    }
                    if (inserts.length) {
                        await prisma_client_1.default.mailMessage.createMany({ data: inserts, skipDuplicates: true });
                        summary.stored += inserts.length;
                    }
                    /* KALENDER: Einladungen in den ERP-Kalender übernehmen. Erst nach
                       dem Speichern der Nachricht — der Termin ist die Zugabe, die
                       Mail bleibt in jedem Fall in der Kommunikation stehen.
    
                       BEIDE RICHTUNGEN: im Posteingang die Einladungen, die WIR
                       bekommen haben, im Gesendet-Ordner die, die aus dem
                       Firmenpostfach rausgegangen sind (ein in Outlook angesetztes
                       Teams-Meeting). Deshalb kennt der Import die Richtung — im
                       Gesendet-Ordner ist die erkannte Person eine Empfängerin und
                       NICHT die Urheberin des Termins. */
                    for (const keeper of keepers) {
                        if (!keeper.calendarPart)
                            continue;
                        try {
                            const download = await client.download(String(keeper.uid), keeper.calendarPart, { uid: true, maxBytes: 256 * 1024 });
                            const chunks = [];
                            for await (const chunk of download.content)
                                chunks.push(chunk);
                            /* DER TERMIN GEHÖRT DEM POSTFACH (31.08.2026).
                               Bis hierher wurde er in die Firma der erkannten
                               Person gelegt — der Kalender war streng je Firma.
                               Das hatte zwei Folgen, die beide falsch waren: wer
                               die Firma wechselte, sah einen anderen Kalender
                               (obwohl es EIN Postfach ist), und die Termine eines
                               abgelegten Kontos blieben in der Untergesellschaft
                               stehen, weil das Aufräumen am Stamm ansetzte.
    
                               Jetzt liegt der Termin dort, wo auch das Postfach und
                               die Nachrichten liegen: am Stamm. Den Urheber sucht
                               `importCalendarEvent` im ganzen Firmenbaum — am Stamm
                               allein ist oft niemand angestellt, und eine Suche nur
                               dort verwürfe die Einladung wortlos. */
                            const result = await (0, calendarImportService_1.importCalendarObject)(tenantId, Buffer.concat(chunks).toString("utf8"), {
                                senderEmail: partiesOf(keeper.envelope?.from)[0]?.address || null,
                                recipientEmails: [
                                    ...partiesOf(keeper.envelope?.to),
                                    ...partiesOf(keeper.envelope?.cc),
                                ].map((party) => party.address),
                                customerId: keeper.customerId,
                                employeeId: keeper.employeeId,
                                direction: job.direction,
                                mailbox: (0, mailboxIdentity_1.mailboxIdentityOf)(settings),
                                source: "MAIL",
                            });
                            if (result.action !== "ignored") {
                                summary.calendar += 1;
                                console.log(`[MAIL-IN] Termin ${result.action}: ${keeper.envelope?.subject || ""}`);
                            }
                            else {
                                // Der häufigste Anruf ist «warum steht der Termin
                                // nicht im Kalender» — der Grund gehört ins Protokoll.
                                console.log(`[MAIL-IN] Termin übersprungen (${result.reason}): ${keeper.envelope?.subject || ""}`);
                            }
                        }
                        catch (error) {
                            console.error(`[MAIL-IN] Termin aus ${keeper.uid} nicht übernommen:`, error?.message || error);
                        }
                    }
                    /* Je Schub eine Zeile: angefragt / geholt / neu / geschrieben.
                       Weichen die Zahlen voneinander ab, ist genau hier zu sehen,
                       wo Post verloren geht — der Lesestand rückt gleich hinter
                       diesen Schub und sieht ihn nie wieder an. */
                    console.log(`[MAIL-IN] ${job.folder} Schub ${batch[0]}…${batch[batch.length - 1]}: ${batch.length} angefragt,`
                        + ` ${candidates.length} geholt, ${keepers.length} neu, ${inserts.length} geschrieben,`
                        + ` ${inserts.filter((row) => row.categoryId).length} etikettiert`);
                    /* DER LESESTAND DARF NUR ÜBER TATSÄCHLICH ANGESEHENE POST
                       HINWEGRÜCKEN. Liefert der Server auf ein FETCH weniger
                       Nachrichten als angefragt (abgebrochener Strom, während des
                       Durchgangs verschobene Post), stünde der Lesestand sonst
                       hinter Nachrichten, die nie jemand gelesen hat — und da der
                       Abruf nur noch nach vorn schaut, wären sie für immer weg.
                       Darum: bis zur letzten LÜCKENLOS gelieferten UID vorrücken,
                       den Rest im nächsten Durchgang erneut anfragen.
    
                       Kommt aus dem Kopf des Schubs gar nichts (die Nachricht ist
                       auf dem Server verschwunden, seit die Suche lief), rückt der
                       Lesestand trotzdem über den ganzen Schub: sonst fragte der
                       Abruf denselben Schub bis in alle Ewigkeit erneut an und
                       käme nie mehr voran. */
                    const delivered = new Set(candidates.map((item) => item.uid));
                    let highestUid = batch[batch.length - 1];
                    let incomplete = false;
                    if (delivered.size < batch.length) {
                        let contiguous = 0;
                        for (const uid of batch) {
                            if (!delivered.has(uid))
                                break;
                            contiguous = uid;
                        }
                        if (contiguous) {
                            highestUid = contiguous;
                            incomplete = true;
                            console.warn(`[MAIL-IN] ${job.folder}: nur ${candidates.length}/${batch.length} geliefert —`
                                + ` Lesestand bleibt bei ${highestUid}, der Rest wird erneut angefragt.`);
                        }
                        else {
                            console.warn(`[MAIL-IN] ${job.folder}: Schub ${batch[0]}…${highestUid} lieferte nichts —`
                                + ` übersprungen, damit der Abruf weiterläuft.`);
                        }
                    }
                    lastUid = BigInt(highestUid);
                    await prisma_client_1.default.mailSetting.update({
                        where: { tenantId: settingsTenantId },
                        data: job.cursorFields(uidValidity, lastUid),
                    });
                    // Der Schub blieb unvollständig: hier abbrechen, sonst liefe
                    // der nächste Schub aus der ALTEN Trefferliste weiter und
                    // schöbe den Lesestand über die Lücke, die gerade offen blieb.
                    if (incomplete)
                        break;
                    // Zeitbudget erschöpft: der Rest kommt im nächsten Durchgang —
                    // der Lesestand steht schon hinter diesem Schub.
                    if (Date.now() - startedAt > RUN_TIME_BUDGET_MS)
                        break;
                }
            }
            finally {
                lock.release();
            }
        }
        summary.durationMs = Date.now() - startedAt;
        if (dryRun)
            return summary;
        const text = `${summary.examined} geprüft, ${summary.stored} übernommen (${summary.replies} Antworten, ${summary.byAddress} bekannte Adressen, ${summary.calendar} Termine), ${summary.skipped} übersprungen`
            + (summary.skippedRepliesOnly > 0 ? ` — davon ${summary.skippedRepliesOnly} nur wegen «nur Antworten»` : "");
        await prisma_client_1.default.mailSetting.update({
            where: { tenantId: settingsTenantId },
            data: { imapLastSyncAt: new Date(), imapLastSummary: text.slice(0, 255), imapLastError: null },
        });
        if (summary.examined)
            console.log(`[MAIL-IN] ${tenantId}: ${text} (${summary.durationMs}ms)`);
    }
    catch (error) {
        summary.durationMs = Date.now() - startedAt;
        summary.error = error?.message || String(error);
        console.error(`[MAIL-IN] ${tenantId} fehlgeschlagen:`, summary.error);
        if (dryRun)
            return summary;
        await prisma_client_1.default.mailSetting.updateMany({
            where: { tenantId },
            data: { imapLastError: String(summary.error).slice(0, 1000), imapLastSyncAt: new Date() },
        }).catch(() => undefined);
    }
    finally {
        if (client) {
            try {
                await client.logout();
            }
            catch { /* Verbindung ist ohnehin hin */ }
        }
        running.delete(tenantId);
    }
    return summary;
};
exports.captureInbox = captureInbox;
const isCaptureRunning = (tenantId) => running.has(tenantId);
exports.isCaptureRunning = isCaptureRunning;
/** Einen einzelnen Anhang vom Mailserver holen — NICHTS wird gespeichert. */
const fetchImapAttachment = async (selectedTenantId, providerMessageId, part) => {
    // Der Anhang liegt in dem Postfach, aus dem die Nachricht stammt.
    const tenantId = await (0, serviceTenantScope_1.getMailTenantId)(selectedTenantId).catch(() => selectedTenantId);
    const settings = await prisma_client_1.default.mailSetting.findUnique({
        where: { tenantId },
        select: {
            tenantId: true, imapHost: true, imapPort: true, imapSecure: true, imapUser: true, imapPassword: true,
            smtpUser: true, smtpPassword: true, fromEmail: true, imapInboxFolder: true,
            imapCaptureRepliesOnly: true, imapUidValidity: true, imapLastUid: true,
        },
    });
    if (!settings?.imapHost?.trim())
        return null;
    // `<ordner>:<uidvalidity>:<uid>` — der Ordner darf Doppelpunkte enthalten.
    const pieces = String(providerMessageId).split(":");
    const uid = pieces.pop();
    pieces.pop();
    const folder = pieces.join(":") || settings.imapInboxFolder?.trim() || "INBOX";
    if (!uid)
        return null;
    const client = (0, exports.buildImapClient)(settings);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
            const download = await client.download(uid, part, { uid: true });
            if (!download?.content)
                return null;
            const chunks = [];
            for await (const chunk of download.content)
                chunks.push(chunk);
            return {
                content: Buffer.concat(chunks),
                contentType: download.meta?.contentType || null,
            };
        }
        finally {
            lock.release();
        }
    }
    finally {
        try {
            await client.logout();
        }
        catch { /* egal */ }
    }
};
exports.fetchImapAttachment = fetchImapAttachment;
/**
 * Alle Postfächer mit eingeschaltetem Abruf, nacheinander.
 *
 * EIN POSTFACH JE FIRMENBAUM: mehrere Mandanten desselben Baums fallen auf
 * denselben Abruf zusammen. Ohne dieses Zusammenlegen liefen zwei Durchgänge
 * über dasselbe Serverpostfach — doppelte Last, zwei Lesestände, und in der
 * zweiten Firma ein Bestand, der erst mit seinem ersten Lauf beginnt.
 */
const runPass = async () => {
    const tenants = await prisma_client_1.default.mailSetting.findMany({
        where: { imapCaptureEnabled: true, NOT: { imapHost: null } },
        select: { tenantId: true },
        orderBy: { imapLastSyncAt: "asc" },
        take: 50,
    });
    const seen = new Set();
    for (const { tenantId } of tenants) {
        const mailTenantId = await (0, serviceTenantScope_1.getMailTenantId)(tenantId).catch(() => tenantId);
        if (seen.has(mailTenantId) || running.has(mailTenantId))
            continue;
        seen.add(mailTenantId);
        await (0, exports.captureInbox)(mailTenantId);
    }
};
let started = false;
const startImapCaptureService = () => {
    if (started || process.env.OFFITEC_DISABLE_MAIL_SYNC === "true")
        return;
    started = true;
    const tick = () => {
        void runPass().catch((error) => console.error("[MAIL-IN] pass failed:", error?.message || error));
    };
    setTimeout(tick, 25_000);
    setInterval(tick, TICK_MS);
};
exports.startImapCaptureService = startImapCaptureService;
//# sourceMappingURL=ImapCaptureService.js.map