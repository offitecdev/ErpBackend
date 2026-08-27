"use strict";
/**
 * TERMINE ALS ECHTE KALENDER-EINLADUNGEN (iCalendar / RFC 5545, 18.08.2026).
 *
 * Vorgabe: "beim Anlegen eines Termins soll eine Mail rausgehen" UND "der
 * Outlook-Kalender soll mit dem System zusammengehen". Beides ist EINE Sache,
 * wenn die Mail keine Beschreibung des Termins ist, sondern der Termin selbst:
 * eine `text/calendar; method=REQUEST`-Nachricht. Outlook (Desktop, Web, App),
 * Apple Kalender und Google tragen sie mit Annehmen/Ablehnen direkt in den
 * Kalender ein — ohne Zusatzprotokoll, ohne Zugangsdaten, über genau den
 * Mailweg, der ohnehin schon läuft.
 *
 * Dieselbe Sprache in der Gegenrichtung: was in Outlook angelegt und an das
 * Firmenpostfach eingeladen wird, kommt als `METHOD:REQUEST` herein und wird
 * von `parseCalendarObject()` gelesen (siehe ImapCaptureService).
 *
 * Bewusst KEINE Bibliothek: es geht um ein knappes, gut kontrolliertes
 * Textformat, und jede Zeile hier ist eine, die man im Fehlerfall lesen können
 * muss (Zeilenfaltung und Escaping sind die einzigen echten Fallen).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCalendarObject = exports.cleanLocation = exports.cleanDescription = exports.onlineMeetingOrigin = exports.buildInvite = exports.newIcalUid = exports.icalDate = void 0;
/** RFC 5545: `\` `;` `,` und Zeilenumbrüche müssen maskiert werden. */
const escapeText = (value) => String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
/**
 * Zeilenfaltung: eine Inhaltszeile darf höchstens 75 OKTETTE lang sein,
 * Folgezeilen beginnen mit einem Leerzeichen. Gezählt werden Bytes, nicht
 * Zeichen — sonst zerschneidet ein Umlaut die UTF-8-Folge und der Termin kommt
 * beim Empfänger als Zeichensalat an.
 */
const foldLine = (line) => {
    const bytes = Buffer.from(line, "utf8");
    if (bytes.length <= 75)
        return line;
    const parts = [];
    let start = 0;
    while (start < bytes.length) {
        let take = Math.min(75 - (parts.length ? 1 : 0), bytes.length - start);
        // Nicht mitten in ein Mehrbyte-Zeichen schneiden.
        while (take > 1 && (bytes[start + take] & 0xc0) === 0x80)
            take -= 1;
        parts.push((parts.length ? " " : "") + bytes.subarray(start, start + take).toString("utf8"));
        start += take;
    }
    return parts.join("\r\n");
};
/** `20260818T093000Z` — Kalenderzeiten gehen immer in UTC raus. */
const icalDate = (date) => `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
exports.icalDate = icalDate;
const address = (email, name) => name ? `;CN="${String(name).replace(/"/g, "")}":mailto:${email}` : `:mailto:${email}`;
/** Eine stabile UID; sie identifiziert den Termin über alle Aktualisierungen. */
const newIcalUid = (id, domain) => `offitec-${id}@${domain || "offitec-erp.local"}`;
exports.newIcalUid = newIcalUid;
const buildInvite = (invite) => {
    /* MEHRERE TAGE, MEHRERE VEVENT (24.08.2026). Die Karte in der Mail zeigt
       den ganzen Einsatzplan; das Kalenderobjekt trägt je Tag einen Eintrag.
       Was ein Programm daraus macht, ist unterschiedlich: Outlook und Gmail
       bieten den ERSTEN Eintrag zum Annehmen an, die angehängte Datei
       (invite.ics, dieselbe Fracht) trägt alle Tage. Ein einzelner Balken über
       vier Tage wäre die Alternative — er stünde in jedem Kalender falsch. */
    const occurrences = invite.occurrences?.length
        ? invite.occurrences
        : [{ uid: invite.uid, sequence: invite.sequence, start: invite.start, end: invite.end }];
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Offitec//ERP Kalender//DE",
        "CALSCALE:GREGORIAN",
        `METHOD:${invite.method}`,
    ];
    for (const occurrence of occurrences) {
        lines.push("BEGIN:VEVENT", `UID:${occurrence.uid}`, `SEQUENCE:${Math.max(0, occurrence.sequence)}`, `DTSTAMP:${(0, exports.icalDate)(new Date())}`, `DTSTART:${(0, exports.icalDate)(occurrence.start)}`, `DTEND:${(0, exports.icalDate)(occurrence.end)}`, `SUMMARY:${escapeText(invite.summary)}`);
        if (invite.description)
            lines.push(`DESCRIPTION:${escapeText(invite.description)}`);
        if (invite.location)
            lines.push(`LOCATION:${escapeText(invite.location)}`);
        lines.push(`ORGANIZER${address(invite.organizer.email, invite.organizer.name)}`);
        for (const attendee of invite.attendees) {
            if (!attendee.email)
                continue;
            const role = attendee.optional ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT";
            lines.push(`ATTENDEE;ROLE=${role};PARTSTAT=NEEDS-ACTION;RSVP=TRUE` +
                address(attendee.email, attendee.name));
        }
        // CANCEL zieht den Termin beim Empfänger zurück; REQUEST bestätigt ihn.
        lines.push(`STATUS:${invite.cancelled || invite.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`);
        if (invite.method === "REQUEST") {
            // Erinnerung 30 Minuten vorher — was Outlook selbst auch vorschlägt.
            lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Erinnerung", "TRIGGER:-PT30M", "END:VALARM");
        }
        lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
};
exports.buildInvite = buildInvite;
const unescapeText = (value) => value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
/** `20260818T093000Z`, `20260818T093000` oder `20260818` (ganztägig). */
const parseIcalDate = (value, params) => {
    const raw = value.trim();
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
    if (!match) {
        const fallback = new Date(raw);
        return Number.isNaN(fallback.getTime()) ? null : fallback;
    }
    const [, y, mo, d, h = "00", mi = "00", s = "00", z] = match;
    // Ohne "Z" und ohne bekannte Zeitzone bleibt nur die lokale Auslegung; die
    // TZID-Datenbank hier nachzubauen wäre unverhältnismässig.
    if (z || /TZID=(UTC|GMT)/i.test(params)) {
        return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
    }
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
};
const mailtoOf = (value) => value.replace(/^mailto:/i, "").trim().toLowerCase();
/**
 * ONLINE-BESPRECHUNGEN (Teams & Co., 21.08.2026).
 *
 * Ein Teams-Termin ist eine ganz normale Einladung mit EINEM Zusatz, der zählt:
 * dem Beitrittslink. Outlook legt ihn in eine eigene X-Eigenschaft, andere
 * Anbieter nur in den Beschreibungstext — deshalb beides.
 */
