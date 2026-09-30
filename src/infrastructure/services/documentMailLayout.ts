import { BRAND_LOGO_CID, BRAND_NAVY, BRAND_RED, brandLogoInline } from './mailBrand';

/**
 * ── DIE BELEGMAIL DER OCC (29.09.2026, Vorgabe Samet) ────────────────────────
 *
 *   «Gönderilen mailler çok daha temiz bir formatta olması lazım — OCC mail
 *    profesyonelliğinde, Adobe maillerine benzeyebilir ama bizim renklerde.»
 *
 * EIN Aufbau für jede Mail, die einen Beleg nach aussen trägt (Bestellung,
 * Preisanfrage, Offerte, Auftragsbestätigung, Rapport …) — gebaut wie die
 * Systemmails von Adobe, aber in den Farben von Offitec (Navy + Rot, dieselben
 * Töne wie Logo und PDFs):
 *   · hellgrauer Grund, EINE weisse Karte (Radius 18, Haarlinie, weicher
 *     Schatten), alles linksbündig;
 *   · Kopf: das Logo (Stern) und der Absender, darunter eine Haarlinie;
 *   · eine kleine rote Versalzeile, die grosse Überschrift, bei Bedarf eine
 *     Kapsel (z. B. «Revision 2»);
 *   · ein Hinweiskasten, die Eckdaten als gruppierte Liste, die Anhänge als
 *     Dateikacheln, auf Wunsch ein Knopf — erst DANACH der Brief (Anrede …
 *     Gruss), damit der Gruss direkt über der Signatur des Mandanten steht;
 *   · unter der Karte leise der Absender.
 *
 * Mail-HTML ist nicht Browser-HTML: Tabellen und Inline-Stile, kein Flexbox,
 * keine SVG — sonst zerfällt die Karte in Outlooks Word-Renderer. Radien und
 * Schatten fehlen dort einfach, der Aufbau steht.
 *
 * Der Text des Benutzers kommt als REINER TEXT (`message`) und wird hier
 * maskiert; `messageHtml`/`extraHtml` nur für schon gebautes, sicheres HTML.
 * Das Logo reist als Inline-Bild mit — der Aufrufer hängt `inlineImages` an.
 */

export type DocumentMailLang = 'de' | 'tr' | 'en';

export interface DocumentMailAttachment {
    name: string;
    /** Grösse in Bytes (für «84 KB»); fehlt sie, steht nur der Name. */
    bytes?: number | null;
}

export interface DocumentMailInput {
    lang?: DocumentMailLang | string | null;
    /** Der Absender (Firma) — im Kopf der Karte und darunter. */
    senderName: string;
    senderEmail?: string | null;
    /** Kleine rote Versalzeile über der Überschrift, z. B. «Bestellung». */
    eyebrow?: string | null;
    heading: string;
    /** Kapsel neben der Überschrift, z. B. «Revision 2». */
    badge?: { text: string; tone?: 'revision' | 'info' } | null;
    /** Hinweiskasten über dem Text (die Revision einer Bestellung). */
    notice?: { title: string; text: string } | null;
    /** Der Text der Mail als reiner Text (Leerzeile = Absatz); mit `messageHtml` nur noch für text/plain. */
    message?: string | null;
    /** Schon sicheres HTML statt `message` (z. B. der Rich-Text einer Offerte). */
    messageHtml?: string | null;
    /** Ein weiterer, schon sicherer HTML-Abschnitt unter dem Text. */
    extraHtml?: string | null;
    /** Die Eckdaten des Belegs: [Bezeichnung, Wert]; leere Werte fallen weg. */
    facts?: Array<[string, string | null | undefined]>;
    /** Weitere benannte Listen unter den Eckdaten, z. B. geplante Termine: [links, rechts]. */
    groups?: Array<{ title: string; rows: Array<[string, string]> }>;
    attachments?: DocumentMailAttachment[];
    /** Ein Knopf (Rapport ansehen, Termin wählen …); nur http(s). */
    action?: { label: string; href: string } | null;
    /** Die Signatur des Mandanten (`buildSignatureParts().html`). */
    signatureHtml?: string | null;
    /** Vorschautext in der Postfachliste. */
    preheader?: string | null;
}

