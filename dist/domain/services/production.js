"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APPROVED_PURCHASE_STATUSES = exports.OPEN_PURCHASE_STATUSES = exports.sumCostFigures = exports.costFiguresByItem = exports.receivedValueOf = exports.finishCostFigures = exports.emptyCostFigures = exports.effectiveNetPrice = exports.assignPurchaseLines = exports.parseAssignmentItemIds = exports.parsePurchaseLines = exports.restrictToOrderedDevices = exports.planProductionSnapshot = exports.itemSourceKey = exports.PRODUCTION_ORDER_TYPES = exports.round2 = void 0;
/**
 * ── DIE REGELN DES PRODUKTIONSMODULS ────────────────────────────────────────
 *
 * Reine Funktionen, ohne Datenbank: wie aus den Aufträgen einer Firma
 * Produktionsprojekte werden, wie eine Bestellzeile ihr Gerät findet und wie
 * Verkauf und Einkauf einander gegenübergestellt werden. Die Anwendungsschicht
 * liest, ruft diese Regeln auf und schreibt.
 */
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
exports.round2 = round2;
/* ═══════════════════════════════════════════════════════════════════════════
   1) AUS DEN AUFTRÄGEN WERDEN PRODUKTIONSPROJEKTE
   ═════════════════════════════════════════════════════════════════════════ */
/** Die Auftragsarten, die in die Produktion gehen (Regie-Einsätze nicht). */
exports.PRODUCTION_ORDER_TYPES = ['PROJECT_NEW', 'PROJECT_EXISTING', 'INVOICE', 'PROJECT_ADDON'];
const itemSourceKey = (sourceType, sourceId) => `${sourceType}:${sourceId}`;
exports.itemSourceKey = itemSourceKey;
const isCancelled = (status) => String(status || '').toUpperCase() === 'CANCELLED';
/** Ein Lieferauftrag hat kein Projekt (Vorgabe: «teslimat siparişi doğrudan müşteriye gider»). */
const sourceKindOf = (main) => main.orderType === 'INVOICE' || !main.projectId ? 'DELIVERY' : 'PROJECT';
const projectKeyOf = (main) => sourceKindOf(main) === 'PROJECT' ? `P:${main.projectId}` : `D:${main.id}`;
/**
 * Der Titel eines Produktionsprojekts. Die ERP-Projekte tragen als Namen oft
 * nur ihre Nummer («PR-2026-10008») — dann ist die Referenz der Offerte oder
 * der Kunde die sprechendere Angabe.
 */
