/**
 * ── WOHER DIE ADRESSE EINES LIEFERANTEN KOMMT (30.09.2026) ─────────────────
 * Reine Funktionen: eine Adresse prüfen und die Adresse finden, die die
 * Depo-Karten der Zeilen für einen Lieferanten nennen. Gebraucht vom Senden
 * (ProcurementDispatchUseCase) und vom Talep (ProcurementDeskUseCase).
 */

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

/** Eine gültige Adresse (ohne «mailto:», getrimmt) — sonst null. */
export const cleanSupplierEmail = (value: unknown): string | null => {
    const text = String(value ?? '').replace(/^mailto:/i, '').trim();
    return text.length <= 254 && EMAIL.test(text) ? text : null;
};

const fold = (value: unknown): string => String(value ?? '').trim().toLocaleLowerCase('tr-TR');

/** Gleicher Lieferant: dieselbe Kennung, sonst derselbe Name (ohne Gross/Klein). */
const same = (card: { supplierId: string | null; name: string }, supplier: { supplierId: string | null; supplierName: string }): boolean =>
    (card.supplierId && supplier.supplierId ? card.supplierId === supplier.supplierId : fold(card.name) === fold(supplier.supplierName));

/**
 * Die Adresse, die eine Karte der Zeilen für diesen Lieferanten trägt — erst
 * per Kennung, dann (eine Karte kennt den Lieferanten nur beim Namen) per Name.
 */
export const cardEmailOf = (
    supplier: { supplierId: string | null; supplierName: string },
    productIds: string[],
    products: Map<string, { suppliers?: Array<{ supplierId: string | null; name: string; email?: string | null }> }>,
): string | null => {
    const cards = productIds.flatMap((id) => products.get(id)?.suppliers ?? []);
    for (const card of cards) {
        const email = cleanSupplierEmail(card.email);
        if (email && same(card, supplier)) return email;
    }
    for (const card of cards) {
        const email = cleanSupplierEmail(card.email);
        if (email && fold(card.name) === fold(supplier.supplierName)) return email;
    }
    return null;
};
