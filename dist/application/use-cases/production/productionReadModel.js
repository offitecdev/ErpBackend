"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectFiguresFor = exports.buildOrderTree = exports.loadPurchaseContext = exports.confirmedLineDto = exports.itemDto = exports.orderDto = exports.projectDto = void 0;
const production_1 = require("../../../domain/services/production");
const projectDto = (project) => ({
    id: project.id,
    sourceKind: project.sourceKind,
    projectNumber: project.projectNumber,
    projectName: project.projectName,
    customerName: project.customerName,
    sourceStatus: project.sourceStatus,
    sourceTenantId: project.sourceTenantId,
    salesTotal: project.salesTotal,
    isActive: project.isActive,
});
exports.projectDto = projectDto;
const orderDto = (order) => ({
    id: order.id,
    sourceSalesOrderId: order.sourceSalesOrderId,
    parentSalesOrderId: order.parentSalesOrderId,
    orderNumber: order.orderNumber,
    orderType: order.orderType,
    orderKind: order.orderKind,
    orderDate: order.orderDate ? order.orderDate.toISOString() : null,
    status: order.status,
    totalAmount: order.totalAmount,
    isActive: order.isActive,
});
exports.orderDto = orderDto;
const itemDto = (item) => ({
    id: item.id,
    productionProjectId: item.productionProjectId,
    productionOrderId: item.productionOrderId,
    sourceType: item.sourceType,
    kind: item.kind,
    positionNumber: item.positionNumber,
    name: item.name,
    description: item.description,
    articleCode: item.articleCode,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPrice,
    totalPrice: item.totalPrice,
    isActive: item.isActive,
});
exports.itemDto = itemDto;
const confirmedLineDto = (line, status) => ({
    id: line.id,
    purchaseOrderId: line.purchaseOrderId,
    purchaseOrderNumber: line.purchaseOrderNumber,
    purchaseStatus: status,
    supplierName: line.supplierName,
    currency: line.currency,
    productionProjectId: line.productionProjectId,
    productionItemId: line.productionItemId,
    lineIndex: line.lineIndex,
    code: line.code,
    name: line.name,
    unit: line.unit,
    quantity: line.quantity,
    grossPrice: line.grossPrice,
    discount: line.discount,
    discount2: line.discount2,
    netPrice: line.netPrice,
    lineTotal: line.lineTotal,
    receivedQuantity: line.receivedQuantity,
    approvedAt: line.approvedAt.toISOString(),
});
exports.confirmedLineDto = confirmedLineDto;
/**
 * Liest in drei Abfragen, was die Einkaufsseite der Projekte ausmacht: die
 * Zuordnungen, die zugehörigen Bestellungen und die bestätigten Zeilen. Die
 * offenen Preise kommen aus den Bestellungen selbst — sie haben noch keine
 * Zeile in `uretim_siparisleri`.
 */
const loadPurchaseContext = async (tenantId, projectIds, purchase, purchaseOrders) => {
    if (!projectIds.length) {
        return { assignments: [], purchaseOrders: new Map(), confirmed: [], priceRows: [], openRows: [] };
    }
    const [assignments, confirmed] = await Promise.all([
        purchase.listAssignments(tenantId, { projectIds }),
        purchase.listLines(tenantId, { projectIds }),
    ]);
    const orders = await purchaseOrders.findByIds(tenantId, [...new Set(assignments.map((entry) => entry.purchaseOrderId))]);
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const priceRows = [];
    const openRows = [];
    for (const assignment of assignments) {
        const order = orderById.get(assignment.purchaseOrderId);
        if (!order)
            continue;
        const resolved = (0, production_1.assignPurchaseLines)(order.items, assignment.productionItemIds);
        const approved = production_1.APPROVED_PURCHASE_STATUSES.has(order.status);
        order.items.forEach((line, index) => {
            const net = (0, production_1.effectiveNetPrice)(line);
            const priced = line.lineTotal > 0 || net > 0 || line.grossPrice > 0;
            if (!priced)
                return;
            const itemId = resolved.itemIds[index] ?? null;
            priceRows.push({
                purchaseOrderId: order.id,
                referenceNumber: order.referenceNumber,
                status: order.status,
                approved,
                supplierName: order.supplierName,
                currency: order.currency,
                createdAt: order.createdAt.toISOString(),
                lineIndex: index,
                code: line.code,
                name: line.name,
                unit: line.unit,
                quantity: line.quantity,
                grossPrice: line.grossPrice,
                discount: line.discount,
                discount2: line.discount2,
                // Vier Stellen: ein Lieferantenpreis kann mehr als Rappen tragen.
                netPrice: Math.round(net * 10_000) / 10_000,
                lineTotal: line.lineTotal,
                productionItemId: itemId,
            });
            if (production_1.OPEN_PURCHASE_STATUSES.has(order.status)) {
                openRows.push({ productionItemId: itemId, lineTotal: line.lineTotal, productionProjectId: assignment.productionProjectId });
            }
        });
    }
    return { assignments, purchaseOrders: orderById, confirmed, priceRows, openRows };
};
exports.loadPurchaseContext = loadPurchaseContext;
/**
 * Der Auftragsbaum eines Projekts: Hauptaufträge mit ihren Geräten, die
 * Nachträge darunter — jede Ebene mit ihren Zahlen.
 */
const buildOrderTree = (orders, items, figuresByItem) => {
    const itemsByOrder = new Map();
    for (const item of items) {
        const list = itemsByOrder.get(item.productionOrderId) ?? [];
        list.push(item);
        itemsByOrder.set(item.productionOrderId, list);
    }
    const node = (order) => {
        const own = (itemsByOrder.get(order.id) ?? []).map((item) => ({
            item: (0, exports.itemDto)(item),
            figures: figuresByItem.get(item.id) ?? (0, production_1.emptyCostFigures)(),
        }));
        return {
            order: (0, exports.orderDto)(order),
            figures: (0, production_1.sumCostFigures)(own.map((entry) => entry.figures)),
            items: own,
            addons: [],
        };
    };
    const bySalesOrder = new Map();
    const mains = [];
    const addons = [];
    for (const order of orders) {
        const built = node(order);
        bySalesOrder.set(order.sourceSalesOrderId, built);
        if (order.parentSalesOrderId)
            addons.push({ parent: order.parentSalesOrderId, node: built });
        else
            mains.push(built);
    }
    for (const entry of addons) {
        const parent = bySalesOrder.get(entry.parent);
        if (parent)
            parent.addons.push(entry.node);
        else
            mains.push(entry.node);
    }
    // Die Zahlen eines Hauptauftrags schliessen seine Nachträge NICHT ein —
    // jede Zeile zeigt ihre eigenen; das Projekt zählt alles.
    return mains;
};
exports.buildOrderTree = buildOrderTree;
const projectFiguresFor = (items, confirmed, openRows) => {
    const byItem = (0, production_1.costFiguresByItem)(items, confirmed, openRows);
    return { byItem, total: (0, production_1.sumCostFigures)([...byItem.values()]) };
};
exports.projectFiguresFor = projectFiguresFor;
//# sourceMappingURL=productionReadModel.js.map