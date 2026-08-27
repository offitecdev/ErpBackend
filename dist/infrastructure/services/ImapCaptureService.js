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
const mailText_1 = require("./outlook/mailText");
const mailBodyParts_1 = require("./outlook/mailBodyParts");
const calendarImportService_1 = require("./calendarImportService");
/**
 * POSTEINGANG DES EIGENEN MAILSERVERS → ERP (Vorgabe 18.08.2026).
 *
 * Ein Dienst liest per IMAP (imapflow) den Posteingang des Firmenpostfachs und
 * legt NUR Nachrichten BEKANNTER Absender als `MailMessage` ab.
 *
 * DIE HARTE REGEL (Vorgabe 18.08.2026): "wir übernehmen niemals die Adresse
 * von jemandem, der nicht im System steht". Der Absender MUSS sich also im
 * Adressbuch auflösen lassen —
 *
 *   • Adresse eines Kunden oder Ansprechpartners  → AUTO_ADDRESS
 *   • eindeutige Firmendomain eines Kunden        → AUTO_DOMAIN
 *   • Adresse einer registrierten Person          → AUTO_EMPLOYEE
 *
 * Löst sie sich nicht auf, wird die Nachricht gelesen, verworfen und NIE
 * gespeichert — auch dann nicht, wenn sie eine Antwort auf eine ERP-Mail zu
 * sein scheint oder eine Kalender-Einladung enthält.
 *
 * Über dieser Schranke steht nur noch die GENAUIGKEIT der Zuordnung:
 *   – Ist die Nachricht eine ANTWORT auf eine ERP-Mail (`In-Reply-To` /
 *     `References` nennen eine von uns vergebene Message-ID), erbt sie Kunde,
 *     Ansprechpartner und Beleg direkt vom Original — sicher statt geraten.
 *   – Enthält sie eine KALENDER-EINLADUNG (`text/calendar`), wandert der Termin
 *     zusätzlich in den ERP-Kalender (calendarImportService).
 *   – `imapCaptureRepliesOnly` verengt weiter auf reine Antworten.
 *
 * Alles andere (Newsletter, Rechnungen von Lieferanten, private Post) wird
 * gelesen, verworfen und NIE gespeichert. Gespeichert werden ohnehin nur die
 * Grunddaten: Absender, Empfänger, Betreff, Zeitpunkt, Textkörper. Anhänge
 * bleiben auf dem Mailserver; abgelegt werden nur ihre Namen/Grössen.
 *
 * ABLAUF PRO DURCHGANG (billig gehalten, weil er alle zwei Minuten läuft):
 *   UID-Fenster bestimmen → NUR KOPFZEILEN der neuen Nachrichten holen →
 *   Relevanz entscheiden → nur für die Treffer den Textkörper nachladen.
 *
 * Der Lesestand steht in `MailSetting.imapLastUid` (+ `imapUidValidity`, damit
 * ein neu aufgebauter Ordner nicht mit alten UIDs verwechselt wird). Nichts
 * wird auf dem Server verändert: keine Flags, keine Verschiebungen, kein
 * Löschen — das Postfach bleibt so, wie der Benutzer es in Outlook sieht.
 */
/* Alle drei Minuten (Vorgabe 19.08.2026). Der Durchgang ist billig gehalten —
   er holt nur die Kopfzeilen der Nachrichten hinter dem Lesestand. */
const TICK_MS = 3 * 60_000;
/** Höchstens so viele Nachrichten pro Durchgang (Rest im nächsten Lauf). */
const MAX_PER_RUN = 200;
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
/**
 * Findet den Textabschnitt über die BODYSTRUCTURE, die der Server liefert —
 * NICHT durch Zerlegen der Rohnachricht. Mehrteilige Mails sind verschachtelt
 * (mixed › related › alternative › text/plain + text/html); wer die Rohbytes
 * am äussersten Grenzstring zerschneidet, erwischt den nächsten Grenzstring
 * statt des Textes und schreibt "------=_NextPart_001…" in die Vorschau.
 * Bevorzugt wird text/plain, sonst text/html.
 */
