"use strict";
/**
 * ── MINDERUNG: DER NACHTRAG MIT MINUSBETRAG (16.09.2026) ────────────────────
 *
 * Vorgabe Samet: läuft die Arbeit schon, wird der Hauptauftrag nicht mehr
 * geändert — auch nicht nach unten. Was wegfällt, steht in einem Nachtrag mit
 * Minuszeilen (Minderung). Für die Verrechnung gilt:
 *
 *   • Ein Nachtrag mit NEGATIVER Summe wird nicht selbst fakturiert — es gibt
 *     keine Rechnung über einen Minusbetrag (dafür kommt später die
 *     Gutschrift). Seine Rechnungsgrundlage ist 0.
 *   • Sein Betrag wird stattdessen vom HAUPTAUFTRAG abgezogen: dessen
 *     Rechnungsgrundlage ist `Auftragssumme + Summe aller aktiven
 *     Minderungen`. So fällt die Schlussrechnung des Hauptauftrags von selbst
 *     um die Minderung kleiner aus, und die Gruppensummen (Hauptauftrag +
 *     Nachträge) stimmen ohne weitere Rechnung.
 *   • Die Grundlage darf nie unter das fallen, was am Hauptauftrag schon
 *     verrechnet ist — das wäre Geld, das zurück muss (Gutschrift).
 *
 * Ein Nachtrag mit Plus- UND Minuszeilen (Tausch A gegen B) ist nur dann eine
 * Minderung, wenn seine Summe negativ ist; sonst wird er wie jeder Nachtrag
 * für sich verrechnet.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadMinderungCapacity = exports.checkMinderungAgainstBilled = exports.loadBillingBase = exports.loadMinderungSum = exports.billingTargetsForGroup = exports.minderungSumOf = exports.isMinderung = void 0;
const invoiceDrafts_1 = require("./invoiceDrafts");
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const isCancelled = (order) => Boolean(order.cancelledAt) || order.status === 'CANCELLED';
/** Ein aktiver Nachtrag mit negativer Summe. */
const isMinderung = (order) => Boolean(order.parentSalesOrderId) && !isCancelled(order) && Number(order.totalAmount || 0) < 0;
exports.isMinderung = isMinderung;
/** Summe (≤ 0) der aktiven Minderungen unter einem Hauptauftrag — aus schon geladenen Zeilen. */
const minderungSumOf = (addons) => round2((addons || [])
    .filter((addon) => !isCancelled(addon) && Number(addon.totalAmount || 0) < 0)
    .reduce((sum, addon) => sum + Number(addon.totalAmount || 0), 0));
exports.minderungSumOf = minderungSumOf;
/**
 * Rechnungsgrundlagen für einen Hauptauftrag und seine Nachträge — genau die
 * Ziele, die `GetBillingSummaryUseCase` braucht. Die Nachträge müssen
 * `totalAmount` und `cancelledAt` tragen.
 */
const billingTargetsForGroup = (order, addons, withStages = false) => [
    {
        salesOrderId: order.id,
        baseAmount: round2(Number(order.totalAmount || 0) + (0, exports.minderungSumOf)(addons)),
        ...(withStages ? { paymentStages: order.paymentStages ?? null } : {}),
    },
    ...(addons || []).map((addon) => ({
        salesOrderId: addon.id,
        baseAmount: Number(addon.totalAmount || 0) < 0 ? 0 : Number(addon.totalAmount || 0),
        ...(withStages ? { paymentStages: addon.paymentStages ?? null } : {}),
    })),
];
exports.billingTargetsForGroup = billingTargetsForGroup;
/** Summe (≤ 0) der aktiven Minderungen unter einem Hauptauftrag — mit Abfrage. */
const loadMinderungSum = async (db, tenantId, parentSalesOrderId, excludeAddonId) => {
    const result = await db.salesOrder.aggregate({
        where: {
            tenantId,
            parentSalesOrderId,
            cancelledAt: null,
            NOT: [{ status: 'CANCELLED' }, ...(excludeAddonId ? [{ id: excludeAddonId }] : [])],
            totalAmount: { lt: 0 },
        },
        _sum: { totalAmount: true },
    });
    return round2(Number(result?._sum?.totalAmount || 0));
};
exports.loadMinderungSum = loadMinderungSum;
/**
 * Rechnungsgrundlage EINES Auftrags: Hauptauftrag = Summe + aktive
 * Minderungen; Minderung selbst = 0; jeder andere Nachtrag = seine Summe.
 */
