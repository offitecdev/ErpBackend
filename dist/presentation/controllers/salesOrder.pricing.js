"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderTotal = exports.DEFAULT_VAT = void 0;
// Default VAT rate mirroring the frontend fallback (pdfSettings.vatRate ?? 8.1)
// used when a line carries no explicit taxRate.
exports.DEFAULT_VAT = 8.1;
// Final order amount (Bestellsumme) matching the tender's offer summary: each
// product line's net (after its line discount) grossed up by its VAT rate, then
// the whole sum reduced by the document-level discounts — directDiscount first,
// extraDiscount SEQUENTIALLY on its result (100 → -20% → 80 → -10% → 72).
// Mirrors the frontend computeTenderPricingSummary().grossTotal so the stored
// total equals the "total incl. VAT" shown on the offer — not the bare net sum.
const orderTotal = (positions, directDiscount = 0, extraDiscount = 0) => {
    const grossBeforeDirectDiscount = positions.reduce((sum, position) => {
        const quantity = Number(position.quantity || 0);
        const unitPrice = position.unitPrice == null ? null : Number(position.unitPrice);
        const discount = Number(position.discount || 0);
        const net = unitPrice != null && quantity > 0
            ? quantity * unitPrice * (1 - discount / 100)
            : Math.max(0, Number(position.calculation?.totalCalculatedPrice || 0));
        const taxRate = Number(position.taxRate || exports.DEFAULT_VAT);
        return sum + net * (1 + taxRate / 100);
    }, 0);
    const clampFactor = (value) => 1 - Math.min(100, Math.max(0, Number(value || 0))) / 100;
    return grossBeforeDirectDiscount * clampFactor(directDiscount) * clampFactor(extraDiscount);
};
exports.orderTotal = orderTotal;
//# sourceMappingURL=salesOrder.pricing.js.map