"use strict";
/**
 * ── FİYAT KARŞILAŞTIRMASI (29.09.2026, Vorgabe Samet) ───────────────────────
 *
 * «Fiyat talebini her onayladıktan sonra satıcının bize verdiği teklifleri …
 *  bu listeye yükleyebileceğiz; istediğimiz max 4 tedarikçinin 4 PDF'ini
 *  (PDF olmazsa yapılamaz) yapay zekâya vererek karşılaştıracağız ve yapay
 *  zekâ bize tablo verecek, en uygunları işaretleyerek; karşılaştırmalar
 *  kayıt edilecek.»
 *
 * Die KI liest die Angebote ab (Preise je Zeile, Lieferzeit, Zahlung); was
 * «en uygun» ist, entscheidet hier die Rechnung, nicht das Modell: je Zeile
 * der niedrigste Stückpreis, insgesamt das günstigste VOLLSTÄNDIGE Angebot —
 * beides nur, wo die Währung gleich ist. Wo sie sich unterscheidet, gilt die
 * Wahl des Modells, und sie ist als solche gekennzeichnet. Reine Funktionen.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.settleComparison = exports.currencyCode = exports.languageCode = exports.vatRateOf = exports.COMPARE_MAX_SUPPLIERS = void 0;
/**
 * Höchstzahl der Angebote eines Vergleichs. 29.09.2026: vier; seit dem
 * 30.09.2026 fragt die Automatik JEDEN Lieferanten der Karten an (A: X,Y ·
 * B: X,Y,Z,T …) — der Vergleich nimmt darum bis zu acht.
 */
exports.COMPARE_MAX_SUPPLIERS = 8;
const round = (value, digits) => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};
const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** «de», «Deutsch», «fr» → de/tr/en (Französisch/Italienisch → de, wie die Schweiz schreibt). */
/** «8,1 %» → 8.1; nichts Lesbares oder ausserhalb 0–30 → null. */
const vatRateOf = (raw) => {
    const match = String(raw ?? '').replace(',', '.').match(/\d+(?:\.\d+)?/);
    if (!match)
        return null;
    const value = Number(match[0]);
    return Number.isFinite(value) && value >= 0 && value <= 30 ? Math.round(value * 100) / 100 : null;
};
exports.vatRateOf = vatRateOf;
const languageCode = (raw) => {
    const value = clip(raw, 20).toLowerCase();
    if (value.startsWith('tr') || value.startsWith('tür') || value.startsWith('tur'))
        return 'tr';
    if (value.startsWith('en'))
        return 'en';
    if (value.startsWith('de') || value.startsWith('ger') || value.startsWith('deu') || value.startsWith('fr') || value.startsWith('it'))
        return 'de';
    return '';
};
exports.languageCode = languageCode;
const SYMBOLS = { '€': 'EUR', 'EURO': 'EUR', '$': 'USD', 'US$': 'USD', '£': 'GBP', '₺': 'TRY', 'TL': 'TRY', 'FR.': 'CHF', 'SFR': 'CHF', 'SFR.': 'CHF' };
/** «€», «Euro», «chf» → EUR/CHF; unbekannt → null. */
const currencyCode = (raw) => {
    const value = clip(raw, 12).toUpperCase();
    if (!value)
        return null;
    if (SYMBOLS[value])
        return SYMBOLS[value];
    return /^[A-Z]{3}$/.test(value) ? value : null;
};
exports.currencyCode = currencyCode;
const positive = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
/** Den Index des Modells prüfen: ein Angebot, das es gibt — sonst null. */
const supplierIndex = (value, count) => {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index < count ? index : null;
};
/**
 * Aus der Abschrift des Modells die Tabelle: je Zeile und Angebot Stückpreis
 * und Betrag (der fehlende aus dem anderen gerechnet), die günstigsten
 * markiert, je Angebot die Summe.
 */
