import type {
    IProductionProjectRepository,
    IProductionPurchaseRepository,
    IPurchaseOrderReader,
} from '../../../domain/repositories/IProductionRepository';
import { receivedValueOf, round2 } from '../../../domain/services/production';
import { confirmedLineDto, itemDto, type ConfirmedLineDto, type ItemDto } from './productionReadModel';

export interface ProductionLineRowDto extends ConfirmedLineDto {
    project: { id: string; projectNumber: string; projectName: string; sourceKind: string } | null;
    item: ItemDto | null;
}

export interface ProductionLinesDto {
    rows: ProductionLineRowDto[];
    totals: { orderedTotal: number; receivedTotal: number; lineCount: number };
    projects: Array<{ id: string; projectNumber: string; projectName: string; sourceKind: string }>;
}

/**
 * ── «BESTELLTE PRODUKTE» ────────────────────────────────────────────────────
 * Die eigene Seite für die Zeilen bestätigter Bestellungen (Vorgabe Samet):
 * jedes Produkt mit seinem Projekt und seinem Gerät. Die Tabelle entsteht bei
 * der Bestätigung und verschwindet mit der Bestellung.
 */
export class ListProductionLinesUseCase {
    constructor(
        private projects: IProductionProjectRepository,
        private purchase: IProductionPurchaseRepository,
        private purchaseOrders: IPurchaseOrderReader,
    ) {}

    async execute(tenantId: string, filter: { projectId?: string; search?: string } = {}): Promise<ProductionLinesDto> {
        const lines = await this.purchase.listLines(tenantId, {
            ...(filter.projectId ? { projectIds: [filter.projectId] } : {}),
            ...(filter.search ? { search: filter.search } : {}),
        });
        const projectIds = [...new Set(lines.map((line) => line.productionProjectId))];
        const itemIds = [...new Set(lines.map((line) => line.productionItemId).filter((id): id is string => Boolean(id)))];
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
        const brief = (project: { id: string; projectNumber: string; projectName: string; sourceKind: string }) => ({
            id: project.id, projectNumber: project.projectNumber, projectName: project.projectName, sourceKind: project.sourceKind,
        });

        const rows: ProductionLineRowDto[] = lines.map((line) => {
            const project = projectById.get(line.productionProjectId);
            const item = line.productionItemId ? itemById.get(line.productionItemId) : undefined;
            return {
                ...confirmedLineDto(line, statusById.get(line.purchaseOrderId) ?? null),
                project: project ? brief(project) : null,
                item: item ? itemDto(item) : null,
            };
        });

        return {
            rows,
            totals: {
                orderedTotal: round2(lines.reduce((sum, line) => sum + line.lineTotal, 0)),
                receivedTotal: round2(lines.reduce((sum, line) => sum + receivedValueOf(line), 0)),
                lineCount: lines.length,
            },
            projects: (allProjects ?? projects).map(brief).sort((a, b) => b.projectNumber.localeCompare(a.projectNumber)),
        };
    }
}
