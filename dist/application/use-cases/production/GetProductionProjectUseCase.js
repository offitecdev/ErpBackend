"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetProductionProjectUseCase = void 0;
const production_1 = require("../../../domain/services/production");
const productionErrors_1 = require("./productionErrors");
const productionReadModel_1 = require("./productionReadModel");
/**
 * ── DIE PROJEKTSEITE DER PRODUKTION ─────────────────────────────────────────
 * Zwei Reiter (Vorgabe Samet): alle Rohzeilen MIT Preis, und die BESTÄTIGTEN
 * Bestellzeilen — sind im Projekt mehrere Geräte gewählt, gruppiert unter der
 * Überschrift ihres Geräts. Dazu der Kostenvergleich je Gerät.
 */
class GetProductionProjectUseCase {
    projects;
    purchase;
    purchaseOrders;
    tenants;
    constructor(projects, purchase, purchaseOrders, tenants) {
        this.projects = projects;
        this.purchase = purchase;
        this.purchaseOrders = purchaseOrders;
        this.tenants = tenants;
    }
    async execute(tenantId, projectId) {
        const project = await this.projects.getProject(tenantId, projectId);
        if (!project)
            throw (0, productionErrors_1.productionError)('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });
        const [orders, items, context, tenants] = await Promise.all([
            this.projects.listOrders(tenantId, [project.id]),
            this.projects.listItems(tenantId, { projectIds: [project.id] }),
            (0, productionReadModel_1.loadPurchaseContext)(tenantId, [project.id], this.purchase, this.purchaseOrders),
            this.tenants.list(),
        ]);
        const figures = (0, productionReadModel_1.projectFiguresFor)(items, context.confirmed, context.openRows);
        const tree = (0, productionReadModel_1.buildOrderTree)(orders, items, figures.byItem);
        /* Die Reihenfolge der Geräte ist die des Auftragsbaums: Hauptauftrag,
           seine Geräte, dann seine Nachträge — so, wie der Verkauf sie führt. */
        const ordered = [];
        const walk = (nodes) => nodes.forEach((node) => {
            node.items.forEach((entry) => ordered.push(entry.item));
            walk(node.addons);
        });
        walk(tree);
        const known = new Set(ordered.map((item) => item.id));
        const statusOf = (purchaseOrderId) => context.purchaseOrders.get(purchaseOrderId)?.status ?? null;
        const linesByItem = new Map();
        for (const line of context.confirmed) {
            const key = line.productionItemId && known.has(line.productionItemId) ? line.productionItemId : null;
            const list = linesByItem.get(key) ?? [];
            list.push((0, productionReadModel_1.confirmedLineDto)(line, statusOf(line.purchaseOrderId)));
            linesByItem.set(key, list);
        }
        const confirmedGroups = ordered
            .filter((item) => linesByItem.has(item.id))
            .map((item) => ({
            item,
            figures: figures.byItem.get(item.id) ?? (0, production_1.emptyCostFigures)(),
            lines: linesByItem.get(item.id) ?? [],
        }));
        if (linesByItem.has(null)) {
            confirmedGroups.push({ item: null, figures: figures.byItem.get(null) ?? (0, production_1.emptyCostFigures)(), lines: linesByItem.get(null) ?? [] });
        }
        const comparison = ordered
            .filter((item) => item.isActive || figures.byItem.get(item.id)?.orderedTotal)
            .map((item) => ({ item, figures: figures.byItem.get(item.id) ?? (0, production_1.emptyCostFigures)() }));
        if (figures.byItem.has(null))
            comparison.push({ item: null, figures: figures.byItem.get(null) });
        const purchaseOrders = context.assignments
            .map((assignment) => {
            const order = context.purchaseOrders.get(assignment.purchaseOrderId);
            return order ? {
                id: order.id,
                referenceNumber: order.referenceNumber,
                status: order.status,
                supplierName: order.supplierName,
                currency: order.currency,
                createdAt: order.createdAt.toISOString(),
                itemIds: assignment.productionItemIds,
            } : null;
        })
            .filter((entry) => Boolean(entry))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
            project: {
                ...(0, productionReadModel_1.projectDto)(project),
                sourceTenantName: tenants.find((tenant) => tenant.id === project.sourceTenantId)?.name ?? null,
            },
            figures: figures.total,
            orders: tree,
            priceRows: context.priceRows,
            confirmedGroups,
            comparison,
            purchaseOrders,
        };
    }
}
exports.GetProductionProjectUseCase = GetProductionProjectUseCase;
//# sourceMappingURL=GetProductionProjectUseCase.js.map