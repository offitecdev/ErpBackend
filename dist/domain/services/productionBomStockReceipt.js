"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serialsForCredits = exports.planOrderReversal = exports.planReceiptReversal = exports.splitAllocation = exports.planStockReceipt = exports.byReceiptPriority = exports.STOCK_RECEIPT_STATUSES = void 0;
const productionBom_1 = require("./productionBom");
/**
 * ── DEPODA OKUTULAN MAL = MAL KABUL (28.09.2026, Vorgabe Samet) ─────────────
 *
 * «Diğer türlü, hiç sormadan, proje teslim tarihi en önce olan ürünün
 *  siparişine otomatik çeksin stoktan.»
 *
 * Was im Depo über «Ürün ekle» eingebucht wird, gehört den bestätigten
 * BOM-Bestellungen (MAL KABULDE), die auf diese Karte warten — der früheste
 * Liefertermin des Projekts zuerst, bei gleichem Termin die früher
 * freigegebene BOM, dann die ältere Bestellung. Nennt der gelesene Barcode
 * einen Lieferanten, zählen nur dessen Bestellungen: die Ware kam von ihm.
 * Was keine Bestellung erwartet, bleibt freier Bestand.
 *
 * Reine Rechnung — die Datenbank steht im Anwendungsfall
 * (BomStockReceiptUseCase).
 */
const EPS = 1e-9;
/** Stände, in denen eine BOM-Bestellung Ware annimmt (wie ihr Wareneingang). */
exports.STOCK_RECEIPT_STATUSES = ['TO_BE_STOCKED', 'PENDING'];
const time = (value) => (value ? value.getTime() : Number.POSITIVE_INFINITY);
/** Früheste Lieferung zuerst, dann die früher freigegebene BOM, dann die ältere Bestellung. */
const byReceiptPriority = (a, b) => time(a.deliveryDate) - time(b.deliveryDate)
    || time(a.bomApprovedAt) - time(b.bomApprovedAt)
    || a.orderCreatedAt.getTime() - b.orderCreatedAt.getTime()
    || a.referenceNumber.localeCompare(b.referenceNumber)
    || a.itemIndex - b.itemIndex;
exports.byReceiptPriority = byReceiptPriority;
/**
 * Verteilt eine Buchung auf die wartenden Positionen. Nennt der Barcode einen
 * Lieferanten, bekommen nur seine Bestellungen etwas — wartet bei ihm nichts,
 * ist die Ware frei (sie wird nie der Bestellung eines anderen gutgeschrieben).
 */
const planStockReceipt = (quantity, lines, supplier) => {
    let rest = (0, productionBom_1.round3)(Math.max(0, quantity));
    const credits = [];
    const waiting = lines
        .filter((line) => (0, productionBom_1.round3)(line.quantity - line.received) > EPS)
        .filter((line) => !supplier || (0, productionBom_1.sameSupplier)(line, supplier))
        .sort(exports.byReceiptPriority);
    for (const line of waiting) {
        if (rest <= EPS)
            break;
        const take = (0, productionBom_1.round3)(Math.min(rest, line.quantity - line.received));
        if (take <= EPS)
            continue;
        let credit = credits.find((entry) => entry.purchaseOrderId === line.purchaseOrderId);
        if (!credit) {
            credit = {
                purchaseOrderId: line.purchaseOrderId,
                referenceNumber: line.referenceNumber,
                bomId: line.bomId,
                productionProjectId: line.productionProjectId,
                productionItemId: line.productionItemId,
                lines: [],
                quantity: 0,
            };
            credits.push(credit);
        }
        credit.lines.push({ index: line.itemIndex, quantity: take });
        credit.quantity = (0, productionBom_1.round3)(credit.quantity + take);
        rest = (0, productionBom_1.round3)(rest - take);
    }
    return { credits, free: rest > EPS ? rest : 0 };
};
exports.planStockReceipt = planStockReceipt;
/**
 * Die Buchung als Ganzes ging an Zeilen (Zuwachs an Reserviertem, frühester
 * Termin zuerst, Rest frei — `receiptAllocation`). Jede Bestellung bekommt
 * davon ihren Teil, in der Reihenfolge, in der sie Ware bekam.
 */