const titleOf = (main, number) => {
    const candidates = [
        main.projectName && main.projectName.trim() !== number ? main.projectName : null,
        main.reference,
        main.customerName,
    ];
    const found = candidates.map((value) => String(value ?? '').trim()).find(Boolean);
    return (found || number).slice(0, 255);
};
const planProductionSnapshot = (source, existing, newId) => {
    const orderById = new Map(source.orders.map((order) => [order.id, order]));
    const mainOf = (order) => order.parentSalesOrderId ? orderById.get(order.parentSalesOrderId) ?? null : order;
    const projects = new Map();
    const orders = new Map();
    /* Die Aufträge der Reihe nach: der älteste Hauptauftrag gibt dem Projekt
       seinen Titel, Nachträge kommen nach ihrem Hauptauftrag. */
    const sorted = [...source.orders].sort((a, b) => (a.orderDate?.getTime() ?? 0) - (b.orderDate?.getTime() ?? 0) || a.orderNumber.localeCompare(b.orderNumber));
    for (const order of sorted) {
        const main = mainOf(order);
        if (!main)
            continue;
        const key = projectKeyOf(main);
        const kind = sourceKindOf(main);
        let project = projects.get(key);
        if (!project) {
            const number = String((kind === 'PROJECT' ? main.projectNumber : null) || main.orderNumber).slice(0, 191);
            project = {
                id: existing.projectIdByKey.get(key) ?? newId(),
                sourceTenantId: main.tenantId,
                sourceKey: key,
                sourceKind: kind,
                sourceProjectId: kind === 'PROJECT' ? main.projectId : null,
                sourceSalesOrderId: kind === 'DELIVERY' ? main.id : null,
                projectNumber: number,
                projectName: titleOf(main, number),
                customerName: main.customerName ? main.customerName.slice(0, 255) : null,
                sourceStatus: (kind === 'PROJECT' ? main.projectStatus : main.status) ?? null,
                salesTotal: 0,
                isActive: false,
            };
            projects.set(key, project);
        }
        const orderKind = order.parentSalesOrderId ? 'ADDON' : (kind === 'PROJECT' ? 'PROJECT' : 'DELIVERY');
        const active = !isCancelled(order.status) && !(order.parentSalesOrderId && isCancelled(main.status));
        orders.set(order.id, {
            id: existing.orderIdBySalesOrder.get(order.id) ?? newId(),
            productionProjectId: project.id,
            sourceSalesOrderId: order.id,
            parentSalesOrderId: order.parentSalesOrderId,
            orderNumber: order.orderNumber.slice(0, 191),
            orderType: order.orderType.slice(0, 40),
            orderKind,
            orderDate: order.orderDate,
            status: String(order.status || 'ORDERED').slice(0, 24),
            totalAmount: (0, exports.round2)(order.totalAmount),
            isActive: active,
        });
        // Ein Projekt lebt, solange einer seiner Aufträge lebt — und das
        // ERP-Projekt selbst nicht storniert ist.
        if (active && !(kind === 'PROJECT' && isCancelled(main.projectStatus)))
            project.isActive = true;
    }
    const items = [];
    for (const line of source.lines) {
        const order = orders.get(line.orderId);
        if (!order)
            continue;
        const key = (0, exports.itemSourceKey)(line.sourceType, line.sourceId);
        const item = {
            id: existing.itemIdBySource.get(key) ?? newId(),
            productionProjectId: order.productionProjectId,
            productionOrderId: order.id,
            sourceType: line.sourceType,
            sourceId: line.sourceId,
            kind: line.kind,
            positionNumber: line.positionNumber ? line.positionNumber.slice(0, 40) : null,
            name: (line.name || '—').slice(0, 500),
            description: line.description ? line.description.slice(0, 4000) : null,
            articleId: line.articleId,
            articleCode: line.articleCode ? line.articleCode.slice(0, 191) : null,
            quantity: Number(line.quantity) || 0,
            unit: line.unit ? line.unit.slice(0, 40) : null,
            unitPrice: Number(line.unitPrice) || 0,
            totalPrice: (0, exports.round2)(line.totalPrice),
            sortOrder: line.sortOrder,
            isActive: order.isActive,
        };
        items.push(item);
    }
    const projectById = new Map([...projects.values()].map((project) => [project.id, project]));
    for (const item of items) {
        if (!item.isActive)
            continue;
        const project = projectById.get(item.productionProjectId);
        if (project)
            project.salesTotal = (0, exports.round2)(project.salesTotal + item.totalPrice);
    }
    return { projects: [...projects.values()], orders: [...orders.values()], items };
};
exports.planProductionSnapshot = planProductionSnapshot;
/**
 * «Üretim şirketindeki Projelerim modülüne artık cihazlar otomatik/toplu
 *  çekilmemeli. Yalnızca siparişi verilip onaylanan cihazlar ilgili projeye
 *  dahil edilmeli; aynı projeye ait cihazlar sipariş onaylandıkça projede
 *  toplanmalı.»
 *
 * Der Abgleich liest weiter die ganzen Aufträge (die Ids bleiben stabil), aber
 * AKTIV bleibt nur:
 *   · eine Offertposition, für die eine bestätigte interne Bestellung besteht
 *     — mit deren Menge (nicht der Auftragsmenge) und anteiligem Betrag;
 *   · was schon eigene Lieferantenbestellungen trägt (sonst zeigten diese
 *     Bestellungen ins Leere);
 * ein Auftrag lebt, solange eines seiner Geräte lebt, ein Projekt ebenso.
 */
const restrictToOrderedDevices = (plan, demand) => {
    const items = plan.items.map((item) => {
        if (!item.isActive)
            return item;
        const ordered = item.sourceType === 'POSITION' ? demand.orderedByPosition.get(item.sourceId) : undefined;
        if (ordered !== undefined && ordered > 0) {
            const share = item.quantity > 0 ? ordered / item.quantity : 1;
            return { ...item, quantity: ordered, totalPrice: (0, exports.round2)(item.totalPrice * share) };
        }
        if (demand.pinnedItemIds.has(item.id))
            return item;
        return { ...item, isActive: false };
    });
    const liveOrders = new Set(items.filter((item) => item.isActive).map((item) => item.productionOrderId));
    const liveProjects = new Set(items.filter((item) => item.isActive).map((item) => item.productionProjectId));
    const orders = plan.orders.map((order) => ({
        ...order,
        isActive: order.isActive && (liveOrders.has(order.id) || demand.pinnedProjectIds.has(order.productionProjectId)),
    }));
    const totals = new Map();
    for (const item of items) {
        if (item.isActive)
            totals.set(item.productionProjectId, (0, exports.round2)((totals.get(item.productionProjectId) ?? 0) + item.totalPrice));
    }
    const projects = plan.projects.map((project) => ({
        ...project,
        isActive: project.isActive && (liveProjects.has(project.id) || demand.pinnedProjectIds.has(project.id)),
        salesTotal: totals.get(project.id) ?? 0,
    }));
    return { projects, orders, items };
};
exports.restrictToOrderedDevices = restrictToOrderedDevices;
/* ═══════════════════════════════════════════════════════════════════════════
   2) DIE BESTELLZEILE UND IHR GERÄT
   ═════════════════════════════════════════════════════════════════════════ */
