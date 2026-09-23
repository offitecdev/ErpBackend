"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ListProductionLinesUseCase = void 0;
const production_1 = require("../../../domain/services/production");
const productionReadModel_1 = require("./productionReadModel");
/**
 * ── «BESTELLTE PRODUKTE» ────────────────────────────────────────────────────
 * Die eigene Seite für die Zeilen bestätigter Bestellungen (Vorgabe Samet):
 * jedes Produkt mit seinem Projekt und seinem Gerät. Die Tabelle entsteht bei
 * der Bestätigung und verschwindet mit der Bestellung.
 */
class ListProductionLinesUseCase {
    projects;
    purchase;
    purchaseOrders;
    constructor(projects, purchase, purchaseOrders) {
        this.projects = projects;
        this.purchase = purchase;
        this.purchaseOrders = purchaseOrders;
    }
    async execute(tenantId, filter = {}) {
        const lines = await this.purchase.listLines(tenantId, {
            ...(filter.projectId ? { projectIds: [filter.projectId] } : {}),
            ...(filter.search ? { search: filter.search } : {}),
        });
        const projectIds = [...new Set(lines.map((line) => line.productionProjectId))];
        const itemIds = [...new Set(lines.map((line) => line.productionItemId).filter((id) => Boolean(id)))];
        const purchaseIds = [...new Set(lines.map((line) => line.purchaseOrderId))];
        const [projects, items, orders, allProjects] = await Promise.all([
            this.projects.listProjects(tenantId, { ids: projectIds, includeInactive: true }),
            this.projects.listItems(tenantId, { itemIds }),
            this.purchaseOrders.findByIds(tenantId, purchaseIds),
            // Für die Filterauswahl: jedes Projekt, das überhaupt Zeilen trägt.
            filter.projectId || filter.search
                ? this.purchase.listLines(tenantId).then((all) => [...new Set(all.map((line) => line.productionProjectId))])
                    .then((ids) => this.projects.listProjects(tenantId, { ids, includeInactive: true }))
                : Promise.resolve(null),
        ]);
        const projectById = new Map(projects.map((project) => [project.id, project]));
        const itemById = new Map(items.map((item) => [item.id, item]));
        const statusById = new Map(orders.map((order) => [order.id, order.status]));
        const brief = (project) => ({
            id: project.id, projectNumber: project.projectNumber, projectName: project.projectName, sourceKind: project.sourceKind,
        });
        const rows = lines.map((line) => {
            const project = projectById.get(line.productionProjectId);
            const item = line.productionItemId ? itemById.get(line.productionItemId) : undefined;
            return {
                ...(0, productionReadModel_1.confirmedLineDto)(line, statusById.get(line.purchaseOrderId) ?? null),
                project: project ? brief(project) : null,
                item: item ? (0, productionReadModel_1.itemDto)(item) : null,
            };
        });
        return {
            rows,
            totals: {
                orderedTotal: (0, production_1.round2)(lines.reduce((sum, line) => sum + line.lineTotal, 0)),
                receivedTotal: (0, production_1.round2)(lines.reduce((sum, line) => sum + (0, production_1.receivedValueOf)(line), 0)),
                lineCount: lines.length,
            },
            projects: (allProjects ?? projects).map(brief).sort((a, b) => b.projectNumber.localeCompare(a.projectNumber)),
        };
    }
}
exports.ListProductionLinesUseCase = ListProductionLinesUseCase;
//# sourceMappingURL=ListProductionLinesUseCase.js.map