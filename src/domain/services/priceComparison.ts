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

export const COMPARE_MAX_SUPPLIERS = 4;

/** Eine Zeile des Talep — fest, in ihrer Reihenfolge. */
export interface ComparisonRowInput {
    bomLineId: string;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    unit: string | null;
    quantity: number;
}

/** Ein Angebot (eine Preisanfrage mit dem PDF des Lieferanten). */
export interface ComparisonSupplierInput {
    purchaseOrderId: string;
    code: string;
    supplierName: string;
    fileName: string;
    /** Die Währung der Preisanfrage — falls das Angebot keine druckt. */
    currency: string;
}

/** Was das Modell abgeschrieben hat (Texte, Zahlen als gedruckte Zeichen). */
export interface RawComparison {
    suppliers: Array<{
        supplier: number;
        offerNumber: string;
        offerDate: string;
        currency: string;
        deliveryTime: string;
        paymentTerms: string;
        validity: string;
        notes: string;
    }>;
    rows: Array<{
        index: number;
        offers: Array<{ supplier: number; unitPrice: number | null; total: number | null; deliveryTime: string; note: string; evidence: string }>;
        best: number;
        reason: string;
    }>;
    recommendation: { supplier: number; text: string };
}

export interface ComparisonOffer {
    unitPrice: number | null;
    total: number | null;
    /** Betrag bzw. Stückpreis aus dem anderen gerechnet (Menge × Preis). */
    computed: boolean;
    deliveryTime: string;
    note: string;
    evidence: string;
}

export interface ComparisonSupplier extends ComparisonSupplierInput {
    offerNumber: string;
    offerDate: string;
    deliveryTime: string;
    paymentTerms: string;
    validity: string;
    notes: string;
    /** Summe der Zeilenbeträge, die dieses Angebot nennt. */
    total: number;
    pricedLines: number;
    /** Nennt einen Preis für jede Zeile des Talep. */
    complete: boolean;
}

export interface ComparisonLine extends ComparisonRowInput {
    offers: ComparisonOffer[];
    /** Index des günstigsten Angebots — null = keines. */
    best: number | null;
    /** `price` = niedrigster Stückpreis gerechnet, `ai` = Wahl des Modells (Währungen verschieden). */
    bestBy: 'price' | 'ai' | null;
    reason: string;
}

export interface ComparisonResult {
    suppliers: ComparisonSupplier[];
    lines: ComparisonLine[];
    /** Insgesamt am günstigsten — null = nicht zu sagen. */
    bestSupplier: number | null;
    bestSupplierBy: 'price' | 'ai' | null;
    /** Alle Zeilen beim jeweils günstigsten Angebot (nur bei einer Währung). */
    bestMix: { total: number; currency: string } | null;
    /** Eine Währung für alle Angebote — sonst null. */
    currency: string | null;
    summary: string;
}

const round = (value: number, digits: number): number => {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
};

