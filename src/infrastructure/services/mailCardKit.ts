import {
    BRAND_ICON_APPOINTMENT_CID,
    BRAND_ICON_DOCUMENT_CID,
    BRAND_ICON_TASK_CID,
    BRAND_LOGO_CID,
    BRAND_NAVY,
    BRAND_RED,
    BRAND_WAVE_CID,
    brandLogoInline,
    brandWaveInline,
} from "./mailBrand";
import { kindIconInline, type MailIconKind } from "./mailKindIcons";

/**
 * ── DIE KARTE DER OCC-MAILS (30.09.2026, Vorgabe Samet) ─────────────────────
 *
 *   Nach der Apple- und der Adobe-Fassung desselben Tages zurück zur
 *   Terminkarte vom August (Bild «eski_version.png»):
 *   «bunun gibi olsun ama biraz daha büyük olabilir, kart daha düzenli olsun,
 *    tablolar falan renkli olsun, sütunları ayrı renk, dalga tasarım yine aynı
 *    kalsın, renkli ve premium görünsün»
 *
 * EINE Karte für jede Systemmail — Termin, Besprechung, Montage, Aufgabe,
 * Beleg:
 *   · weisser Grund (19.08.: nichts Bläuliches hinter der Karte); die Karte
 *     600 px statt 520, runde Ecken, Haarlinie, weicher Schatten;
 *   · Kopf: Logo, Absender und leise die Rubrik («KALENDER»);
 *   · die Welle der Anmeldeseite über die ganze Breite — unverändert;
 *   · mittig das farbige Zeichen (Kalenderblatt, Haken, Beleg), Stichwort und
 *     Überschrift;
 *   · das Datum als Ticket: links das Kalenderblatt in der Akzentfarbe, rechts
 *     Tag und Uhrzeit;
 *   · die Angaben als farbige TABELLE, jede Spalte in ihrer Farbe: marineblaue
 *     Kopfzeile, Bezeichnungen hell-marineblau, Werte weiss — im Einsatzplan
 *     die Uhrzeit rot getönt, bei Anhängen die Dateiart;
 *   · Notiz und Hinweis als getönte Kästen, der Knopf als Kapsel;
 *   · unter der Karte leise der automatische Hinweis.
 * Schrift: Inter (Google Fonts), sonst die Systemschrift; Outlooks
 * Word-Renderer bekommt Arial.
 *
 * Mail-HTML ist nicht Browser-HTML: Tabellen und Inline-Stile, kein Flexbox,
 * keine SVG. Jede Farbfläche trägt auch `bgcolor` (Outlook); Verläufe,
 * Schatten und Radien sind Zugabe für Apple Mail, iOS und Gmail.
 * Die Bilder reisen als Inline-Bilder mit: der Aufrufer hängt
 * `mailInlineImages(icon)` an — mit DEMSELBEN Zeichen wie die Karte, sonst
 * fehlt es, und ein ungenutztes Bild erschiene als Anhang.
 */

export type MailIcon = MailIconKind;

export const CARD_WIDTH = 600;
const PAD = 32;

export const CARD_INK = "#0f172a";
export const CARD_BODY = "#334155";
export const CARD_MUTED = "#64748b";
export const CARD_SUBTLE = "#8b93a7";
const LINE = "#e3e8f4";
const EDGE = "#d9e0f0";
const NAVY_TINT = "#edf0fa";
const NAVY_SOFT = "#f6f8fd";
const RED_TINT = "#fdf0f0";
const RED_EDGE = "#f6caca";
const RED_DEEP = "#b10d12";
/** Das Ende des Verlaufs in der marineblauen Kopfzeile. */
const NAVY_GLOW = "#35418a";

export const CARD_FONT =
    "font-family:'Inter','Inter Variable',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

const MSO_OPEN = `<!--[if mso]><table role="presentation" width="${CARD_WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->`;
const MSO_CLOSE = "<!--[if mso]></td></tr></table><![endif]-->";