const findTextPart = (node) => {
    if (!node)
        return null;
    const children = node.childNodes || node.children || [];
    if (children.length) {
        const nested = children.map(findTextPart).filter(Boolean);
        return nested.find((item) => !item.isHtml) || nested[0] || null;
    }
    const type = String(node.type || "").toLowerCase();
    if (!type.startsWith("text/"))
        return null;
    // Angehängte .txt/.html-Dateien sind kein Nachrichtentext.
    const disposition = String(node.disposition || "").toLowerCase();
    if (disposition === "attachment")
        return null;
    return {
        part: String(node.part || "1"),
        encoding: String(node.encoding || "").toLowerCase(),
        charset: String(node.parameters?.charset || "utf-8").toLowerCase(),
        isHtml: type === "text/html",
    };
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
 * Ein Durchgang für EINEN Mandanten. Wirft nicht: Fehler landen in
 * `MailSetting.imapLastError` und im Rückgabewert.
 */
const captureInbox = async (tenantId, options = {}) => {
    const startedAt = Date.now();
    const dryRun = Boolean(options.dryRun);
    const summary = { tenantId, examined: 0, stored: 0, replies: 0, byAddress: 0, calendar: 0, skipped: 0, skippedRepliesOnly: 0, durationMs: 0 };
    if (dryRun)
        summary.preview = [];
    if (running.has(tenantId)) {
        summary.error = "Abruf läuft bereits.";
        return summary;
    }
    running.add(tenantId);
    let client = null;
    try {
        const settings = await prisma_client_1.default.mailSetting.findUnique({
            where: { tenantId },
            select: {
                tenantId: true, imapHost: true, imapPort: true, imapSecure: true, imapUser: true, imapPassword: true,
                smtpUser: true, smtpPassword: true, fromEmail: true, imapInboxFolder: true,
                imapCaptureRepliesOnly: true, imapUidValidity: true, imapLastUid: true, imapWindowMonths: true,
                sentFolder: true, imapSentUidValidity: true, imapSentLastUid: true,
            },
        });
        if (!settings?.imapHost?.trim()) {
            summary.error = "Kein IMAP-Server hinterlegt.";
            return summary;
        }
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
                const batch = uids.slice(0, MAX_PER_RUN);
                if (batch.length) {
                    const own = (0, mailCustomerMatcher_1.normalizeAddress)(settings.fromEmail);
                    const book = await (0, mailCustomerMatcher_1.getAddressBook)(tenantId);
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
                    const refIds = Array.from(new Set(candidates.flatMap((c) => c.refs)));
                    const [existing, parents] = await Promise.all([
                        ownIds.length
                            ? prisma_client_1.default.mailMessage.findMany({
                                where: { tenantId, internetMessageId: { in: ownIds } },
                                select: { internetMessageId: true },
                            })
                            : Promise.resolve([]),
                        refIds.length
                            ? prisma_client_1.default.mailMessage.findMany({
                                where: { tenantId, internetMessageId: { in: refIds } },
                                select: {
                                    internetMessageId: true, customerId: true, contactId: true,
                                    entityType: true, entityId: true, entityLabel: true, employeeId: true,
                                },
                            })
                            : Promise.resolve([]),
                    ]);
                    const known = new Set(existing.map((row) => row.internetMessageId));
                    const parentById = new Map(parents.map((row) => [row.internetMessageId, row]));
                    const keepers = [];
                    /* NUR im Probelauf: Nachrichten, die einzig am Schalter «nur
                       Antworten übernehmen» scheitern. Der Absender steht im System,
                       die Nachricht ist bloss keine Antwort auf eine ERP-Mail. Ohne
                       diese Liste meldet «Testen» nur «1 geprüft, 0 übernommen» und
                       verschweigt, dass eine EINSTELLUNG das war. */
                    const blockedByRepliesOnly = [];
                    /* Ebenfalls nur im Probelauf: wer an der Schranke scheitert,
                       nach Adresse gezählt. */
                    const unknown = new Map();
                    for (const candidate of candidates) {
                        if (candidate.messageId && known.has(candidate.messageId)) {
                            summary.skipped += 1;
                            continue;
                        }
                        // ── SCHRANKE: die GEGENSTELLE muss im System stehen ─────────────
                        // Zuerst und für JEDE Nachricht. Ohne Treffer wird nichts
                        // gespeichert — auch keine Antwort und keine Einladung.
                        /* Im Posteingang ist die Gegenstelle der ABSENDER, im
                           Gesendet-Ordner sind es die EMPFÄNGER: dort sind WIR der
                           Absender, und «schreibt uns jemand Bekanntes» hiesse dort
                           «schreiben wir uns selbst». */
                        const counterparts = (job.direction === "OUT"
                            ? [...partiesOf(candidate.envelope?.to), ...partiesOf(candidate.envelope?.cc)]
                            : [...partiesOf(candidate.envelope?.from), ...partiesOf(candidate.envelope?.replyTo)]).map((p) => p.address).filter((address) => address && address !== own);
                        const hit = (0, mailCustomerMatcher_1.matchAddresses)(book, counterparts);
                        if (!hit) {
                            summary.skipped += 1;
                            if (dryRun) {
                                const address = counterparts[0] || "(ohne Absender)";
                                unknown.set(address, (unknown.get(address) || 0) + 1);
                            }
                            continue;
                        }
                        const calendarPart = findCalendarPart(candidate.bodyStructure)?.part ?? null;
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
                                calendarPart,
                            });
                            summary.replies += 1;
                            continue;
                        }
                        // (2) Sonst zählt der Adresstreffer selbst. Der strenge
                        // Modus lässt nur Antworten durch und endet hier.
                        // «Nur Antworten» ist eine Regel gegen fremde Post im
                        // Posteingang. Was WIR verschickt haben, ist nie fremd.
                        if (job.direction === "IN" && settings.imapCaptureRepliesOnly) {
                            summary.skipped += 1;
                            summary.skippedRepliesOnly += 1;
                            if (dryRun)
                                blockedByRepliesOnly.push(candidate);
                            continue;
                        }
                        keepers.push({
                            ...candidate,
                            customerId: hit.customerId,
                            contactId: hit.contactId,
                            matchSource: hit.source,
                            entityType: null,
                            entityId: null,
                            entityLabel: null,
                            // Post einer registrierten Person: sie "gehört" ihr, damit
                            // sie im Postfach als eigene Zeile erkennbar ist.
                            employeeId: hit.employeeId,
                            calendarPart,
                        });
                        summary.byAddress += 1;
                    }
                    if (dryRun) {
                        summary.preview = [
                            ...keepers.map((keeper) => ({
                                subject: String(keeper.envelope?.subject || "(kein Betreff)").slice(0, 120),
                                from: partiesOf(keeper.envelope?.from)[0]?.address || "",
                                reason: keeper.matchSource,
                                customerId: keeper.customerId,
                            })),
                            ...blockedByRepliesOnly.map((candidate) => ({
                                subject: String(candidate.envelope?.subject || "(kein Betreff)").slice(0, 120),
                                from: partiesOf(candidate.envelope?.from)[0]?.address || "",
                                // Absender bekannt, Schalter im Weg — genau der Fall,
                                // den man beim Testen sucht.
                                reason: "BLOCKED_REPLIES_ONLY",
                                customerId: null,
                            })),
                        ].slice(0, 25);
                        summary.unknownSenders = Array.from(unknown.entries())
                            .map(([address, count]) => ({ address, count }))
                            .sort((a, b) => b.count - a.count)
                            .slice(0, 40);
                        summary.stored = keepers.length;
                        summary.durationMs = Date.now() - startedAt;
                        return summary;
                    }
                    // ── 2. NUR für die Treffer den Textkörper holen ───────────────
                    const inserts = [];
                    for (const keeper of keepers) {
                        let bodyText = null;
                        const textPart = findTextPart(keeper.bodyStructure);
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
                        }
                        catch (error) {
                            console.error(`[MAIL-IN] Rumpf ${keeper.uid} nicht lesbar:`, error?.message || error);
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
                        });
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
                            const result = await (0, calendarImportService_1.importCalendarObject)(tenantId, Buffer.concat(chunks).toString("utf8"), {
                                senderEmail: partiesOf(keeper.envelope?.from)[0]?.address || null,
                                customerId: keeper.customerId,
                                employeeId: keeper.employeeId,
                                direction: job.direction,
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
                    const highestUid = batch[batch.length - 1];
                    lastUid = BigInt(highestUid);
                    await prisma_client_1.default.mailSetting.update({
                        where: { tenantId },
                        data: job.cursorFields(uidValidity, lastUid),
                    });
                }
                else if (!dryRun && (resetCursor || job.uidValidity === null)) {
                    await prisma_client_1.default.mailSetting.update({
                        where: { tenantId },
                        data: job.cursorFields(BigInt(client.mailbox?.uidValidity ?? 0), 0n),
                    });
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
            where: { tenantId },
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
        await prisma_client_1.default.mailSetting.update({
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
const fetchImapAttachment = async (tenantId, providerMessageId, part) => {
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
/** Alle Mandanten mit eingeschaltetem Abruf, nacheinander. */
const runPass = async () => {
    const tenants = await prisma_client_1.default.mailSetting.findMany({
        where: { imapCaptureEnabled: true, NOT: { imapHost: null } },
        select: { tenantId: true },
        orderBy: { imapLastSyncAt: "asc" },
        take: 50,
    });
    for (const { tenantId } of tenants) {
        if (running.has(tenantId))
            continue;
        await (0, exports.captureInbox)(tenantId);
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