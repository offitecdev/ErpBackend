"use strict";
/**
 * ── WOHER DIE ADRESSE EINES LIEFERANTEN KOMMT (30.09.2026) ─────────────────
 * Reine Funktionen: eine Adresse prüfen und die Adresse finden, die die
 * Depo-Karten der Zeilen für einen Lieferanten nennen. Gebraucht vom Senden
 * (ProcurementDispatchUseCase) und vom Talep (ProcurementDeskUseCase).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardSupplierNumbersOf = exports.cardEmailOf = exports.cleanSupplierEmail = void 0;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
/** Eine gültige Adresse (ohne «mailto:», getrimmt) — sonst null. */
const cleanSupplierEmail = (value) => {
    const text = String(value ?? '').replace(/^mailto:/i, '').trim();
    return text.length <= 254 && EMAIL.test(text) ? text : null;
};
exports.cleanSupplierEmail = cleanSupplierEmail;
const fold = (value) => String(value ?? '').trim().toLocaleLowerCase('tr-TR');
/** Gleicher Lieferant: dieselbe Kennung, sonst derselbe Name (ohne Gross/Klein). */
const same = (card, supplier) => (card.supplierId && supplier.supplierId ? card.supplierId === supplier.supplierId : fold(card.name) === fold(supplier.supplierName));
/**
 * Die Adresse, die eine Karte der Zeilen für diesen Lieferanten trägt — erst
 * per Kennung, dann (eine Karte kennt den Lieferanten nur beim Namen) per Name.
 */
const cardEmailOf = (supplier, productIds, products) => {
    const cards = productIds.flatMap((id) => products.get(id)?.suppliers ?? []);
    for (const card of cards) {
        const email = (0, exports.cleanSupplierEmail)(card.email);
        if (email && same(card, supplier))
            return email;
    }
    for (const card of cards) {
        const email = (0, exports.cleanSupplierEmail)(card.email);
        if (email && fold(card.name) === fold(supplier.supplierName))
            return email;
    }
    return null;
};
exports.cardEmailOf = cardEmailOf;
/**
 * Die Artikel- und Bestellnummer, die die Karte für DIESEN Lieferanten trägt
 * (01.10.2026, Samet: «her tedarikçiye özel … ürün numarası ve sipariş
 * numarası … ilgili tedarikçilere kendi maillerine gitmeli»). Erst per
 * Kennung, dann per Name; die Karte kennt ihn nicht → beide leer.
 */
const cardSupplierNumbersOf = (supplier, product) => {
    const cards = product?.suppliers ?? [];
    const card = cards.find((entry) => same(entry, supplier))
        ?? cards.find((entry) => fold(entry.name) === fold(supplier.supplierName));
    return {
        supplierArticleNumber: card?.articleNumber?.trim() || null,
        supplierOrderNumber: card?.orderNumber?.trim() || null,
    };
};
exports.cardSupplierNumbersOf = cardSupplierNumbersOf;
//# sourceMappingURL=supplierEmails.js.map