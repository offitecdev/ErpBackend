"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newestFirst = exports.revisionEvents = exports.receiptEvents = exports.PROCUREMENT_EVENT_ACTIONS = exports.stageOf = exports.docStateOf = exports.receivedShareOf = void 0;
const productionBom_1 = require("./productionBom");
const EPS = 1e-9;
const priced = (item) => Number(item.grossPrice) > EPS || Number(item.netPrice) > EPS;
const receivedShareOf = (items) => {
    let ordered = 0;
    let received = 0;
    for (const item of items) {
        ordered += Math.max(0, Number(item.quantity) || 0);
        received += Math.max(0, Number(item.receivedQuantity) || 0);
    }
    return ordered > EPS ? Math.min(1, received / ordered) : 0;
};
exports.receivedShareOf = receivedShareOf;
/** Eine Preisanfrage ist beantwortet, sobald die Antwort des Lieferanten oder seine Preise da sind. */
const docStateOf = (doc) => {
    const status = String(doc.status).toUpperCase();
    if (status === 'CANCELLED')
        return 'CANCELLED';
    if (doc.kind === 'REQUEST') {
        if (doc.hasQuoteFile || (doc.items.length > 0 && doc.items.every(priced)))
            return 'REPLIED';
        return status === 'PRICE_REQUEST' || doc.emailSentAt ? 'SENT' : 'DRAFT';
    }
    if (status === 'COMPLETED')
        return 'RECEIVED';
    if (productionBom_1.CONFIRMED_ORDER_STATUSES.has(status))
        return (0, exports.receivedShareOf)(doc.items) >= 1 - EPS ? 'RECEIVED' : 'CONFIRMED';
    // Die Bestätigung galt der alten Fassung: nach einer Revision geht sie neu hinaus.
    // Ging die geänderte Fassung schon hinaus (automatisch oder von Hand), wartet
    // sie auf die Bestätigung des Lieferanten wie jede gesendete (30.09.2026).
    if (doc.orderRevision > 0) {
        const resent = doc.emailSentAt && doc.revisedAt && doc.emailSentAt.getTime() >= doc.revisedAt.getTime();
        return resent ? 'SENT' : 'REVISED';
    }
    return doc.emailSentAt || status === 'ORDERED' ? 'SENT' : 'DRAFT';
};
exports.docStateOf = docStateOf;
const stage = (key, done, total, action = null, purchaseOrderId = null) => ({ key, done, total, next: action ? { action, purchaseOrderId } : null });
const holds = (doc, bomLineId) => doc.lines.some((line) => line.bomLineId === bomLineId);
/**
 * ORDER: erst bestellen (alle Zeilen in einer Bestellung), dann jede
 * Bestellung mit dem Angebot bestätigen, dann die Ware annehmen.
 * PRICE: erst anfragen, dann die Antworten einlesen, dann vergleichen.
 * Ein geschlossener Talep bestellt nichts mehr — was schon unterwegs ist,
 * bleibt zu erledigen.
 */
const stageOf = (request, docs) => {
    if (request.status === 'CANCELLED')
        return stage('CANCELLED', 0, 0);
    const open = request.status !== 'DONE';
    const live = docs.filter((doc) => doc.state !== 'CANCELLED');
    /* «Fiyat talebinden satın almaya dönüşünce direkt labelı o oluyor»
       (30.09.2026): hat ein Preistalep Bestellungen (aus dem Vergleich), folgt
       sein Stand diesen Bestellungen — gesendet, bestätigt, geliefert. */
    if (request.kind === 'PRICE' && live.some((doc) => doc.kind === 'ORDER')) {
        return ordersStage(request, live.filter((doc) => doc.kind === 'ORDER'), false);
    }
    if (request.kind === 'PRICE') {
        const asks = live.filter((doc) => doc.kind === 'REQUEST');
        const replied = asks.filter((doc) => doc.state === 'REPLIED').length;
        if (!open)
            return stage('DONE', replied, asks.length);
        const uncovered = request.lines.some((line) => !asks.some((doc) => holds(doc, line.bomLineId)));
        if (!asks.length || uncovered || asks.some((doc) => doc.state === 'DRAFT')) {
            return stage('PRICE_NEEDED', asks.filter((doc) => doc.state !== 'DRAFT').length, Math.max(asks.length, 1), 'ASK');
        }
        const waiting = asks.find((doc) => doc.state === 'SENT');
        if (waiting)
            return stage('REPLIES_EXPECTED', replied, asks.length, 'REPLY', waiting.purchaseOrderId);
        return stage('COMPARE', replied, asks.length, 'COMPARE');
    }
    const orders = live.filter((doc) => doc.kind === 'ORDER');
    const covered = request.lines.filter((line) => orders.some((doc) => holds(doc, line.bomLineId))).length;
    if (open && covered < request.lines.length)
        return stage('ORDER_NEEDED', covered, request.lines.length, 'ORDER');
    return ordersStage(request, orders, true);
};
exports.stageOf = stageOf;
/**
 * Der Stand der Bestellungen eines Talep. `legacy` = ein Satın alma talebi
 * von vor dem 30.09.2026 (Knopf «Teklif ekle»/«Onayla»); ein Preistalep mit
 * Bestellungen kennt die Automatik: Entwurf → «Onayla ve gönder», beim
 * Lieferanten → «Onay bekliyor».
 */
