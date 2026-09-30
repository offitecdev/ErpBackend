import { localizePurchaseCode } from '../../shared/purchaseDocumentCode';
import { renderDocumentMail, type DocumentMail, type DocumentMailLang } from './documentMailLayout';

/**
 * ── DIE MAILS DER AUTOMATIK (30.09.2026, Vorgabe Samet) ────────────────────
 *
 * «Onayla ve gönder deyince bizim de Adobe gibi güzel tasarımlı, temiz bir
 *  şekilde anlattığımız bir mail gitmesi gerekiyor, biraz uzun bir mail
 *  olabilir … fiyat taleplerinde üste ve alta sarı fosforlu ile: lütfen fiyat
 *  teklifinizi bu mailin altına [yanıt olarak] gönderiniz, başka bir mail
 *  olarak göndermeyiniz — büyük harflerle.»
 *
 * Drei Mails in der Belegkarte (documentMailLayout): Preisanfrage (mit dem
 * gelben Band oben und unten — die Antwort muss an DIESER Mail hängen, sonst
 * findet der Abruf sie nicht), Bestellung, geänderte Bestellung (Revision).
 * Sprache = Sprache des PDF («pdf de hangi dildeyse … e postaya da o dille»).
 */

export type ProcurementMailType = 'RFQ' | 'ORDER' | 'REVISION';

export interface ProcurementMailFacts {
    type: ProcurementMailType;
    lang: DocumentMailLang;
    /** Gespeicherter Code (PA-/BE-) — gedruckt in der Sprache des Belegs. */
    code: string;
    projectNumber: string | null;
    projectName: string | null;
    quoteNumber: string | null;
    recipientName: string | null;
    orderedByName: string | null;
    currency: string;
    /** Brutto (mit MwSt., Zuschlägen) — nur Bestellungen. */
    total: number;
    revision: number;
    /** Datum der ersten Sendung (Revision: «ersetzt unsere Bestellung vom …»). */
    firstSentAt: Date | null;
    lines: Array<{ name: string; quantity: number; unit: string | null; lineTotal: number | null }>;
    senderName: string;
    senderEmail: string;
    companyName: string;
    attachment: { name: string; bytes: number };
}

const LINES_SHOWN = 12;

const W = {
    de: {
        rfq: 'Preisanfrage', order: 'Bestellung', revision: 'Geänderte Bestellung', revisionBadge: 'Revision',
        highlight: 'Bitte senden Sie Ihr Angebot als Antwort auf diese E-Mail – nicht als neue, separate E-Mail.',
        requestNo: 'Anfrage-Nr.', orderNo: 'Bestell-Nr.', project: 'Projekt-Nr.', positions: 'Positionen', quote: 'Ihre Offerte',
        total: 'Gesamtbetrag', contact: 'Ansprechpartner', orderedBy: 'Besteller', replyTo: 'Antwort an',
        askedLines: 'Angefragte Positionen', orderedLines: 'Bestellte Positionen', more: (n: number) => `… und ${n} weitere Positionen im PDF`,
        noticeTitle: 'Diese Fassung ersetzt die bisherige Bestellung',
        notice: (code: string, date: string) => `Revision der Bestellung ${code}${date ? ` vom ${date}` : ''}. Die Änderungen stehen im beigefügten PDF unter «Änderungen».`,
        hello: (name: string | null) => (name ? `Guten Tag ${name}` : 'Guten Tag'),
        locale: 'de-CH',
    },
    tr: {
        rfq: 'Fiyat talebi', order: 'Sipariş', revision: 'Revize sipariş', revisionBadge: 'Revizyon',
        highlight: 'Lütfen fiyat teklifinizi bu e-postaya yanıt olarak gönderiniz – ayrı, yeni bir e-posta olarak göndermeyiniz.',
        requestNo: 'Talep no.', orderNo: 'Sipariş no.', project: 'Proje no.', positions: 'Kalem', quote: 'Teklif numaranız',
        total: 'Toplam tutar', contact: 'İlgili kişi', orderedBy: 'Sipariş veren', replyTo: 'Yanıt adresi',
        askedLines: 'Talep edilen kalemler', orderedLines: 'Sipariş edilen kalemler', more: (n: number) => `… ve PDF'te ${n} kalem daha`,
        noticeTitle: 'Bu sürüm önceki siparişin yerine geçer',
        notice: (code: string, date: string) => `${code} numaralı siparişin revizyonu${date ? ` (ilk gönderim ${date})` : ''}. Değişiklikler ekteki PDF'te «Değişiklikler» bölümündedir.`,
        hello: (name: string | null) => (name ? `Merhaba ${name},` : 'Merhaba,'),
        locale: 'tr-TR',
    },
    en: {
        rfq: 'Request for quotation', order: 'Purchase order', revision: 'Revised purchase order', revisionBadge: 'Revision',
        highlight: 'Please send your quotation as a reply to this e-mail – not as a new, separate e-mail.',
        requestNo: 'Request no.', orderNo: 'Order no.', project: 'Project no.', positions: 'Items', quote: 'Your quotation',
        total: 'Total amount', contact: 'Contact', orderedBy: 'Ordered by', replyTo: 'Reply to',
        askedLines: 'Requested items', orderedLines: 'Ordered items', more: (n: number) => `… and ${n} more items in the PDF`,
        noticeTitle: 'This version replaces our previous order',
        notice: (code: string, date: string) => `Revision of purchase order ${code}${date ? ` dated ${date}` : ''}. The changes are listed in the attached PDF under «Changes».`,
        hello: (name: string | null) => (name ? `Dear ${name},` : 'Dear Sir or Madam,'),
        locale: 'en-GB',
    },
} as const;

