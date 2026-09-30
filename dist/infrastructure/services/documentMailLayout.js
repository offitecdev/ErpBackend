"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderDocumentMail = exports.escapeMailHtml = exports.documentMailLang = void 0;
const mailBrand_1 = require("./mailBrand");
const mailCardKit_1 = require("./mailCardKit");
const RED_TEXT = '#b10d12';
/** Der Leuchtstift (Textmarker-Gelb) und seine Kante. */
const HIGHLIGHT = '#fff34d';
const HIGHLIGHT_EDGE = '#f0c400';
const WORDS = {
    de: { attachment: 'Anhang', attachments: 'Anhänge', details: 'Angaben', rubric: 'Dokumente', footer: 'Gesendet mit Offitec Control Center', locale: 'de-CH' },
    tr: { attachment: 'Ek', attachments: 'Ekler', details: 'Bilgiler', rubric: 'Belgeler', footer: 'Offitec Control Center ile gönderildi', locale: 'tr-TR' },
    en: { attachment: 'Attachment', attachments: 'Attachments', details: 'Details', rubric: 'Documents', footer: 'Sent with Offitec Control Center', locale: 'en-GB' },
};
const documentMailLang = (value) => (value === 'tr' || value === 'en' ? value : 'de');
exports.documentMailLang = documentMailLang;
const escapeMailHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
exports.escapeMailHtml = escapeMailHtml;
/** Reiner Text → Absätze (Leerzeile) mit Zeilenumbrüchen. */
const paragraphs = (text) => text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .filter((block) => block.trim())
    .map((block, index, all) => `<p style="margin:0 0 ${index === all.length - 1 ? 0 : 14}px;">${(0, exports.escapeMailHtml)(block).replace(/\n/g, '<br />')}</p>`)
    .join('');