const ordersStage = (request, orders, legacy) => {
    const pending = orders.find((doc) => doc.state === 'DRAFT' || doc.state === 'SENT' || doc.state === 'REVISED');
    if (pending) {
        const confirmed = orders.filter((doc) => doc.state === 'CONFIRMED' || doc.state === 'RECEIVED').length;
        const action = pending.state === 'REVISED'
            ? 'RESEND'
            : legacy
                ? (pending.hasQuote ? 'CONFIRM' : 'QUOTE')
                : pending.state === 'DRAFT' ? 'SEND' : 'AWAIT';
        return stage(!legacy && pending.state === 'SENT' ? 'CONFIRMATION_EXPECTED' : 'QUOTE_NEEDED', confirmed, orders.length, action, pending.purchaseOrderId);
    }
    // Eine Zeile ist da, wenn ihre bestellte Menge vollständig eingegangen ist.
    // Beim Preistalep zählen nur die bestellten Zeilen (was im Lager war, wird nicht bestellt).
    const lines = legacy ? request.lines : request.lines.filter((line) => orders.some((doc) => holds(doc, line.bomLineId)));
    const arrived = lines.filter((line) => {
        let ordered = 0;
        let received = 0;
        for (const doc of orders) {
            for (const entry of doc.lines) {
                if (entry.bomLineId !== line.bomLineId)
                    continue;
                ordered += entry.quantity;
                received += entry.received;
            }
        }
        return ordered > EPS && received + EPS >= ordered;
    }).length;
    const expecting = orders.find((doc) => doc.state === 'CONFIRMED');
    if (expecting)
        return stage('GOODS_EXPECTED', arrived, lines.length, 'RECEIVE', expecting.purchaseOrderId);
    return stage('DONE', arrived, lines.length);
};
exports.PROCUREMENT_EVENT_ACTIONS = [
    'REQUEST_CREATED', 'REQUEST_WITHDRAWN', 'ORDERS_CREATED', 'PRICE_REQUESTS_CREATED', 'PRICE_REQUESTS_SENT',
    'ORDER_CONFIRMED', 'REPLY_ADDED', 'SELECTION_SAVED', 'COMPARISON_SAVED', 'ORDER_REVISED', 'GOODS_RECEIVED', 'REQUEST_CLOSED', 'REQUEST_CANCELLED', 'REQUEST_REOPENED',
    'ORDER_SENT', 'REVISION_SENT', 'SEND_FAILED', 'REPLY_RECEIVED', 'SUPPLIER_CONFIRMED',
];
/**
 * Der Wareneingang schreibt seine eigene Spur (uretim_bom_gelen_mallar, auch
 * vom Depo-Scan): EINE Buchung einer Bestellung = ein Eintrag im Verlauf.
 * `D…`/`S…` = im Depo gebucht, `R…` = hier von Hand.
 */
const receiptEvents = (rows) => {
    const groups = new Map();
    for (const row of rows) {
        if (!row.purchaseOrderId)
            continue;
        const key = `${row.receiptId}:${row.purchaseOrderId}`;
        const known = groups.get(key);
        if (known) {
            known.data.count = Number(known.data.count) + 1;
            if (row.receivedAt > known.at)
                known.at = row.receivedAt;
            continue;
        }
        groups.set(key, {
            action: 'GOODS_RECEIVED',
            at: row.receivedAt,
            actorId: row.receivedById ?? null,
            actorName: row.receivedByName ?? null,
            data: { code: row.referenceNumber, count: 1, depot: /^[DS]/.test(row.receiptId) },
        });
    }
    return [...groups.values()];
};
exports.receiptEvents = receiptEvents;
/**
 * Eine BOM-Revision änderte eine Bestellung beim Lieferanten (Archivzeile je
 * Revision der Bestellung): ein Handgriff im Verlauf — die Satın alma muss die
 * Änderung dem Lieferanten schicken (29.09.2026, Samet: «siparişte revize
 * olması gerekmez mi … tedarikçiyi PDF ile bilgilendirmemiz lazım»).
 */
const revisionEvents = (rows, orders) => rows.flatMap((row) => {
    const order = orders.get(row.purchaseOrderId);
    return order
        ? [{ action: 'ORDER_REVISED', at: row.createdAt, actorId: row.createdById, actorName: null, data: { code: order.code, supplier: order.supplier, revision: row.number } }]
        : [];
});
exports.revisionEvents = revisionEvents;
/** Neueste zuerst. */
const newestFirst = (events) => [...events].sort((a, b) => b.at.getTime() - a.at.getTime());
exports.newestFirst = newestFirst;
//# sourceMappingURL=procurementFlow.js.map