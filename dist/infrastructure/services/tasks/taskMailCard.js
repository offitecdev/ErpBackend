"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTaskMailText = exports.buildTaskMailHtml = exports.TASK_MAIL_RED = exports.TASK_MAIL_BLUE = void 0;
const mailBrand_1 = require("../mailBrand");
/**
 * ── DIE MAILKARTE DES GÖREVLER-MODULS (16.09.2026, Vorgabe Samet) ───────────
 *
 *   «maile giden kartların tasarımı daha sade … temiz apple modern mail
 *    mesajları gibi … swift ui mac os apple tarzı kart tasarımı»
 *   2. Runde: «daha güzel ve estetik … border radius … daha profesyonel»
 *
 * EINE Karte für «Yeni görev» UND «Soru/Sorun», gebaut wie eine Systemmail von
 * Apple:
 *   · hellgrauer Grund, weisse Karte (Radius 22, Haarlinie, sehr weicher
 *     Schatten);
 *   · oben ZENTRIERT das Logo als App-Symbol (abgerundetes Quadrat), darunter
 *     eine getönte Kapsel mit dem Stichwort und die grosse Überschrift;
 *   · die Fälligkeit als eigener Block mit Kalenderblatt (wie eine Einladung
 *     in Apple Kalender);
 *   · die Angaben als gruppierte Liste in einem abgerundeten Kasten, die
 *     Haarlinien eingerückt wie in den macOS-Einstellungen;
 *   · EIN Knopf in Kapselform, zentriert.
 * Farbe tragen nur Kapsel und Knopf (Blau fragt/teilt zu, Rot meldet ein
 * Problem).
 *
 * Mail-HTML ist nicht Browser-HTML: Tabellen und Inline-Stile, kein Flexbox,
 * keine SVG — sonst zerfällt die Karte in Outlooks Word-Renderer. Radien und
 * Schatten fehlen dort einfach, der Aufbau steht.
 */
