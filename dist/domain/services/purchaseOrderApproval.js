"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.missingApprovalFields = void 0;
const positive = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
};
const missingApprovalFields = (items) => {
    const gaps = [];
    items.forEach((item, index) => {
        const fields = [];
        if (!String(item?.name ?? '').trim())
            fields.push('productName');
        if (!positive(item?.quantity))
            fields.push('quantity');
        if (!positive(item?.grossPrice))
            fields.push('unitPrice');
        if (!positive(item?.netPrice))
            fields.push('netPrice');
        if (!positive(item?.lineTotal))
            fields.push('lineTotal');
        if (fields.length)
            gaps.push({ index, fields });
    });
    return gaps;
};
exports.missingApprovalFields = missingApprovalFields;
//# sourceMappingURL=purchaseOrderApproval.js.map