const qtyText = (value: number, unit: string | null, locale: string): string =>
    `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value)}${unit ? ` ${unit}` : ''}`;

const money = (value: number, currency: string, locale: string): string =>
    `${currency} ${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;

const dateText = (date: Date | null, locale: string): string =>
    (date ? new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Zurich' }).format(date) : '');

/** Der Brief — lang und freundlich, wie Samet es wollte; Absätze durch Leerzeilen. */
const letterOf = (facts: ProcurementMailFacts, code: string): string => {
    const project = facts.projectNumber;
    const quote = facts.quoteNumber?.trim() || '';
    const sign = [facts.senderName, facts.companyName].filter((part, index, all) => part && all.indexOf(part) === index).join('\n');
    if (facts.lang === 'tr') {
        if (facts.type === 'RFQ') {
            return [
                W.tr.hello(null),
                `Ekteki PDF'te yer alan kalemler için fiyat teklifinizi rica ederiz (fiyat talebi ${code}${project ? `, proje ${project}` : ''}).`,
                'Teklifinizde lütfen şunları belirtiniz:\n• her kalem için birim fiyat ve satır tutarı (net, KDV hariç)\n• varsa indirimler, nakliye ve ambalaj masrafları\n• teslim süresi veya en erken teslim tarihi\n• teklifin geçerlilik süresi ve ödeme koşullarınız',
                'Teklifinizi PDF olarak doğrudan BU E-POSTAYA YANIT olarak gönderiniz. Sistemimiz yanıtınızı bu taleple otomatik olarak eşleştirir; ayrı bir e-posta eşleştirilemez ve gecikmeye yol açar.',
                `Lütfen teklifinizde talep numaramızı ${code}${project ? ` ve proje numaramızı ${project}` : ''} belirtiniz. Bu talep bağlayıcı değildir; sipariş ayrıca verilecektir.`,
                'Desteğiniz için şimdiden teşekkür eder, teklifinizi bekleriz.',
                `Saygılarımızla\n${sign}`,
            ].join('\n\n');
        }
        if (facts.type === 'REVISION') {
            return [
                W.tr.hello(facts.recipientName),
                `${code} numaralı siparişimizde değişiklik oldu. Ekte güncel sürümü (Revizyon ${facts.revision}) bulabilirsiniz; bu sürüm önceki siparişin tamamen yerine geçer. Değişiklikler PDF'te «Değişiklikler» bölümünde tek tek listelenmiştir.`,
                'Revize siparişi lütfen bu e-postaya yanıt vererek onaylayınız ve teslim tarihinde bir değişiklik olup olmadığını bildiriniz.',
                'Anlayışınız için teşekkür ederiz.',
                `Saygılarımızla\n${sign}`,
            ].join('\n\n');
        }
        return [
            W.tr.hello(facts.recipientName),
            `${quote ? `${quote} numaralı teklifiniz` : 'Teklifiniz'} için teşekkür ederiz. Ekteki PDF'te yer alan kalemleri teklifiniz doğrultusunda sipariş ediyoruz (sipariş ${code}${project ? `, proje ${project}` : ''}).`,
            `Sizden ricamız:\n• siparişin alındığını yazılı bir sipariş onayı ile — lütfen bu e-postaya yanıt olarak — bildirmeniz\n• bağlayıcı teslim tarihini iletmeniz\n• fiyat, miktar, model veya teslim tarihinde bir sapma varsa sevkiyattan önce haber vermeniz\n• irsaliye ve faturada sipariş numaramızı ${code}${project ? ` ve proje numaramızı ${project}` : ''} belirtmeniz`,
            'Genel satın alma koşullarımız geçerlidir: offitec.ch/agb',
            'İyi iş birliğiniz için teşekkür ederiz.',
            `Saygılarımızla\n${sign}`,
        ].join('\n\n');
    }
    if (facts.lang === 'en') {
        if (facts.type === 'RFQ') {
            return [
                W.en.hello(null),
                `We kindly ask you for a quotation for the items listed in the attached PDF (request ${code}${project ? `, project ${project}` : ''}).`,
                'Please state in your quotation:\n• the unit price and the line total of every item (net, excluding VAT)\n• any discounts as well as freight and packaging costs\n• the delivery time or the earliest possible delivery date\n• how long your offer is valid and your payment terms',
                'Please send your quotation as a PDF directly AS A REPLY TO THIS E-MAIL. Our system matches your reply to this request automatically; a separate e-mail cannot be matched and causes delays.',
                `Please quote our request number ${code}${project ? ` and our project number ${project}` : ''} in your offer. This request is non-binding; an order will be placed separately.`,
                'Thank you in advance for your support — we look forward to your offer.',
                `Kind regards\n${sign}`,
            ].join('\n\n');
        }
        if (facts.type === 'REVISION') {
            return [
                W.en.hello(facts.recipientName),
                `Our purchase order ${code} has changed. Attached you will find the updated version (revision ${facts.revision}); it fully replaces the previous order. Every change is listed in the PDF under «Changes».`,
                'Please confirm the revised order by replying to this e-mail and let us know whether the delivery date is affected.',
                'Thank you for your understanding.',
                `Kind regards\n${sign}`,
            ].join('\n\n');
        }
        return [
            W.en.hello(facts.recipientName),
            `Thank you for your quotation${quote ? ` ${quote}` : ''}. We are pleased to order the items listed in the attached PDF according to your offer (purchase order ${code}${project ? `, project ${project}` : ''}).`,
            `We kindly ask you to:\n• confirm this order in writing with an order confirmation — please as a reply to this e-mail\n• let us know the binding delivery date\n• inform us before delivery about any deviation in price, quantity, specification or delivery date\n• quote our order number ${code}${project ? ` and our project number ${project}` : ''} on the delivery note and the invoice`,
            'Our general terms and conditions apply: offitec.ch/agb',
            'Thank you for the good cooperation.',
            `Kind regards\n${sign}`,
        ].join('\n\n');
    }
    if (facts.type === 'RFQ') {
        return [
            W.de.hello(null),
            `Wir bitten Sie um ein Angebot für die im beigefügten PDF aufgeführten Positionen (Preisanfrage ${code}${project ? `, Projekt ${project}` : ''}).`,
            'Bitte nennen Sie uns in Ihrem Angebot:\n• den Einzelpreis und den Positionsbetrag je Position (netto, ohne MwSt.)\n• allfällige Rabatte sowie Fracht- und Verpackungskosten\n• die Lieferzeit bzw. den frühestmöglichen Liefertermin\n• die Gültigkeit Ihres Angebots und Ihre Zahlungsbedingungen',
            'Bitte senden Sie Ihr Angebot als PDF direkt ALS ANTWORT AUF DIESE E-MAIL. Unser System ordnet Ihre Antwort automatisch dieser Anfrage zu; eine separate E-Mail kann nicht zugeordnet werden und führt zu Verzögerungen.',
            `Bitte vermerken Sie in Ihrem Angebot unsere Anfragenummer ${code}${project ? ` sowie die Projektnummer ${project}` : ''}. Diese Anfrage ist unverbindlich; eine Bestellung erfolgt separat.`,
            'Vielen Dank im Voraus für Ihre Unterstützung — wir freuen uns auf Ihr Angebot.',
            `Freundliche Grüsse\n${sign}`,
        ].join('\n\n');
    }
    if (facts.type === 'REVISION') {
        return [
            W.de.hello(facts.recipientName),
            `Unsere Bestellung ${code} hat sich geändert. Im Anhang finden Sie die aktualisierte Fassung (Revision ${facts.revision}); sie ersetzt die bisherige Bestellung vollständig. Jede Änderung ist im PDF unter «Änderungen» aufgeführt.`,
            'Bitte bestätigen Sie uns die geänderte Bestellung als Antwort auf diese E-Mail und teilen Sie uns mit, ob sich dadurch am Liefertermin etwas ändert.',
            'Vielen Dank für Ihr Verständnis.',
            `Freundliche Grüsse\n${sign}`,
        ].join('\n\n');
    }
    return [
        W.de.hello(facts.recipientName),
        `Vielen Dank für Ihr Angebot${quote ? ` ${quote}` : ''}. Gerne bestellen wir die im beigefügten PDF aufgeführten Positionen gemäss Ihrem Angebot (Bestellung ${code}${project ? `, Projekt ${project}` : ''}).`,
        `Wir bitten Sie:\n• den Eingang dieser Bestellung mit einer schriftlichen Auftragsbestätigung zu bestätigen — bitte als Antwort auf diese E-Mail\n• uns den verbindlichen Liefertermin mitzuteilen\n• Abweichungen bei Preis, Menge, Ausführung oder Liefertermin vor der Auslieferung zu melden\n• auf Lieferschein und Rechnung unsere Bestellnummer ${code}${project ? ` sowie die Projektnummer ${project}` : ''} anzugeben`,
        'Es gelten unsere Allgemeinen Einkaufsbedingungen: offitec.ch/agb',
        'Vielen Dank für die gute Zusammenarbeit.',
        `Freundliche Grüsse\n${sign}`,
    ].join('\n\n');
};

