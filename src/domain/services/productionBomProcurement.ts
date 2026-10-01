/**
 * ── SATIN ALMA TALEBİ & GELEN MALLAR · DIE REGELN (27.09.2026 abends) ────────
 *
 * Samet: «Fiyat talepleri ve siparişleri muhasebe ve yöneticiler yapacak …
 * bom'da sadece sipariş ve fiyat talep istekleri oluşsun, revizyonlar
 * yapılsın ama tedarikçi ve fiyatlar gözükmesin, başka bir sayfada talep
 * olarak gelsin … mal kabulde projeler arasında en erken teslim tarihli
 * projeye aktarılması gerekmektedir.»
 *
 * Reine Funktionen: was ein Talep enthalten darf, wie weit der Einkauf ihn
 * erledigt hat, wohin eine Buchung Ware gab und was die BOM vom Einkauf NICHT
 * sehen darf (Lieferant, Preise).
 */
import type {
    BomDemand,
    BomLineCoverage,
    BomProcurementKind,
    BomProcurementRequest,
    BomProcurementStatus,
} from '../entities/ProductionBom';
import { bomError, byPriority, round3 } from './productionBom';

const EPS = 1e-9;

/* ── Was ein Talep enthält ──────────────────────────────────────────────── */

export const procurementKindFrom = (value: unknown): BomProcurementKind | null => {
    const raw = String(value ?? '').trim().toUpperCase();
    return raw === 'PRICE' || raw === 'ORDER' ? raw : null;
};

/**
 * «Fiyat talebi alınan üründen bir daha fiyat talebi istenemeyecek» (Samet,
 * 30.09.2026): eine BOM-Zeile, die schon in einem Fiyat talebi steht (egal in
 * welcher Revision, nur ein verworfener zählt nicht), kommt in keinen zweiten.
 * Mehr Lieferanten fragt der Einkauf im SELBEN Talep an; eine Mehrmenge einer
 * Revision folgt der Bestellung (Revision der Bestellung), nicht einer neuen
 * Anfrage.
 */
export const priceRequestedLineIds = (
    requests: Array<Pick<BomProcurementRequest, 'kind' | 'status' | 'lines'>>,
): Set<string> => new Set(requests
    .filter((request) => request.kind === 'PRICE' && request.status !== 'CANCELLED')
    .flatMap((request) => request.lines.map((line) => line.bomLineId)));

/** Only the requested quantity is pending; another request can cover the remainder. */
export const remainingPriceRequestQuantities = (
    lines: Array<{ id: string; quantity: number }>,
    revision: number,
    requests: Array<Pick<BomProcurementRequest, 'kind' | 'status' | 'bomRevision' | 'lines'>>,
): Map<string, number> => {
    const remaining = new Map(lines.map((line) => [line.id, round3(line.quantity)]));
    for (const request of requests) {
        if (request.kind !== 'PRICE' || request.bomRevision !== revision
            || (request.status !== 'OPEN' && request.status !== 'IN_PROGRESS')) continue;
        for (const line of request.lines) {
            if (!remaining.has(line.bomLineId)) continue;
            remaining.set(line.bomLineId, round3(Math.max(0, remaining.get(line.bomLineId)! - Math.max(0, line.quantity))));
        }
    }
    return remaining;
};

/**
 * `lines: [{ lineId, quantity, note }]` gegen die erlaubten Zeilen der BOM
 * (`allowed`: Kennung → kleinste Menge, 0 = frei). Jede Zeile höchstens
 * einmal, Menge > 0 und nie unter der Untergrenze (bei ORDER die fehlende
 * Menge — «stokta olmayan kadarı»).
 */
export const procurementLinesFrom = (
    raw: unknown,
    allowed: Map<string, number>,
): Array<{ lineId: string; quantity: number; note: string | null }> => {
    if (!Array.isArray(raw) || !raw.length) throw bomError('REQUEST_EMPTY', 'Keine Zeile gewählt.');
    const seen = new Set<string>();
    const result: Array<{ lineId: string; quantity: number; note: string | null }> = [];
    for (const entry of raw) {
        const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const lineId = String(value.lineId ?? '').trim();
        if (!lineId || seen.has(lineId) || !allowed.has(lineId)) {
            throw bomError('LINE_INVALID', 'Diese Zeile kann nicht angefragt werden.', { params: { lineId } });
        }
        seen.add(lineId);
        const quantity = round3(Number(String(value.quantity ?? '').replace(',', '.')));
        const floor = allowed.get(lineId) ?? 0;
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity + EPS < floor) {
            throw bomError('QTY_INVALID', 'Die Menge ist ungültig.', { params: { lineId, min: floor } });
        }
        const note = String(value.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
        result.push({ lineId, quantity, note });
    }
    return result;
};

/* ── Wie weit der Einkauf ist ───────────────────────────────────────────── */

/** Ein Beleg des Einkaufs, soweit ein Talep ihn kennen muss. */
export interface ProcurementDocFact {
    purchaseOrderId: string;
    /** REQUEST = Preisanfrage (PA-), ORDER = Bestellung (BE-). */
    kind: 'ORDER' | 'REQUEST';
    confirmed: boolean;
    lineIds: Set<string>;
}