export interface DocumentMail {
    html: string;
    /** text/plain ohne Signatur — der Aufrufer hängt `signature.text` an. */
    text: string;
    /** Das Logo als Inline-Bild (`cid:`) — mit den Signaturbildern mitsenden. */
    inlineImages: Array<{ cid: string; contentType: string; contentBase64: string }>;
}

const INK = '#1d1d1f';
const INK_2 = '#3a3a3c';
const SECONDARY = '#6e6e73';
const TERTIARY = '#8e8e93';
const HAIRLINE = '#e5e5ea';
const CANVAS = '#f4f5f7';
const GROUP = '#fafafc';
const RED_TINT = '#fdf1f1';
const RED_EDGE = '#f4d4d5';
const RED_TEXT = '#b10d12';
const NAVY_TINT = '#eceef6';
const WIDTH = 600;
const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif;";
const MSO_OPEN = `<!--[if mso]><table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->`;
const MSO_CLOSE = '<!--[if mso]></td></tr></table><![endif]-->';

const WORDS: Record<DocumentMailLang, { attachment: string; attachments: string; footer: string; locale: string }> = {
    de: { attachment: 'Anhang', attachments: 'Anhänge', footer: 'Gesendet mit Offitec Control Center', locale: 'de-CH' },
    tr: { attachment: 'Ek', attachments: 'Ekler', footer: 'Offitec Control Center ile gönderildi', locale: 'tr-TR' },
    en: { attachment: 'Attachment', attachments: 'Attachments', footer: 'Sent with Offitec Control Center', locale: 'en-GB' },
};

export const documentMailLang = (value: unknown): DocumentMailLang => (value === 'tr' || value === 'en' ? value : 'de');

export const escapeMailHtml = (value: unknown): string => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Reiner Text → Absätze (Leerzeile) mit Zeilenumbrüchen. */
const paragraphs = (text: string): string => text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .filter((block) => block.trim())
    .map((block, index, all) => `<p style="margin:0 0 ${index === all.length - 1 ? 0 : 14}px;">${escapeMailHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('');

/** Nur http(s) als Knopfziel — nichts anderes gelangt in ein href. */
const safeHref = (href: string): string | null => (/^https?:\/\/[^\s"'<>]+$/i.test(href) ? href : null);

const fileSize = (bytes: number, locale: string): string => {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`;
};

const factRow = (name: string, value: string, last: boolean) => `
<tr><td style="padding:0 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="${FONT}padding:11px 0;vertical-align:top;font-size:14px;line-height:20px;color:${SECONDARY};white-space:nowrap;${last ? '' : `border-bottom:1px solid ${HAIRLINE};`}">${escapeMailHtml(name)}</td>
        <td align="right" style="${FONT}padding:11px 0 11px 20px;vertical-align:top;text-align:right;font-size:14px;line-height:20px;font-weight:600;color:${INK};${last ? '' : `border-bottom:1px solid ${HAIRLINE};`}">${escapeMailHtml(value)}</td>
    </tr></table>
</td></tr>`;

