import { BRAND_LOGO_CID, BRAND_NAVY, BRAND_RED } from "./mailBrand";
import type { CalendarMethod } from "./calendarInvite";

/**
 * DIE EINLADUNGSMAIL ALS KARTE (18.08.2026).
 *
 * Vorgabe: die Terminmail soll kein nackter Text sein, sondern eine Karte mit
 * Logo und Absender im Kopf, einem ruhigen Hintergrund und den Angaben zum
 * Termin ("Bilgiler") deutlich lesbar auf der Karte.
 *
 * Mail-HTML ist NICHT Browser-HTML: kein Flexbox, kein Grid, keine externen
 * Stylesheets, keine SVGs. Alles hier sind Tabellen mit Inline-Stilen — das
 * ist der kleinste gemeinsame Nenner von Outlook (Word-Renderer), Gmail und
 * Apple Mail. Abgerundete Ecken zeigt Outlook Desktop nicht; die Karte bleibt
 * dort eckig, aber vollständig lesbar. Das Logo kommt als Inline-Bild mit
 * Content-ID mit (siehe mailBrand.ts), damit kein "Bilder anzeigen" nötig ist.
 */

export interface InviteDetail {
    label: string;
    value: string;
}

export interface InviteCardInput {
    method: CalendarMethod;
    /** 0 = neu, >0 = Aktualisierung eines schon verschickten Termins. */
    sequence: number;
    start: Date;
    end: Date;
    summary: string;
    location?: string | null;
    /** Zeilen der Karte: Projekt, Kunde, Team … in dieser Reihenfolge. */
    details: InviteDetail[];
    /** Freitext (Notizen), unter den Zeilen. */
    notes?: string | null;
    /**
     * Persönliche Nachricht der absendenden Person (aus dem Versandfenster).
     * Steht auf der Karte anstelle des Standardsatzes — die Angaben zum Termin
     * folgen darunter unverändert.
     */
    message?: string | null;
    /** Absendername — steht im Kopf neben dem Logo und in der Grussformel. */
    senderName: string;
}

const TZ = "Europe/Zurich";
const LOCALE = "de-CH";

const escapeHtml = (value: string) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const nl2br = (value: string) => escapeHtml(value).replace(/\r?\n/g, "<br />");

const fmt = (date: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, ...options }).format(date);

const sameDay = (a: Date, b: Date) =>
    fmt(a, { year: "numeric", month: "2-digit", day: "2-digit" }) ===
    fmt(b, { year: "numeric", month: "2-digit", day: "2-digit" });

