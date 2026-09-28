import type { BomDemand, BomGoodsIn } from '../entities/ProductionBom';
import { round3, sameSupplier } from './productionBom';

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
export const STOCK_RECEIPT_STATUSES = ['TO_BE_STOCKED', 'PENDING'] as const;

/** Eine Position einer bestätigten BOM-Bestellung zu dieser Karte. */
export interface ReceivableLine {
    purchaseOrderId: string;
    referenceNumber: string;
    supplierId: string | null;
    supplierName: string;
    orderCreatedAt: Date;
    /** Die Stelle in `PurchaseOrder.items`. */
    itemIndex: number;
    bomLineId: string;
    bomId: string;
    productionProjectId: string;
    productionItemId: string;
    /** Freigabe der BOM — bei gleichem Liefertermin geht die ältere vor. */
    bomApprovedAt: Date | null;
    /** Liefertermin des Projekts («teslim tarihi en önce olan»); ohne Termin ganz hinten. */
    deliveryDate: Date | null;
    quantity: number;
    received: number;
}

/** Was eine Bestellung aus einer Buchung bekommt. */
export interface StockReceiptCredit {
    purchaseOrderId: string;
    referenceNumber: string;
    bomId: string;
    productionProjectId: string;
    productionItemId: string;
    /** Positionen (`items`-Stelle) und ihre Menge. */
    lines: Array<{ index: number; quantity: number }>;
    quantity: number;
}

const time = (value: Date | null): number => (value ? value.getTime() : Number.POSITIVE_INFINITY);

/** Früheste Lieferung zuerst, dann die früher freigegebene BOM, dann die ältere Bestellung. */
export const byReceiptPriority = (a: ReceivableLine, b: ReceivableLine): number =>
    time(a.deliveryDate) - time(b.deliveryDate)
    || time(a.bomApprovedAt) - time(b.bomApprovedAt)
    || a.orderCreatedAt.getTime() - b.orderCreatedAt.getTime()
    || a.referenceNumber.localeCompare(b.referenceNumber)
    || a.itemIndex - b.itemIndex;

/**
 * Verteilt eine Buchung auf die wartenden Positionen. Nennt der Barcode einen
 * Lieferanten, bekommen nur seine Bestellungen etwas — wartet bei ihm nichts,
 * ist die Ware frei (sie wird nie der Bestellung eines anderen gutgeschrieben).
 */
export const planStockReceipt = (
    quantity: number,
    lines: ReceivableLine[],
    supplier: { supplierId: string | null; supplierName: string } | null,
): { credits: StockReceiptCredit[]; free: number } => {
    let rest = round3(Math.max(0, quantity));
    const credits: StockReceiptCredit[] = [];
    const waiting = lines
        .filter((line) => round3(line.quantity - line.received) > EPS)
        .filter((line) => !supplier || sameSupplier(line, supplier))
        .sort(byReceiptPriority);
    for (const line of waiting) {
        if (rest <= EPS) break;
        const take = round3(Math.min(rest, line.quantity - line.received));
        if (take <= EPS) continue;
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
        credit.quantity = round3(credit.quantity + take);
        rest = round3(rest - take);
    }
    return { credits, free: rest > EPS ? rest : 0 };
};

/**
 * Die Buchung als Ganzes ging an Zeilen (Zuwachs an Reserviertem, frühester
 * Termin zuerst, Rest frei — `receiptAllocation`). Jede Bestellung bekommt
 * davon ihren Teil, in der Reihenfolge, in der sie Ware bekam.
 */
