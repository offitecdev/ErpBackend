import { BRAND_NAVY, BRAND_RED } from './mailBrand';
import {
    CARD_FONT,
    CARD_INK,
    CARD_SUBTLE,
    cardButton,
    cardEnd,
    cardFileType,
    cardGrid,
    cardHeader,
    cardHero,
    cardNote,
    cardPage,
    cardParagraphHtml,
    cardRow,
    cardTable,
    cardWave,
    mailInlineImages,
} from './mailCardKit';

/**
 * ── DIE BELEGMAIL DER OCC (29.09.2026, Vorgabe Samet) ────────────────────────
 *
 *   «Gönderilen mailler çok daha temiz bir formatta olması lazım — OCC mail
 *    profesyonelliğinde, Adobe maillerine benzeyebilir ama bizim renklerde.»
 *
 * EIN Aufbau für jede Mail, die einen Beleg nach aussen trägt (Bestellung,
 * Preisanfrage, Offerte, Auftragsbestätigung, Rapport …). Seit 30.09.2026
 * steht er auf der Karte der Terminmail (mailCardKit.ts, Vorgabe Samet mit
 * dem Bild der Augustkarte: «tablolar renkli, sütunları ayrı renk, dalga aynı
 * kalsın, premium»):
 *   · Kopf mit dem Absender, die Welle, das Beleg-Zeichen, die rote
 *     Stichzeile, die Überschrift, bei Bedarf eine Kapsel («Revision 2»);
 *   · ein Hinweiskasten, die Eckdaten und Listen als farbige Tabellen, die
 *     Anhänge als Tabelle (Art · Name · Grösse), auf Wunsch ein Knopf — erst
 *     DANACH der Brief (Anrede … Gruss), damit der Gruss direkt über der
 *     Signatur des Mandanten steht;
 *   · unter der Karte leise der Absender.
 *
 * Der Text des Benutzers kommt als REINER TEXT (`message`) und wird hier
 * maskiert; `messageHtml`/`extraHtml` nur für schon gebautes, sicheres HTML.
 * Die Bilder (Logo, Welle, Zeichen) reisen als Inline-Bilder mit — der
 * Aufrufer hängt `inlineImages` an.
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
    /**
     * Ein Leuchtstift-Band (gelb, VERSALIEN) — oben unter der Überschrift UND
     * unten über der Signatur (30.09.2026, Samet: «üste ve alta sarı fosforlu
     * ile … büyük harflerle»): die Bitte, als Antwort auf diese Mail zu senden.
     */
    highlight?: { text: string } | null;
}

export interface DocumentMail {
    html: string;
    /** text/plain ohne Signatur — der Aufrufer hängt `signature.text` an. */
    text: string;
    /** Logo, Welle und Zeichen als Inline-Bilder (`cid:`) — mit den Signaturbildern mitsenden. */
    inlineImages: Array<{ cid: string; contentType: string; contentBase64: string }>;
}

const RED_TEXT = '#b10d12';
/** Der Leuchtstift (Textmarker-Gelb) und seine Kante. */
const HIGHLIGHT = '#fff34d';
const HIGHLIGHT_EDGE = '#f0c400';
const WORDS: Record<DocumentMailLang, { attachment: string; attachments: string; details: string; rubric: string; footer: string; locale: string }> = {
    de: { attachment: 'Anhang', attachments: 'Anhänge', details: 'Angaben', rubric: 'Dokumente', footer: 'Gesendet mit Offitec Control Center', locale: 'de-CH' },
    tr: { attachment: 'Ek', attachments: 'Ekler', details: 'Bilgiler', rubric: 'Belgeler', footer: 'Offitec Control Center ile gönderildi', locale: 'tr-TR' },
    en: { attachment: 'Attachment', attachments: 'Attachments', details: 'Details', rubric: 'Documents', footer: 'Sent with Offitec Control Center', locale: 'en-GB' },
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

    /* 30.09.2026 (Samet, mit dem Bild der Augustkarte: «bunun gibi olsun …
       tablolar renkli, sütunları ayrı renk, dalga aynı kalsın, premium»):
       dieselbe Karte wie die Terminmail (mailCardKit.ts) — Kopf mit dem
       Absender, Welle, das Beleg-Zeichen, die rote Stichzeile und der Titel,
       die Eckdaten und Listen als farbige Tabellen, danach der Brief. */
    const sections: string[] = [
        cardHeader(senderName, words.rubric),
        cardWave(),
        cardHero({
            icon: 'DOCUMENT',
            accent: BRAND_NAVY,
            kicker: input.eyebrow ?? null,
            kickerColor: BRAND_RED,
            title: input.heading,
            badge: input.badge?.text ? { text: input.badge.text, tone: input.badge.tone === 'info' ? 'navy' : 'red' } : null,
        }),
    ];
    const highlightText = input.highlight?.text?.trim() ?? '';
    const highlightRow = (top: boolean) => cardRow(`
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
                <td bgcolor="${HIGHLIGHT}" style="${CARD_FONT}background:${HIGHLIGHT};border-left:5px solid ${HIGHLIGHT_EDGE};border-radius:6px;padding:13px 16px;font-size:14px;line-height:21px;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:${CARD_INK};">${escapeMailHtml(highlightText.toLocaleUpperCase(WORDS[lang].locale))}</td>
            </tr></table>`, top ? 22 : 26);

    if (highlightText) sections.push(highlightRow(true));

    if (input.notice?.text?.trim()) {
        sections.push(cardNote(
            `${input.notice.title ? `<div style="font-weight:700;color:${RED_TEXT};">${escapeMailHtml(input.notice.title)}</div>` : ''}`
            + `<div style="margin-top:${input.notice.title ? 3 : 0}px;">${escapeMailHtml(input.notice.text.trim()).replace(/\r?\n/g, '<br />')}</div>`,
            'red',
            22,
        ));
    }

    if (facts.length) sections.push(cardTable(facts.map(([label, value]) => ({ label, value })), { title: words.details }));

    for (const group of groups) {
        sections.push(cardTable(group.rows.map(([label, value]) => ({ label, value })), { title: group.title }));
    }

    if (attachments.length) {
        sections.push(cardGrid({
            head: [{ text: attachments.length === 1 ? words.attachment : words.attachments, colspan: 3 }],
            rows: attachments.map((file) => [
                cardFileType(file.name),
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
        sections.push(cardButton(input.action.label, href, BRAND_NAVY));
        sections.push(cardRow(`<div style="font-size:12px;line-height:17px;color:${CARD_SUBTLE};word-break:break-all;">${escapeMailHtml(href)}</div>`, 10, true));
    }

    if (bodyHtml) sections.push(cardParagraphHtml(bodyHtml, 26));
    if (input.extraHtml) {
        sections.push(cardRow(`<div style="font-size:14px;line-height:22px;color:${CARD_INK};">${input.extraHtml}</div>`, 18));
    }
    if (highlightText) sections.push(highlightRow(false));

    if (input.signatureHtml) {
        sections.push(cardRow(`<div style="font-size:14px;line-height:21px;color:${CARD_INK};">${input.signatureHtml}</div>`, 14));
    }
    sections.push(cardEnd());

    const html = cardPage({
        lang,
        title: input.heading,
        preheader: input.preheader ?? input.heading,
        rows: sections,
        below: [senderName, words.footer],
        belowHtml: senderEmail
            ? `<a href="mailto:${escapeMailHtml(senderEmail)}" style="color:#a3abbd;text-decoration:none;">${escapeMailHtml(senderEmail)}</a>`
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

    return { html, text, inlineImages: mailInlineImages('DOCUMENT') };
};
