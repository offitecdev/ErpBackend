"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signedAfterDiscounts = void 0;
exports.normalizeAddonLines = normalizeAddonLines;
exports.priceAddonProduct = priceAddonProduct;
exports.readAddonLineMetadata = readAddonLineMetadata;
const tender_discounts_1 = require("../../presentation/controllers/tender.discounts");
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const number = (value, label) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0)
        throw new Error(`${label} ungültig.`);
    return parsed;
};
/**
 * Rabatte mit Vorzeichen (16.09.2026): `remainingAfterDiscounts` kennt nur
 * Beträge ≥ 0 und machte aus einer Minderung still 0. Eine Minuszeile bzw.
 * eine Minussumme wird über ihren Betrag rabattiert und behält ihr Vorzeichen —
 * eine Minderung einer rabattierten Leistung ist genauso rabattiert.
 */
const signedAfterDiscounts = (base, discounts) => base < 0 ? -(0, tender_discounts_1.remainingAfterDiscounts)(-base, discounts) : (0, tender_discounts_1.remainingAfterDiscounts)(base, discounts);
exports.signedAfterDiscounts = signedAfterDiscounts;
/** The project ledger stores the discounted amount; metadata preserves the editable document. */
function normalizeAddonLines(raw) {
    if (!Array.isArray(raw))
        throw new Error('Positionen fehlen.');
    if (raw.length > 1000)
        throw new Error('Zu viele Positionen.');
    const products = [];
    const texts = [];
    const ids = new Set();
    raw.forEach((line, sortOrder) => {
        if (!line || typeof line !== 'object')
            throw new Error('Position ungültig.');
        const id = line.id ? String(line.id) : null;
        if (id && ids.has(id))
            throw new Error('Doppelte Positions-ID.');
        if (id)
            ids.add(id);
        const kind = String(line.kind || (line.articleId || line.materialId ? 'PRODUCT' : 'TEXT')).toUpperCase();
        if (kind !== 'PRODUCT' && kind !== 'TEXT')
            throw new Error('Positionsart ungültig.');
        // MINDERUNG (16.09.2026): eine NEGATIVE Menge ist eine Minuszeile —
        // das fällt weg. Null bleibt ungültig, der Preis bleibt ≥ 0.
        const quantity = Number(line.quantity ?? 1);
        if (!Number.isFinite(quantity) || quantity === 0)
            throw new Error('Menge darf nicht 0 sein.');
        const title = String(line.description || '').trim();
        const unitPrice = line.unitPrice === undefined || line.unitPrice === null || line.unitPrice === '' ? null : number(line.unitPrice, 'Preis');
        const metadata = { description: title, quantity, unitPrice: unitPrice ?? 0, unit: String(line.unit || '').trim(),
            discounts: (0, tender_discounts_1.parseDiscountList)((0, tender_discounts_1.normalizeDiscountList)(line.discounts, tender_discounts_1.MAX_LINE_DISCOUNTS), tender_discounts_1.MAX_LINE_DISCOUNTS), sortOrder };
        if (kind === 'PRODUCT') {
            const articleId = String(line.articleId || line.materialId || '').trim();
            if (!articleId)
                throw new Error('Artikel fehlt.');
            products.push({ id, articleId, quantity, unitPrice, description: String(line.longDescription || '').trim() || null, metadata });
        }
        else {
            if (!title)
                throw new Error('Bezeichnung fehlt.');
            // Ohne Einzelpreis zählt der Betrag; sein Vorzeichen kommt aus der Menge.
            metadata.unitPrice = unitPrice ?? Math.abs(Number(line.amount ?? 0)) / Math.abs(quantity);
            if (!Number.isFinite(metadata.unitPrice))
                throw new Error('Betrag ungültig.');
            const base = round2(quantity * metadata.unitPrice);
            if (!Number.isFinite(base))
                throw new Error('Betrag ungültig.');
            texts.push({ id, description: title, longDescription: String(line.longDescription || '').trim() || null,
                amount: round2((0, exports.signedAfterDiscounts)(base, metadata.discounts)), documentLine: JSON.stringify(metadata) });
        }
    });
    return { products, texts };
}
function priceAddonProduct(line, fallback) {
    const price = line.unitPrice ?? number(fallback.salePrice ?? 0, 'Preis');
    const base = round2(line.quantity * price);
    if (!Number.isFinite(base))
        throw new Error('Betrag ungültig.');
    const lineTotal = round2((0, exports.signedAfterDiscounts)(base, line.metadata.discounts));
    return { ...line, lineTotal, unitPrice: lineTotal / line.quantity,
        documentLine: JSON.stringify({ ...line.metadata, unitPrice: price, description: line.metadata.description || fallback.name || '' }) };
}
function readAddonLineMetadata(raw) {
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=addonDocumentLines.js.map