/** Eine Dateikachel: farbiges Feld mit der Endung, Name, Grösse. */
const fileTile = (file: DocumentMailAttachment, locale: string, first: boolean) => {
    const ext = (/\.([a-z0-9]{2,4})$/i.exec(file.name)?.[1] ?? 'file').toUpperCase();
    const tone = ext === 'PDF' ? BRAND_RED : BRAND_NAVY;
    const size = typeof file.bytes === 'number' && file.bytes > 0 ? fileSize(file.bytes, locale) : '';
    return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:${first ? 0 : 8}px;border-collapse:separate;">
<tr><td style="background:#ffffff;border:1px solid ${HAIRLINE};border-radius:12px;padding:10px 12px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="36" height="36" align="center" valign="middle" bgcolor="${tone}" style="${FONT}width:36px;height:36px;background:${tone};border-radius:8px;font-size:10px;line-height:12px;font-weight:700;letter-spacing:.04em;color:#ffffff;">${escapeMailHtml(ext)}</td>
        <td style="${FONT}padding-left:12px;vertical-align:middle;">
            <div style="font-size:14px;line-height:19px;font-weight:600;color:${INK};word-break:break-word;overflow-wrap:anywhere;">${escapeMailHtml(file.name)}</div>
            ${size ? `<div style="margin-top:1px;font-size:12px;line-height:16px;color:${TERTIARY};">${escapeMailHtml(size)}</div>` : ''}
        </td>
    </tr></table>
</td></tr>
</table>`;
};

export const renderDocumentMail = (input: DocumentMailInput): DocumentMail => {
    const lang = documentMailLang(input.lang);
    const words = WORDS[lang];
    const senderName = (input.senderName || '').trim() || 'Offitec Control Center';
    const senderEmail = (input.senderEmail || '').trim();
    const facts = (input.facts ?? [])
        .map(([name, value]) => [name, String(value ?? '').trim()] as [string, string])
        .filter(([, value]) => value);
    const groups = (input.groups ?? []).filter((group) => group.rows.length > 0);
    const attachments = (input.attachments ?? []).filter((file) => file?.name);
    const href = input.action ? safeHref(input.action.href) : null;
    const bodyHtml = input.messageHtml ?? (input.message?.trim() ? paragraphs(input.message) : '');

    const badge = input.badge?.text
        ? `<span style="display:inline-block;margin-left:10px;padding:4px 11px;border-radius:999px;font-size:12px;line-height:16px;font-weight:600;letter-spacing:.01em;vertical-align:5px;white-space:nowrap;${input.badge.tone === 'info'
            ? `background:${NAVY_TINT};color:${BRAND_NAVY};`
            : `background:${RED_TINT};color:${RED_TEXT};`}">${escapeMailHtml(input.badge.text)}</span>`
        : '';

    const sections: string[] = [];

    // Versalzeile, Überschrift, Kapsel.
    sections.push(`<tr><td style="${FONT}padding:30px 32px 0;">
        ${input.eyebrow ? `<div style="font-size:12px;line-height:16px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${BRAND_RED};">${escapeMailHtml(input.eyebrow)}</div>` : ''}
        <div style="margin-top:${input.eyebrow ? 8 : 0}px;font-size:26px;line-height:33px;font-weight:600;letter-spacing:-.02em;color:${INK};">${escapeMailHtml(input.heading)}${badge}</div>
    </td></tr>`);

    if (input.notice?.text?.trim()) {
        sections.push(`<tr><td style="padding:20px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
                <td bgcolor="${RED_TINT}" style="${FONT}background:${RED_TINT};border:1px solid ${RED_EDGE};border-radius:14px;padding:14px 16px;">
                    ${input.notice.title ? `<div style="font-size:14px;line-height:20px;font-weight:600;color:${RED_TEXT};">${escapeMailHtml(input.notice.title)}</div>` : ''}
                    <div style="margin-top:${input.notice.title ? 3 : 0}px;font-size:14px;line-height:21px;color:${INK_2};">${escapeMailHtml(input.notice.text.trim()).replace(/\r?\n/g, '<br />')}</div>
                </td>
            </tr></table>
        </td></tr>`);
    }

    if (facts.length) {
        sections.push(`<tr><td style="padding:24px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
                <td bgcolor="${GROUP}" style="background:${GROUP};border:1px solid ${HAIRLINE};border-radius:14px;padding:2px 0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    ${facts.map(([name, value], index) => factRow(name, value, index === facts.length - 1)).join('')}
                    </table>
                </td>
            </tr></table>
        </td></tr>`);
    }

    for (const group of groups) {
        sections.push(`<tr><td style="${FONT}padding:22px 32px 0;">
            <div style="margin-bottom:8px;font-size:12px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${TERTIARY};">${escapeMailHtml(group.title)}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
                <td bgcolor="${GROUP}" style="background:${GROUP};border:1px solid ${HAIRLINE};border-radius:14px;padding:2px 0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    ${group.rows.map(([name, value], index) => factRow(name, value, index === group.rows.length - 1)).join('')}
                    </table>
                </td>
            </tr></table>
        </td></tr>`);
    }

    if (attachments.length) {
        sections.push(`<tr><td style="${FONT}padding:22px 32px 0;">
            <div style="margin-bottom:8px;font-size:12px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${TERTIARY};">${attachments.length === 1 ? words.attachment : words.attachments}</div>
            ${attachments.map((file, index) => fileTile(file, words.locale, index === 0)).join('')}
        </td></tr>`);
    }

    if (input.action && href) {
        sections.push(`<tr><td style="${FONT}padding:26px 32px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                <td bgcolor="${BRAND_NAVY}" style="background:${BRAND_NAVY};border-radius:999px;">
                    <a href="${escapeMailHtml(href)}" style="${FONT}display:inline-block;padding:12px 26px;font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeMailHtml(input.action.label)}</a>
                </td>
            </tr></table>
            <div style="margin-top:10px;font-size:12px;line-height:17px;color:${TERTIARY};word-break:break-all;">${escapeMailHtml(href)}</div>
        </td></tr>`);
    }

    if (bodyHtml) {
        sections.push(`<tr><td style="${FONT}padding:28px 32px 0;font-size:15px;line-height:24px;color:${INK};">${bodyHtml}</td></tr>`);
    }
    if (input.extraHtml) {
        sections.push(`<tr><td style="${FONT}padding:18px 32px 0;font-size:14px;line-height:22px;color:${INK};">${input.extraHtml}</td></tr>`);
    }

    if (input.signatureHtml) {
        sections.push(`<tr><td style="${FONT}padding:10px 32px 0;font-size:14px;line-height:21px;color:${INK};">${input.signatureHtml}</td></tr>`);
    }

    const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeMailHtml(input.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeMailHtml(input.preheader ?? input.heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CANVAS}" style="background:${CANVAS};">
<tr><td align="center" style="padding:36px 14px 44px;">

    ${MSO_OPEN}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:${WIDTH}px;margin:0 auto;">

    <tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${HAIRLINE};border-radius:18px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 10px 28px rgba(16,24,40,.06);">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

        <!-- KOPF: Logo und Absender. -->
        <tr><td style="padding:20px 32px;border-bottom:1px solid ${HAIRLINE};">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                <td width="30" style="width:30px;vertical-align:middle;"><img src="cid:${BRAND_LOGO_CID}" width="30" height="30" alt="" style="display:block;width:30px;height:30px;border:0;" /></td>
                <td style="${FONT}padding-left:10px;vertical-align:middle;font-size:15px;line-height:20px;font-weight:600;letter-spacing:-.005em;color:${BRAND_NAVY};">${escapeMailHtml(senderName)}</td>
            </tr></table>
        </td></tr>

        ${sections.join('\n')}

        <tr><td style="padding:0 0 32px;font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
    </td></tr>

    <!-- FUSS: Absender, klein und grau. -->
    <tr><td align="center" style="${FONT}padding:20px 24px 0;font-size:12px;line-height:18px;color:${TERTIARY};">
        <span style="font-weight:600;color:${SECONDARY};">${escapeMailHtml(senderName)}</span>${senderEmail ? ` · <a href="mailto:${escapeMailHtml(senderEmail)}" style="color:${TERTIARY};text-decoration:none;">${escapeMailHtml(senderEmail)}</a>` : ''}
        <div style="margin-top:3px;">${words.footer}</div>
    </td></tr>
    </table>
    ${MSO_CLOSE}

</td></tr>
</table>
</body>
</html>`;

    const text = [
        [input.eyebrow, input.heading].filter(Boolean).join(' · ') + (input.badge?.text ? ` (${input.badge.text})` : ''),
        ...(input.notice?.text?.trim() ? ['', ...(input.notice.title ? [input.notice.title] : []), input.notice.text.trim()] : []),
        ...(facts.length ? ['', ...facts.map(([name, value]) => `${name}: ${value}`)] : []),
        ...groups.flatMap((group) => ['', `${group.title}:`, ...group.rows.map(([name, value]) => `- ${name} ${value}`)]),
        ...(attachments.length ? ['', `${attachments.length === 1 ? words.attachment : words.attachments}: ${attachments.map((file) => file.name).join(', ')}`] : []),
        ...(input.action && href ? ['', `${input.action.label}: ${href}`] : []),
        ...(input.message?.trim() ? ['', input.message.trim()] : []),
    ].join('\n');

    return { html, text, inlineImages: [brandLogoInline()] };
};