/** "Dienstag, 18. August 2026" */
export const formatInviteDate = (date: Date) =>
    fmt(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** "09:30 – 10:30 Uhr" bzw. "18.08.2026, 09:30 – 19.08.2026, 10:30 Uhr" bei Tagwechsel. */
export const formatInviteTime = (start: Date, end: Date) => {
    const from = fmt(start, { hour: "2-digit", minute: "2-digit" });
    const to = fmt(end, { hour: "2-digit", minute: "2-digit" });
    if (sameDay(start, end)) return `${from} – ${to} Uhr`;
    return `${fmt(start, { day: "2-digit", month: "2-digit", year: "numeric" })}, ${from} – ` +
        `${fmt(end, { day: "2-digit", month: "2-digit", year: "numeric" })}, ${to} Uhr`;
};

interface Tone {
    kicker: string;
    lead: string;
    footer: string;
    accent: string;
}

const toneOf = (method: CalendarMethod, sequence: number): Tone => {
    if (method === "CANCEL") {
        return {
            kicker: "Termin abgesagt",
            lead: "der folgende Termin wurde abgesagt:",
            footer: "Der Termin wird beim Öffnen dieser E-Mail aus Ihrem Kalender entfernt.",
            accent: BRAND_RED,
        };
    }
    if (sequence > 0) {
        return {
            kicker: "Termin geändert",
            lead: "der folgende Termin wurde geändert:",
            footer: "Mit „Annehmen“ wird der Termin in Ihrem Kalender aktualisiert.",
            accent: BRAND_NAVY,
        };
    }
    return {
        kicker: "Termineinladung",
        lead: "wir haben folgenden Termin für Sie eingetragen:",
        footer: "Mit „Annehmen“ übernehmen Sie den Termin direkt in Ihren Kalender.",
        accent: BRAND_NAVY,
    };
};

/** Klartext-Fassung (text/plain-Teil) — dieselben Angaben, ohne Gestaltung. */
export const buildInviteText = (input: InviteCardInput): string => {
    const tone = toneOf(input.method, input.sequence);
    const rows = [
        `Datum: ${formatInviteDate(input.start)}`,
        `Zeit: ${formatInviteTime(input.start, input.end)}`,
        input.location ? `Ort: ${input.location}` : null,
        ...input.details.map((row) => `${row.label}: ${row.value}`),
    ].filter((line): line is string => line !== null);
    const notes = input.notes?.trim();
    const message = input.message?.trim();
    // Leerzeilen sind hier Absicht (Absätze) — nur `null` fällt weg.
    return [
        "Guten Tag",
        "",
        message || tone.lead,
        "",
        input.summary,
        ...rows,
        ...(notes ? ["", notes] : []),
        "",
        tone.footer,
        "",
        "Freundliche Grüsse",
        input.senderName,
    ].join("\n");
};

const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

/**
 * Spaltenbreite: `width="100%"` + `max-width` — schmal auf dem Handy, volle
 * Breite am Bildschirm. Outlook (Word) kennt kein max-width und würde die
 * Tabelle über die ganze Fensterbreite ziehen; für ihn steht dieselbe Spalte
 * zusätzlich in einem bedingten Kommentar mit fester Breite.
 */
const WIDTH = 660;
const MSO_OPEN = `<!--[if mso]><table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->`;
const MSO_CLOSE = '<!--[if mso]></td></tr></table><![endif]-->';

/** Eine Zeile der Angaben: Bezeichnung links, Wert rechts, Haarlinie darunter. */
const detailRow = (label: string, value: string, last: boolean) => `
    <tr>
        <td style="${FONT}padding:13px 0;width:120px;vertical-align:top;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#7b8497;${last ? "" : "border-bottom:1px solid #edf0f6;"}">${escapeHtml(label)}</td>
        <td style="${FONT}padding:13px 0;vertical-align:top;font-size:16px;line-height:1.45;color:#0f172a;${last ? "" : "border-bottom:1px solid #edf0f6;"}">${nl2br(value)}</td>
    </tr>`;

/** HTML-Fassung: Kopf mit Logo + Absender, darunter die grosse Karte mit den Angaben. */
export const buildInviteHtml = (input: InviteCardInput): string => {
    const tone = toneOf(input.method, input.sequence);
    const cancelled = input.method === "CANCEL";
    const dayNumber = fmt(input.start, { day: "numeric" });
    const monthShort = fmt(input.start, { month: "short" }).replace(/\.$/, "");
    const weekday = fmt(input.start, { weekday: "long" });
    const dateLong = fmt(input.start, { day: "numeric", month: "long", year: "numeric" });
    const time = formatInviteTime(input.start, input.end);
    const message = input.message?.trim();
    const notes = input.notes?.trim();

    const rows: InviteDetail[] = [
        ...(input.location ? [{ label: "Ort", value: input.location }] : []),
        ...input.details.filter((row) => row.value && row.value.trim()),
    ];

    return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(input.summary)}</title>
</head>
<body style="margin:0;padding:0;background:#eef1f7;">
<!-- Hintergrund: ruhiges Grau-Blau, oben ein Band in der Hausfarbe, auf dem die Karte aufliegt. -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1f7;">
<tr><td align="center" style="padding:0;">

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND_NAVY};">
    <tr><td align="center" style="padding:36px 20px 96px;">
        ${MSO_OPEN}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${WIDTH}px;">
        <tr>
            <td style="vertical-align:middle;width:64px;">
                <img src="cid:${BRAND_LOGO_CID}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border:0;border-radius:28px;" />
            </td>
            <td style="${FONT}vertical-align:middle;padding-left:16px;">
                <div style="font-size:21px;font-weight:700;color:#ffffff;letter-spacing:.01em;">${escapeHtml(input.senderName)}</div>
                <div style="font-size:12px;color:#c7cde6;letter-spacing:.1em;text-transform:uppercase;margin-top:3px;">Kalender · Offitec ERP</div>
            </td>
        </tr>
        </table>
        ${MSO_CLOSE}
    </td></tr>
    </table>

    <!-- Die Karte: hängt mit negativem Abstand ins Band hinein; wo das nicht geht (Outlook), sitzt sie einfach darunter. -->
    ${MSO_OPEN}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${WIDTH}px;margin:-64px auto 0;">
    <tr><td style="padding:0 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:24px;border:1px solid #dfe3ee;box-shadow:0 18px 44px rgba(31,38,84,.16);">

        <!-- Kopf der Karte -->
        <tr><td style="padding:36px 40px 10px;">
            <div style="${FONT}font-size:11.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${tone.accent};">${escapeHtml(tone.kicker)}</div>
            <div style="${FONT}font-size:28px;line-height:1.25;font-weight:700;color:${BRAND_NAVY};margin-top:12px;${cancelled ? "text-decoration:line-through;color:#64748b;" : ""}">${escapeHtml(input.summary)}</div>
            <div style="${FONT}font-size:16px;line-height:1.6;color:#475569;margin-top:18px;">Guten Tag</div>
            <div style="${FONT}font-size:16px;line-height:1.6;color:#475569;margin-top:2px;">${message ? nl2br(message) : escapeHtml(tone.lead)}</div>
        </td></tr>

        <!-- Datum & Zeit: Kalenderblatt links, Angaben rechts. -->
        <tr><td style="padding:22px 40px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fb;border-radius:18px;">
            <tr>
                <td style="padding:18px 0 18px 18px;width:76px;vertical-align:middle;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:76px;border-radius:14px;overflow:hidden;border:1px solid #d9deea;background:#ffffff;">
                    <tr><td align="center" style="${FONT}background:${tone.accent};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;padding:6px 0 5px;">${escapeHtml(monthShort)}</td></tr>
                    <tr><td align="center" style="${FONT}color:${BRAND_NAVY};font-size:32px;font-weight:700;line-height:1;padding:11px 0 12px;">${escapeHtml(dayNumber)}</td></tr>
                    </table>
                </td>
                <td style="${FONT}padding:18px 20px;vertical-align:middle;">
                    <div style="font-size:17px;font-weight:700;color:#0f172a;">${escapeHtml(weekday)}, ${escapeHtml(dateLong)}</div>
                    <div style="font-size:16px;color:#334155;margin-top:5px;">${escapeHtml(time)}</div>
                </td>
            </tr>
            </table>
        </td></tr>

        <!-- Die Angaben zum Termin. -->
        <tr><td style="padding:18px 40px 8px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${rows.map((row, index) => detailRow(row.label, row.value, index === rows.length - 1)).join("")}
            </table>
            ${notes
                ? `<div style="${FONT}margin-top:18px;padding:14px 18px;background:#fffbeb;border-left:4px solid #f59e0b;border-radius:12px;font-size:15px;line-height:1.55;color:#3f3f46;">${nl2br(notes)}</div>`
                : ""}
        </td></tr>

        <!-- Hinweis und Gruss -->
        <tr><td style="padding:18px 40px 36px;">
            <div style="${FONT}font-size:13.5px;line-height:1.55;color:#64748b;padding-top:18px;border-top:1px solid #edf0f6;">${escapeHtml(tone.footer)}</div>
            <div style="${FONT}font-size:16px;line-height:1.6;color:#0f172a;margin-top:22px;">Freundliche Grüsse<br /><strong>${escapeHtml(input.senderName)}</strong></div>
        </td></tr>
        </table>
    </td></tr>
    </table>
    ${MSO_CLOSE}

    ${MSO_OPEN}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${WIDTH}px;">
    <tr><td align="center" style="${FONT}padding:24px 20px 40px;font-size:11.5px;line-height:1.7;color:#94a3b8;">
        Diese Einladung wurde automatisch vom Offitec ERP erstellt.<br />
        Antworten Sie mit „Annehmen“ oder „Ablehnen“ in Ihrem Kalenderprogramm.
    </td></tr>
    </table>
    ${MSO_CLOSE}

</td></tr>
</table>
</body>
</html>`;
};
