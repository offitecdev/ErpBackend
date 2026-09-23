"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetProductionItemUseCase = void 0;
const production_1 = require("../../../domain/services/production");
const productionErrors_1 = require("./productionErrors");
const productionReadModel_1 = require("./productionReadModel");
/**
 * ── DAS GERÄT IM FENSTER ────────────────────────────────────────────────────
 * Ein Klick auf die Gerätekarte öffnet die Einzelheiten (Vorgabe Samet):
 * woher das Gerät kommt (Auftrag, Nachtrag, Projekt), was es im Verkauf wert
 * ist, und was dafür bestellt, angefragt und eingegangen ist.
 */
class GetProductionItemUseCase {
    projects;
    purchase;
    purchaseOrders;
    constructor(projects, purchase, purchaseOrders) {
        this.projects = projects;
        this.purchase = purchase;
        this.purchaseOrders = purchaseOrders;
    }
    async execute(tenantId, itemId) {
        const [item] = await this.projects.listItems(tenantId, { itemIds: [itemId] });
        if (!item)
            throw (0, productionErrors_1.productionError)('NOT_FOUND', 'Gerät nicht gefunden.', { status: 404 });
        const [project, orders, siblings, context] = await Promise.all([
            this.projects.getProject(tenantId, item.productionProjectId),
            this.projects.listOrders(tenantId, [item.productionProjectId]),
            this.projects.listItems(tenantId, { projectIds: [item.productionProjectId] }),
            (0, productionReadModel_1.loadPurchaseContext)(tenantId, [item.productionProjectId], this.purchase, this.purchaseOrders),
        ]);
        const order = orders.find((entry) => entry.id === item.productionOrderId) ?? null;
        const parent = order?.parentSalesOrderId
            ? orders.find((entry) => entry.sourceSalesOrderId === order.parentSalesOrderId) ?? null
            : null;
        const figures = (0, productionReadModel_1.projectFiguresFor)(siblings, context.confirmed, context.openRows);
        const statusOf = (id) => context.purchaseOrders.get(id)?.status ?? null;
        return {
            item: (0, productionReadModel_1.itemDto)(item),
            order: order ? (0, productionReadModel_1.orderDto)(order) : null,
            parentOrder: parent ? (0, productionReadModel_1.orderDto)(parent) : null,
            project: project ? (0, productionReadModel_1.projectDto)(project) : null,
            figures: figures.byItem.get(item.id) ?? (0, production_1.emptyCostFigures)(),
            confirmedLines: context.confirmed
                .filter((line) => line.productionItemId === item.id)
                .map((line) => (0, productionReadModel_1.confirmedLineDto)(line, statusOf(line.purchaseOrderId))),
            openRows: context.priceRows.filter((row) => !row.approved && row.productionItemId === item.id),
        };
    }
}
exports.GetProductionItemUseCase = GetProductionItemUseCase;
//# sourceMappingURL=GetProductionItemUseCase.js.map