export interface ProcurementProgress {
    /** Zeilen, die in einem Beleg der passenden Art stehen. */
    covered: number;
    total: number;
    /** Belege je Art, die aus dem Talep entstanden. */
    requests: number;
    orders: number;
    confirmed: number;
}

/** PRICE wird durch Preisanfragen erledigt, ORDER durch Bestellungen. */
export const procurementProgress = (
    request: Pick<BomProcurementRequest, 'kind' | 'lines' | 'purchaseOrderIds'>,
    docs: ProcurementDocFact[],
): ProcurementProgress => {
    const mine = docs.filter((doc) => request.purchaseOrderIds.includes(doc.purchaseOrderId));
    const wanted = request.kind === 'PRICE' ? 'REQUEST' : 'ORDER';
    const relevant = mine.filter((doc) => doc.kind === wanted);
    const covered = request.lines.filter((line) => relevant.some((doc) => doc.lineIds.has(line.bomLineId))).length;
    return {
        covered,
        total: request.lines.length,
        requests: mine.filter((doc) => doc.kind === 'REQUEST').length,
        orders: mine.filter((doc) => doc.kind === 'ORDER').length,
        confirmed: mine.filter((doc) => doc.kind === 'ORDER' && doc.confirmed).length,
    };
};

/**
 * Der Stand, den ein offener Talep nach neuen Belegen hat (geschlossene bleiben).
 * Ein Satın alma talebi ist erledigt, wenn jede Zeile bestellt ist. Ein Fiyat
 * talebi NIE von selbst (29.09.2026, Samet: «fiyat taleplerinin hepsinde
 * tamamlandı diyor, ne alaka? … başka tedarikçilere de danışabilelim») — es
 * bleibt offen für weitere Lieferanten, bis der Einkauf es schliesst.
 */
export const procurementStatusAfter = (
    current: BomProcurementStatus,
    progress: ProcurementProgress,
    kind: BomProcurementKind = 'ORDER',
): BomProcurementStatus => {
    if (current === 'CANCELLED' || current === 'DONE') return current;
    if (kind === 'ORDER' && progress.total > 0 && progress.covered >= progress.total) return 'DONE';
    return progress.covered > 0 || progress.requests + progress.orders > 0 ? 'IN_PROGRESS' : 'OPEN';
};

/* ── Wohin eingegangene Ware ging ───────────────────────────────────────── */

/**
 * «Mal kabulde projeler arasında en erken teslim tarihli projeye»: die
 * Reservierung wird gerechnet (frühester Liefertermin zuerst) — was eine
 * Buchung bewirkt hat, ist der Zuwachs an Reserviertem je Zeile zwischen
 * vorher und nachher, in der Reihenfolge des Vorrangs, gedeckelt auf die
 * gebuchte Menge. Der Rest ging in den freien Bestand (`demand: null`).
 */
export const receiptAllocation = (
    quantity: number,
    demands: BomDemand[],
    before: Map<string, BomLineCoverage>,
    after: Map<string, BomLineCoverage>,
): Array<{ demand: BomDemand | null; quantity: number }> => {
    let rest = round3(quantity);
    const result: Array<{ demand: BomDemand | null; quantity: number }> = [];
    for (const demand of [...demands].sort(byPriority)) {
        if (rest <= EPS) break;
        const gained = round3((after.get(demand.lineId)?.reserved ?? 0) - (before.get(demand.lineId)?.reserved ?? 0));
        if (gained <= EPS) continue;
        const take = round3(Math.min(gained, rest));
        result.push({ demand, quantity: take });
        rest = round3(rest - take);
    }
    if (rest > EPS) result.push({ demand: null, quantity: rest });
    return result;
};

/* ── Was die BOM vom Einkauf nicht sieht ────────────────────────────────── */

/** Schlüssel, deren Wert in der BOM leer bleibt: Lieferant und Preise. */
const HIDDEN_TEXT = new Set(['supplierName', 'supplierId']);
const HIDDEN_NUMBERS = new Set(['totalNet', 'grossPrice', 'netPrice', 'lineTotal', 'purchasePrice', 'unitPrice']);
const HIDDEN_NULLS = new Set(['quoteNumber', 'quoteFile']);
const HIDDEN_LISTS = new Set(['suppliers']);

/**
 * «Tedarikçi ve fiyatlar gözükmesin»: gibt eine Kopie der Antwort zurück, in
 * der kein Lieferant und kein Preis mehr steht — für alle, die den Einkauf
 * («Satın alma») nicht sehen dürfen. Stände, Mengen und Nummern bleiben: sie
 * sind die Prozessinformation der BOM.
 */
export const withoutSupplierFacts = <T>(value: T): T => {
    const walk = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(walk);
        if (!node || typeof node !== 'object' || node instanceof Date) return node;
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
            if (HIDDEN_TEXT.has(key)) out[key] = entry === null ? null : '';
            else if (HIDDEN_NUMBERS.has(key)) out[key] = entry === null ? null : 0;
            else if (HIDDEN_NULLS.has(key)) out[key] = null;
            else if (HIDDEN_LISTS.has(key)) out[key] = [];
            else out[key] = walk(entry);
        }
        return out;
    };
    return walk(value) as T;
};
