"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testCalendarAccess = exports.startCaldavCaptureService = exports.captureCalendar = exports.discoverCalendars = exports.isCaldavRunning = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const serviceTenantScope_1 = require("../../presentation/controllers/serviceTenantScope");
const calendarInvite_1 = require("./calendarInvite");
const calendarImportService_1 = require("./calendarImportService");
const mailboxIdentity_1 = require("./mailboxIdentity");
/** Wie weit der Kalender gelesen wird: ein Monat zurück, sechs nach vorn. */
const WINDOW_BACK_DAYS = 31;
const WINDOW_AHEAD_DAYS = 183;
const REQUEST_TIMEOUT_MS = 20_000;
/* Ein Durchgang je Postfach, wie beim Mailabruf. Zwei gleichzeitige Läufe
   würden einander die Aufräumrunde unter den Füssen wegziehen: der eine hat
   seine Termine noch nicht geschrieben, während der andere schon zählt, was
   fehlt — und löschte, was gleich wieder da wäre. */
const running = new Set();
const isCaldavRunning = (tenantId) => running.has(tenantId);
exports.isCaldavRunning = isCaldavRunning;
const xmlText = (block, tag) => {
    // Namensräume sind bei CalDAV nicht vorhersagbar (`d:`, `D:`, gar keiner),
    // darum wird das Präfix übersprungen statt geraten.
    const match = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "i").exec(block);
    return match ? match[1].trim() : null;
};
const xmlBlocks = (body, tag) => {
    const out = [];
    const pattern = new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "gi");
    for (const match of body.matchAll(pattern))
        out.push(match[1]);
    return out;
};
const decodeXml = (value) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
/** Eine relative `href` aus der Antwort auf eine absolute Adresse bringen. */
const absolute = (base, href) => {
    try {
        return new URL(decodeXml(href.trim()), base).toString();
    }
    catch {
        return "";
    }
};
const davFetch = async ({ url, method, auth, depth, body }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method,
            redirect: "follow",
            signal: controller.signal,
            headers: {
                Authorization: auth,
                "Content-Type": 'application/xml; charset="utf-8"',
                ...(depth ? { Depth: depth } : {}),
            },
            // Nur setzen, wenn es einen gibt: `exactOptionalPropertyTypes`
            // unterscheidet "kein Rumpf" von "Rumpf undefined".
            ...(body ? { body } : {}),
        });
        return { status: response.status, body: await response.text(), url: response.url || url };
    }
    finally {
        clearTimeout(timer);
    }
};
const PROP_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const PROP_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;
const PROP_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;
/**
 * DIE ADRESSE DES KALENDERS FINDEN.
 *
 * Eingetragen werden muss nichts: RFC 6764 verlangt von jedem CalDAV-Server ein
 * `/.well-known/caldav`, das auf den Einstiegspunkt zeigt. Von dort führen zwei
 * Schritte zum Ziel — `current-user-principal` sagt, WER man ist,
 * `calendar-home-set` sagt, wo die eigenen Kalender liegen.
 *
 * Der Startpunkt wird aus dem IMAP-Server abgeleitet (`mail.cyon.ch` ⇒
 * `https://mail.cyon.ch`), es sei denn, in den Einstellungen steht eine eigene
 * Adresse. Wer eine einträgt, überspringt die Suche nicht — sie ist bloss der
 * Startpunkt; auch eine direkt eingetragene Kalenderadresse wird geprüft.
 */