const clip = (value: unknown, max: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const SYMBOLS: Record<string, string> = { '€': 'EUR', 'EURO': 'EUR', '$': 'USD', 'US$': 'USD', '£': 'GBP', '₺': 'TRY', 'TL': 'TRY', 'FR.': 'CHF', 'SFR': 'CHF', 'SFR.': 'CHF' };

/** «€», «Euro», «chf» → EUR/CHF; unbekannt → null. */
export const currencyCode = (raw: unknown): string | null => {
    const value = clip(raw, 12).toUpperCase();
    if (!value) return null;
    if (SYMBOLS[value]) return SYMBOLS[value]!;
    return /^[A-Z]{3}$/.test(value) ? value : null;
};

const positive = (value: number | null | undefined): number | null =>
    (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/** Den Index des Modells prüfen: ein Angebot, das es gibt — sonst null. */
const supplierIndex = (value: unknown, count: number): number | null => {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index < count ? index : null;
};

/**
 * Aus der Abschrift des Modells die Tabelle: je Zeile und Angebot Stückpreis
 * und Betrag (der fehlende aus dem anderen gerechnet), die günstigsten
 * markiert, je Angebot die Summe.
 */
export const settleComparison = (
    rows: ComparisonRowInput[],
    suppliersIn: ComparisonSupplierInput[],
    raw: RawComparison,
): ComparisonResult => {
    const count = suppliersIn.length;
    const facts = suppliersIn.map((supplier, index) => {
        const read = raw.suppliers.find((entry) => entry.supplier === index);
        return {
            ...supplier,
            currency: currencyCode(read?.currency) ?? currencyCode(supplier.currency) ?? 'CHF',
            offerNumber: clip(read?.offerNumber, 80),
            offerDate: /^\d{4}-\d{2}-\d{2}$/.test(clip(read?.offerDate, 10)) ? clip(read?.offerDate, 10) : '',
            deliveryTime: clip(read?.deliveryTime, 120),
            paymentTerms: clip(read?.paymentTerms, 160),
            validity: clip(read?.validity, 120),
            notes: clip(read?.notes, 400),
        };
    });

    const lines: ComparisonLine[] = rows.map((row, rowIndex) => {
        const read = raw.rows.find((entry) => entry.index === rowIndex);
        const quantity = row.quantity > 0 ? row.quantity : 0;
        const offers: ComparisonOffer[] = suppliersIn.map((_, index) => {
            const offer = read?.offers.find((entry) => entry.supplier === index);
            let unitPrice = positive(offer?.unitPrice);
            let total = positive(offer?.total);
            let computed = false;
            if (unitPrice !== null && total === null && quantity > 0) {
                total = round(unitPrice * quantity, 2);
                computed = true;
            } else if (unitPrice === null && total !== null && quantity > 0) {
                unitPrice = round(total / quantity, 4);
                computed = true;
            }
            return {
                unitPrice,
                total,
                computed,
                deliveryTime: clip(offer?.deliveryTime, 80),
                note: clip(offer?.note, 200),
                evidence: clip(offer?.evidence, 300),
            };
        });
        const priced = offers.flatMap((offer, index) => (offer.unitPrice !== null ? [{ index, price: offer.unitPrice }] : []));
        const currencies = new Set(priced.map((entry) => facts[entry.index]!.currency));
        let best: number | null = null;
        let bestBy: ComparisonLine['bestBy'] = null;
        if (priced.length && currencies.size === 1) {
            best = [...priced].sort((a, b) => a.price - b.price || a.index - b.index)[0]!.index;
            bestBy = 'price';
        } else if (priced.length) {
            const pick = supplierIndex(read?.best, count);
            if (pick !== null && offers[pick]!.unitPrice !== null) {
                best = pick;
                bestBy = 'ai';
            }
        }
        return { ...row, offers, best, bestBy, reason: clip(read?.reason, 240) };
    });

    const suppliers: ComparisonSupplier[] = facts.map((supplier, index) => {
        const priced = lines.filter((line) => line.offers[index]!.total !== null);
        return {
            ...supplier,
            total: round(priced.reduce((sum, line) => sum + (line.offers[index]!.total ?? 0), 0), 2),
            pricedLines: priced.length,
            complete: lines.length > 0 && priced.length === lines.length,
        };
    });

    const currencies = new Set(suppliers.map((supplier) => supplier.currency));
    const currency = currencies.size === 1 ? suppliers[0]?.currency ?? null : null;

    let bestSupplier: number | null = null;
    let bestSupplierBy: ComparisonResult['bestSupplierBy'] = null;
    const complete = suppliers.flatMap((supplier, index) => (supplier.complete ? [{ index, total: supplier.total }] : []));
    if (currency && complete.length) {
        bestSupplier = [...complete].sort((a, b) => a.total - b.total || a.index - b.index)[0]!.index;
        bestSupplierBy = 'price';
    } else {
        const pick = supplierIndex(raw.recommendation?.supplier, count);
        if (pick !== null && suppliers[pick]!.pricedLines > 0) {
            bestSupplier = pick;
            bestSupplierBy = 'ai';
        }
    }

    const mixLines = lines.filter((line) => line.best !== null);
    const bestMix = currency && mixLines.length
        ? { total: round(mixLines.reduce((sum, line) => sum + (line.offers[line.best!]!.total ?? 0), 0), 2), currency }
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
