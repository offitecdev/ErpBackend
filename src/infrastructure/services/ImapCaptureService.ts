import { ImapFlow } from "imapflow";
import { nanoid } from "nanoid";
import { Prisma } from "@prisma/client";
import prisma from "../database/prisma.client";
import { getAddressBook, matchAddresses, normalizeAddress } from "./outlook/mailCustomerMatcher";
import { clampBody, htmlToText, previewOf } from "./outlook/mailText";
import { mainBodyOf, stripImagePlaceholders } from "./outlook/mailBodyParts";
import { importCalendarObject } from "./calendarImportService";

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
export const DEFAULT_WINDOW_MONTHS = 2;
/** Erlaubt sind 1 und 2 — alles andere fällt auf die Vorgabe zurück. */
export const normalizeWindowMonths = (value: unknown): number => (Number(value) === 1 ? 1 : DEFAULT_WINDOW_MONTHS);
const lookbackStart = (months: number): Date => {
    const since = new Date();
    since.setMonth(since.getMonth() - normalizeWindowMonths(months));
    return since;
};

export interface CaptureSummary {
    tenantId: string;
    examined: number;
    stored: number;
    replies: number;
    byAddress: number;
    /** Übernommene Kalender-Einladungen (angelegt/aktualisiert/abgesagt). */
    calendar: number;
    skipped: number;
    /**
     * Wie viele davon NUR am Schalter «nur Antworten übernehmen» gescheitert
     * sind: Absender bekannt, aber die Nachricht ist keine Antwort auf eine
     * ERP-Mail. Ohne diese Zahl meldet der Abruf «1 geprüft, 0 übernommen» und
     * verschweigt, dass eine EINSTELLUNG das war und kein Fehler.
     */
    skippedRepliesOnly: number;
    error?: string;
    durationMs: number;
    /** Nur im Probelauf: was übernommen WÜRDE (Betreff + Grund). */
    preview?: Array<{ subject: string; from: string; reason: string; customerId: string | null }>;
    /**
     * Nur im Probelauf: die Absender, die an der Schranke gescheitert sind —
     * ihre Adresse steht nicht im System. Das ist die Antwort auf die Frage,
     * wegen der «Testen» gedrückt wird ("warum kam meine Mail nicht an?"):
     * ohne diese Liste sieht man nur eine Zahl und rät, welche Adresse fehlt.
     */
    unknownSenders?: Array<{ address: string; count: number }>;
}

export interface CaptureOptions {
    /** Lesestand verwerfen und den Ordner erneut vom Anfang des Fensters lesen. */
    reset?: boolean;
    /** Anderen Ordner prüfen, ohne die Einstellung zu ändern (nur Probelauf). */
    folder?: string | null;
    /**
     * PROBELAUF — verbindet, liest und entscheidet wie sonst auch, schreibt aber
     * NICHTS: weder Nachrichten noch Lesestand. Damit lässt sich vor dem
     * Einschalten prüfen, ob Zugangsdaten, Ordner und Filter stimmen.
     */
    dryRun?: boolean;
}

const running = new Set<string>();

type CaptureSettings = {
    tenantId: string;
    imapHost: string | null;
    imapPort: number | null;
    imapSecure: boolean | null;
    imapUser: string | null;
    imapPassword: string | null;
    smtpUser: string | null;
    smtpPassword: string | null;
    fromEmail: string | null;
    imapInboxFolder: string | null;
    imapCaptureRepliesOnly: boolean;
    imapUidValidity: bigint | null;
    imapLastUid: bigint | null;
};

/** `<id@host>`-Liste aus einer Kopfzeile (In-Reply-To / References). */
const messageIds = (value: string | undefined | null): string[] => {
    if (!value) return [];
    return (String(value).match(/<[^>\s]+>/g) || []).map((id) => id.trim());
};

const headerValue = (headers: string, name: string): string | undefined => {
    // Kopfzeilen dürfen umbrechen (Folding): Folgezeilen beginnen mit Leerraum.
    const pattern = new RegExp(`^${name}:[ \\t]*([\\s\\S]*?)(?=\\r?\\n[^ \\t]|$)`, "im");
    const match = pattern.exec(headers);
    return match ? match[1]!.replace(/\r?\n[ \t]+/g, " ").trim() : undefined;
};

