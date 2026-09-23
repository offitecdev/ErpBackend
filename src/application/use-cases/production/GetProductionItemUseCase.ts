import type {
    IProductionProjectRepository,
    IProductionPurchaseRepository,
    IPurchaseOrderReader,
} from '../../../domain/repositories/IProductionRepository';
import { emptyCostFigures, type CostFigures } from '../../../domain/services/production';
import { productionError } from './productionErrors';
import {
    confirmedLineDto,
    itemDto,
    loadPurchaseContext,
    orderDto,
    projectDto,
    projectFiguresFor,
    type ConfirmedLineDto,
    type ItemDto,
    type OrderDto,
    type PriceRowDto,
    type ProjectDto,
} from './productionReadModel';

export interface ProductionItemDetailDto {
    item: ItemDto;
    order: OrderDto | null;
    /** Der Hauptauftrag, wenn das Gerät aus einem Nachtrag stammt. */
    parentOrder: OrderDto | null;
    project: ProjectDto | null;
    figures: CostFigures;
    confirmedLines: ConfirmedLineDto[];
    openRows: PriceRowDto[];
}

/**
 * ── DAS GERÄT IM FENSTER ────────────────────────────────────────────────────
 * Ein Klick auf die Gerätekarte öffnet die Einzelheiten (Vorgabe Samet):
 * woher das Gerät kommt (Auftrag, Nachtrag, Projekt), was es im Verkauf wert
 * ist, und was dafür bestellt, angefragt und eingegangen ist.
 */
export class GetProductionItemUseCase {
    constructor(
        private projects: IProductionProjectRepository,
        private purchase: IProductionPurchaseRepository,
        private purchaseOrders: IPurchaseOrderReader,
    ) {}

    async execute(tenantId: string, itemId: string): Promise<ProductionItemDetailDto> {
        const [item] = await this.projects.listItems(tenantId, { itemIds: [itemId] });
        if (!item) throw productionError('NOT_FOUND', 'Gerät nicht gefunden.', { status: 404 });

        const [project, orders, siblings, context] = await Promise.all([
            this.projects.getProject(tenantId, item.productionProjectId),
            this.projects.listOrders(tenantId, [item.productionProjectId]),
            this.projects.listItems(tenantId, { projectIds: [item.productionProjectId] }),
            loadPurchaseContext(tenantId, [item.productionProjectId], this.purchase, this.purchaseOrders),
        ]);
        const order = orders.find((entry) => entry.id === item.productionOrderId) ?? null;
        const parent = order?.parentSalesOrderId
            ? orders.find((entry) => entry.sourceSalesOrderId === order.parentSalesOrderId) ?? null
            : null;
        const figures = projectFiguresFor(siblings, context.confirmed, context.openRows);
        const statusOf = (id: string) => context.purchaseOrders.get(id)?.status ?? null;

        return {
            item: itemDto(item),
            order: order ? orderDto(order) : null,
            parentOrder: parent ? orderDto(parent) : null,
            project: project ? projectDto(project) : null,
            figures: figures.byItem.get(item.id) ?? emptyCostFigures(),
            confirmedLines: context.confirmed
                .filter((line) => line.productionItemId === item.id)
                .map((line) => confirmedLineDto(line, statusOf(line.purchaseOrderId))),
            openRows: context.priceRows.filter((row) => !row.approved && row.productionItemId === item.id),
        };
    }
}
