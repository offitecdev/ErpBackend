import type {
    ProductionAssignment,
    ProductionItem,
    ProductionOrderLine,
    ProductionProject,
    ProductionProjectOrder,
    PurchaseOrderView,
} from '../../../domain/entities/Production';
import type {
    IProductionPurchaseRepository,
    IPurchaseOrderReader,
} from '../../../domain/repositories/IProductionRepository';
import {
    APPROVED_PURCHASE_STATUSES,
    OPEN_PURCHASE_STATUSES,
    assignPurchaseLines,
    costFiguresByItem,
    effectiveNetPrice,
    emptyCostFigures,
    sumCostFigures,
    type CostFigures,
    type OpenPriceRow,
} from '../../../domain/services/production';

/* ═══════════════════════════════════════════════════════════════════════════
   WAS DIE OBERFLÄCHE BEKOMMT
   ═════════════════════════════════════════════════════════════════════════ */

export interface ProjectDto {
    id: string;
    sourceKind: ProductionProject['sourceKind'];
    projectNumber: string;
    projectName: string;
    customerName: string | null;
    sourceStatus: string | null;
    sourceTenantId: string;
    salesTotal: number;
    isActive: boolean;
}

export interface OrderDto {
    id: string;
    sourceSalesOrderId: string;
    parentSalesOrderId: string | null;
    orderNumber: string;
    orderType: string;
    orderKind: ProductionProjectOrder['orderKind'];
    orderDate: string | null;
    status: string;
    totalAmount: number;
    isActive: boolean;
}

export interface ItemDto {
    id: string;
    productionProjectId: string;
    productionOrderId: string;
    sourceType: ProductionItem['sourceType'];
    kind: ProductionItem['kind'];
    positionNumber: string | null;
    name: string;
    description: string | null;
    articleCode: string | null;
    quantity: number;
    unit: string | null;
    unitPrice: number;
    totalPrice: number;
    isActive: boolean;
}

export interface ItemNodeDto {
    item: ItemDto;
    figures: CostFigures;
}

export interface OrderNodeDto {
    order: OrderDto;
    figures: CostFigures;
    items: ItemNodeDto[];
    /** Nachträge (NT) unter ihrem Hauptauftrag — wie in der Auftragsliste. */
    addons: OrderNodeDto[];
}

export interface ConfirmedLineDto {
    id: string;
    purchaseOrderId: string;
    purchaseOrderNumber: string;
    purchaseStatus: string | null;
    supplierName: string | null;
    currency: string;
    productionProjectId: string;
    productionItemId: string | null;
    lineIndex: number;
    code: string | null;
    name: string;
    unit: string | null;
    quantity: number;
    grossPrice: number;
    discount: number;
    discount2: number;
    netPrice: number;
    lineTotal: number;
    receivedQuantity: number;
    approvedAt: string;
}

/** Eine Preiszeile einer Bestellung (Reiter 1 der Projektseite). */
export interface PriceRowDto {
    purchaseOrderId: string;
    referenceNumber: string;
    status: string;
    approved: boolean;
    supplierName: string | null;
    currency: string;
    createdAt: string;
    lineIndex: number;
    code: string | null;
    name: string;
    unit: string | null;
    quantity: number;
    grossPrice: number;
    discount: number;
    discount2: number;
    netPrice: number;
    lineTotal: number;
    productionItemId: string | null;
}

