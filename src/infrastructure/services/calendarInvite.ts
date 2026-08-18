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

export type CalendarMethod = "REQUEST" | "CANCEL" | "REPLY";

export interface InviteAttendee {
    email: string;
    name?: string | null;
    /** Erforderlich (REQ-PARTICIPANT) oder optional (OPT-PARTICIPANT, die CC-Leute). */
    optional?: boolean;
}

export interface InviteInput {
    uid: string;
    sequence: number;
    method: CalendarMethod;
    start: Date;
    end: Date;
    summary: string;
    description?: string | null;
    location?: string | null;
    organizer: { email: string; name?: string | null };
    attendees: InviteAttendee[];
    /** CANCEL ⇒ STATUS:CANCELLED. */
    cancelled?: boolean;
}

/** RFC 5545: `\` `;` `,` und Zeilenumbrüche müssen maskiert werden. */
const escapeText = (value: string): string =>
    String(value ?? "")
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
const foldLine = (line: string): string => {
    const bytes = Buffer.from(line, "utf8");
    if (bytes.length <= 75) return line;
    const parts: string[] = [];
    let start = 0;
    while (start < bytes.length) {
        let take = Math.min(75 - (parts.length ? 1 : 0), bytes.length - start);
        // Nicht mitten in ein Mehrbyte-Zeichen schneiden.
        while (take > 1 && (bytes[start + take]! & 0xc0) === 0x80) take -= 1;
        parts.push((parts.length ? " " : "") + bytes.subarray(start, start + take).toString("utf8"));
        start += take;
    }
    return parts.join("\r\n");
};

/** `20260818T093000Z` — Kalenderzeiten gehen immer in UTC raus. */
export const icalDate = (date: Date): string =>
    `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;

const address = (email: string, name?: string | null) =>
    name ? `;CN="${String(name).replace(/"/g, "")}":mailto:${email}` : `:mailto:${email}`;

/** Eine stabile UID; sie identifiziert den Termin über alle Aktualisierungen. */
export const newIcalUid = (id: string, domain: string): string =>
    `offitec-${id}@${domain || "offitec-erp.local"}`;

export const buildInvite = (invite: InviteInput): string => {
    const lines: string[] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Offitec//ERP Kalender//DE",
        "CALSCALE:GREGORIAN",
        `METHOD:${invite.method}`,
        "BEGIN:VEVENT",
        `UID:${invite.uid}`,
        `SEQUENCE:${Math.max(0, invite.sequence)}`,
        `DTSTAMP:${icalDate(new Date())}`,
        `DTSTART:${icalDate(invite.start)}`,
        `DTEND:${icalDate(invite.end)}`,
        `SUMMARY:${escapeText(invite.summary)}`,
    ];
    if (invite.description) lines.push(`DESCRIPTION:${escapeText(invite.description)}`);
    if (invite.location) lines.push(`LOCATION:${escapeText(invite.location)}`);
    lines.push(`ORGANIZER${address(invite.organizer.email, invite.organizer.name)}`);
    for (const attendee of invite.attendees) {
        if (!attendee.email) continue;
        const role = attendee.optional ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT";
        lines.push(
            `ATTENDEE;ROLE=${role};PARTSTAT=NEEDS-ACTION;RSVP=TRUE` +
            address(attendee.email, attendee.name),
        );
    }
    // CANCEL zieht den Termin beim Empfänger zurück; REQUEST bestätigt ihn.
    lines.push(`STATUS:${invite.cancelled || invite.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`);
    if (invite.method === "REQUEST") {
        // Erinnerung 30 Minuten vorher — was Outlook selbst auch vorschlägt.
        lines.push(
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "DESCRIPTION:Erinnerung",
            "TRIGGER:-PT30M",
            "END:VALARM",
        );
    }
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.map(foldLine).join("\r\n") + "\r\n";
};

/* ── Gegenrichtung: eingehende Kalenderobjekte lesen ────────────────────── */

