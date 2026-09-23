import type {
    IProductionProjectRepository,
    IProductionPurchaseRepository,
} from '../../../domain/repositories/IProductionRepository';
import { emptyCostFigures } from '../../../domain/services/production';
import { productionError } from './productionErrors';
import {
    buildOrderTree,
    itemDto,
    projectDto,
    type ItemDto,
    type OrderNodeDto,
    type ProjectDto,
} from './productionReadModel';

export interface PickerProjectDto extends ProjectDto {
    deviceCount: number;
    serviceCount: number;
}

export interface PurchaseAssignmentDto {
    assignment: { productionProjectId: string; productionItemIds: string[] } | null;
    project: ProjectDto | null;
    /** Die gewählten Geräte in der Reihenfolge der Auswahl. */
    items: ItemDto[];
}

/**
 * ── DIE AUSWAHL IN DER LIEFERANTENBESTELLUNG ────────────────────────────────
 * Preisanfrage, Bestellung und Wareneingang verlangen ein PROJEKT; Geräte und
 * Leistungen daraus sind freiwillig (Vorgabe Samet, 20.09.2026) — hier kommen
 * die Listen für diese Auswahl her. Nur Lebendes: stornierte Aufträge und
 * stillgelegte Geräte stehen nicht zur Wahl.
 */
export class ProductionPickerUseCase {
    constructor(
        private projects: IProductionProjectRepository,
        private purchase: IProductionPurchaseRepository,
    ) {}

    async listProjects(tenantId: string, search?: string): Promise<PickerProjectDto[]> {
        const projects = await this.projects.listProjects(tenantId, search ? { search } : {});
        const items = await this.projects.listItems(tenantId, { projectIds: projects.map((project) => project.id) });
        const count = new Map<string, { devices: number; services: number }>();
        for (const item of items) {
            if (!item.isActive) continue;
            const entry = count.get(item.productionProjectId) ?? { devices: 0, services: 0 };
            if (item.kind === 'SERVICE') entry.services += 1; else entry.devices += 1;
            count.set(item.productionProjectId, entry);
        }
        return projects.map((project) => ({
            ...projectDto(project),
            deviceCount: count.get(project.id)?.devices ?? 0,
            serviceCount: count.get(project.id)?.services ?? 0,
        }));
    }

    async projectTree(tenantId: string, projectId: string): Promise<{ project: ProjectDto; orders: OrderNodeDto[] }> {
        const project = await this.projects.getProject(tenantId, projectId);
        if (!project) throw productionError('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });
        const [orders, items] = await Promise.all([
            this.projects.listOrders(tenantId, [project.id]),
            this.projects.listItems(tenantId, { projectIds: [project.id] }),
        ]);
        const liveOrders = orders.filter((order) => order.isActive);
        const liveItems = items.filter((item) => item.isActive);
        return { project: projectDto(project), orders: buildOrderTree(liveOrders, liveItems, new Map([[null, emptyCostFigures()]])) };
    }

    async assignmentFor(tenantId: string, purchaseOrderId: string): Promise<PurchaseAssignmentDto> {
        const assignment = await this.purchase.getAssignment(tenantId, purchaseOrderId);
        if (!assignment) return { assignment: null, project: null, items: [] };
        const [project, items] = await Promise.all([
            this.projects.getProject(tenantId, assignment.productionProjectId),
            this.projects.listItems(tenantId, { itemIds: assignment.productionItemIds }),
        ]);
        const byId = new Map(items.map((item) => [item.id, item]));
        return {
            assignment: { productionProjectId: assignment.productionProjectId, productionItemIds: assignment.productionItemIds },
            project: project ? projectDto(project) : null,
            items: assignment.productionItemIds.map((id) => byId.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item)).map(itemDto),
        };
    }
}