/** Nur http(s) als Knopfziel — nichts anderes gelangt in ein href. */
const safeHref = (href) => (/^https?:\/\/[^\s"'<>]+$/i.test(href) ? href : null);
const fileSize = (bytes, locale) => {
    if (bytes < 1024 * 1024)
        return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / (1024 * 1024))} MB`;
};
const renderDocumentMail = (input) => {
    const lang = (0, exports.documentMailLang)(input.lang);
    const words = WORDS[lang];
    const senderName = (input.senderName || '').trim() || 'Offitec Control Center';
    const senderEmail = (input.senderEmail || '').trim();
    const facts = (input.facts ?? [])
        .map(([name, value]) => [name, String(value ?? '').trim()])
        .filter(([, value]) => value);
    const groups = (input.groups ?? []).filter((group) => group.rows.length > 0);
    const attachments = (input.attachments ?? []).filter((file) => file?.name);
    const href = input.action ? safeHref(input.action.href) : null;
    const bodyHtml = input.messageHtml ?? (input.message?.trim() ? paragraphs(input.message) : '');
    /* 30.09.2026 (Samet, mit dem Bild der Augustkarte: «bunun gibi olsun …
       tablolar renkli, sütunları ayrı renk, dalga aynı kalsın, premium»):
       dieselbe Karte wie die Terminmail (mailCardKit.ts) — Kopf mit dem
       Absender, Welle, das Beleg-Zeichen, die rote Stichzeile und der Titel,
       die Eckdaten und Listen als farbige Tabellen, danach der Brief. */
    const sections = [
        (0, mailCardKit_1.cardHeader)(senderName, words.rubric),
        (0, mailCardKit_1.cardWave)(),
        (0, mailCardKit_1.cardHero)({
            icon: 'DOCUMENT',
            accent: mailBrand_1.BRAND_NAVY,
            kicker: input.eyebrow ?? null,
            kickerColor: mailBrand_1.BRAND_RED,
            title: input.heading,
            badge: input.badge?.text ? { text: input.badge.text, tone: input.badge.tone === 'info' ? 'navy' : 'red' } : null,
        }),
    ];
    const highlightText = input.highlight?.text?.trim() ?? '';
    const highlightRow = (top) => (0, mailCardKit_1.cardRow)(`
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
                <td bgcolor="${HIGHLIGHT}" style="${mailCardKit_1.CARD_FONT}background:${HIGHLIGHT};border-left:5px solid ${HIGHLIGHT_EDGE};border-radius:6px;padding:13px 16px;font-size:14px;line-height:21px;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:${mailCardKit_1.CARD_INK};">${(0, exports.escapeMailHtml)(highlightText.toLocaleUpperCase(WORDS[lang].locale))}</td>
            </tr></table>`, top ? 22 : 26);
    if (highlightText)
        sections.push(highlightRow(true));
    if (input.notice?.text?.trim()) {
        sections.push((0, mailCardKit_1.cardNote)(`${input.notice.title ? `<div style="font-weight:700;color:${RED_TEXT};">${(0, exports.escapeMailHtml)(input.notice.title)}</div>` : ''}`
            + `<div style="margin-top:${input.notice.title ? 3 : 0}px;">${(0, exports.escapeMailHtml)(input.notice.text.trim()).replace(/\r?\n/g, '<br />')}</div>`, 'red', 22));
    }
    if (facts.length)
        sections.push((0, mailCardKit_1.cardTable)(facts.map(([label, value]) => ({ label, value })), { title: words.details }));
    for (const group of groups) {
        sections.push((0, mailCardKit_1.cardTable)(group.rows.map(([label, value]) => ({ label, value })), { title: group.title }));
    }
    if (attachments.length) {
        sections.push((0, mailCardKit_1.cardGrid)({
            head: [{ text: attachments.length === 1 ? words.attachment : words.attachments, colspan: 3 }],
            rows: attachments.map((file) => [
                (0, mailCardKit_1.cardFileType)(file.name),
                file.name,
                typeof file.bytes === 'number' && file.bytes > 0 ? fileSize(file.bytes, words.locale) : '',
            ]),
            tones: ['red', 'plain', 'soft'],
            widths: ['40px', '', '22%'],
            nowrap: [2],
            right: [2],
        }));
    }
    if (input.action && href) {
        sections.push((0, mailCardKit_1.cardButton)(input.action.label, href, mailBrand_1.BRAND_NAVY));
        sections.push((0, mailCardKit_1.cardRow)(`<div style="font-size:12px;line-height:17px;color:${mailCardKit_1.CARD_SUBTLE};word-break:break-all;">${(0, exports.escapeMailHtml)(href)}</div>`, 10, true));
    }
    if (bodyHtml)
        sections.push((0, mailCardKit_1.cardParagraphHtml)(bodyHtml, 26));
    if (input.extraHtml) {
        sections.push((0, mailCardKit_1.cardRow)(`<div style="font-size:14px;line-height:22px;color:${mailCardKit_1.CARD_INK};">${input.extraHtml}</div>`, 18));
    }
    if (highlightText)
        sections.push(highlightRow(false));
    if (input.signatureHtml) {
        sections.push((0, mailCardKit_1.cardRow)(`<div style="font-size:14px;line-height:21px;color:${mailCardKit_1.CARD_INK};">${input.signatureHtml}</div>`, 14));
    }
    sections.push((0, mailCardKit_1.cardEnd)());
    const html = (0, mailCardKit_1.cardPage)({
        lang,
        title: input.heading,
        preheader: input.preheader ?? input.heading,
        rows: sections,
        below: [senderName, words.footer],
        belowHtml: senderEmail
            ? `<a href="mailto:${(0, exports.escapeMailHtml)(senderEmail)}" style="color:#a3abbd;text-decoration:none;">${(0, exports.escapeMailHtml)(senderEmail)}</a>`
            : null,
    });
    const shout = highlightText ? `*** ${highlightText.toLocaleUpperCase(words.locale)} ***` : '';
    const text = [
        [input.eyebrow, input.heading].filter(Boolean).join(' · ') + (input.badge?.text ? ` (${input.badge.text})` : ''),
        ...(shout ? ['', shout] : []),
        ...(input.notice?.text?.trim() ? ['', ...(input.notice.title ? [input.notice.title] : []), input.notice.text.trim()] : []),
        ...(facts.length ? ['', ...facts.map(([name, value]) => `${name}: ${value}`)] : []),
        ...groups.flatMap((group) => ['', `${group.title}:`, ...group.rows.map(([name, value]) => `- ${name} ${value}`)]),
        ...(attachments.length ? ['', `${attachments.length === 1 ? words.attachment : words.attachments}: ${attachments.map((file) => file.name).join(', ')}`] : []),
        ...(input.action && href ? ['', `${input.action.label}: ${href}`] : []),
        ...(input.message?.trim() ? ['', input.message.trim()] : []),
        ...(shout ? ['', shout] : []),
    ].join('\n');
    return { html, text, inlineImages: (0, mailCardKit_1.mailInlineImages)('DOCUMENT') };
};
exports.renderDocumentMail = renderDocumentMail;
//# sourceMappingURL=documentMailLayout.js.map