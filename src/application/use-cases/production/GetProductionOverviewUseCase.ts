import type { ProductionSourceKind } from '../../../domain/entities/Production';
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

export interface ProductionOrderListRow {
    project: Pick<ProjectDto, 'id' | 'sourceKind' | 'projectNumber' | 'projectName' | 'customerName'>;
    sourceTenantName: string | null;
    orderNumbers: string[];
    mainOrderNumbers: string[];
    addonCount: number;
    /** Wie viele Geräte/Leistungen schon einer Bestellung zugeordnet sind. */
    counts: { ordered: number; total: number };
}

export interface ProductionOrderListDto {
    projects: ProductionOrderListRow[];
    lastSyncedAt: string | null;
    total: number;
    page: number;
    pageSize: number;
}

export interface ProductionOrderListQuery {
    page: number;
    pageSize: number;
    search: string;
    kind: '' | ProductionSourceKind;
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

    /**
     * Die flache Liste der Seite «Produktionsaufträge»: eine Zeile je Projekt,
     * Suche, Art und Seite rechnet der Server; Aufträge, Geräte und
     * Bestellungen werden nur für die Projekte der Seite gelesen.
     */
    async list(tenantId: string, query: ProductionOrderListQuery): Promise<ProductionOrderListDto> {
        const [all, settings, tenants] = await Promise.all([
            this.projects.listProjects(tenantId, query.search ? { search: query.search } : {}),
            this.settings.get(tenantId),
            this.tenants.list(),
        ]);
        const filtered = query.kind ? all.filter((project) => project.sourceKind === query.kind) : all;
        const pageSize = Math.min(100, Math.max(1, query.pageSize));
        const lastPage = Math.max(1, Math.ceil(filtered.length / pageSize));
        const page = Math.min(lastPage, Math.max(1, query.page));
        const projects = filtered.slice((page - 1) * pageSize, page * pageSize);

        const ids = projects.map((project) => project.id);
        const [orders, items, context] = await Promise.all([
            this.projects.listOrders(tenantId, ids),
            this.projects.listItems(tenantId, { projectIds: ids }),
            loadPurchaseContext(tenantId, ids, this.purchase, this.purchaseOrders),
        ]);
        const tenantName = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));

        // Bestellt ist ein Gerät, sobald eine Bestellung (offen oder bestätigt) es führt.
        const orderedItemIds = new Set<string>();
        for (const assignment of context.assignments) assignment.productionItemIds.forEach((id) => orderedItemIds.add(id));
        for (const row of context.priceRows) if (row.productionItemId) orderedItemIds.add(row.productionItemId);
        for (const line of context.confirmed) if (line.productionItemId) orderedItemIds.add(line.productionItemId);

        const rows = projects.map((project): ProductionOrderListRow => {
            const ownOrders = orders.filter((order) => order.productionProjectId === project.id && order.isActive);
            const ownItems = items.filter((item) => item.productionProjectId === project.id && item.isActive);
            const mains = ownOrders.filter((order) => !order.parentSalesOrderId);
            return {
                project: {
                    id: project.id,
                    sourceKind: project.sourceKind,
                    projectNumber: project.projectNumber,
                    projectName: project.projectName,
                    customerName: project.customerName,
                },
                sourceTenantName: tenantName.get(project.sourceTenantId) ?? null,
                orderNumbers: ownOrders.map((order) => order.orderNumber),
                mainOrderNumbers: mains.map((order) => order.orderNumber),
                addonCount: ownOrders.length - mains.length,
                counts: {
                    ordered: ownItems.filter((item) => orderedItemIds.has(item.id)).length,
                    total: ownItems.length,
                },
            };
        });

        return {
            projects: rows,
            lastSyncedAt: settings?.lastSyncedAt ? settings.lastSyncedAt.toISOString() : null,
            total: filtered.length,
            page,
            pageSize,
        };
    }
}