/** Der Betreff — mit dem Code in der Sprache des PDF (der Abruf erkennt ihn auch dort). */
export const procurementMailSubject = (facts: Pick<ProcurementMailFacts, 'type' | 'lang' | 'code' | 'projectNumber' | 'revision' | 'companyName'>): string => {
    const words = W[facts.lang];
    const code = localizePurchaseCode(facts.code, facts.lang);
    const kind = facts.type === 'RFQ' ? words.rfq : facts.type === 'REVISION' ? words.revision : words.order;
    return [
        `${kind} ${code}${facts.type === 'REVISION' ? ` · ${words.revisionBadge} ${facts.revision}` : ''}`,
        facts.projectNumber ? `${words.project} ${facts.projectNumber}` : null,
        facts.companyName || null,
    ].filter(Boolean).join(' · ').slice(0, 200);
};

export const buildProcurementMail = (facts: ProcurementMailFacts): DocumentMail => {
    const words = W[facts.lang];
    const code = localizePurchaseCode(facts.code, facts.lang);
    const rfq = facts.type === 'RFQ';
    const kind = rfq ? words.rfq : facts.type === 'REVISION' ? words.revision : words.order;
    const shown = facts.lines.slice(0, LINES_SHOWN);
    const rows: Array<[string, string]> = shown.map((line) => [
        line.name,
        [qtyText(line.quantity, line.unit, words.locale), !rfq && line.lineTotal && line.lineTotal > 0 ? money(line.lineTotal, facts.currency, words.locale) : null]
            .filter(Boolean).join(' · '),
    ]);
    if (facts.lines.length > shown.length) rows.push([words.more(facts.lines.length - shown.length), '']);

    return renderDocumentMail({
        lang: facts.lang,
        senderName: facts.companyName || facts.senderName,
        senderEmail: facts.senderEmail,
        eyebrow: kind,
        heading: code,
        badge: facts.type === 'REVISION' ? { text: `${words.revisionBadge} ${facts.revision}`, tone: 'revision' } : null,
        highlight: rfq ? { text: words.highlight } : null,
        notice: facts.type === 'REVISION'
            ? { title: words.noticeTitle, text: words.notice(code, dateText(facts.firstSentAt, words.locale)) }
            : null,
        facts: [
            [rfq ? words.requestNo : words.orderNo, code],
            [words.project, facts.projectNumber],
            [words.quote, rfq ? null : facts.quoteNumber],
            [words.positions, facts.lines.length ? String(facts.lines.length) : null],
            [words.total, !rfq && facts.total > 0 ? money(facts.total, facts.currency, words.locale) : null],
            [rfq ? words.contact : words.orderedBy, facts.orderedByName],
            [words.replyTo, facts.senderEmail],
        ],
        groups: rows.length ? [{ title: rfq ? words.askedLines : words.orderedLines, rows }] : [],
        attachments: [facts.attachment],
        message: letterOf(facts, code),
        preheader: `${kind} ${code}${facts.projectNumber ? ` · ${words.project} ${facts.projectNumber}` : ''} · ${facts.companyName || facts.senderName}`,
    });
};