const discoverCalendars = async (startUrl, auth) => {
    const tried = new Set();
    const roots = [];
    const push = (url) => { if (url && !tried.has(url)) {
        tried.add(url);
        roots.push(url);
    } };
    try {
        const base = new URL(startUrl);
        push(new URL("/.well-known/caldav", base).toString());
        push(base.toString());
        push(new URL("/", base).toString());
    }
    catch {
        return { calendars: [], error: "Die CalDAV-Adresse ist keine gültige URL." };
    }
    let principal = "";
    let lastStatus = 0;
    for (const root of roots) {
        const response = await davFetch({ url: root, method: "PROPFIND", auth, depth: "0", body: PROP_PRINCIPAL });
        lastStatus = response.status;
        if (response.status === 401 || response.status === 403) {
            return { calendars: [], error: "Der Server hat die Zugangsdaten abgelehnt (401/403)." };
        }
        if (response.status < 200 || response.status >= 300)
            continue;
        const href = xmlText(xmlText(response.body, "current-user-principal") || "", "href");
        if (href) {
            principal = absolute(response.url, href);
            break;
        }
        // Manche Server antworten auf dem Kalender selbst ohne Principal —
        // dann ist die angesprochene Adresse schon die Sammlung.
        if (/calendar/i.test(response.body)) {
            principal = response.url;
            break;
        }
    }
    if (!principal) {
        return { calendars: [], error: `Kein CalDAV-Einstiegspunkt gefunden (zuletzt HTTP ${lastStatus || 0}).` };
    }
    let home = principal;
    const homeResponse = await davFetch({ url: principal, method: "PROPFIND", auth, depth: "0", body: PROP_HOME });
    if (homeResponse.status >= 200 && homeResponse.status < 300) {
        const href = xmlText(xmlText(homeResponse.body, "calendar-home-set") || "", "href");
        if (href)
            home = absolute(homeResponse.url, href);
    }
    const listing = await davFetch({ url: home, method: "PROPFIND", auth, depth: "1", body: PROP_CALENDARS });
    if (listing.status < 200 || listing.status >= 300) {
        return { calendars: [], error: `Die Kalenderliste war nicht lesbar (HTTP ${listing.status}).` };
    }
    const calendars = [];
    for (const block of xmlBlocks(listing.body, "response")) {
        // Nur echte Kalender, und nur solche, die TERMINE führen: ein
        // Adressbuch oder eine reine Aufgabenliste liegt im selben Verzeichnis
        // und lieferte auf die Terminabfrage nichts als Fehler.
        if (!/<(?:[\w-]+:)?calendar[\s/>]/i.test(block))
            continue;
        const components = xmlText(block, "supported-calendar-component-set");
        if (components && !/name\s*=\s*"VEVENT"/i.test(components))
            continue;
        const href = xmlText(block, "href");
        if (!href)
            continue;
        const url = absolute(listing.url, href);
        if (!url || calendars.some((entry) => entry.href === url))
            continue;
        calendars.push({ href: url, displayName: decodeXml(xmlText(block, "displayname") || "").slice(0, 120) || "Kalender" });
    }
    if (!calendars.length)
        return { calendars: [], error: "Der Zugang steht, aber es wurde kein Kalender gefunden." };
    return { calendars };
};
exports.discoverCalendars = discoverCalendars;
/** Termine eines Kalenders in einem Zeitraum — Serien vom Server aufgelöst. */
const queryEvents = async (calendarHref, auth, from, to) => {
    const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    /* `expand` lässt den SERVER die Wiederholungsregeln auflösen: jede
       wöchentliche Besprechung kommt als eigenes VEVENT mit eigener
       RECURRENCE-ID zurück, statt als ein Serienkopf, den der ERP-Kalender
       ohnehin abweisen müsste. Das ist der ganze Unterschied zwischen «der
       Kalender ist da» und «der Kalender ist halb da». */
    const withExpand = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-data><c:expand start="${stamp(from)}" end="${stamp(to)}"/></c:calendar-data>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${stamp(from)}" end="${stamp(to)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
    const plain = withExpand.replace(/<c:calendar-data>[\s\S]*?<\/c:calendar-data>/, "<c:calendar-data/>");
    let response = await davFetch({ url: calendarHref, method: "REPORT", auth, depth: "1", body: withExpand });
    // Nicht jeder Server beherrscht `expand`. Dann wird ohne gefragt; die
    // Serienköpfe weist der Import mit eigenem Grund ab, alles andere kommt an.
    if (response.status < 200 || response.status >= 300) {
        response = await davFetch({ url: calendarHref, method: "REPORT", auth, depth: "1", body: plain });
    }
    if (response.status < 200 || response.status >= 300) {
        return { payloads: [], error: `HTTP ${response.status}` };
    }
    return { payloads: xmlBlocks(response.body, "calendar-data").map(decodeXml) };
};
/**
 * EIN DURCHGANG FÜR EIN POSTFACH. Wirft nicht: Fehler landen in
 * `MailSetting.caldavLastError` und im Rückgabewert.
 */
const captureCalendar = async (selectedTenantId) => {
    const startedAt = Date.now();
    const tenantId = await (0, serviceTenantScope_1.getMailTenantId)(selectedTenantId).catch(() => selectedTenantId);
    const summary = {
        tenantId, calendars: 0, examined: 0, created: 0, updated: 0, removed: 0, skipped: 0, durationMs: 0,
    };
    if (running.has(tenantId)) {
        summary.error = "Kalenderabruf läuft bereits.";
        return summary;
    }
    running.add(tenantId);
    try {
        const settings = await prisma_client_1.default.mailSetting.findUnique({
            where: { tenantId },
            select: {
                imapHost: true, imapUser: true, imapPassword: true, smtpUser: true, fromEmail: true,
                caldavEnabled: true, caldavUrl: true, caldavUser: true, caldavPassword: true, caldavCalendars: true,
            },
        });
        if (!settings?.caldavEnabled) {
            summary.error = "Kalenderabruf ist ausgeschaltet.";
            return summary;
        }
        /* DASSELBE KONTO. Leer gelassene Felder erben vom IMAP-Zugang — es ist
           ein Postfach, kein zweites System. Wer hier etwas einträgt, weicht
           bewusst ab (etwa ein eigenes Anwendungspasswort). */
        const user = settings.caldavUser?.trim() || settings.imapUser?.trim() || "";
        const password = settings.caldavPassword?.trim() || settings.imapPassword?.trim() || "";
        if (!user || !password) {
            summary.error = "Für den Kalender fehlen Benutzer oder Passwort.";
            return summary;
        }
        const startUrl = settings.caldavUrl?.trim()
            || (settings.imapHost?.trim() ? `https://${settings.imapHost.trim()}` : "");
        if (!startUrl) {
            summary.error = "Keine CalDAV-Adresse und kein IMAP-Server hinterlegt.";
            return summary;
        }
        const mailbox = (0, mailboxIdentity_1.mailboxIdentityOf)(settings);
        const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
        /* Die gefundenen Kalender werden gespeichert: die Ermittlung kostet drei
           Anfragen, und der Kalender wird alle paar Minuten abgerufen. Fällt der
           gespeicherte Stand aus (Kalender umbenannt, Server umgezogen), wird
           einmal neu gesucht. */
        let calendars = Array.isArray(settings.caldavCalendars)
            ? settings.caldavCalendars.filter((entry) => entry?.href)
            : [];
        if (!calendars.length) {
            const found = await (0, exports.discoverCalendars)(startUrl, auth);
            if (!found.calendars.length) {
                summary.error = found.error || "Kein Kalender gefunden.";
                await prisma_client_1.default.mailSetting.update({
                    where: { tenantId },
                    data: { caldavLastError: summary.error, caldavLastSyncAt: new Date() },
                }).catch(() => undefined);
                return summary;
            }
            calendars = found.calendars;
            await prisma_client_1.default.mailSetting.update({
                where: { tenantId },
                data: { caldavCalendars: calendars },
            }).catch(() => undefined);
        }
        summary.calendars = calendars.length;
        const from = new Date(Date.now() - WINDOW_BACK_DAYS * 86_400_000);
        const to = new Date(Date.now() + WINDOW_AHEAD_DAYS * 86_400_000);
        const seen = new Set();
        let anyCalendarRead = false;
        const failures = [];
        for (const calendar of calendars) {
            const { payloads, error } = await queryEvents(calendar.href, auth, from, to);
            if (error) {
                failures.push(`${calendar.displayName}: ${error}`);
                continue;
            }
            anyCalendarRead = true;
            for (const payload of payloads) {
                for (const event of (0, calendarInvite_1.parseCalendarObjects)(payload)) {
                    summary.examined += 1;
                    try {
                        const result = await (0, calendarImportService_1.importCalendarEvent)(tenantId, event, {
                            mailbox,
                            source: "CALDAV",
                            senderEmail: event.organizer?.email || null,
                            recipientEmails: [
                                settings.imapUser,
                                settings.smtpUser,
                                settings.fromEmail,
                            ].filter((value) => Boolean(value?.trim())),
                        });
                        if (result.icalUid)
                            seen.add(result.icalUid);
                        if (result.action === "created")
                            summary.created += 1;
                        else if (result.action === "updated")
                            summary.updated += 1;
                        else
                            summary.skipped += 1;
                    }
                    catch (importError) {
                        summary.skipped += 1;
                        console.error(`[KALENDER] Termin nicht übernommen:`, importError?.message || importError);
                    }
                }
            }
        }
        /* WAS IM KALENDER GELÖSCHT WURDE, MUSS AUCH HIER VERSCHWINDEN.
           Der Abruf hat gerade den GANZEN Zeitraum gesehen — was er darin nicht
           angetroffen hat, gibt es dort nicht mehr.

           Drei Schranken, damit das nie zu viel wegräumt:
             • nur Zeilen aus DIESEM Weg (`externalSource: CALDAV`) — ein per
               Mail hereingekommener Termin steht vielleicht in gar keinem
               Kalender dieses Kontos und bliebe sonst nicht lange am Leben;
             • nur dieses Postfach;
             • nur der abgefragte Zeitraum.
           Und gar nicht, wenn KEIN Kalender lesbar war: ein Serverausfall darf
           den Kalender nicht leerräumen. */
        if (anyCalendarRead) {
            const stale = await prisma_client_1.default.meetingActivity.findMany({
                where: {
                    tenantId,
                    externalSource: "CALDAV",
                    externalMailbox: mailbox,
                    startTime: { gte: from, lte: to },
                    ...(seen.size ? { NOT: { icalUid: { in: [...seen] } } } : {}),
                },
                select: { id: true },
            });
            if (stale.length) {
                const removed = await prisma_client_1.default.meetingActivity.deleteMany({
                    where: { id: { in: stale.map((row) => row.id) } },
                });
                summary.removed = removed.count;
            }
        }
        if (failures.length)
            summary.error = failures.join("; ").slice(0, 500);
        summary.durationMs = Date.now() - startedAt;
        const line = `${summary.calendars} Kalender, ${summary.examined} gelesen, `
            + `${summary.created} neu, ${summary.updated} geändert, ${summary.removed} entfernt`;
        console.log(`[KALENDER] ${tenantId}: ${line}`);
        await prisma_client_1.default.mailSetting.update({
            where: { tenantId },
            data: {
                caldavLastSyncAt: new Date(),
                caldavLastSummary: line.slice(0, 255),
                caldavLastError: summary.error ?? null,
            },
        }).catch(() => undefined);
        return summary;
    }
    catch (error) {
        summary.error = error?.message || "Kalenderabruf fehlgeschlagen.";
        summary.durationMs = Date.now() - startedAt;
        console.error(`[KALENDER] ${tenantId}:`, summary.error);
        await prisma_client_1.default.mailSetting.update({
            where: { tenantId },
            data: { caldavLastSyncAt: new Date(), caldavLastError: summary.error?.slice(0, 2000) ?? null },
        }).catch(() => undefined);
        return summary;
    }
    finally {
        running.delete(tenantId);
    }
};
exports.captureCalendar = captureCalendar;
/* ── ZEITPLAN ────────────────────────────────────────────────────────────────
 *
 * Ein eigener, NEBEN dem des Postfachs. Der Postfachabruf rückt einen
 * Lesestand vor und muss deshalb oft laufen (alle 3 Minuten), damit die Lücke
 * klein bleibt. Der Kalender kennt keinen Lesestand: er liest jedes Mal den
 * ganzen Zeitraum und ist danach vollständig, egal wie lange er ausgesetzt hat.
 * Alle 10 Minuten genügt also — und das Öffnen des Kalenders stösst ihn
 * ohnehin an (`POST /meetings/sync`).
 *
 * EIN DURCHGANG JE FIRMENBAUM, wie beim Postfach: mehrere Mandanten desselben
 * Baums fallen auf denselben Abruf zusammen, sonst räumten zwei Läufe einander
 * die Termine weg.
 */
const CALDAV_TICK_MS = 10 * 60_000;
const runCaldavPass = async () => {
    const tenants = await prisma_client_1.default.mailSetting.findMany({
        where: { caldavEnabled: true },
        select: { tenantId: true },
        orderBy: { caldavLastSyncAt: "asc" },
        take: 50,
    });
    const seen = new Set();
    for (const { tenantId } of tenants) {
        const mailTenantId = await (0, serviceTenantScope_1.getMailTenantId)(tenantId).catch(() => tenantId);
        if (seen.has(mailTenantId) || running.has(mailTenantId))
            continue;
        seen.add(mailTenantId);
        await (0, exports.captureCalendar)(mailTenantId);
    }
};
let started = false;
const startCaldavCaptureService = () => {
    if (started || process.env.OFFITEC_DISABLE_MAIL_SYNC === "true")
        return;
    started = true;
    const tick = () => {
        void runCaldavPass().catch((error) => console.error("[KALENDER] Durchgang fehlgeschlagen:", error?.message || error));
    };
    // Erst nach dem Postfachabruf anlaufen: beide gleichzeitig beim Start
    // wären zwei Verbindungen zu demselben Server in derselben Sekunde.
    setTimeout(tick, 45_000);
    setInterval(tick, CALDAV_TICK_MS);
};
exports.startCaldavCaptureService = startCaldavCaptureService;
/**
 * Prüft die Einrichtung und meldet, was gefunden wurde — der Knopf «Kalender
 * prüfen» in den Mail-Einstellungen. Schreibt die gefundenen Kalender mit, damit
 * der nächste Abruf nicht erneut suchen muss.
 */
const testCalendarAccess = async (selectedTenantId) => {
    const tenantId = await (0, serviceTenantScope_1.getMailTenantId)(selectedTenantId).catch(() => selectedTenantId);
    const settings = await prisma_client_1.default.mailSetting.findUnique({
        where: { tenantId },
        select: {
            imapHost: true, imapUser: true, imapPassword: true,
            caldavUrl: true, caldavUser: true, caldavPassword: true,
        },
    });
    const user = settings?.caldavUser?.trim() || settings?.imapUser?.trim() || "";
    const password = settings?.caldavPassword?.trim() || settings?.imapPassword?.trim() || "";
    const startUrl = settings?.caldavUrl?.trim()
        || (settings?.imapHost?.trim() ? `https://${settings.imapHost.trim()}` : "");
    if (!user || !password)
        return { ok: false, calendars: [], error: "Für den Kalender fehlen Benutzer oder Passwort." };
    if (!startUrl)
        return { ok: false, calendars: [], error: "Keine CalDAV-Adresse und kein IMAP-Server hinterlegt." };
    const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    const found = await (0, exports.discoverCalendars)(startUrl, auth);
    await prisma_client_1.default.mailSetting.update({
        where: { tenantId },
        data: {
            caldavCalendars: found.calendars.length ? found.calendars : undefined,
            caldavLastError: found.error ?? null,
        },
    }).catch(() => undefined);
    return {
        ok: found.calendars.length > 0,
        calendars: found.calendars,
        ...(found.error ? { error: found.error } : {}),
    };
};
exports.testCalendarAccess = testCalendarAccess;
//# sourceMappingURL=caldavCalendarService.js.map