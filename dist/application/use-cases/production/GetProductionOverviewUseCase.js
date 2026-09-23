"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetProductionOverviewUseCase = void 0;
const production_1 = require("../../../domain/services/production");
const productionReadModel_1 = require("./productionReadModel");
/**
 * ── DIE SEITE «PRODUKTIONSAUFTRÄGE» ─────────────────────────────────────────
 * Alle Produkte aller Projekte und Aufträge auf EINER Seite (Vorgabe Samet):
 * Projekt → Auftrag (AB) → Geräte, die Nachträge (NT) als Unterzeilen des
 * Hauptauftrags; jede Ebene mit Verkaufswert und Ausgaben. Die Trennung in
 * Projekt- und Lieferaufträge macht die Oberfläche an `sourceKind`.
 */
class GetProductionOverviewUseCase {
    projects;
    purchase;
    purchaseOrders;
    settings;
    tenants;
    constructor(projects, purchase, purchaseOrders, settings, tenants) {
        this.projects = projects;
        this.purchase = purchase;
        this.purchaseOrders = purchaseOrders;
        this.settings = settings;
        this.tenants = tenants;
    }
    async execute(tenantId) {
        const [projects, settings, tenants] = await Promise.all([
            this.projects.listProjects(tenantId),
            this.settings.get(tenantId),
            this.tenants.list(),
        ]);
        const ids = projects.map((project) => project.id);
        const [orders, items, context] = await Promise.all([
            this.projects.listOrders(tenantId, ids),
            this.projects.listItems(tenantId, { projectIds: ids }),
            (0, productionReadModel_1.loadPurchaseContext)(tenantId, ids, this.purchase, this.purchaseOrders),
        ]);
        const tenantName = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
        const rows = projects.map((project) => {
            const ownItems = items.filter((item) => item.productionProjectId === project.id);
            const figures = (0, productionReadModel_1.projectFiguresFor)(ownItems, context.confirmed.filter((line) => line.productionProjectId === project.id), context.openRows.filter((row) => row.productionProjectId === project.id));
            return {
                project: (0, productionReadModel_1.projectDto)(project),
                sourceTenantName: tenantName.get(project.sourceTenantId) ?? null,
                figures: figures.total,
                orders: (0, productionReadModel_1.buildOrderTree)(orders.filter((order) => order.productionProjectId === project.id), ownItems, figures.byItem),
            };
        });
        return {
            lastSyncedAt: settings?.lastSyncedAt ? settings.lastSyncedAt.toISOString() : null,
            totals: (0, production_1.sumCostFigures)(rows.map((row) => row.figures)),
            projects: rows,
        };
    }
}
exports.GetProductionOverviewUseCase = GetProductionOverviewUseCase;
//# sourceMappingURL=GetProductionOverviewUseCase.js.map