/**
 * Die Zeilen einer Lieferantenbestellung aus ihrer JSON-Spalte `items` — nur
 * die Felder, die die Produktion braucht.
 */
const parsePurchaseLines = (raw) => {
    let items = raw;
    if (typeof items === 'string') {
        try {
            items = JSON.parse(items);
        }
        catch {
            items = [];
        }
    }
    if (!Array.isArray(items))
        return [];
    return items.map((item, index) => ({
        index,
        articleId: item?.articleId ? String(item.articleId) : null,
        code: item?.code ? String(item.code) : null,
        name: String(item?.name ?? ''),
        unit: item?.unit ? String(item.unit) : null,
        quantity: Number(item?.quantity) || 0,
        grossPrice: Number(item?.grossPrice) || 0,
        netPrice: Number(item?.netPrice) || 0,
        discount: Number(item?.discount) || 0,
        discount2: Number(item?.discount2) || 0,
        lineTotal: Number(item?.lineTotal) || 0,
        calcMode: item?.calcMode ? String(item.calcMode) : null,
        receivedQuantity: Number(item?.receivedQuantity) || 0,
        productionItemId: typeof item?.productionItemId === 'string' && item.productionItemId ? item.productionItemId : null,
    }));
};
exports.parsePurchaseLines = parsePurchaseLines;
/* ═══════════════════════════════════════════════════════════════════════════
   2a) DIE GEWÄHLTEN GERÄTE EINER BESTELLUNG
   ═════════════════════════════════════════════════════════════════════════ */
/**
 * Die Spalte `productionItemIds` ist eine Liste von Ids — eine Bestellung
 * betrifft ein Gerät oder eine Leistung GANZ: «cihazı seçince işte eklensin»
 * (Vorgabe Samet, 20.09.2026, nach einem kurzen Versuch mit Mengen). Zeilen
 * aus diesem Versuch können `[{ id, quantity }]` tragen — auch die werden
 * gelesen, die Menge wird dabei verworfen.
 */
const parseAssignmentItemIds = (raw) => {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            value = [];
        }
    }
    if (!Array.isArray(value))
        return [];
    const ids = [];
    for (const entry of value) {
        const id = (typeof entry === 'string' ? entry : String(entry?.id ?? '')).trim();
        if (id && !ids.includes(id))
            ids.push(id);
    }
    return ids;
};
exports.parseAssignmentItemIds = parseAssignmentItemIds;
/**
 * Welche Zeile zu welchem Gerät gehört: NUR ihr eigenes Etikett
 * (`productionItemId`) sagt es. Ohne Etikett gehört die Zeile dem PROJEKT —
 * auch dann, wenn genau EIN Gerät gewählt ist (Vorgabe Samet, 20.09.2026:
 * «tek bir cihaza yüklenmesin … eğer cihaza etiketlenirse yüklensin»). Ein
 * Etikett, das nicht (mehr) zur Auswahl gehört, fällt weg; niemand muss
 * etikettieren.
 */
const assignPurchaseLines = (lines, selectedItemIds) => {
    const selected = new Set(selectedItemIds);
    return {
        itemIds: lines.map((line) => {
            const own = typeof line.productionItemId === 'string' ? line.productionItemId.trim() : '';
            return own && selected.has(own) ? own : null;
        }),
    };
};
exports.assignPurchaseLines = assignPurchaseLines;
/**
 * Der wirksame Nettopreis einer Bestellzeile. In der LIEFERANTENBERECHNUNG ist
 * `netPrice` der Preis des Lieferanten VOR den Zeilenrabatten; seit dem
 * 19.09.2026 wirken Rabatt und Rabatt 2 dort mit (Vorgabe: «girilen
 * indirimler tedarikçi hesaplamalarına ve satır toplamlarına yansımalı»).
 */
