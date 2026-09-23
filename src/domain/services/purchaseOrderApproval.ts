/**
 * ── WAS EINE BESTELLUNG ZUR BESTÄTIGUNG BRAUCHT (19.09.2026, Vorgabe Samet) ─
 *
 * «Damit eine Bestellung bestätigt werden kann, müssen Produktname, Menge,
 *  Einzelpreis, Nettopreis und Zeilensumme ausgefüllt sein. Fehlt eines, wird
 *  die Bestätigung blockiert. Rabatt und Rabatt 2 sind keine Pflicht.»
 *
 * «Ausgefüllt» heisst bei den Zahlen: grösser als null. Eine gespeicherte
 * Zeile kennt kein leeres Zahlenfeld mehr, eine 0 steht dort, wo nichts
 * eingetragen war.
 *
 * ⚠ Frontend-Zwilling: `pages/inventory/utils/orderApproval.ts` — dort prüft
 *   die Maske dieselben Felder schon vor dem Absenden (dort zusätzlich, ob die
 *   Zelle des Einzelpreises selbst gefüllt ist).
 */

export type ApprovalField = 'productName' | 'quantity' | 'unitPrice' | 'netPrice' | 'lineTotal';

export interface ApprovalGap {
    /** Stelle der Zeile in `items`. */
    index: number;
    fields: ApprovalField[];
}

const positive = (value: unknown): boolean => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
};

export const missingApprovalFields = (items: Array<{
    name?: unknown;
    quantity?: unknown;
    grossPrice?: unknown;
    netPrice?: unknown;
    lineTotal?: unknown;
}>): ApprovalGap[] => {
    const gaps: ApprovalGap[] = [];
    items.forEach((item, index) => {
        const fields: ApprovalField[] = [];
        if (!String(item?.name ?? '').trim()) fields.push('productName');
        if (!positive(item?.quantity)) fields.push('quantity');
        if (!positive(item?.grossPrice)) fields.push('unitPrice');
        if (!positive(item?.netPrice)) fields.push('netPrice');
        if (!positive(item?.lineTotal)) fields.push('lineTotal');
        if (fields.length) gaps.push({ index, fields });
    });
    return gaps;
};