exports.TASK_MAIL_BLUE = "#0a7aff";
exports.TASK_MAIL_RED = "#ff3b30";
/** Getönter Grund der Kapsel und die (etwas dunklere, lesbare) Schrift darauf. */
const TINTS = {
    [exports.TASK_MAIL_BLUE]: { bg: "#e9f2ff", fg: "#0064d6" },
    [exports.TASK_MAIL_RED]: { bg: "#ffecea", fg: "#d70015" },
};
const INK = "#1d1d1f";
const SECONDARY = "#6e6e73";
const TERTIARY = "#86868b";
const HAIRLINE = "#e8e8ed";
const CANVAS = "#f5f5f7";
const GROUP = "#fbfbfd";
const WIDTH = 600;
const TZ = "Europe/Zurich";
const FONT = "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue','Segoe UI',Roboto,Arial,sans-serif;";
const DISPLAY = "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue','Segoe UI',Roboto,Arial,sans-serif;";
const MSO_OPEN = `<!--[if mso]><table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->`;
const MSO_CLOSE = "<!--[if mso]></td></tr></table><![endif]-->";
const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const nl2br = (value) => escapeHtml(value).replace(/\r?\n/g, "<br />");
const part = (date, options) => new Intl.DateTimeFormat("tr-TR", { timeZone: TZ, ...options }).format(date);
const capsule = (text, bg, fg) => `<td style="padding:0 3px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${bg}" style="${FONT}background:${bg};border-radius:999px;padding:5px 12px;font-size:12px;line-height:16px;font-weight:600;letter-spacing:.01em;color:${fg};white-space:nowrap;">${escapeHtml(text)}</td></tr></table></td>`;
/** Das Kalenderblatt: roter Kopf mit dem Monat, darunter der Tag. */
const dateTile = (date) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="52" style="width:52px;border-collapse:separate;background:#ffffff;border:1px solid ${HAIRLINE};border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.05);">
<tr><td bgcolor="${exports.TASK_MAIL_RED}" align="center" style="${FONT}background:${exports.TASK_MAIL_RED};border-radius:11px 11px 0 0;padding:3px 0 2px;font-size:9.5px;line-height:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#ffffff;">${escapeHtml(part(date, { month: "short" }))}</td></tr>
<tr><td align="center" style="${DISPLAY}padding:4px 0 6px;font-size:24px;line-height:26px;font-weight:500;letter-spacing:-.02em;color:${INK};">${escapeHtml(part(date, { day: "numeric" }))}</td></tr>
</table>`;
const dateBlock = (date) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-collapse:separate;">
<tr><td bgcolor="${GROUP}" style="background:${GROUP};border:1px solid ${HAIRLINE};border-radius:16px;padding:14px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="52" style="vertical-align:middle;width:52px;">${dateTile(date.at)}</td>
        <td style="vertical-align:middle;padding-left:14px;">
            <div style="${FONT}font-size:12px;line-height:16px;font-weight:500;color:${TERTIARY};">${escapeHtml(date.label)}</div>
            <div style="${FONT}margin-top:2px;font-size:16px;line-height:22px;font-weight:600;color:${INK};">${escapeHtml(date.text)}</div>
        </td>
    </tr></table>
</td></tr>
</table>`;
/** Eine Zeile der gruppierten Liste; die Haarlinie ist links und rechts eingerückt. */
const listRow = (row, last) => `
<tr><td style="padding:0 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="${FONT}padding:12px 0;vertical-align:top;font-size:14px;line-height:20px;color:${SECONDARY};white-space:nowrap;${last ? "" : `border-bottom:1px solid ${HAIRLINE};`}">${escapeHtml(row.label)}</td>
        <td align="right" style="${FONT}padding:12px 0 12px 20px;vertical-align:top;text-align:right;font-size:14px;line-height:20px;font-weight:500;color:${INK};${last ? "" : `border-bottom:1px solid ${HAIRLINE};`}">${escapeHtml(row.value)}</td>
    </tr></table>
</td></tr>`;
const buildTaskMailHtml = (card) => {
    const rows = card.rows.filter((row) => row.value.trim());
    const tint = TINTS[card.accent] ?? { bg: "#f2f2f7", fg: card.accent };
    const red = TINTS[exports.TASK_MAIL_RED];
    return `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(card.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CANVAS}" style="background:${CANVAS};">
<tr><td align="center" style="padding:40px 14px 44px;">

    ${MSO_OPEN}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:${WIDTH}px;margin:0 auto;">

    <tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${HAIRLINE};border-radius:22px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.06);">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

        <!-- KOPF, zentriert: App-Symbol, Kapseln, Überschrift. -->
        <tr><td align="center" style="padding:36px 32px 28px;border-bottom:1px solid ${HAIRLINE};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;border-collapse:separate;"><tr>
                <td width="56" height="56" align="center" valign="middle" bgcolor="#ffffff" style="width:56px;height:56px;background:#ffffff;border:1px solid ${HAIRLINE};border-radius:15px;box-shadow:0 2px 6px rgba(0,0,0,.06);">
                    <img src="cid:${mailBrand_1.BRAND_LOGO_CID}" width="34" height="34" alt="" style="display:block;margin:0 auto;width:34px;height:34px;border:0;" />
                </td>
            </tr></table>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:18px auto 0;"><tr>
                ${capsule(card.kicker, tint.bg, tint.fg)}
                ${card.badge ? capsule(`! ${card.badge}`, red.bg, red.fg) : ""}
            </tr></table>
            <div style="${DISPLAY}margin-top:14px;font-size:26px;line-height:32px;font-weight:600;letter-spacing:-.022em;color:${INK};text-align:center;">${escapeHtml(card.heading)}</div>
        </td></tr>

        <!-- INHALT -->
        <tr><td style="padding:26px 32px 32px;">
            <div style="${FONT}font-size:15px;line-height:23px;font-weight:600;color:${INK};">${escapeHtml(card.greeting)}</div>
            <div style="${FONT}margin-top:4px;font-size:15px;line-height:23px;color:${SECONDARY};">${escapeHtml(card.lead)}</div>

            ${card.quote?.trim()
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-collapse:separate;"><tr>
                <td bgcolor="${CANVAS}" style="${FONT}background:${CANVAS};border-radius:16px;padding:16px 18px;font-size:15px;line-height:23px;color:${INK};">${nl2br(card.quote.trim())}</td>
            </tr></table>`
        : ""}

            ${card.date ? dateBlock(card.date) : ""}

            ${rows.length
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-collapse:separate;">
                <tr><td bgcolor="${GROUP}" style="background:${GROUP};border:1px solid ${HAIRLINE};border-radius:16px;padding:2px 0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    ${rows.map((row, index) => listRow(row, index === rows.length - 1)).join("")}
                    </table>
                </td></tr>
            </table>`
        : ""}

            ${card.button
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:28px auto 0;"><tr>
                <td bgcolor="${card.accent}" style="background:${card.accent};border-radius:999px;box-shadow:0 1px 2px rgba(0,0,0,.08);">
                    <a href="${escapeHtml(card.button.href)}" style="${FONT}display:inline-block;padding:12px 28px;font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(card.button.label)}</a>
                </td>
            </tr></table>`
        : ""}
        </td></tr>
        </table>
    </td></tr>

    <!-- FUSS: Absender und Hinweis, klein und grau. -->
    <tr><td align="center" style="padding:22px 28px 0;">
        <div style="${FONT}font-size:12px;line-height:17px;font-weight:600;color:${SECONDARY};">${escapeHtml(card.brand)}</div>
        <div style="${FONT}margin-top:4px;font-size:12px;line-height:17px;color:${TERTIARY};">${escapeHtml(card.footer)}</div>
    </td></tr>
    </table>
    ${MSO_CLOSE}

</td></tr>
</table>
</body>
</html>`;
};
exports.buildTaskMailHtml = buildTaskMailHtml;
const buildTaskMailText = (card) => {
    const lines = [
        `${card.badge ? `! ${card.badge} · ` : ""}${card.kicker}`,
        card.heading,
        "",
        card.greeting,
        card.lead,
        ...(card.quote?.trim() ? ["", card.quote.trim()] : []),
        "",
        ...(card.date ? [`${card.date.label}: ${card.date.text}`] : []),
        ...card.rows.filter((row) => row.value.trim()).map((row) => `${row.label}: ${row.value}`),
        ...(card.button ? ["", `${card.button.label}: ${card.button.href}`] : []),
        "",
        "—",
        card.brand,
        card.footer,
    ];
    return lines.join("\n");
};
exports.buildTaskMailText = buildTaskMailText;
//# sourceMappingURL=taskMailCard.js.map