const effectiveNetPrice = (line) => {
    const net = Number(line.netPrice) || 0;
    if (String(line.calcMode || '').toUpperCase() !== 'SUPPLIER')
        return net;
    const factor = (1 - clampPercent(line.discount) / 100) * (1 - clampPercent(line.discount2) / 100);
    return net * factor;
};
exports.effectiveNetPrice = effectiveNetPrice;
const clampPercent = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return 0;
    return Math.min(100, Math.max(0, parsed));
};
const emptyCostFigures = () => ({
    salesTotal: 0, openTotal: 0, orderedTotal: 0, receivedTotal: 0, difference: 0, marginPercent: null,
});
exports.emptyCostFigures = emptyCostFigures;
const finishCostFigures = (figures) => {
    const salesTotal = (0, exports.round2)(figures.salesTotal);
    const orderedTotal = (0, exports.round2)(figures.orderedTotal);
    const difference = (0, exports.round2)(salesTotal - orderedTotal);
    return {
        salesTotal,
        openTotal: (0, exports.round2)(figures.openTotal),
        orderedTotal,
        receivedTotal: (0, exports.round2)(figures.receivedTotal),
        difference,
        marginPercent: salesTotal > 0 ? Math.round((difference / salesTotal) * 1000) / 10 : null,
    };
};
exports.finishCostFigures = finishCostFigures;
/** Der eingegangene Anteil einer bestätigten Zeile, in Franken. */
const receivedValueOf = (line) => {
    const quantity = Number(line.quantity) || 0;
    if (quantity <= 0)
        return 0;
    const share = Math.min(quantity, Math.max(0, Number(line.receivedQuantity) || 0)) / quantity;
    return (0, exports.round2)((Number(line.lineTotal) || 0) * share);
};
exports.receivedValueOf = receivedValueOf;
/**
 * Die Zahlen JE GERÄT (Schlüssel = Geräte-Id; `null` sammelt, was keinem Gerät
 * zugeordnet ist). Verkauf kommt vom Gerät, Einkauf aus den Bestellzeilen.
 */
const costFiguresByItem = (items, confirmed, open) => {
    const known = new Set(items.map((item) => item.id));
    const figures = new Map();
    const bucket = (id) => {
        const key = id && known.has(id) ? id : null;
        let entry = figures.get(key);
        if (!entry) {
            entry = (0, exports.emptyCostFigures)();
            figures.set(key, entry);
        }
        return entry;
    };
    for (const item of items) {
        const entry = bucket(item.id);
        if (item.isActive)
            entry.salesTotal += Number(item.totalPrice) || 0;
    }
    for (const line of confirmed) {
        const entry = bucket(line.productionItemId);
        entry.orderedTotal += Number(line.lineTotal) || 0;
        entry.receivedTotal += (0, exports.receivedValueOf)(line);
    }
    for (const row of open)
        bucket(row.productionItemId).openTotal += Number(row.lineTotal) || 0;
    for (const [key, entry] of figures)
        figures.set(key, (0, exports.finishCostFigures)(entry));
    return figures;
};
exports.costFiguresByItem = costFiguresByItem;
/** Mehrere Zahlenblöcke zusammenzählen (Projekt aus Geräten, Modul aus Projekten). */
const sumCostFigures = (list) => (0, exports.finishCostFigures)(list.reduce((acc, entry) => ({
    salesTotal: acc.salesTotal + entry.salesTotal,
    openTotal: acc.openTotal + entry.openTotal,
    orderedTotal: acc.orderedTotal + entry.orderedTotal,
    receivedTotal: acc.receivedTotal + entry.receivedTotal,
    difference: 0,
    marginPercent: null,
}), (0, exports.emptyCostFigures)()));
exports.sumCostFigures = sumCostFigures;
/** Bestellstufen, deren Preise noch OFFEN sind — alles vor der Bestätigung. */
exports.OPEN_PURCHASE_STATUSES = new Set(['DRAFT', 'PRICE_REQUEST', 'ORDER_DRAFT']);
/** Bestellstufen, in denen die Bestellung BESTÄTIGT ist. */
exports.APPROVED_PURCHASE_STATUSES = new Set(['PENDING', 'ORDERED', 'TO_BE_STOCKED', 'COMPLETED']);
//# sourceMappingURL=production.js.map