export const projectDto = (project: ProductionProject): ProjectDto => ({
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

export const orderDto = (order: ProductionProjectOrder): OrderDto => ({
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

export const itemDto = (item: ProductionItem): ItemDto => ({
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

export const confirmedLineDto = (line: ProductionOrderLine, status: string | null): ConfirmedLineDto => ({
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

/* ═══════════════════════════════════════════════════════════════════════════
   DIE EINKAUFSSEITE EINES ODER MEHRERER PROJEKTE
   ═════════════════════════════════════════════════════════════════════════ */

export interface PurchaseContext {
    assignments: ProductionAssignment[];
    purchaseOrders: Map<string, PurchaseOrderView>;
    confirmed: ProductionOrderLine[];
    /** Alle Preiszeilen der zugeordneten Bestellungen (offen UND bestätigt). */
    priceRows: PriceRowDto[];
    /** Nur die offenen (noch nicht bestätigten) — für den Vergleich. */
    openRows: Array<OpenPriceRow & { productionProjectId: string }>;
}

/**
 * Liest in drei Abfragen, was die Einkaufsseite der Projekte ausmacht: die
 * Zuordnungen, die zugehörigen Bestellungen und die bestätigten Zeilen. Die
 * offenen Preise kommen aus den Bestellungen selbst — sie haben noch keine
 * Zeile in `uretim_siparisleri`.
 */
export const loadPurchaseContext = async (
    tenantId: string,
    projectIds: string[],
    purchase: IProductionPurchaseRepository,
    purchaseOrders: IPurchaseOrderReader,
): Promise<PurchaseContext> => {
    if (!projectIds.length) {
        return { assignments: [], purchaseOrders: new Map(), confirmed: [], priceRows: [], openRows: [] };
    }
    const [assignments, confirmed] = await Promise.all([
        purchase.listAssignments(tenantId, { projectIds }),
        purchase.listLines(tenantId, { projectIds }),
    ]);
    const orders = await purchaseOrders.findByIds(tenantId, [...new Set(assignments.map((entry) => entry.purchaseOrderId))]);
    const orderById = new Map(orders.map((order) => [order.id, order]));

    const priceRows: PriceRowDto[] = [];
    const openRows: PurchaseContext['openRows'] = [];
    for (const assignment of assignments) {
        const order = orderById.get(assignment.purchaseOrderId);
        if (!order) continue;
        const resolved = assignPurchaseLines(order.items, assignment.productionItemIds);
        const approved = APPROVED_PURCHASE_STATUSES.has(order.status);
        order.items.forEach((line, index) => {
            const net = effectiveNetPrice(line);
            const priced = line.lineTotal > 0 || net > 0 || line.grossPrice > 0;
            if (!priced) return;
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
            if (OPEN_PURCHASE_STATUSES.has(order.status)) {
                openRows.push({ productionItemId: itemId, lineTotal: line.lineTotal, productionProjectId: assignment.productionProjectId });
            }
        });
    }
    return { assignments, purchaseOrders: orderById, confirmed, priceRows, openRows };
};

/**
 * Der Auftragsbaum eines Projekts: Hauptaufträge mit ihren Geräten, die
 * Nachträge darunter — jede Ebene mit ihren Zahlen.
 */
export const buildOrderTree = (
    orders: ProductionProjectOrder[],
    items: ProductionItem[],
    figuresByItem: Map<string | null, CostFigures>,
): OrderNodeDto[] => {
    const itemsByOrder = new Map<string, ProductionItem[]>();
    for (const item of items) {
        const list = itemsByOrder.get(item.productionOrderId) ?? [];
        list.push(item);
        itemsByOrder.set(item.productionOrderId, list);
    }
    const node = (order: ProductionProjectOrder): OrderNodeDto => {
        const own = (itemsByOrder.get(order.id) ?? []).map((item) => ({
            item: itemDto(item),
            figures: figuresByItem.get(item.id) ?? emptyCostFigures(),
        }));
        return {
            order: orderDto(order),
            figures: sumCostFigures(own.map((entry) => entry.figures)),
            items: own,
            addons: [],
        };
    };
    const bySalesOrder = new Map<string, OrderNodeDto>();
    const mains: OrderNodeDto[] = [];
    const addons: Array<{ parent: string; node: OrderNodeDto }> = [];
    for (const order of orders) {
        const built = node(order);
        bySalesOrder.set(order.sourceSalesOrderId, built);
        if (order.parentSalesOrderId) addons.push({ parent: order.parentSalesOrderId, node: built });
        else mains.push(built);
    }
    for (const entry of addons) {
        const parent = bySalesOrder.get(entry.parent);
        if (parent) parent.addons.push(entry.node);
        else mains.push(entry.node);
    }
    // Die Zahlen eines Hauptauftrags schliessen seine Nachträge NICHT ein —
    // jede Zeile zeigt ihre eigenen; das Projekt zählt alles.
    return mains;
};

export const projectFiguresFor = (
    items: ProductionItem[],
    confirmed: ProductionOrderLine[],
    openRows: OpenPriceRow[],
): { byItem: Map<string | null, CostFigures>; total: CostFigures } => {
    const byItem = costFiguresByItem(items, confirmed, openRows);
    return { byItem, total: sumCostFigures([...byItem.values()]) };
};
