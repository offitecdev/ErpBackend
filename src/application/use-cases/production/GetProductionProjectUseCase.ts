import type {
    IProductionProjectRepository,
    IProductionPurchaseRepository,
    IPurchaseOrderReader,
    ITenantDirectory,
} from '../../../domain/repositories/IProductionRepository';
import { emptyCostFigures, type CostFigures } from '../../../domain/services/production';
import { productionError } from './productionErrors';
import {
    buildOrderTree,
    confirmedLineDto,
    loadPurchaseContext,
    projectDto,
    projectFiguresFor,
    type ConfirmedLineDto,
    type ItemDto,
    type OrderNodeDto,
    type PriceRowDto,
    type ProjectDto,
} from './productionReadModel';

export interface ConfirmedGroupDto {
    /** null = Zeilen ohne Gerät (Bestellungen von vor der Zuordnung). */
    item: ItemDto | null;
    figures: CostFigures;
    lines: ConfirmedLineDto[];
}

export interface ProductionProjectDetailDto {
    project: ProjectDto & { sourceTenantName: string | null };
    figures: CostFigures;
    orders: OrderNodeDto[];
    /** Reiter 1: jede Zeile der zugeordneten Bestellungen, die einen Preis trägt. */
    priceRows: PriceRowDto[];
    /** Reiter 2: die bestätigten Zeilen, je Gerät gruppiert. */
    confirmedGroups: ConfirmedGroupDto[];
    /** Der Vergleich je Gerät (Verkauf / offen / bestellt / eingegangen). */
    comparison: Array<{ item: ItemDto | null; figures: CostFigures }>;
    purchaseOrders: Array<{
        id: string;
        referenceNumber: string;
        status: string;
        supplierName: string | null;
        currency: string;
        createdAt: string;
        itemIds: string[];
    }>;
}

/**
 * ── DIE PROJEKTSEITE DER PRODUKTION ─────────────────────────────────────────
 * Zwei Reiter (Vorgabe Samet): alle Rohzeilen MIT Preis, und die BESTÄTIGTEN
 * Bestellzeilen — sind im Projekt mehrere Geräte gewählt, gruppiert unter der
 * Überschrift ihres Geräts. Dazu der Kostenvergleich je Gerät.
 */
export class GetProductionProjectUseCase {
    constructor(
        private projects: IProductionProjectRepository,
        private purchase: IProductionPurchaseRepository,
        private purchaseOrders: IPurchaseOrderReader,
        private tenants: ITenantDirectory,
    ) {}

    async execute(tenantId: string, projectId: string): Promise<ProductionProjectDetailDto> {
        const project = await this.projects.getProject(tenantId, projectId);
        if (!project) throw productionError('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });

        const [orders, items, context, tenants] = await Promise.all([
            this.projects.listOrders(tenantId, [project.id]),
            this.projects.listItems(tenantId, { projectIds: [project.id] }),
            loadPurchaseContext(tenantId, [project.id], this.purchase, this.purchaseOrders),
            this.tenants.list(),
        ]);
        const figures = projectFiguresFor(items, context.confirmed, context.openRows);
        const tree = buildOrderTree(orders, items, figures.byItem);

        /* Die Reihenfolge der Geräte ist die des Auftragsbaums: Hauptauftrag,
           seine Geräte, dann seine Nachträge — so, wie der Verkauf sie führt. */
        const ordered: ItemDto[] = [];
        const walk = (nodes: OrderNodeDto[]) => nodes.forEach((node) => {
            node.items.forEach((entry) => ordered.push(entry.item));
            walk(node.addons);
        });
        walk(tree);
        const known = new Set(ordered.map((item) => item.id));

        const statusOf = (purchaseOrderId: string) => context.purchaseOrders.get(purchaseOrderId)?.status ?? null;
        const linesByItem = new Map<string | null, ConfirmedLineDto[]>();
        for (const line of context.confirmed) {
            const key = line.productionItemId && known.has(line.productionItemId) ? line.productionItemId : null;
            const list = linesByItem.get(key) ?? [];
            list.push(confirmedLineDto(line, statusOf(line.purchaseOrderId)));
            linesByItem.set(key, list);
        }

        const confirmedGroups: ConfirmedGroupDto[] = ordered
            .filter((item) => linesByItem.has(item.id))
            .map((item) => ({
                item,
                figures: figures.byItem.get(item.id) ?? emptyCostFigures(),
                lines: linesByItem.get(item.id) ?? [],
            }));
        if (linesByItem.has(null)) {
            confirmedGroups.push({ item: null, figures: figures.byItem.get(null) ?? emptyCostFigures(), lines: linesByItem.get(null) ?? [] });
        }

        const comparison: ProductionProjectDetailDto['comparison'] = ordered
            .filter((item) => item.isActive || figures.byItem.get(item.id)?.orderedTotal)
            .map((item) => ({ item, figures: figures.byItem.get(item.id) ?? emptyCostFigures() }));
        if (figures.byItem.has(null)) comparison.push({ item: null, figures: figures.byItem.get(null)! });

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
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        return {
            project: {
                ...projectDto(project),
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