type Party = { name: string | null; address: string };

const partyOf = (raw: any): Party | null => {
    const address = normalizeAddress(raw?.address);
    if (!address) return null;
    return { name: String(raw?.name || "").trim() || null, address };
};
const partiesOf = (raw: any): Party[] =>
    (Array.isArray(raw) ? raw.map(partyOf).filter((p): p is Party => Boolean(p)) : []);

/**
 * Anhangs-METADATEN aus der BODYSTRUCTURE (keine Inhalte). `node.type` ist bei
 * imapflow bereits der volle Typ ("application/pdf"), und `node.id` ist die
 * Content-ID: Teile MIT Content-ID sind im HTML eingebettete Bilder (die
 * Signaturgrafiken von Outlook) — die gehören nicht in die Anhangsliste,
 * sonst hinge an jeder Antwort ein "image001.gif".
 */
const attachmentsOf = (node: any, out: Array<{ id: string; name: string; size: number | null; contentType: string | null }> = []) => {
    if (!node) return out;
    const children = node.childNodes || node.children || [];
    for (const child of children) attachmentsOf(child, out);
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
const findTextPart = (node: any): { part: string; encoding: string; charset: string; isHtml: boolean } | null => {
    if (!node) return null;
    const children = node.childNodes || node.children || [];
    if (children.length) {
        const nested = children.map(findTextPart).filter(Boolean) as Array<{ part: string; encoding: string; charset: string; isHtml: boolean }>;
        return nested.find((item) => !item.isHtml) || nested[0] || null;
    }
    const type = String(node.type || "").toLowerCase();
    if (!type.startsWith("text/")) return null;
    // Angehängte .txt/.html-Dateien sind kein Nachrichtentext.
    const disposition = String(node.disposition || "").toLowerCase();
    if (disposition === "attachment") return null;
    return {
        part: String(node.part || "1"),
        encoding: String(node.encoding || "").toLowerCase(),
        charset: String(node.parameters?.charset || "utf-8").toLowerCase(),
        isHtml: type === "text/html",
    };
};

/** Der `text/calendar`-Abschnitt einer Einladung, falls vorhanden. */
const findCalendarPart = (node: any): { part: string } | null => {
    if (!node) return null;
    const children = node.childNodes || node.children || [];
    for (const child of children) {
        const found = findCalendarPart(child);
        if (found) return found;
    }
    const type = String(node.type || "").toLowerCase();
    const filename = String(node.dispositionParameters?.filename || node.parameters?.name || "").toLowerCase();
    if (type === "text/calendar" || filename.endsWith(".ics")) return { part: String(node.part || "1") };
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
const resolveSentFolder = async (client: ImapFlow, configured: string | null | undefined): Promise<string | null> => {
    const wanted = String(configured || "").trim();
    if (wanted) return wanted;
    try {
        const boxes = (await client.list()) as Array<{ path?: string; specialUse?: string }>;
        const special = boxes.find((box) => String(box.specialUse || "") === "\\Sent");
        if (special?.path) return special.path;
        const known = boxes.find((box) => SENT_FOLDER_NAMES.includes(String(box.path || "").toLowerCase()));
        return known?.path || null;
    } catch {
        return null;
    }
};

export const buildImapClient = (settings: CaptureSettings): ImapFlow => {
    const port = Number(settings.imapPort || 993);
    return new ImapFlow({
        host: settings.imapHost!.trim(),
        port,
        secure: settings.imapSecure ?? port === 993,
        auth: {
            // Leere IMAP-Zugangsdaten = dieselben wie SMTP (meist dasselbe Konto).
            user: (settings.imapUser?.trim() || settings.smtpUser?.trim() || "") as string,
            pass: (settings.imapPassword || settings.smtpPassword || "") as string,
        },
        logger: false,
        tls: { rejectUnauthorized: false },
        socketTimeout: 60_000,
        greetingTimeout: 20_000,
        connectionTimeout: 20_000,
    });
};

/**
 * Ein Durchgang für EINEN Mandanten. Wirft nicht: Fehler landen in
 * `MailSetting.imapLastError` und im Rückgabewert.
 */
export const captureInbox = async (tenantId: string, options: CaptureOptions = {}): Promise<CaptureSummary> => {
    const startedAt = Date.now();
    const dryRun = Boolean(options.dryRun);
    const summary: CaptureSummary = { tenantId, examined: 0, stored: 0, replies: 0, byAddress: 0, calendar: 0, skipped: 0, skippedRepliesOnly: 0, durationMs: 0 };
    if (dryRun) summary.preview = [];
    if (running.has(tenantId)) {
        summary.error = "Abruf läuft bereits.";
        return summary;
    }
    running.add(tenantId);
    let client: ImapFlow | null = null;
    try {
        const settings = await prisma.mailSetting.findUnique({
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
        client = buildImapClient(settings as CaptureSettings);
        await client.connect();

        /* ZWEI ORDNER, ZWEI LESESTÄNDE (Vorgabe 19.08.2026: «nicht nur was
           hereinkommt, auch was wir schicken — es soll nicht lokal bleiben»).

             Posteingang   direction IN  — die Gegenstelle ist der ABSENDER
             Gesendet      direction OUT — die Gegenstelle sind die EMPFÄNGER

           Der Gesendet-Ordner führt einen eigenen Lesestand: seine UIDs haben
           mit denen des Posteingangs nichts zu tun. Was das ERP selbst
           verschickt hat, steht schon als Zeile da und wird an der Message-ID
           wiedererkannt — es entsteht kein Doppel.

           Im Probelauf mit ausdrücklichem Ordner bleibt es bei diesem einen. */
        type FolderJob = {
            folder: string;
            direction: "IN" | "OUT";
            uidValidity: bigint | null;
            lastUid: bigint | null;
            cursorFields: (validity: bigint, uid: bigint) => Record<string, bigint>;
        };
        const jobs: FolderJob[] = [{
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
        } catch (error: any) {
            // Ein fehlender oder anders benannter Ordner darf den anderen
            // Durchgang nicht mitreißen — gemeldet, nicht geworfen.
            console.error(`[MAIL-IN] Ordner ${job.folder} nicht lesbar:`, error?.message || error);
            continue;
        }
        try {
            const mailbox: any = client.mailbox;
            const uidValidity = BigInt(mailbox?.uidValidity ?? 0);
            const knownValidity = job.uidValidity;
            // Ordner neu aufgebaut (UIDVALIDITY geändert) → Lesestand verwerfen.
            const resetCursor = Boolean(options.reset) || (knownValidity !== null && knownValidity !== uidValidity);
            let lastUid = resetCursor ? 0n : (job.lastUid ?? 0n);

            let uids: number[] = [];
            if (lastUid > 0n) {
                uids = await client.search({ uid: `${Number(lastUid) + 1}:*` }, { uid: true }) as unknown as number[];
                // Manche Server geben bei `n:*` immer die letzte Nachricht zurück.
                uids = (uids || []).filter((uid) => BigInt(uid) > lastUid);
            } else {
                // Erstlauf: nur das eingestellte Fenster, nicht das ganze Postfach.
                const since = lookbackStart(settings.imapWindowMonths);
                uids = await client.search({ since }, { uid: true }) as unknown as number[];
                uids = uids || [];
            }
            uids.sort((a, b) => a - b);
            const batch = uids.slice(0, MAX_PER_RUN);

            if (batch.length) {
                const own = normalizeAddress(settings.fromEmail);
                const book = await getAddressBook(tenantId);

                // ── 1. NUR KOPFZEILEN: was ist überhaupt relevant? ────────────
                type Candidate = {
                    uid: number;
                    envelope: any;
                    refs: string[];
                    messageId: string | null;
                    bodyStructure: any;
                    internalDate: Date;
                };
                const candidates: Candidate[] = [];
                for await (const message of client.fetch(
                    batch.map(String).join(","),
                    { uid: true, envelope: true, bodyStructure: true, internalDate: true, headers: ["in-reply-to", "references", "message-id"] },
                    { uid: true },
                )) {
                    summary.examined += 1;
                    const headers = message.headers ? message.headers.toString() : "";
                    const refs = [
                        ...messageIds(headerValue(headers, "in-reply-to")),
                        ...messageIds(headerValue(headers, "references")),
                    ];
                    const messageId = (message.envelope?.messageId
                        || messageIds(headerValue(headers, "message-id"))[0]
                        || null) as string | null;
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
                const ownIds = candidates.map((c) => c.messageId).filter(Boolean) as string[];
                const refIds = Array.from(new Set(candidates.flatMap((c) => c.refs)));
                const [existing, parents] = await Promise.all([
                    ownIds.length
                        ? prisma.mailMessage.findMany({
                            where: { tenantId, internetMessageId: { in: ownIds } },
                            select: { internetMessageId: true },
                        })
                        : Promise.resolve([]),
                    refIds.length
                        ? prisma.mailMessage.findMany({
                            where: { tenantId, internetMessageId: { in: refIds } },
                            select: {
                                internetMessageId: true, customerId: true, contactId: true,
                                entityType: true, entityId: true, entityLabel: true, employeeId: true,
                            },
                        })
                        : Promise.resolve([]),
                ]);
                const known = new Set(existing.map((row) => row.internetMessageId));
                const parentById = new Map(parents.map((row) => [row.internetMessageId!, row]));

                type Keeper = Candidate & {
                    customerId: string | null;
                    contactId: string | null;
                    matchSource: "REPLY" | "AUTO_ADDRESS" | "AUTO_DOMAIN" | "AUTO_EMPLOYEE";
                    calendarPart?: string | null;
                    entityType: string | null;
                    entityId: string | null;
                    entityLabel: string | null;
                    employeeId: string | null;
                };
                const keepers: Keeper[] = [];
                /* NUR im Probelauf: Nachrichten, die einzig am Schalter «nur
                   Antworten übernehmen» scheitern. Der Absender steht im System,
                   die Nachricht ist bloss keine Antwort auf eine ERP-Mail. Ohne
                   diese Liste meldet «Testen» nur «1 geprüft, 0 übernommen» und
                   verschweigt, dass eine EINSTELLUNG das war. */
                const blockedByRepliesOnly: Candidate[] = [];
                /* Ebenfalls nur im Probelauf: wer an der Schranke scheitert,
                   nach Adresse gezählt. */
                const unknown = new Map<string, number>();
                for (const candidate of candidates) {
                    if (candidate.messageId && known.has(candidate.messageId)) { summary.skipped += 1; continue; }

                    // ── SCHRANKE: die GEGENSTELLE muss im System stehen ─────────────
                    // Zuerst und für JEDE Nachricht. Ohne Treffer wird nichts
                    // gespeichert — auch keine Antwort und keine Einladung.
                    /* Im Posteingang ist die Gegenstelle der ABSENDER, im
                       Gesendet-Ordner sind es die EMPFÄNGER: dort sind WIR der
                       Absender, und «schreibt uns jemand Bekanntes» hiesse dort
                       «schreiben wir uns selbst». */
                    const counterparts = (job.direction === "OUT"
                        ? [...partiesOf(candidate.envelope?.to), ...partiesOf(candidate.envelope?.cc)]
                        : [...partiesOf(candidate.envelope?.from), ...partiesOf(candidate.envelope?.replyTo)]
                    ).map((p) => p.address).filter((address) => address && address !== own);
                    const hit = matchAddresses(book, counterparts);
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
                        if (dryRun) blockedByRepliesOnly.push(candidate);
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
                const inserts: Prisma.MailMessageCreateManyInput[] = [];
                for (const keeper of keepers) {
                    let bodyText: string | null = null;
                    const textPart = findTextPart(keeper.bodyStructure);
                    try {
                        // Nur DIESEN Abschnitt holen — nicht die ganze Nachricht:
                        // ein 20-MB-Anhang muss für eine Textvorschau nicht über
                        // die Leitung. `maxBytes` deckelt im Strom selbst; imapflow
                        // dekodiert dabei bereits Transportkodierung UND Zeichensatz
                        // nach UTF-8 (ein zweites Dekodieren zerstörte base64-Teile).
                        const download = await client.download(String(keeper.uid), textPart?.part || "1", { uid: true, maxBytes: 512 * 1024 });
                        const chunks: Buffer[] = [];
                        for await (const chunk of download.content as any) chunks.push(chunk as Buffer);
                        const decoded = Buffer.concat(chunks).toString("utf8");
                        // Bildplatzhalter ("[cid:…]", "[image: …]") sind Reste der
                        // Umwandlung und sagen nichts — sie stünden sonst mitten im Satz.
                        bodyText = clampBody(stripImagePlaceholders(textPart?.isHtml ? htmlToText(decoded) : decoded.trim()));
                    } catch (error: any) {
                        console.error(`[MAIL-IN] Rumpf ${keeper.uid} nicht lesbar:`, error?.message || error);
                    }

                    const from = partiesOf(keeper.envelope?.from)[0] || null;
                    const to = partiesOf(keeper.envelope?.to);
                    const cc = partiesOf(keeper.envelope?.cc);
                    const attachments = attachmentsOf(keeper.bodyStructure);
                    const sentAt = keeper.envelope?.date ? new Date(keeper.envelope.date) : keeper.internalDate;

                    inserts.push({
                        id: nanoid(12),
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
                        toRecipients: to as unknown as Prisma.InputJsonValue,
                        ccRecipients: cc.length ? (cc as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
                        /* Die VORSCHAU kommt aus dem neuen Teil der Nachricht:
                           bei einem "RE:" hängt der ganze Verlauf mit dran, und
                           in der Liste stünde sonst der Anfang eines alten
                           Zitats statt dessen, was gerade geschrieben wurde.
                           Der volle Text bleibt gespeichert — der Lesebereich
                           zerlegt ihn beim Anzeigen. */
                        bodyPreview: previewOf(mainBodyOf(bodyText) || bodyText, 500),
                        bodyText,
                        sentAt: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
                        hasAttachments: attachments.length > 0,
                        attachments: attachments.length ? (attachments as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
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
                    await prisma.mailMessage.createMany({ data: inserts, skipDuplicates: true });
                    summary.stored += inserts.length;
                }

                // KALENDER: Einladungen in den ERP-Kalender übernehmen. Erst nach
                // dem Speichern der Nachricht — der Termin ist die Zugabe, die
                // Mail bleibt in jedem Fall in der Kommunikation stehen.
                for (const keeper of keepers) {
                    if (!keeper.calendarPart) continue;
                    try {
                        const download = await client.download(String(keeper.uid), keeper.calendarPart, { uid: true, maxBytes: 256 * 1024 });
                        const chunks: Buffer[] = [];
                        for await (const chunk of download.content as any) chunks.push(chunk as Buffer);
                        const result = await importCalendarObject(tenantId, Buffer.concat(chunks).toString("utf8"), {
                            senderEmail: partiesOf(keeper.envelope?.from)[0]?.address || null,
                            customerId: keeper.customerId,
                            employeeId: keeper.employeeId,
                        });
                        if (result.action !== "ignored") {
                            summary.calendar += 1;
                            console.log(`[MAIL-IN] Termin ${result.action}: ${keeper.envelope?.subject || ""}`);
                        }
                    } catch (error: any) {
                        console.error(`[MAIL-IN] Termin aus ${keeper.uid} nicht übernommen:`, error?.message || error);
                    }
                }

                const highestUid = batch[batch.length - 1]!;
                lastUid = BigInt(highestUid);
                await prisma.mailSetting.update({
                    where: { tenantId },
                    data: job.cursorFields(uidValidity, lastUid),
                });
            } else if (!dryRun && (resetCursor || job.uidValidity === null)) {
                await prisma.mailSetting.update({
                    where: { tenantId },
                    data: job.cursorFields(BigInt((client.mailbox as any)?.uidValidity ?? 0), 0n),
                });
            }
        } finally {
            lock.release();
        }
        }

        summary.durationMs = Date.now() - startedAt;
        if (dryRun) return summary;
        const text = `${summary.examined} geprüft, ${summary.stored} übernommen (${summary.replies} Antworten, ${summary.byAddress} bekannte Adressen, ${summary.calendar} Termine), ${summary.skipped} übersprungen`
            + (summary.skippedRepliesOnly > 0 ? ` — davon ${summary.skippedRepliesOnly} nur wegen «nur Antworten»` : "");
        await prisma.mailSetting.update({
            where: { tenantId },
            data: { imapLastSyncAt: new Date(), imapLastSummary: text.slice(0, 255), imapLastError: null },
        });
        if (summary.examined) console.log(`[MAIL-IN] ${tenantId}: ${text} (${summary.durationMs}ms)`);
    } catch (error: any) {
        summary.durationMs = Date.now() - startedAt;
        summary.error = error?.message || String(error);
        console.error(`[MAIL-IN] ${tenantId} fehlgeschlagen:`, summary.error);
        if (dryRun) return summary;
        await prisma.mailSetting.update({
            where: { tenantId },
            data: { imapLastError: String(summary.error).slice(0, 1000), imapLastSyncAt: new Date() },
        }).catch(() => undefined);
    } finally {
        if (client) { try { await client.logout(); } catch { /* Verbindung ist ohnehin hin */ } }
        running.delete(tenantId);
    }
    return summary;
};

export const isCaptureRunning = (tenantId: string) => running.has(tenantId);

/** Einen einzelnen Anhang vom Mailserver holen — NICHTS wird gespeichert. */
export const fetchImapAttachment = async (
    tenantId: string,
    providerMessageId: string,
    part: string,
): Promise<{ content: Buffer; contentType: string | null } | null> => {
    const settings = await prisma.mailSetting.findUnique({
        where: { tenantId },
        select: {
            tenantId: true, imapHost: true, imapPort: true, imapSecure: true, imapUser: true, imapPassword: true,
            smtpUser: true, smtpPassword: true, fromEmail: true, imapInboxFolder: true,
            imapCaptureRepliesOnly: true, imapUidValidity: true, imapLastUid: true,
        },
    });
    if (!settings?.imapHost?.trim()) return null;
    // `<ordner>:<uidvalidity>:<uid>` — der Ordner darf Doppelpunkte enthalten.
    const pieces = String(providerMessageId).split(":");
    const uid = pieces.pop();
    pieces.pop();
    const folder = pieces.join(":") || settings.imapInboxFolder?.trim() || "INBOX";
    if (!uid) return null;

    const client = buildImapClient(settings as CaptureSettings);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
            const download = await client.download(uid, part, { uid: true });
            if (!download?.content) return null;
            const chunks: Buffer[] = [];
            for await (const chunk of download.content as any) chunks.push(chunk as Buffer);
            return {
                content: Buffer.concat(chunks),
                contentType: (download as any).meta?.contentType || null,
            };
        } finally {
            lock.release();
        }
    } finally {
        try { await client.logout(); } catch { /* egal */ }
    }
};

/** Alle Mandanten mit eingeschaltetem Abruf, nacheinander. */
const runPass = async (): Promise<void> => {
    const tenants = await prisma.mailSetting.findMany({
        where: { imapCaptureEnabled: true, NOT: { imapHost: null } },
        select: { tenantId: true },
        orderBy: { imapLastSyncAt: "asc" },
        take: 50,
    });
    for (const { tenantId } of tenants) {
        if (running.has(tenantId)) continue;
        await captureInbox(tenantId);
    }
};

let started = false;
export const startImapCaptureService = (): void => {
    if (started || process.env.OFFITEC_DISABLE_MAIL_SYNC === "true") return;
    started = true;
    const tick = () => {
        void runPass().catch((error) => console.error("[MAIL-IN] pass failed:", error?.message || error));
    };
    setTimeout(tick, 25_000);
    setInterval(tick, TICK_MS);
};