const loadBillingBase = async (db, tenantId, order) => {
    const total = Number(order.totalAmount || 0);
    if (order.parentSalesOrderId)
        return total < 0 ? 0 : total;
    return round2(total + await (0, exports.loadMinderungSum)(db, tenantId, order.id));
};
exports.loadBillingBase = loadBillingBase;
/**
 * DIE SCHRANKE: nach dem Speichern einer Minderung darf die Grundlage des
 * Hauptauftrags nicht unter das fallen, was an ihm schon verrechnet ist.
 * `nextAddonTotal` ist die künftige Summe des gespeicherten Nachtrags.
 * Gibt die Zahlen zurück, wenn die Schranke verletzt ist, sonst `null`.
 */
const checkMinderungAgainstBilled = async (db, opts) => {
    const { tenantId, parentSalesOrderId, addonId, nextAddonTotal } = opts;
    const [parent, otherMinderung, billedAgg] = await Promise.all([
        db.salesOrder.findFirst({ where: { id: parentSalesOrderId, tenantId }, select: { totalAmount: true } }),
        (0, exports.loadMinderungSum)(db, tenantId, parentSalesOrderId, addonId),
        db.invoice.aggregate({
            where: { tenantId, salesOrderId: parentSalesOrderId, ...invoiceDrafts_1.billedInvoiceWhere },
            _sum: { amount: true },
        }),
    ]);
    const base = round2(Number(parent?.totalAmount || 0) + otherMinderung + Math.min(0, nextAddonTotal));
    const billed = round2(Number(billedAgg?._sum?.amount || 0));
    return base < billed - 0.005 ? { billed, base } : null;
};
exports.checkMinderungAgainstBilled = checkMinderungAgainstBilled;
/**
 * WIE VIEL DARF WEGFALLEN? Je Artikel die Menge, die im Hauptauftrag steht:
 * die Offertpositionen dieses Artikels, dazu das Zusatzmaterial des Auftrags
 * und seiner aktiven Nachträge — abzüglich der Minderungen, die schon in
 * ANDEREN aktiven Nachträgen stehen. Eine Minderung eines Artikels, der im
 * Auftrag gar nicht vorkommt, ist keine Minderung.
 */
const loadMinderungCapacity = async (db, opts) => {
    const { tenantId, parent, excludeAddonId } = opts;
    const addons = await db.salesOrder.findMany({
        where: {
            tenantId,
            parentSalesOrderId: parent.id,
            cancelledAt: null,
            NOT: [{ status: 'CANCELLED' }, ...(excludeAddonId ? [{ id: excludeAddonId }] : [])],
        },
        select: { id: true },
    });
    const orderIds = [parent.id, ...addons.map((row) => row.id)];
    const [positions, extras] = await Promise.all([
        parent.tenderId
            ? db.position.findMany({
                where: { tenderId: parent.tenderId, tenantId, sourceArticleId: { not: null } },
                select: { sourceArticleId: true, quantity: true },
            })
            : Promise.resolve([]),
        db.projectExtraMaterial.findMany({
            where: { salesOrderId: { in: orderIds } },
            select: { articleId: true, quantity: true },
        }),
    ]);
    const capacity = new Map();
    const add = (articleId, quantity) => {
        if (!articleId || !Number.isFinite(quantity))
            return;
        capacity.set(articleId, round2((capacity.get(articleId) ?? 0) + quantity));
    };
    for (const row of positions)
        add(row.sourceArticleId, Math.max(0, Number(row.quantity || 0)));
    for (const row of extras)
        add(row.articleId, Number(row.quantity || 0));
    return capacity;
};
exports.loadMinderungCapacity = loadMinderungCapacity;
//# sourceMappingURL=minderung.js.map