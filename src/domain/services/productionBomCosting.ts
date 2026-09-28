/**
 * ── KALKÜLASYON AUS DER BOM (27.09.2026 abends, Vorgabe Samet) ───────────────
 *
 * «BOM'dan otomatik bir kalkülasyon listesi oluşsun. Her kalemin miktarı,
 *  alış fiyatı ve toplamı hesaplansın, en altta da makinenin/projenin toplam
 *  malzeme maliyetini görelim. Sonradan gerçek alış fiyatları gelince
 *  planlanan maliyet ile gerçek maliyeti de karşılaştırabilelim.»
 *
 * Reine Rechnung, nichts wird gespeichert:
 *   · PLAN   = Menge × Alışpreis der Depo-Karte; hat die Karte keinen, der
 *              günstigste Preis einer Preisanfrage dieser Zeile (Quelle QUOTE).
 *   · GERÇEK = Durchschnitt der BESTÄTIGTEN Bestellpositionen der Zeile
 *              (Positionssumme ÷ Menge, gewichtet).
 *   · TAHMİN = Menge × (gerçek ?? plan) — so vergleicht die Summe Gleiches
 *              mit Gleichem, auch solange erst ein Teil bestellt ist.
 * Umgerechnet wird nie: jede Währung hat ihre eigene Summe.
 */

const EPS = 1e-9;
const round2 = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;
const round4 = (value: number): number => Math.round((Number(value) || 0) * 10_000) / 10_000;
const num = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};

export const currencyOf = (value: unknown): string => (String(value ?? '').trim().toUpperCase() || 'CHF');

/**
 * Der Stückpreis einer Bestellposition, wie er bezahlt wird: Positionssumme ÷
 * Menge (sie trägt Rabatte schon), sonst der Nettopreis, sonst der Bruttopreis
 * abzüglich der Rabatte. `null` = die Position hat (noch) keinen Preis.
 */
export const unitPriceOfItem = (item: Record<string, unknown>): { unit: number; quantity: number; total: number } | null => {
    const quantity = num(item.quantity);
    if (quantity <= EPS) return null;
    const lineTotal = num(item.lineTotal);
    if (lineTotal > EPS) return { unit: round4(lineTotal / quantity), quantity, total: round2(lineTotal) };
    const net = num(item.netPrice);
    const gross = num(item.grossPrice);
    const factor = (1 - Math.min(100, Math.abs(num(item.discount))) / 100) * (1 - Math.min(100, Math.abs(num(item.discount2))) / 100);
    const unit = net > EPS ? net : gross > EPS ? gross * factor : 0;
    if (unit <= EPS) return null;
    return { unit: round4(unit), quantity, total: round2(unit * quantity) };
};

export interface CostingPrice {
    unit: number;
    currency: string;
}

export interface CostingLineFacts {
    key: string;
    productId: string;
    erpCode: string | null;
    name: string;
    unit: string;
    quantity: number;
    /** Alışpreis der Depo-Karte. */
    card: CostingPrice | null;
    /** Günstigster Preis aus den Preisanfragen der Zeile. */
    quote: CostingPrice | null;
    /** Bestätigte Bestellpositionen der Zeile (bezahlte Stückpreise). */
    orders: Array<{ unit: number; quantity: number; total: number; currency: string }>;
}

export interface CostingLine {
    key: string;
    productId: string;
    erpCode: string | null;
    name: string;
    unit: string;
    quantity: number;
    plan: (CostingPrice & { source: 'CARD' | 'QUOTE' }) | null;
    actual: (CostingPrice & { orderedQuantity: number }) | null;
    planTotal: number | null;
    actualTotal: number | null;
    /** Menge × (gerçek ?? plan). */
    forecastTotal: number | null;
    /** forecast − plan, nur wenn beide in derselben Währung. */
    diff: number | null;
}

export interface CostingTotal {
    currency: string;
    /** Summe der Kalemler mit Alışpreis. */
    plan: number;
    /** Summe der Kalemler mit bestätigtem Bestellpreis. */
    actual: number;
    /** Menge × (gerçek ?? plan) über alle Kalemler. */
    forecast: number;
    /** Plan der Kalemler, die BEIDE Preise haben — die Basis des Vergleichs. */
    comparablePlan: number;
    /** gerçek − plan, NUR über Kalemler mit beiden Preisen (sonst wäre ein fehlender Plan ein «Mehrpreis»). */
    diff: number;
}

