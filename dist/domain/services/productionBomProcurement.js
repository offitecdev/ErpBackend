"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withoutSupplierFacts = exports.receiptAllocation = exports.procurementStatusAfter = exports.procurementProgress = exports.procurementLinesFrom = exports.remainingPriceRequestQuantities = exports.procurementKindFrom = void 0;
const productionBom_1 = require("./productionBom");
const EPS = 1e-9;
/* ── Was ein Talep enthält ──────────────────────────────────────────────── */
const procurementKindFrom = (value) => {
    const raw = String(value ?? '').trim().toUpperCase();
    return raw === 'PRICE' || raw === 'ORDER' ? raw : null;
};
exports.procurementKindFrom = procurementKindFrom;
/** Only the requested quantity is pending; another request can cover the remainder. */
const remainingPriceRequestQuantities = (lines, revision, requests) => {
    const remaining = new Map(lines.map((line) => [line.id, (0, productionBom_1.round3)(line.quantity)]));
    for (const request of requests) {
        if (request.kind !== 'PRICE' || request.bomRevision !== revision
            || (request.status !== 'OPEN' && request.status !== 'IN_PROGRESS'))
            continue;
        for (const line of request.lines) {
            if (!remaining.has(line.bomLineId))
                continue;
            remaining.set(line.bomLineId, (0, productionBom_1.round3)(Math.max(0, remaining.get(line.bomLineId) - Math.max(0, line.quantity))));
        }
    }
    return remaining;
};
exports.remainingPriceRequestQuantities = remainingPriceRequestQuantities;
/**
 * `lines: [{ lineId, quantity, note }]` gegen die erlaubten Zeilen der BOM
 * (`allowed`: Kennung → kleinste Menge, 0 = frei). Jede Zeile höchstens
 * einmal, Menge > 0 und nie unter der Untergrenze (bei ORDER die fehlende
 * Menge — «stokta olmayan kadarı»).
 */
const procurementLinesFrom = (raw, allowed) => {
    if (!Array.isArray(raw) || !raw.length)
        throw (0, productionBom_1.bomError)('REQUEST_EMPTY', 'Keine Zeile gewählt.');
    const seen = new Set();
    const result = [];
    for (const entry of raw) {
        const value = (entry && typeof entry === 'object' ? entry : {});
        const lineId = String(value.lineId ?? '').trim();
        if (!lineId || seen.has(lineId) || !allowed.has(lineId)) {
            throw (0, productionBom_1.bomError)('LINE_INVALID', 'Diese Zeile kann nicht angefragt werden.', { params: { lineId } });
        }
        seen.add(lineId);
        const quantity = (0, productionBom_1.round3)(Number(String(value.quantity ?? '').replace(',', '.')));
        const floor = allowed.get(lineId) ?? 0;
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity + EPS < floor) {
            throw (0, productionBom_1.bomError)('QTY_INVALID', 'Die Menge ist ungültig.', { params: { lineId, min: floor } });
        }
        const note = String(value.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
        result.push({ lineId, quantity, note });
    }
    return result;
};
exports.procurementLinesFrom = procurementLinesFrom;
/** PRICE wird durch Preisanfragen erledigt, ORDER durch Bestellungen. */
const procurementProgress = (request, docs) => {
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
exports.procurementProgress = procurementProgress;
/** Der Stand, den ein offener Talep nach neuen Belegen hat (geschlossene bleiben). */
const procurementStatusAfter = (current, progress) => {
    if (current === 'CANCELLED' || current === 'DONE')
        return current;
    if (progress.total > 0 && progress.covered >= progress.total)
        return 'DONE';
    return progress.covered > 0 || progress.requests + progress.orders > 0 ? 'IN_PROGRESS' : 'OPEN';
};
exports.procurementStatusAfter = procurementStatusAfter;
/* ── Wohin eingegangene Ware ging ───────────────────────────────────────── */
/**
 * «Mal kabulde projeler arasında en erken teslim tarihli projeye»: die
 * Reservierung wird gerechnet (frühester Liefertermin zuerst) — was eine
 * Buchung bewirkt hat, ist der Zuwachs an Reserviertem je Zeile zwischen
 * vorher und nachher, in der Reihenfolge des Vorrangs, gedeckelt auf die
 * gebuchte Menge. Der Rest ging in den freien Bestand (`demand: null`).
 */
const receiptAllocation = (quantity, demands, before, after) => {
    let rest = (0, productionBom_1.round3)(quantity);
    const result = [];
    for (const demand of [...demands].sort(productionBom_1.byPriority)) {
        if (rest <= EPS)
            break;
        const gained = (0, productionBom_1.round3)((after.get(demand.lineId)?.reserved ?? 0) - (before.get(demand.lineId)?.reserved ?? 0));
        if (gained <= EPS)
            continue;
        const take = (0, productionBom_1.round3)(Math.min(gained, rest));
        result.push({ demand, quantity: take });
        rest = (0, productionBom_1.round3)(rest - take);
    }
    if (rest > EPS)
        result.push({ demand: null, quantity: rest });
    return result;
};
exports.receiptAllocation = receiptAllocation;
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
const withoutSupplierFacts = (value) => {
    const walk = (node) => {
        if (Array.isArray(node))
            return node.map(walk);
        if (!node || typeof node !== 'object' || node instanceof Date)
            return node;
        const out = {};
        for (const [key, entry] of Object.entries(node)) {
            if (HIDDEN_TEXT.has(key))
                out[key] = entry === null ? null : '';
            else if (HIDDEN_NUMBERS.has(key))
                out[key] = entry === null ? null : 0;
            else if (HIDDEN_NULLS.has(key))
                out[key] = null;
            else if (HIDDEN_LISTS.has(key))
                out[key] = [];
            else
                out[key] = walk(entry);
        }
        return out;
    };
    return walk(value);
};
exports.withoutSupplierFacts = withoutSupplierFacts;
//# sourceMappingURL=productionBomProcurement.js.map