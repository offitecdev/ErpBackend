import type { DocumentMailLang } from './documentMailLayout';

/**
 * DIE WÖRTER DER BELEGMAILS (29.09.2026) — Versalzeilen, Eckdaten und Knöpfe
 * der Karte (`documentMailLayout.ts`) in den drei Sprachen der OCC. Der Text
 * selbst kommt vom Benutzer; hier steht nur, was die Karte drumherum sagt.
 * Schweizer Wortwahl: «Rapport», nie «Bericht».
 */
const WORDS = {
    de: {
        offer: 'Offerte',
        orderConfirmation: 'Auftragsbestätigung',
        installation: 'Montagetermin',
        fieldReport: 'Rapport',
        maintenance: 'Wartungstermin',
        maintenanceReport: 'Wartungsrapport',
        signature: 'Unterschrift',
        supplyRequest: 'Bedarfsanfrage',
        quote: 'Offerte',
        commission: 'Kommission',
        reference: 'Referenz',
        date: 'Datum',
        validUntil: 'Gültig bis',
        quantity: 'Menge',
        articleCode: 'Artikelnummer',
        plannedDates: 'Geplante Termine',
        proposedDates: 'Vorgeschlagene Termine',
        chooseTime: 'Termin wählen',
        viewReport: 'Rapport ansehen',
        viewAndSign: 'Rapport ansehen und unterschreiben',
        locale: 'de-CH',
    },
    tr: {
        offer: 'Teklif',
        orderConfirmation: 'Sipariş onayı',
        installation: 'Montaj randevusu',
        fieldReport: 'Saha raporu',
        maintenance: 'Bakım randevusu',
        maintenanceReport: 'Bakım raporu',
        signature: 'İmza talebi',
        supplyRequest: 'Tedarik talebi',
        quote: 'Teklif',
        commission: 'Komisyon',
        reference: 'Referans',
        date: 'Tarih',
        validUntil: 'Geçerlilik',
        quantity: 'Miktar',
        articleCode: 'Ürün kodu',
        plannedDates: 'Planlanan tarih ve saatler',
        proposedDates: 'Önerilen saatler',
        chooseTime: 'Randevu saatini seç',
        viewReport: 'Raporu görüntüle',
        viewAndSign: 'Raporu görüntüle ve imzala',
        locale: 'tr-TR',
    },
    en: {
        offer: 'Quotation',
        orderConfirmation: 'Order confirmation',
        installation: 'Installation appointment',
        fieldReport: 'Field report',
        maintenance: 'Maintenance appointment',
        maintenanceReport: 'Maintenance report',
        signature: 'Signature request',
        supplyRequest: 'Supply request',
        quote: 'Quotation',
        commission: 'Commission',
        reference: 'Reference',
        date: 'Date',
        validUntil: 'Valid until',
        quantity: 'Quantity',
        articleCode: 'Item code',
        plannedDates: 'Planned dates',
        proposedDates: 'Proposed times',
        chooseTime: 'Choose a time',
        viewReport: 'View report',
        viewAndSign: 'View and sign the report',
        locale: 'en-GB',
    },
} satisfies Record<DocumentMailLang, Record<string, string>>;

export type DocumentMailWords = (typeof WORDS)['de'];

export const documentMailWords = (lang: DocumentMailLang): DocumentMailWords => WORDS[lang];

/** Die Zeitzone der Termine — die Kunden sitzen in der Schweiz, der Server läuft in UTC. */
const TZ = 'Europe/Zurich';

/** «Mo., 12.10.2026» — ein Datum in der Sprache der Mail. */
export const mailDate = (value: Date | string | null | undefined, lang: DocumentMailLang): string => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(WORDS[lang].locale, { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
};

/** Ein Termin als Zeile der Liste: [«Mo., 12.10.2026», «08:00 – 17:00»]. */
export const mailDateRange = (start: Date | string, end: Date | string, lang: DocumentMailLang): [string, string] => {
    const from = new Date(start);
    const to = new Date(end);
    const locale = WORDS[lang].locale;
    const day = new Intl.DateTimeFormat(locale, { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }).format(from);
    const time = new Intl.DateTimeFormat(locale, { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    return [day, `${time.format(from)} – ${time.format(to)}`];
};