export interface ParsedCalendarEvent {
    method: string;
    uid: string;
    sequence: number;
    start: Date | null;
    end: Date | null;
    summary: string | null;
    description: string | null;
    location: string | null;
    organizer: { email: string; name: string | null } | null;
    attendees: Array<{ email: string; name: string | null; partstat: string | null }>;
    cancelled: boolean;
}

const unescapeText = (value: string): string =>
    value
        .replace(/\\n/gi, "\n")
        .replace(/\\,/g, ",")
        .replace(/\\;/g, ";")
        .replace(/\\\\/g, "\\");

/** `20260818T093000Z`, `20260818T093000` oder `20260818` (ganztägig). */
const parseIcalDate = (value: string, params: string): Date | null => {
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

const mailtoOf = (value: string): string =>
    value.replace(/^mailto:/i, "").trim().toLowerCase();

const paramValue = (params: string, name: string): string | null => {
    const match = new RegExp(`${name}=("[^"]*"|[^;:]*)`, "i").exec(params);
    if (!match) return null;
    return match[1]!.replace(/^"|"$/g, "").trim() || null;
};

/**
 * Liest das ERSTE VEVENT eines iCalendar-Textes. Genau so viel, wie für die
 * Übernahme in den Kalender nötig ist — Wiederholungsregeln (RRULE) bleiben
 * bewusst aussen vor, eine Serie käme sonst als EIN Termin an und wäre
 * schlimmer als gar keiner.
 */
export const parseCalendarObject = (text: string): ParsedCalendarEvent | null => {
    if (!text || !/BEGIN:VCALENDAR/i.test(text)) return null;
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
    const event: ParsedCalendarEvent = {
        method, uid: "", sequence: 0, start: null, end: null,
        summary: null, description: null, location: null,
        organizer: null, attendees: [], cancelled: false,
    };

    for (const line of lines) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        const head = line.slice(0, separator);
        const value = line.slice(separator + 1);
        const semicolon = head.indexOf(";");
        const name = (semicolon < 0 ? head : head.slice(0, semicolon)).trim().toUpperCase();
        const params = semicolon < 0 ? "" : head.slice(semicolon + 1);

        if (name === "METHOD" && !inEvent) { method = value.trim().toUpperCase(); continue; }
        if (name === "BEGIN" && value.trim().toUpperCase() === "VEVENT") { inEvent = true; continue; }
        if (name === "END" && value.trim().toUpperCase() === "VEVENT" && nested === 0) break;
        if (!inEvent) continue;
        if (name === "BEGIN") { nested += 1; continue; }
        if (name === "END") { nested = Math.max(0, nested - 1); continue; }
        if (nested > 0) continue;

        switch (name) {
            case "UID": event.uid = value.trim(); break;
            case "SEQUENCE": event.sequence = Number(value.trim()) || 0; break;
            case "DTSTART": event.start = parseIcalDate(value, params); break;
            case "DTEND": event.end = parseIcalDate(value, params); break;
            case "SUMMARY": event.summary = unescapeText(value).trim() || null; break;
            case "DESCRIPTION": event.description = unescapeText(value).trim() || null; break;
            case "LOCATION": event.location = unescapeText(value).trim() || null; break;
            case "STATUS": if (value.trim().toUpperCase() === "CANCELLED") event.cancelled = true; break;
            case "RRULE": case "RDATE": hasRecurrence = true; break;
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

    if (!event.uid || !event.start) return null;
    // Serientermine werden NICHT übernommen: ein einzelner Eintrag an ihrer
    // Stelle wäre falsch und würde jede Woche neu falsch sein.
    if (hasRecurrence) return null;
    event.method = method;
    if (method === "CANCEL") event.cancelled = true;
    // Ohne DTEND gilt die Vorgabe: eine Stunde.
    if (!event.end) event.end = new Date(event.start.getTime() + 60 * 60_000);
    return event;
};