const settleComparison = (rows, suppliersIn, raw) => {
    const count = suppliersIn.length;
    const facts = suppliersIn.map((supplier, index) => {
        const read = raw.suppliers.find((entry) => entry.supplier === index);
        return {
            ...supplier,
            currency: (0, exports.currencyCode)(read?.currency) ?? (0, exports.currencyCode)(supplier.currency) ?? 'CHF',
            offerNumber: clip(read?.offerNumber, 80),
            offerDate: /^\d{4}-\d{2}-\d{2}$/.test(clip(read?.offerDate, 10)) ? clip(read?.offerDate, 10) : '',
            deliveryTime: clip(read?.deliveryTime, 120),
            paymentTerms: clip(read?.paymentTerms, 160),
            validity: clip(read?.validity, 120),
            notes: clip(read?.notes, 400),
            contactName: clip(read?.contactName, 120),
            contactEmail: clip(read?.contactEmail, 191),
            language: (0, exports.languageCode)(read?.language),
            vatRate: (0, exports.vatRateOf)(read?.vatRate),
        };
    });
    const askedBy = suppliersIn.map((supplier) => (supplier.askedLineIds ? new Set(supplier.askedLineIds) : null));
    const wasAsked = (supplierIndex, bomLineId) => {
        const set = askedBy[supplierIndex];
        return !set || set.has(bomLineId);
    };
    const lines = rows.map((row, rowIndex) => {
        const read = raw.rows.find((entry) => entry.index === rowIndex);
        const quantity = row.quantity > 0 ? row.quantity : 0;
        const offers = suppliersIn.map((_, index) => {
            const asked = wasAsked(index, row.bomLineId);
            // Wer nicht gefragt wurde, hat für die Zeile kein Angebot — was das Modell auch liest.
            const offer = asked ? read?.offers.find((entry) => entry.supplier === index) : undefined;
            let unitPrice = positive(offer?.unitPrice);
            let total = positive(offer?.total);
            let computed = false;
            if (unitPrice !== null && total === null && quantity > 0) {
                total = round(unitPrice * quantity, 2);
                computed = true;
            }
            else if (unitPrice === null && total !== null && quantity > 0) {
                unitPrice = round(total / quantity, 4);
                computed = true;
            }
            const listPrice = positive(offer?.listPrice);
            const discount = typeof offer?.discount === 'number' && offer.discount > 0 && offer.discount < 100 ? round(offer.discount, 2) : null;
            return {
                unitPrice,
                total,
                computed,
                deliveryTime: clip(offer?.deliveryTime, 80),
                note: clip(offer?.note, 200),
                evidence: clip(offer?.evidence, 300),
                asked,
                listPrice: unitPrice !== null && listPrice !== null && listPrice + 1e-9 >= unitPrice ? listPrice : null,
                discount: unitPrice !== null ? discount : null,
            };
        });
        const priced = offers.flatMap((offer, index) => (offer.unitPrice !== null ? [{ index, price: offer.unitPrice }] : []));
        const currencies = new Set(priced.map((entry) => facts[entry.index].currency));
        let best = null;
        let bestBy = null;
        if (priced.length && currencies.size === 1) {
            best = [...priced].sort((a, b) => a.price - b.price || a.index - b.index)[0].index;
            bestBy = 'price';
        }
        else if (priced.length) {
            const pick = supplierIndex(read?.best, count);
            if (pick !== null && offers[pick].unitPrice !== null) {
                best = pick;
                bestBy = 'ai';
            }
        }
        return { ...row, offers, best, bestBy, reason: clip(read?.reason, 240) };
    });
    const suppliers = facts.map((supplier, index) => {
        const priced = lines.filter((line) => line.offers[index].total !== null);
        // Vollständig heisst: jede Zeile, nach der er GEFRAGT wurde, hat einen Preis.
        const asked = lines.filter((line) => line.offers[index].asked !== false);
        return {
            ...supplier,
            total: round(priced.reduce((sum, line) => sum + (line.offers[index].total ?? 0), 0), 2),
            pricedLines: priced.length,
            askedLines: asked.length,
            complete: asked.length > 0 && asked.every((line) => line.offers[index].total !== null),
        };
    });
    const currencies = new Set(suppliers.map((supplier) => supplier.currency));
    const currency = currencies.size === 1 ? suppliers[0]?.currency ?? null : null;
    let bestSupplier = null;
    let bestSupplierBy = null;
    const complete = suppliers.flatMap((supplier, index) => (supplier.complete ? [{ index, total: supplier.total }] : []));
    if (currency && complete.length) {
        bestSupplier = [...complete].sort((a, b) => a.total - b.total || a.index - b.index)[0].index;
        bestSupplierBy = 'price';
    }
    else {
        const pick = supplierIndex(raw.recommendation?.supplier, count);
        if (pick !== null && suppliers[pick].pricedLines > 0) {
            bestSupplier = pick;
            bestSupplierBy = 'ai';
        }
    }
    const mixLines = lines.filter((line) => line.best !== null);
    const bestMix = currency && mixLines.length
        ? { total: round(mixLines.reduce((sum, line) => sum + (line.offers[line.best].total ?? 0), 0), 2), currency }
        : null;
    return {
        suppliers,
        lines,
        bestSupplier,
        bestSupplierBy,
        bestMix,
        currency,
        summary: clip(raw.recommendation?.text, 1200),
    };
};
exports.settleComparison = settleComparison;
//# sourceMappingURL=priceComparison.js.map