const ICON_CID: Record<MailIcon, string> = {
    APPOINTMENT: BRAND_ICON_APPOINTMENT_CID,
    TASK: BRAND_ICON_TASK_CID,
    DOCUMENT: BRAND_ICON_DOCUMENT_CID,
};

/** Logo, Welle und das Zeichen der Karte — als Inline-Bilder, nicht als Anhang. */
export const mailInlineImages = (icon: MailIcon) => [brandLogoInline(), brandWaveInline(), kindIconInline(icon)];

export const mailEscape = (value: unknown): string =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

export const mailNl2br = (value: unknown): string => mailEscape(value).replace(/\r?\n/g, "<br />");

/** «Bestellung.pdf» → «PDF» — die Spalte mit der Dateiart. */
export const cardFileType = (name: string): string =>
    (/\.([a-z0-9]{2,4})$/i.exec(name)?.[1] ?? "").toUpperCase() || "—";

const rgb = (hex: string): number[] => {
    const clean = hex.replace("#", "");
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const value = parseInt(full, 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** Die Farbe aufgehellt (0 = unverändert, 1 = weiss) — der Anfang eines Verlaufs. */
const lighten = (hex: string, amount: number) =>
    `#${rgb(hex).map((c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, "0")).join("")}`;

/** Die Farbe als weicher Schatten. */
const glow = (hex: string, alpha: number) => `rgba(${rgb(hex).join(",")},${alpha})`;

/** Eine Farbfläche: `background-color` für Outlook, darüber der Verlauf. */
const fill = (hex: string, angle = 135) =>
    `background-color:${hex};background-image:linear-gradient(${angle}deg,${lighten(hex, 0.22)} 0%,${hex} 100%);`;

/** Eine Zeile der Karte mit dem seitlichen Rand — alle Bausteine sind `<tr>`. */
export const cardRow = (inner: string, top = 0, center = false) =>
    `<tr><td class="occ-pad"${center ? ' align="center"' : ""} style="${CARD_FONT}padding:${top}px ${PAD}px 0;${center ? "text-align:center;" : ""}">${inner}</td></tr>`;

/** Der Kopf: Logo, Absender, darunter leise die Rubrik. */
export const cardHeader = (brand: string, label: string) => `
    <tr><td class="occ-pad" style="padding:22px ${PAD}px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="40" style="width:40px;vertical-align:middle;">
                <img src="cid:${BRAND_LOGO_CID}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border:0;border-radius:20px;" />
            </td>
            <td style="${CARD_FONT}vertical-align:middle;padding-left:12px;">
                <div style="font-size:16px;line-height:20px;font-weight:700;color:${BRAND_NAVY};">${mailEscape(brand)}</div>
                <div style="margin-top:3px;font-size:10px;line-height:12px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#98a0b5;">${mailEscape(label)}</div>
            </td>
        </tr></table>
    </td></tr>`;

/**
 * Die Welle der Anmeldeseite über die GANZE Kartenbreite — ohne Innenabstand.
 * Das Bild ist 1040×124 (doppelt aufgelöst); die Breitenangabe im Attribut ist
 * für Outlook, das kein Prozent auf Bildern mag.
 */
export const cardWave = () => `
    <tr><td style="padding:0;font-size:0;line-height:0;">
        <img src="cid:${BRAND_WAVE_CID}" width="${CARD_WIDTH}" height="72" alt="" style="display:block;width:100%;max-width:${CARD_WIDTH}px;height:auto;border:0;" />
    </td></tr>`;

export interface CardHero {
    icon: MailIcon;
    accent: string;
    kicker?: string | null;
    /** Farbe des Stichworts, wenn sie nicht die des Zeichens ist (Beleg: rot). */
    kickerColor?: string;
    title: string;
    strike?: boolean;
    /** Kapsel unter der Überschrift («Revision 2», «! Önemli»). */
    badge?: { text: string; tone: "red" | "navy" } | null;
}

/** Mittig: das farbige Zeichen, das Stichwort, die Überschrift, ggf. eine Kapsel. */
export const cardHero = (hero: CardHero) => {
    const red = hero.badge?.tone === "red";
    const badge = hero.badge?.text
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:12px auto 0;border-collapse:separate;"><tr>
            <td bgcolor="${red ? RED_TINT : NAVY_TINT}" style="${CARD_FONT}background:${red ? RED_TINT : NAVY_TINT};border:1px solid ${red ? RED_EDGE : EDGE};border-radius:999px;padding:5px 14px;font-size:12px;line-height:16px;font-weight:700;color:${red ? RED_DEEP : BRAND_NAVY};white-space:nowrap;">${mailEscape(hero.badge.text)}</td>
        </tr></table>`
        : "";
    return `
    <tr><td align="center" class="occ-pad" style="padding:26px ${PAD}px 0;text-align:center;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;border-collapse:separate;"><tr>
            <td align="center" valign="middle" width="60" height="60" bgcolor="${hero.accent}" style="width:60px;height:60px;${fill(hero.accent)}border-radius:18px;box-shadow:0 8px 20px ${glow(hero.accent, 0.28)};text-align:center;vertical-align:middle;font-size:0;line-height:0;">
                <img src="cid:${ICON_CID[hero.icon]}" width="32" height="32" alt="" style="display:inline-block;width:32px;height:32px;border:0;" />
            </td>
        </tr></table>
        ${hero.kicker ? `<div style="${CARD_FONT}margin-top:16px;font-size:11px;line-height:14px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${hero.kickerColor ?? hero.accent};">${mailEscape(hero.kicker)}</div>` : ""}
        <div style="${CARD_FONT}margin-top:${hero.kicker ? 10 : 16}px;font-size:24px;line-height:31px;font-weight:700;letter-spacing:-.01em;color:${hero.strike ? CARD_MUTED : BRAND_NAVY};${hero.strike ? "text-decoration:line-through;" : ""}">${mailEscape(hero.title)}</div>
        ${badge}
    </td></tr>`;
};

export interface CardTicket {
    accent: string;
    /** Das Kalenderblatt: Monat kurz («AUG») und Tag («21»). */
    month: string;
    day: string;
    /** Leise Zeile über dem Datum («FÄLLIG»); ohne Angabe keine. */
    label?: string | null;
    date: string;
    time?: string | null;
}

/** Das Datum als Ticket: links das Kalenderblatt in der Akzentfarbe, rechts Tag und Zeit. */
export const cardTicket = (ticket: CardTicket) => `
    <tr><td align="center" class="occ-pad" style="padding:22px ${PAD}px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;border-collapse:separate;border:1px solid ${EDGE};border-radius:16px;box-shadow:0 6px 18px rgba(31,38,84,.08);">
        <tr>
            <td width="80" align="center" valign="middle" bgcolor="${ticket.accent}" style="width:80px;${fill(ticket.accent, 160)}border-radius:15px 0 0 15px;padding:12px 0 13px;text-align:center;">
                <div style="${CARD_FONT}font-size:11px;line-height:13px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#e6e9f7;">${mailEscape(ticket.month)}</div>
                <div style="${CARD_FONT}margin-top:3px;font-size:30px;line-height:32px;font-weight:800;color:#ffffff;">${mailEscape(ticket.day)}</div>
            </td>
            <td valign="middle" bgcolor="${NAVY_SOFT}" style="background:${NAVY_SOFT};border-radius:0 15px 15px 0;padding:13px 28px 13px 20px;text-align:left;">
                ${ticket.label ? `<div style="${CARD_FONT}font-size:10.5px;line-height:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${CARD_SUBTLE};">${mailEscape(ticket.label)}</div>` : ""}
                <div style="${CARD_FONT}${ticket.label ? "margin-top:3px;" : ""}font-size:16px;line-height:22px;font-weight:700;color:${CARD_INK};">${mailEscape(ticket.date)}</div>
                ${ticket.time ? `<div style="${CARD_FONT}margin-top:2px;font-size:17px;line-height:23px;font-weight:700;color:${ticket.accent};">${mailEscape(ticket.time)}</div>` : ""}
            </td>
        </tr>
        </table>
    </td></tr>`;

/** Anrede und erster Satz; `leadHtml` muss schon sicher sein. */
export const cardGreeting = (greeting: string, leadHtml: string, top = 26) =>
    cardRow(`<div style="font-size:15.5px;line-height:25px;color:${CARD_BODY};"><div style="font-weight:600;color:${CARD_INK};">${mailEscape(greeting)}</div><div style="margin-top:3px;">${leadHtml}</div></div>`, top);

/** Fliesstext; `html` muss schon sicher sein. */
export const cardParagraphHtml = (html: string, top = 22) =>
    cardRow(`<div style="font-size:15px;line-height:24px;color:${CARD_BODY};">${html}</div>`, top);

/** Die marineblaue Kopfzeile einer Tabelle; `glowing` = mit Verlauf (eine Zelle über die ganze Breite). */
const headCell = (text: string, corners: string, colspan = 1, glowing = false) =>
    `<td${colspan > 1 ? ` colspan="${colspan}"` : ""} bgcolor="${BRAND_NAVY}" style="${CARD_FONT}background-color:${BRAND_NAVY};${glowing ? `background-image:linear-gradient(90deg,${BRAND_NAVY} 0%,${NAVY_GLOW} 100%);` : ""}padding:10px 16px;font-size:11px;line-height:14px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#ffffff;${corners}">${mailEscape(text)}</td>`;

export interface CardTableRow {
    label: string;
    value: string;
    /** Wert fett. */
    strong?: boolean;
}

/**
 * Die Angaben als farbige Tabelle: oben die marineblaue Kopfzeile (`title`),
 * links die Bezeichnungen hell-marineblau, rechts die Werte weiss. Leere Werte
 * fallen weg; ohne Zeilen kommt nichts.
 */
export const cardTable = (rows: CardTableRow[], options: { title?: string | null; top?: number } = {}) => {
    const list = rows.filter((row) => String(row.value ?? "").trim());
    if (!list.length) return "";
    const titled = Boolean(options.title);
    const head = titled ? `<tr>${headCell(options.title ?? "", "border-radius:11px 11px 0 0;", 2, true)}</tr>` : "";
    const body = list.map((row, index) => {
        const first = index === 0 && !titled;
        const last = index === list.length - 1;
        const line = last ? "" : `border-bottom:1px solid ${LINE};`;
        return `<tr>
            <td width="36%" valign="top" bgcolor="${NAVY_TINT}" style="${CARD_FONT}width:36%;background:${NAVY_TINT};padding:13px 16px 11px;vertical-align:top;font-size:11px;line-height:20px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${BRAND_NAVY};border-right:1px solid ${EDGE};${line}${first ? "border-top-left-radius:11px;" : ""}${last ? "border-bottom-left-radius:11px;" : ""}">${mailEscape(row.label)}</td>
            <td valign="top" bgcolor="#ffffff" style="${CARD_FONT}background:#ffffff;padding:12px 16px;vertical-align:top;font-size:15px;line-height:21px;font-weight:${row.strong ? 700 : 500};color:${CARD_INK};${line}${first ? "border-top-right-radius:11px;" : ""}${last ? "border-bottom-right-radius:11px;" : ""}">${mailNl2br(row.value)}</td>
        </tr>`;
    }).join("");
    return cardRow(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border:1px solid ${EDGE};border-radius:12px;">${head}${body}</table>`,
        options.top ?? 22,
    );
};

/** Die Farbe einer Spalte («sütunları ayrı renk»). */
export type CardTone = "navy" | "plain" | "red" | "soft";

const TONE: Record<CardTone, { bg: string; fg: string; weight: number }> = {
    navy: { bg: NAVY_TINT, fg: BRAND_NAVY, weight: 700 },
    plain: { bg: "#ffffff", fg: CARD_INK, weight: 500 },
    red: { bg: RED_TINT, fg: RED_DEEP, weight: 700 },
    soft: { bg: NAVY_SOFT, fg: CARD_MUTED, weight: 500 },
};

export interface CardGrid {
    /** Die Kopfzeile; eine Zelle darf mehrere Spalten überspannen. */
    head?: Array<{ text: string; colspan?: number }> | null;
    rows: string[][];
    /** Die Farbe JEDER Spalte — ihre Anzahl ist die Spaltenzahl. */
    tones: CardTone[];
    /** Breite des INHALTS einer Spalte («20px», «30%», «» = frei) — die 2×16 px Innenabstand kommen dazu. */
    widths?: string[];
    /** Spalten, die nicht umbrechen (Uhrzeit, Grösse). */
    nowrap?: number[];
    /** Rechtsbündige Spalten. */
    right?: number[];
    top?: number;
}

/** Eine mehrspaltige, farbige Tabelle (Einsatzplan, Anhänge). */
export const cardGrid = (grid: CardGrid) => {
    if (!grid.rows.length) return "";
    const columns = grid.tones.length;
    const headCells = grid.head ?? [];
    const head = headCells.length
        ? `<tr>${headCells.map((cell, index) => headCell(
            cell.text,
            `${index === 0 ? "border-top-left-radius:11px;" : ""}${index === headCells.length - 1 ? "border-top-right-radius:11px;" : ""}`,
            cell.colspan ?? 1,
            headCells.length === 1,
        )).join("")}</tr>`
        : "";
    const body = grid.rows.map((row, rowIndex) => {
        const first = rowIndex === 0 && !headCells.length;
        const last = rowIndex === grid.rows.length - 1;
        return `<tr>${Array.from({ length: columns }, (_, index) => {
            const tone = TONE[grid.tones[index] ?? "plain"];
            const width = grid.widths?.[index] || "";
            const corners = `${first && index === 0 ? "border-top-left-radius:11px;" : ""}${first && index === columns - 1 ? "border-top-right-radius:11px;" : ""}${last && index === 0 ? "border-bottom-left-radius:11px;" : ""}${last && index === columns - 1 ? "border-bottom-right-radius:11px;" : ""}`;
            return `<td${width ? ` width="${width.replace("px", "")}"` : ""} valign="top" bgcolor="${tone.bg}" style="${CARD_FONT}${width ? `width:${width};` : ""}background:${tone.bg};padding:12px 16px;vertical-align:top;font-size:14.5px;line-height:20px;font-weight:${tone.weight};color:${tone.fg};${grid.nowrap?.includes(index) ? "white-space:nowrap;" : ""}${grid.right?.includes(index) ? "text-align:right;" : ""}${index < columns - 1 ? `border-right:1px solid ${EDGE};` : ""}${last ? "" : `border-bottom:1px solid ${LINE};`}${corners}">${mailNl2br(row[index] ?? "")}</td>`;
        }).join("")}</tr>`;
    }).join("");
    return cardRow(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border:1px solid ${EDGE};border-radius:12px;">${head}${body}</table>`,
        grid.top ?? 22,
    );
};

export type CardNoteTone = "amber" | "navy" | "red";

const NOTE: Record<CardNoteTone, { bg: string; edge: string }> = {
    amber: { bg: "#fff8e8", edge: "#f59e0b" },
    navy: { bg: NAVY_SOFT, edge: BRAND_NAVY },
    red: { bg: RED_TINT, edge: BRAND_RED },
};

/** Ein getönter Kasten mit farbiger Kante (Notiz, Beschreibung, Hinweis); `html` muss sicher sein. */
export const cardNote = (html: string, tone: CardNoteTone = "amber", top = 16) =>
    cardRow(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
            <td bgcolor="${NOTE[tone].bg}" style="${CARD_FONT}background:${NOTE[tone].bg};border-left:4px solid ${NOTE[tone].edge};border-radius:12px;padding:14px 18px;font-size:14.5px;line-height:22px;color:#3f3f46;">${html}</td>
        </tr></table>`,
        top,
    );

/** Der Knopf als Kapsel in der Akzentfarbe, mittig. */
export const cardButton = (label: string, href: string, accent: string = BRAND_NAVY, top = 26) =>
    cardRow(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;border-collapse:separate;"><tr>
            <td bgcolor="${accent}" style="${fill(accent)}border-radius:999px;box-shadow:0 8px 18px ${glow(accent, 0.25)};">
                <a href="${mailEscape(href)}" style="${CARD_FONT}display:inline-block;padding:13px 30px;font-size:15px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${mailEscape(label)}</a>
            </td>
        </tr></table>`,
        top,
        true,
    );

/** Der Schluss der Karte: Haarlinie, der leise Hinweis, der Gruss. */
export const cardClosing = (note: string | null, regards: string, brand: string) => `
    <tr><td class="occ-pad" style="padding:26px ${PAD}px 30px;">
        <div style="border-top:1px solid ${LINE};font-size:0;line-height:0;">&nbsp;</div>
        ${note ? `<div style="${CARD_FONT}padding-top:14px;font-size:12.5px;line-height:19px;color:${CARD_SUBTLE};">${mailEscape(note)}</div>` : ""}
        <div style="${CARD_FONT}margin-top:16px;font-size:15px;line-height:23px;color:${CARD_BODY};">${mailEscape(regards)}<br /><strong style="color:${BRAND_NAVY};">${mailEscape(brand)}</strong></div>
    </td></tr>`;

/** Der untere Rand der Karte, wenn kein Gruss den Schluss macht. */
export const cardEnd = () => `<tr><td style="padding:0 0 30px;font-size:0;line-height:0;">&nbsp;</td></tr>`;

export interface CardPageInput {
    lang: string;
    title: string;
    preheader?: string | null;
    /** Die `<tr>`-Bausteine der Karte (cardHeader, cardWave, cardHero …). */
    rows: string[];
    /** Leise Zeilen UNTER der Karte (automatischer Hinweis, Absender). */
    below?: string[];
    /** Schon sicheres HTML unter der Karte (z. B. der mailto-Link). */
    belowHtml?: string | null;
}

/** Die ganze Mail: weisser Grund, die Karte, darunter leise der Hinweis. */
export const cardPage = (input: CardPageInput): string => {
    const below = (input.below ?? []).filter((line) => line && line.trim());
    return `<!DOCTYPE html>
<html lang="${mailEscape(input.lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<meta name="x-apple-disable-message-reformatting" />
<title>${mailEscape(input.title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&amp;display=swap" rel="stylesheet" />
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
body{margin:0;padding:0;}
@media (max-width:520px){
  .occ-canvas{padding:14px 8px 26px!important;}
  .occ-pad{padding-left:20px!important;padding-right:20px!important;}
}
</style>
<!--[if mso]><style>body,table,td,div,p,a,span{font-family:Arial,Helvetica,sans-serif!important;}</style><![endif]-->
</head>
<!-- WEISSER GRUND (19.08.2026, Vorgabe Samet): nichts Bläuliches hinter der Karte. -->
<body style="margin:0;padding:0;background:#ffffff;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${mailEscape(input.preheader ?? input.title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;">
<tr><td align="center" class="occ-canvas" style="padding:28px 16px 36px;">
    ${MSO_OPEN}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="#ffffff" style="max-width:${CARD_WIDTH}px;margin:0 auto;background:#ffffff;border:1px solid #dde3f0;border-radius:20px;box-shadow:0 16px 40px rgba(31,38,84,.12);border-collapse:separate;">
    ${input.rows.join("\n")}
    </table>
    ${MSO_CLOSE}
    ${below.length || input.belowHtml ? `${MSO_OPEN}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:${CARD_WIDTH}px;margin:0 auto;">
    <tr><td align="center" style="${CARD_FONT}padding:18px 24px 0;font-size:11.5px;line-height:18px;color:#a3abbd;">
        ${below.map((line) => `<div>${mailEscape(line)}</div>`).join("")}
        ${input.belowHtml ? `<div>${input.belowHtml}</div>` : ""}
    </td></tr>
    </table>
    ${MSO_CLOSE}` : ""}
</td></tr>
</table>
</body>
</html>`;
};