const splitAllocation = (credits, parts) => {
    const queue = parts.map((part) => ({ demand: part.demand, quantity: (0, productionBom_1.round3)(part.quantity) }));
    const result = [];
    for (const credit of credits) {
        let need = (0, productionBom_1.round3)(credit.quantity);
        while (need > EPS && queue.length) {
            const head = queue[0];
            const take = (0, productionBom_1.round3)(Math.min(need, head.quantity));
            if (take > EPS) {
                const same = result.find((row) => row.key === credit.key && row.demand?.lineId === head.demand?.lineId);
                if (same)
                    same.quantity = (0, productionBom_1.round3)(same.quantity + take);
                else
                    result.push({ key: credit.key, demand: head.demand, quantity: take });
            }
            head.quantity = (0, productionBom_1.round3)(head.quantity - take);
            need = (0, productionBom_1.round3)(need - take);
            if (head.quantity <= EPS)
                queue.shift();
        }
        if (need > EPS)
            result.push({ key: credit.key, demand: null, quantity: need });
    }
    return result;
};
exports.splitAllocation = splitAllocation;
/**
 * «Geri al» im Protokoll: nimmt Stück einer Buchung zurück — zuerst, was in
 * den freien Bestand ging, dann von der Zeile mit dem spätesten Termin (die
 * Reservierung gibt in derselben Richtung frei). Seriennummern gehen einzeln
 * aus ihrer Zeile. `rank`: je grösser, desto später der Termin.
 * null = die Buchung trägt so viel nicht (oder die Nummer nicht).
 */
const planReceiptReversal = (rows, quantity, serials, rank) => {
    const state = rows.map((row) => ({ id: row.id, lineId: row.lineId, quantity: (0, productionBom_1.round3)(row.quantity), serials: [...row.serials] }));
    const touched = new Set();
    if (serials.length) {
        for (const serial of serials) {
            const row = state.find((entry) => entry.serials.includes(serial));
            if (!row)
                return null;
            row.serials = row.serials.filter((entry) => entry !== serial);
            row.quantity = (0, productionBom_1.round3)(Math.max(0, row.quantity - 1));
            touched.add(row.id);
        }
    }
    else {
        let rest = (0, productionBom_1.round3)(quantity);
        const total = state.reduce((sum, row) => sum + row.quantity, 0);
        if (rest <= EPS || rest > (0, productionBom_1.round3)(total) + EPS)
            return null;
        const order = [...state].sort((a, b) => rank(b.lineId) - rank(a.lineId) || a.id.localeCompare(b.id));
        for (const row of order) {
            if (rest <= EPS)
                break;
            const take = (0, productionBom_1.round3)(Math.min(rest, row.quantity));
            if (take <= EPS)
                continue;
            row.quantity = (0, productionBom_1.round3)(row.quantity - take);
            rest = (0, productionBom_1.round3)(rest - take);
            touched.add(row.id);
        }
    }
    return state
        .filter((row) => touched.has(row.id))
        .map((row) => ({ id: row.id, quantity: row.quantity, serials: row.serials }));
};
exports.planReceiptReversal = planReceiptReversal;
/**
 * «Geri al» an der Bestellung: dieselbe Menge kommt aus den Positionen dieser
 * Karte wieder heraus — die hinterste zuerst (gebucht wird von vorn). Mehr
 * als eingegangen ist, geht nicht zurück.
 */
const planOrderReversal = (lines, quantity) => {
    let rest = (0, productionBom_1.round3)(quantity);
    const result = [];
    for (const line of [...lines].sort((a, b) => b.index - a.index)) {
        if (rest <= EPS)
            break;
        const take = (0, productionBom_1.round3)(Math.min(rest, line.received));
        if (take <= EPS)
            continue;
        result.push({ index: line.index, quantity: take });
        rest = (0, productionBom_1.round3)(rest - take);
    }
    return result;
};
exports.planOrderReversal = planOrderReversal;
/** Die Seriennummern einer Buchung, der Reihe nach auf die Bestellungen verteilt. */
const serialsForCredits = (credits, serials) => {
    const result = new Map();
    let at = 0;
    for (const credit of credits) {
        const count = Math.round(credit.quantity);
        result.set(credit.key, serials.slice(at, at + count));
        at += count;
    }
    return result;
};
exports.serialsForCredits = serialsForCredits;
//# sourceMappingURL=productionBomStockReceipt.js.map