export const splitAllocation = <K>(
    credits: Array<{ key: K; quantity: number }>,
    parts: Array<{ demand: BomDemand | null; quantity: number }>,
): Array<{ key: K; demand: BomDemand | null; quantity: number }> => {
    const queue = parts.map((part) => ({ demand: part.demand, quantity: round3(part.quantity) }));
    const result: Array<{ key: K; demand: BomDemand | null; quantity: number }> = [];
    for (const credit of credits) {
        let need = round3(credit.quantity);
        while (need > EPS && queue.length) {
            const head = queue[0]!;
            const take = round3(Math.min(need, head.quantity));
            if (take > EPS) {
                const same = result.find((row) => row.key === credit.key && row.demand?.lineId === head.demand?.lineId);
                if (same) same.quantity = round3(same.quantity + take);
                else result.push({ key: credit.key, demand: head.demand, quantity: take });
            }
            head.quantity = round3(head.quantity - take);
            need = round3(need - take);
            if (head.quantity <= EPS) queue.shift();
        }
        if (need > EPS) result.push({ key: credit.key, demand: null, quantity: need });
    }
    return result;
};

/**
 * «Geri al» im Protokoll: nimmt Stück einer Buchung zurück — zuerst, was in
 * den freien Bestand ging, dann von der Zeile mit dem spätesten Termin (die
 * Reservierung gibt in derselben Richtung frei). Seriennummern gehen einzeln
 * aus ihrer Zeile. `rank`: je grösser, desto später der Termin.
 * null = die Buchung trägt so viel nicht (oder die Nummer nicht).
 */
export const planReceiptReversal = (
    rows: Array<Pick<BomGoodsIn, 'id' | 'lineId' | 'quantity' | 'serials'>>,
    quantity: number,
    serials: string[],
    rank: (lineId: string | null) => number,
): Array<{ id: string; quantity: number; serials: string[] }> | null => {
    const state = rows.map((row) => ({ id: row.id, lineId: row.lineId, quantity: round3(row.quantity), serials: [...row.serials] }));
    const touched = new Set<string>();
    if (serials.length) {
        for (const serial of serials) {
            const row = state.find((entry) => entry.serials.includes(serial));
            if (!row) return null;
            row.serials = row.serials.filter((entry) => entry !== serial);
            row.quantity = round3(Math.max(0, row.quantity - 1));
            touched.add(row.id);
        }
    } else {
        let rest = round3(quantity);
        const total = state.reduce((sum, row) => sum + row.quantity, 0);
        if (rest <= EPS || rest > round3(total) + EPS) return null;
        const order = [...state].sort((a, b) => rank(b.lineId) - rank(a.lineId) || a.id.localeCompare(b.id));
        for (const row of order) {
            if (rest <= EPS) break;
            const take = round3(Math.min(rest, row.quantity));
            if (take <= EPS) continue;
            row.quantity = round3(row.quantity - take);
            rest = round3(rest - take);
            touched.add(row.id);
        }
    }
    return state
        .filter((row) => touched.has(row.id))
        .map((row) => ({ id: row.id, quantity: row.quantity, serials: row.serials }));
};

/**
 * «Geri al» an der Bestellung: dieselbe Menge kommt aus den Positionen dieser
 * Karte wieder heraus — die hinterste zuerst (gebucht wird von vorn). Mehr
 * als eingegangen ist, geht nicht zurück.
 */
export const planOrderReversal = (
    lines: Array<{ index: number; received: number }>,
    quantity: number,
): Array<{ index: number; quantity: number }> => {
    let rest = round3(quantity);
    const result: Array<{ index: number; quantity: number }> = [];
    for (const line of [...lines].sort((a, b) => b.index - a.index)) {
        if (rest <= EPS) break;
        const take = round3(Math.min(rest, line.received));
        if (take <= EPS) continue;
        result.push({ index: line.index, quantity: take });
        rest = round3(rest - take);
    }
    return result;
};

/** Die Seriennummern einer Buchung, der Reihe nach auf die Bestellungen verteilt. */
export const serialsForCredits = <K>(
    credits: Array<{ key: K; quantity: number }>,
    serials: string[],
): Map<K, string[]> => {
    const result = new Map<K, string[]>();
    let at = 0;
    for (const credit of credits) {
        const count = Math.round(credit.quantity);
        result.set(credit.key, serials.slice(at, at + count));
        at += count;
    }
    return result;
};