const ONLINE_HOSTS = /^https:\/\/(?:[\w.-]+\.)?(?:teams\.microsoft\.com|teams\.live\.com|teams\.microsoft\.us|zoom\.us|meet\.google\.com|webex\.com|gotomeet\.me|gotomeeting\.com|whereby\.com)\//i;
/** Ein Link endet an Anführungszeichen, Klammern und Satzzeichen, nicht am Zeilenende. */
const cleanUrl = (value) => value.trim().replace(/^[<("']+/, "").replace(/[>)"'.,;]+$/, "");
/** Der erste Beitrittslink in einem Freitext (Beschreibung, Ort, HTML-Fassung). */
const findOnlineUrl = (text) => {
    if (!text)
        return null;
    for (const match of String(text).matchAll(/https:\/\/[^\s<>"']+/gi)) {
        const url = cleanUrl(match[0]);
        if (ONLINE_HOSTS.test(url))
            return url.slice(0, 512);
    }
    return null;
};
/** Teams-Link ⇒ Teams-Besprechung; sonst ein gewöhnlicher Termin aus der Mail. */
const onlineMeetingOrigin = (onlineUrl) => onlineUrl && /teams\.(microsoft|live)\.com/i.test(onlineUrl) ? "TEAMS" : "OUTLOOK";
exports.onlineMeetingOrigin = onlineMeetingOrigin;
/**
 * Teams hängt an jede Beschreibung einen Block mit Beitrittslink, Einwahl-
 * nummern und Hilfeadressen, abgetrennt durch eine lange Unterstrichlinie.
 * Der Link steht als `meetingUrl` am Termin — der Rest ist im Kalender nur
 * Rauschen und fliegt raus. Bleibt nichts übrig, bleibt die Notiz leer.
 */
const isJoinBlock = (part) => /teams\.microsoft\.com|meetup-join|zoom\.us\/j\/|besprechungs-id|meeting id|konferenz-id|conference id/i.test(part);
const cleanDescription = (text) => {
    if (!text)
        return "";
    const parts = String(text).split(/_{20,}/);
    return parts.filter((part) => part.trim() && !isJoinBlock(part)).join("\n\n").trim();
};
exports.cleanDescription = cleanDescription;
/**
 * Der Ort einer Online-Besprechung ist bei manchen Absendern der komplette
 * Beitrittslink — als "Ort: https://teams.microsoft.com/l/meetup-join/19%3a…"
 * wäre die Zeile länger als der ganze Termin.
 */
const cleanLocation = (location) => {
    if (!location)
        return "";
    const withoutUrl = String(location).replace(/https?:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();
    return withoutUrl.replace(/^[,;·|-]+|[,;·|-]+$/g, "").trim();
};
exports.cleanLocation = cleanLocation;
const paramValue = (params, name) => {
    const match = new RegExp(`${name}=("[^"]*"|[^;:]*)`, "i").exec(params);
    if (!match)
        return null;
    return match[1].replace(/^"|"$/g, "").trim() || null;
};
/**
 * Liest das ERSTE VEVENT eines iCalendar-Textes. Genau so viel, wie für die
 * Übernahme in den Kalender nötig ist — Wiederholungsregeln (RRULE) bleiben
 * bewusst aussen vor, eine Serie käme sonst als EIN Termin an und wäre
 * schlimmer als gar keiner.
 */
const parseCalendarObject = (text) => {
    if (!text || !/BEGIN:VCALENDAR/i.test(text))
        return null;
    // Gefaltete Zeilen zusammenziehen, danach ist jede Zeile eine Eigenschaft.
    const unfolded = text.replace(/\r?\n[ \t]/g, "");
    const lines = unfolded.split(/\r?\n/);
    let method = "REQUEST";
    let inEvent = false;
    let hasRecurrence = false;
    // Verschachtelte Blöcke im VEVENT (VALARM) haben EIGENE Eigenschaften mit
    // denselben Namen — die Erinnerung eines Outlook-Termins trägt fast immer
    // ein `DESCRIPTION:Erinnerung`. Ohne diese Tiefenzählung überschriebe sie
    // die Beschreibung des Termins.
    let nested = 0;
    // Die HTML-Fassung der Beschreibung (Outlook: X-ALT-DESC) trägt den
    // Teams-Link auch dann, wenn die Textfassung ihn verstümmelt hat.
    let richText = "";
    const event = {
        method, uid: "", sequence: 0, start: null, end: null,
        summary: null, description: null, location: null,
        organizer: null, attendees: [], cancelled: false,
        recurring: false, onlineUrl: null,
    };
    for (const line of lines) {
        const separator = line.indexOf(":");
        if (separator < 0)
            continue;
        const head = line.slice(0, separator);
        const value = line.slice(separator + 1);
        const semicolon = head.indexOf(";");
        const name = (semicolon < 0 ? head : head.slice(0, semicolon)).trim().toUpperCase();
        const params = semicolon < 0 ? "" : head.slice(semicolon + 1);
        if (name === "METHOD" && !inEvent) {
            method = value.trim().toUpperCase();
            continue;
        }
        if (name === "BEGIN" && value.trim().toUpperCase() === "VEVENT") {
            inEvent = true;
            continue;
        }
        if (name === "END" && value.trim().toUpperCase() === "VEVENT" && nested === 0)
            break;
        if (!inEvent)
            continue;
        if (name === "BEGIN") {
            nested += 1;
            continue;
        }
        if (name === "END") {
            nested = Math.max(0, nested - 1);
            continue;
        }
        if (nested > 0)
            continue;
        switch (name) {
            case "UID":
                event.uid = value.trim();
                break;
            case "SEQUENCE":
                event.sequence = Number(value.trim()) || 0;
                break;
            case "DTSTART":
                event.start = parseIcalDate(value, params);
                break;
            case "DTEND":
                event.end = parseIcalDate(value, params);
                break;
            case "SUMMARY":
                event.summary = unescapeText(value).trim() || null;
                break;
            case "DESCRIPTION":
                event.description = unescapeText(value).trim() || null;
                break;
            case "LOCATION":
                event.location = unescapeText(value).trim() || null;
                break;
            case "STATUS":
                if (value.trim().toUpperCase() === "CANCELLED")
                    event.cancelled = true;
                break;
            case "RRULE":
            case "RDATE":
                hasRecurrence = true;
                break;
            // Teams schreibt den Beitrittslink in eine eigene Eigenschaft;
            // RFC 7986 kennt dafür CONFERENCE. Beides ist eindeutiger als der
            // Beschreibungstext und geht ihm deshalb vor.
            case "X-MICROSOFT-SKYPETEAMSMEETINGURL":
            case "X-MICROSOFT-ONLINEMEETINGEXTERNALLINK":
            case "X-GOOGLE-CONFERENCE":
            case "CONFERENCE": {
                const url = cleanUrl(unescapeText(value));
                if (!event.onlineUrl && /^https:\/\//i.test(url))
                    event.onlineUrl = url.slice(0, 512);
                break;
            }
            case "X-ALT-DESC":
                richText = unescapeText(value);
                break;
            case "ORGANIZER":
                event.organizer = { email: mailtoOf(value), name: paramValue(params, "CN") };
                break;
            case "ATTENDEE":
                event.attendees.push({
                    email: mailtoOf(value),
                    name: paramValue(params, "CN"),
                    partstat: paramValue(params, "PARTSTAT"),
                });
                break;
            default: break;
        }
    }
    if (!event.uid || !event.start)
        return null;
    // Serientermine werden NICHT übernommen: ein einzelner Eintrag an ihrer
    // Stelle wäre falsch und würde jede Woche neu falsch sein. Gelesen wird die
    // Einladung trotzdem — der Abruf soll den Grund nennen können.
    event.recurring = hasRecurrence;
    if (!event.onlineUrl)
        event.onlineUrl = findOnlineUrl(event.description) || findOnlineUrl(richText) || findOnlineUrl(event.location);
    event.method = method;
    if (method === "CANCEL")
        event.cancelled = true;
    // Ohne DTEND gilt die Vorgabe: eine Stunde.
    if (!event.end)
        event.end = new Date(event.start.getTime() + 60 * 60_000);
    return event;
};
exports.parseCalendarObject = parseCalendarObject;
//# sourceMappingURL=calendarInvite.js.map