export const costingLine = (facts: CostingLineFacts): CostingLine => {
    const plan = facts.card && facts.card.unit > EPS
        ? { unit: facts.card.unit, currency: currencyOf(facts.card.currency), source: 'CARD' as const }
        : facts.quote && facts.quote.unit > EPS ? { unit: facts.quote.unit, currency: currencyOf(facts.quote.currency), source: 'QUOTE' as const } : null;
    // Gerçek: gewichteter Durchschnitt — gibt es Bestellungen in mehreren Währungen, gilt die grösste.
    const byCurrency = new Map<string, { quantity: number; total: number }>();
    for (const order of facts.orders) {
        const currency = currencyOf(order.currency);
        const entry = byCurrency.get(currency) ?? { quantity: 0, total: 0 };
        entry.quantity += order.quantity;
        entry.total += order.total;
        byCurrency.set(currency, entry);
    }
    const main = [...byCurrency.entries()].sort((a, b) => b[1].quantity - a[1].quantity)[0];
    const actual = main && main[1].quantity > EPS
        ? { unit: round4(main[1].total / main[1].quantity), currency: main[0], orderedQuantity: round4(main[1].quantity) }
        : null;
    const planTotal = plan ? round2(plan.unit * facts.quantity) : null;
    const actualTotal = actual ? round2(actual.unit * facts.quantity) : null;
    const forecastTotal = actualTotal ?? planTotal;
    const diff = plan && actual && plan.currency === actual.currency ? round2((actualTotal ?? 0) - (planTotal ?? 0)) : null;
    return {
        key: facts.key,
        productId: facts.productId,
        erpCode: facts.erpCode,
        name: facts.name,
        unit: facts.unit,
        quantity: round4(facts.quantity),
        plan,
        actual,
        planTotal,
        actualTotal,
        forecastTotal,
        diff,
    };
};

/** Summen je Währung: Plan, Tahmin (gerçek wo bekannt) und ihr Unterschied. */
export const costingTotals = (lines: CostingLine[]): CostingTotal[] => {
    const totals = new Map<string, CostingTotal>();
    const bucket = (currency: string): CostingTotal => {
        const entry = totals.get(currency) ?? { currency, plan: 0, actual: 0, forecast: 0, comparablePlan: 0, diff: 0 };
        totals.set(currency, entry);
        return entry;
    };
    for (const line of lines) {
        if (line.plan && line.planTotal !== null) bucket(line.plan.currency).plan += line.planTotal;
        const forecastCurrency = line.actual?.currency ?? line.plan?.currency ?? null;
        if (forecastCurrency && line.forecastTotal !== null) bucket(forecastCurrency).forecast += line.forecastTotal;
        if (line.actual && line.actualTotal !== null) bucket(line.actual.currency).actual += line.actualTotal;
        if (line.diff !== null && line.plan && line.planTotal !== null) {
            const entry = bucket(line.plan.currency);
            entry.diff += line.diff;
            entry.comparablePlan += line.planTotal;
        }
    }
    return [...totals.values()]
        .map((entry) => ({
            currency: entry.currency,
            plan: round2(entry.plan),
            actual: round2(entry.actual),
            forecast: round2(entry.forecast),
            comparablePlan: round2(entry.comparablePlan),
            diff: round2(entry.diff),
        }))
        .sort((a, b) => b.plan - a.plan || a.currency.localeCompare(b.currency));
};

/** Mehrere Summenlisten zusammen (Gerät → Projekt). */
export const mergeTotals = (lists: CostingTotal[][]): CostingTotal[] => {
    const merged = new Map<string, CostingTotal>();
    for (const list of lists) {
        for (const entry of list) {
            const current = merged.get(entry.currency) ?? { currency: entry.currency, plan: 0, actual: 0, forecast: 0, comparablePlan: 0, diff: 0 };
            current.plan = round2(current.plan + entry.plan);
            current.actual = round2(current.actual + entry.actual);
            current.forecast = round2(current.forecast + entry.forecast);
            current.comparablePlan = round2(current.comparablePlan + entry.comparablePlan);
            current.diff = round2(current.diff + entry.diff);
            merged.set(entry.currency, current);
        }
    }
    return [...merged.values()].sort((a, b) => b.plan - a.plan || a.currency.localeCompare(b.currency));
};
