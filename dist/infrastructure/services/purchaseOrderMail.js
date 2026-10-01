"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPurchaseOrderMail = void 0;
const purchaseDocumentCode_1 = require("../../shared/purchaseDocumentCode");
const documentMailLayout_1 = require("./documentMailLayout");
/**
 * DIE MAIL ZUR BESTELLUNG / PREISANFRAGE (29.09.2026) — in der Belegkarte
 * (`documentMailLayout.ts`): rote Versalzeile mit der Belegart, als Überschrift
 * der Code, wie ihn das angehängte PDF trägt, die Eckdaten mit denselben Wörtern
 * wie das PDF (Kommission · Ihre Offerte · Besteller).
 *
 * Revision (Samet: «revize olmuşsa … tedarikçi bilgilendirilecek ve e-postası
 * otomatik güncel revize şeklinde yazacak»): trägt das PDF eine Revision (BOM,
 * `revision` > 0), heisst die Zeile «Geänderte Bestellung» und die Überschrift
 * bekommt die Kapsel «Revision n» — dieselbe Nummer wie im PDF. Wurde eine
 * Bestellung sonst nach dem Versand geändert (`order.revision` > 0), steht die
 * leise Kapsel «Aktualisiert». Den Text selbst schreibt die Oberfläche.
 */
const WORDS = {
    de: {
        order: 'Bestellung',
        revisedOrder: 'Geänderte Bestellung',
        priceRequest: 'Preisanfrage',
        revision: 'Revision',
        updated: 'Aktualisiert',
        positions: 'Positionen',
        total: 'Gesamtbetrag',
        quote: 'Ihre Offerte',
        project: 'Kommission',
        projectNumber: 'Projekt-Nr.',
        orderedBy: 'Besteller',
        contact: 'Ansprechpartner',
        locale: 'de-CH',
    },
    tr: {
        order: 'Sipariş',
        revisedOrder: 'Revize sipariş',
        priceRequest: 'Fiyat talebi',
        revision: 'Revizyon',
        updated: 'Güncellendi',
        positions: 'Pozisyon',
        total: 'Toplam tutar',
        quote: 'Teklif numaranız',
        project: 'Komisyon',
        projectNumber: 'Proje no.',
        orderedBy: 'Sipariş veren',
        contact: 'İlgili kişi',
        locale: 'tr-TR',
    },
    en: {
        order: 'Purchase order',
        revisedOrder: 'Revised purchase order',
        priceRequest: 'Price request',
        revision: 'Revision',
        updated: 'Updated',
        positions: 'Items',
        total: 'Total amount',
        quote: 'Your quotation',
        project: 'Commission',
        projectNumber: 'Project no.',
        orderedBy: 'Ordered by',
        contact: 'Contact',
        locale: 'en-GB',
    },
};
/**
 * Die Kommission: der Freitext des Belegs — nur der Projektname, wenn der Text
 * mit der Projektnummer beginnt (ältere Belege: «PR-… · Name — Gerät (BOM)»);
 * ohne Text der Projektname. Dieselbe Regel wie `utils/purchaseProject.ts` im PDF.
 */
const commissionOf = (typed, project) => {
    const text = String(typed ?? '').replace(/\s+/g, ' ').trim();
    const name = String(project?.name ?? '').trim();
    if (project?.number && name && text.startsWith(project.number))
        return name;
    return text || name;
};
const positionsOf = (items) => {
    try {
        const parsed = JSON.parse(items || '[]');
        if (!Array.isArray(parsed))
            return 0;
        return parsed.filter((item) => String(item?.name ?? '').trim() || String(item?.code ?? '').trim()).length;
    }
    catch {
        return 0;
    }
};
const buildPurchaseOrderMail = (input) => {
    const lang = (0, documentMailLayout_1.documentMailLang)(input.lang);
    const words = WORDS[lang];
    const code = (0, purchaseDocumentCode_1.localizePurchaseCode)(input.order.referenceNumber, (0, documentMailLayout_1.documentMailLang)(input.documentLang));
    const revisionNumber = Number(input.revision);
    const revision = !input.priceRequest && Number.isInteger(revisionNumber) && revisionNumber > 0 ? revisionNumber : 0;
    const updated = !input.priceRequest && !revision && Number(input.order.revision) > 0 && Boolean(input.order.emailSentAt);
    const kind = input.priceRequest ? words.priceRequest : revision ? words.revisedOrder : words.order;
    const positions = positionsOf(input.order.items);
    const total = (Number(input.order.totalNet) || 0) + (Number(input.order.totalFees) || 0) + (Number(input.order.totalVat) || 0);
    const amount = !input.priceRequest && total > 0
        ? `${(input.order.currency || 'CHF').toUpperCase()} ${new Intl.NumberFormat(words.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(total)}`
        : '';
    return (0, documentMailLayout_1.renderDocumentMail)({
        lang,
        senderName: input.senderName,
        senderEmail: input.senderEmail,
        eyebrow: kind,
        heading: code,
        badge: revision
            ? { text: `${words.revision} ${revision}`, tone: 'revision' }
            : updated ? { text: words.updated, tone: 'info' } : null,
        message: input.message,
        facts: [
            [words.positions, positions > 0 ? String(positions) : ''],
            [words.total, amount],
            // Projektnummer STATT Kommission (29.09.2026 abends, Samet: «komisyon yazmasın, proje numarası yazsın»);
            // nur ein Beleg ohne Projekt trägt noch seine frei geschriebene Kommission.
            input.project?.number
                ? [words.projectNumber, input.project.number]
                : [words.project, commissionOf(input.order.projectName, null)],
            [words.quote, input.order.quoteNumber],
            [input.priceRequest ? words.contact : words.orderedBy, input.order.orderedByName],
        ],
        attachments: input.attachments,
        signatureHtml: input.signatureHtml,
        preheader: `${kind} ${code}${revision ? ` · ${words.revision} ${revision}` : ''} · ${input.senderName}`,
    });
};
exports.buildPurchaseOrderMail = buildPurchaseOrderMail;
//# sourceMappingURL=purchaseOrderMail.js.map