import { localizePurchaseCode } from '../../shared/purchaseDocumentCode';
import {
    documentMailLang,
    renderDocumentMail,
    type DocumentMail,
    type DocumentMailAttachment,
    type DocumentMailLang,
} from './documentMailLayout';

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

const WORDS: Record<DocumentMailLang, {
    order: string;
    revisedOrder: string;
    priceRequest: string;
    revision: string;
    updated: string;
    positions: string;
    total: string;
    quote: string;
    project: string;
    projectNumber: string;
    orderedBy: string;
    contact: string;
    locale: string;
}> = {
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

export interface PurchaseOrderMailInput {
    order: {
        referenceNumber: string;
        revision?: number | null;
        emailSentAt?: Date | string | null;
        currency?: string | null;
        totalNet?: number | null;
        totalFees?: number | null;
        totalVat?: number | null;
        quoteNumber?: string | null;
        projectName?: string | null;
        orderedByName?: string | null;
        items?: string | null;
    };
    priceRequest: boolean;
    /** Sprache der Mail (Wörter der Karte) — die Sprache des Textes. */
    lang: unknown;
    /** Sprache des angehängten PDF — sein Code (BE-/SP-/PO-) steht in der Überschrift. */
    documentLang: unknown;
    /** Die Revision, die das angehängte PDF trägt (BOM); 0/null = keine. */
    revision: unknown;
    /** Das zugeordnete Produktionsprojekt (uretim_siparis_atamalari) — Nummer getrennt von der Kommission. */
    project?: { number: string; name: string } | null;
    message: string;
    attachments: DocumentMailAttachment[];
    senderName: string;
    senderEmail: string;
    signatureHtml: string;
}

/**
 * Die Kommission: der Freitext des Belegs — nur der Projektname, wenn der Text
 * mit der Projektnummer beginnt (ältere Belege: «PR-… · Name — Gerät (BOM)»);
 * ohne Text der Projektname. Dieselbe Regel wie `utils/purchaseProject.ts` im PDF.
 */
const commissionOf = (typed: string | null | undefined, project: { number: string; name: string } | null | undefined): string => {
    const text = String(typed ?? '').replace(/\s+/g, ' ').trim();
    const name = String(project?.name ?? '').trim();
    if (project?.number && name && text.startsWith(project.number)) return name;
    return text || name;
};

const positionsOf = (items: string | null | undefined): number => {
    try {
        const parsed = JSON.parse(items || '[]');
        if (!Array.isArray(parsed)) return 0;
        return parsed.filter((item) => String(item?.name ?? '').trim() || String(item?.code ?? '').trim()).length;
    } catch {
        return 0;
    }
};

export const buildPurchaseOrderMail = (input: PurchaseOrderMailInput): DocumentMail => {
    const lang = documentMailLang(input.lang);
    const words = WORDS[lang];
    const code = localizePurchaseCode(input.order.referenceNumber, documentMailLang(input.documentLang));
    const revisionNumber = Number(input.revision);
    const revision = !input.priceRequest && Number.isInteger(revisionNumber) && revisionNumber > 0 ? revisionNumber : 0;
    const updated = !input.priceRequest && !revision && Number(input.order.revision) > 0 && Boolean(input.order.emailSentAt);
    const kind = input.priceRequest ? words.priceRequest : revision ? words.revisedOrder : words.order;

    const positions = positionsOf(input.order.items);
    const total = (Number(input.order.totalNet) || 0) + (Number(input.order.totalFees) || 0) + (Number(input.order.totalVat) || 0);
    const amount = !input.priceRequest && total > 0
        ? `${(input.order.currency || 'CHF').toUpperCase()} ${new Intl.NumberFormat(words.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(total)}`
        : '';

    return renderDocumentMail({
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
