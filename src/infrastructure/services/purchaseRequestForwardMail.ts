import { localizePurchaseCode } from '../../shared/purchaseDocumentCode';
import {
    documentMailLang,
    renderDocumentMail,
    type DocumentMail,
    type DocumentMailAttachment,
    type DocumentMailLang,
} from './documentMailLayout';
import { mailDate } from './documentMailWords';

/**
 * ── FİYAT TALEBİ → SATIN ALMA (29.09.2026, Vorgabe Samet) ────────────────────
 *
 *   «Diğerlerinin de mail ve PDF gönderme şansı olacak … mail OCC kalitesindeki
 *    mailler gibi olması lazım, yani mail gönderecek ve orada fiyat talebinin
 *    linki olacak … talebin kimden geldiği de üstte yazacak.»
 *
 * Die INTERNE Mail: eine Person ohne Einkaufsrolle schickt ihre Preisanfrage an
 * den Einkauf (Purser) und die Administration — nicht an einen Lieferanten.
 * Dieselbe Belegkarte wie jede OCC-Mail (`documentMailLayout.ts`): rote Zeile
 * «Neue Preisanfrage», der Code als Überschrift, als ERSTE Zeile der Eckdaten
 * wer anfragt, dann Positionen und Projekt, das PDF als Kachel, der Knopf
 * «Preisanfrage öffnen» (der Link in die OCC) und darunter der Text der Person.
 * Keine Signatur des Mandanten — die Post geht im Haus.
 */

const WORDS: Record<DocumentMailLang, {
    eyebrow: string;
    requestedBy: string;
    positions: string;
    projectNumber: string;
    commission: string;
    created: string;
    open: string;
    preheader: string;
}> = {
    de: {
        eyebrow: 'Neue Preisanfrage',
        requestedBy: 'Angefragt von',
        positions: 'Positionen',
        projectNumber: 'Projekt-Nr.',
        commission: 'Kommission',
        created: 'Erstellt am',
        open: 'Preisanfrage öffnen',
        preheader: '{name} hat eine Preisanfrage an den Einkauf gesendet',
    },
    tr: {
        eyebrow: 'Yeni fiyat talebi',
        requestedBy: 'Talep eden',
        positions: 'Pozisyon',
        projectNumber: 'Proje no.',
        commission: 'Komisyon',
        created: 'Oluşturulma',
        open: 'Fiyat talebini aç',
        preheader: '{name} satın almaya bir fiyat talebi gönderdi',
    },
    en: {
        eyebrow: 'New price request',
        requestedBy: 'Requested by',
        positions: 'Items',
        projectNumber: 'Project no.',
        commission: 'Commission',
        created: 'Created',
        open: 'Open price request',
        preheader: '{name} sent a price request to purchasing',
    },
};

export interface PurchaseRequestForwardMailInput {
    order: {
        referenceNumber: string;
        projectName?: string | null;
        items?: string | null;
        createdAt?: Date | string | null;
    };
    /** Sprache der Karte — die Oberfläche der sendenden Person. */
    lang: unknown;
    /** Das zugeordnete Produktionsprojekt — seine Nummer steht statt der Kommission. */
    project?: { number: string; name: string } | null;
    /** Wer die Anfrage an den Einkauf schickt. */
    requesterName: string;
    message: string;
    attachments: DocumentMailAttachment[];
    /** Der Weg zur Anfrage in der OCC (http/https). */
    link: string;
    senderName: string;
    senderEmail: string;
}

const positionsOf = (items: string | null | undefined): number => {
    try {
        const parsed = JSON.parse(items || '[]');
        if (!Array.isArray(parsed)) return 0;
        return parsed.filter((item) => String(item?.name ?? '').trim() || String(item?.code ?? '').trim()).length;
    } catch {
        return 0;
    }
};

export const buildPurchaseRequestForwardMail = (input: PurchaseRequestForwardMailInput): DocumentMail => {
    const lang = documentMailLang(input.lang);
    const words = WORDS[lang];
    // Der Code in der Sprache der Karte (FT-/PA-/PR-) — wie die Liste der lesenden Person.
    const code = localizePurchaseCode(input.order.referenceNumber, lang);
    const positions = positionsOf(input.order.items);
    const commission = String(input.order.projectName ?? '').replace(/\s+/g, ' ').trim();
    const requester = input.requesterName.trim();

    return renderDocumentMail({
        lang,
        senderName: input.senderName,
        senderEmail: input.senderEmail,
        eyebrow: words.eyebrow,
        heading: code,
        message: input.message,
        facts: [
            // «Talebin kimden geldiği üstte yazacak» — die erste Zeile.
            [words.requestedBy, requester],
            [words.positions, positions > 0 ? String(positions) : ''],
            input.project?.number
                ? [words.projectNumber, input.project.number]
                : [words.commission, commission],
            [words.created, mailDate(input.order.createdAt ?? null, lang)],
        ],
        attachments: input.attachments,
        action: { label: words.open, href: input.link },
        preheader: `${code} · ${words.preheader.replace('{name}', requester || input.senderName)}`,
    });
};
