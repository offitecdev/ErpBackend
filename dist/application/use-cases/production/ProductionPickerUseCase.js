"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionPickerUseCase = void 0;
const production_1 = require("../../../domain/services/production");
const productionErrors_1 = require("./productionErrors");
const productionReadModel_1 = require("./productionReadModel");
/**
 * ── DIE AUSWAHL IN DER LIEFERANTENBESTELLUNG ────────────────────────────────
 * Preisanfrage, Bestellung und Wareneingang verlangen ein PROJEKT; Geräte und
 * Leistungen daraus sind freiwillig (Vorgabe Samet, 20.09.2026) — hier kommen
 * die Listen für diese Auswahl her. Nur Lebendes: stornierte Aufträge und
 * stillgelegte Geräte stehen nicht zur Wahl.
 */
class ProductionPickerUseCase {
    projects;
    purchase;
    constructor(projects, purchase) {
        this.projects = projects;
        this.purchase = purchase;
    }
    async listProjects(tenantId, search) {
        const projects = await this.projects.listProjects(tenantId, search ? { search } : {});
        const items = await this.projects.listItems(tenantId, { projectIds: projects.map((project) => project.id) });
        const count = new Map();
        for (const item of items) {
            if (!item.isActive)
                continue;
            const entry = count.get(item.productionProjectId) ?? { devices: 0, services: 0 };
            if (item.kind === 'SERVICE')
                entry.services += 1;
            else
                entry.devices += 1;
            count.set(item.productionProjectId, entry);
        }
        return projects.map((project) => ({
            ...(0, productionReadModel_1.projectDto)(project),
            deviceCount: count.get(project.id)?.devices ?? 0,
            serviceCount: count.get(project.id)?.services ?? 0,
        }));
    }
    async projectTree(tenantId, projectId) {
        const project = await this.projects.getProject(tenantId, projectId);
        if (!project)
            throw (0, productionErrors_1.productionError)('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });
        const [orders, items] = await Promise.all([
            this.projects.listOrders(tenantId, [project.id]),
            this.projects.listItems(tenantId, { projectIds: [project.id] }),
        ]);
        const liveOrders = orders.filter((order) => order.isActive);
        const liveItems = items.filter((item) => item.isActive);
        return { project: (0, productionReadModel_1.projectDto)(project), orders: (0, productionReadModel_1.buildOrderTree)(liveOrders, liveItems, new Map([[null, (0, production_1.emptyCostFigures)()]])) };
    }
    async assignmentFor(tenantId, purchaseOrderId) {
        const assignment = await this.purchase.getAssignment(tenantId, purchaseOrderId);
        if (!assignment)
            return { assignment: null, project: null, items: [] };
        const [project, items] = await Promise.all([
            this.projects.getProject(tenantId, assignment.productionProjectId),
            this.projects.listItems(tenantId, { itemIds: assignment.productionItemIds }),
        ]);
        const byId = new Map(items.map((item) => [item.id, item]));
        return {
            assignment: { productionProjectId: assignment.productionProjectId, productionItemIds: assignment.productionItemIds },
            project: project ? (0, productionReadModel_1.projectDto)(project) : null,
            items: assignment.productionItemIds.map((id) => byId.get(id)).filter((item) => Boolean(item)).map(productionReadModel_1.itemDto),
        };
    }
}
exports.ProductionPickerUseCase = ProductionPickerUseCase;
//# sourceMappingURL=ProductionPickerUseCase.js.map