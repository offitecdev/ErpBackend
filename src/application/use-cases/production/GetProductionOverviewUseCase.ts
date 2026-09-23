import type {
    IProductionProjectRepository,
    IProductionPurchaseRepository,
    IProductionSettingsRepository,
    IPurchaseOrderReader,
    ITenantDirectory,
} from '../../../domain/repositories/IProductionRepository';
import { sumCostFigures, type CostFigures } from '../../../domain/services/production';
import {
    buildOrderTree,
    loadPurchaseContext,
    projectDto,
    projectFiguresFor,
    type OrderNodeDto,
    type ProjectDto,
} from './productionReadModel';

export interface ProductionOverviewProject {
    project: ProjectDto;
    sourceTenantName: string | null;
    figures: CostFigures;
    orders: OrderNodeDto[];
}

export interface ProductionOverviewDto {
    lastSyncedAt: string | null;
    totals: CostFigures;
    projects: ProductionOverviewProject[];
}

/**
 * ── DIE SEITE «PRODUKTIONSAUFTRÄGE» ─────────────────────────────────────────
 * Alle Produkte aller Projekte und Aufträge auf EINER Seite (Vorgabe Samet):
 * Projekt → Auftrag (AB) → Geräte, die Nachträge (NT) als Unterzeilen des
 * Hauptauftrags; jede Ebene mit Verkaufswert und Ausgaben. Die Trennung in
 * Projekt- und Lieferaufträge macht die Oberfläche an `sourceKind`.
 */
export class GetProductionOverviewUseCase {
    constructor(
        private projects: IProductionProjectRepository,
        private purchase: IProductionPurchaseRepository,
        private purchaseOrders: IPurchaseOrderReader,
        private settings: IProductionSettingsRepository,
        private tenants: ITenantDirectory,
    ) {}

    async execute(tenantId: string): Promise<ProductionOverviewDto> {
        const [projects, settings, tenants] = await Promise.all([
            this.projects.listProjects(tenantId),
            this.settings.get(tenantId),
            this.tenants.list(),
        ]);
        const ids = projects.map((project) => project.id);
        const [orders, items, context] = await Promise.all([
            this.projects.listOrders(tenantId, ids),
            this.projects.listItems(tenantId, { projectIds: ids }),
            loadPurchaseContext(tenantId, ids, this.purchase, this.purchaseOrders),
        ]);
        const tenantName = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));

        const rows = projects.map((project) => {
            const ownItems = items.filter((item) => item.productionProjectId === project.id);
            const figures = projectFiguresFor(
                ownItems,
                context.confirmed.filter((line) => line.productionProjectId === project.id),
                context.openRows.filter((row) => row.productionProjectId === project.id),
            );
            return {
                project: projectDto(project),
                sourceTenantName: tenantName.get(project.sourceTenantId) ?? null,
                figures: figures.total,
                orders: buildOrderTree(
                    orders.filter((order) => order.productionProjectId === project.id),
                    ownItems,
                    figures.byItem,
                ),
            };
        });

        return {
            lastSyncedAt: settings?.lastSyncedAt ? settings.lastSyncedAt.toISOString() : null,
            totals: sumCostFigures(rows.map((row) => row.figures)),
            projects: rows,
        };
    }
}
