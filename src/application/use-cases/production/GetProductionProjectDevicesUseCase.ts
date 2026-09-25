import type {
    IProductionIntakeReader,
    IProductionProjectRepository,
    IProductionProjectSourceReader,
    ITenantDirectory,
} from '../../../domain/repositories/IProductionRepository';
import type { ProductionItem, ProductionProject, ProductionProjectOrder, ProductionProjectSource } from '../../../domain/entities/Production';
import { productionError } from './productionErrors';
import { projectDto, type ProjectDto } from './productionReadModel';

/** Die Bestellung der Projektfirma, aus der ein Gerät kam. */
export interface DeviceIntakeDto {
    purchaseOrderId: string;
    referenceNumber: string;
    sourceTenantName: string | null;
    status: string;
    quantity: number;
}

/** Eine Zeile der Stufe «Geräte». */
export interface ProductionDeviceRowDto {
    id: string;
    kind: ProductionItem['kind'];
    positionNumber: string | null;
    name: string;
    description: string | null;
    articleCode: string | null;
    quantity: number;
    unit: string | null;
    /** Der Verkaufsauftrag (AB/NT), zu dem die Position gehört. */
    salesOrderNumber: string | null;
    orderKind: ProductionProjectOrder['orderKind'] | null;
    intake: DeviceIntakeDto[];
}

/**
 * Die Angaben der Projekttabelle (24.09.2026, Vorgabe Samet: «proje bilgileri
 * tablo halinde, daha fazla detay»): Aufträge, eingegangene Bestellungen und
 * was die Quelle über Leitung, Termine und Adressen weiss.
 */
export interface ProductionProjectDetailsDto {
    managerName: string | null;
    salespersonName: string | null;
    startDate: string | null;
    endDate: string | null;
    deliveryDate: string | null;
    installationAddress: string | null;
    deliveryAddress: string | null;
    commissionNumber: string | null;
    customerReference: string | null;
    orders: Array<{
        id: string;
        orderNumber: string;
        orderKind: ProductionProjectOrder['orderKind'];
        orderDate: string | null;
        /** ORDERED | CANCELLED */
        status: string;
        isActive: boolean;
    }>;
    /** Jede eingegangene Bestellung einmal, über alle Geräte. */
    intake: Array<{ purchaseOrderId: string; referenceNumber: string; sourceTenantName: string | null }>;
    syncedAt: string | null;
}

export interface ProductionProjectDevicesDto {
    project: ProjectDto & { sourceTenantName: string | null };
    devices: ProductionDeviceRowDto[];
    counts: { devices: number; services: number };
    details: ProductionProjectDetailsDto;
}

/**
 * ── DIE GERÄTE EINES PRODUKTIONSPROJEKTS (24.09.2026) ───────────────────────
 *
 * Vorgabe Samet: «sipariş onayıyla proje açılacak … açılan projede gelen
 * cihazlar ilk önce satır satır sıralanması gerekmektedir». Nur die AKTIVEN
 * Geräte und Leistungen — also die, die eine bestätigte Bestellung gebracht
 * hat — in der Reihenfolge des Verkaufs: Hauptauftrag nach Datum, seine
 * Positionen, dann seine Nachträge. Keine Preise: die Produktion baut.
 * Dieselbe Antwort trägt die Projekttabelle und die Geräteseite.
 */
export class GetProductionProjectDevicesUseCase {
    constructor(
        private projects: IProductionProjectRepository,
        private intake: IProductionIntakeReader,
        private tenants: ITenantDirectory,
        private sources: IProductionProjectSourceReader,
    ) {}

    async execute(tenantId: string, projectId: string): Promise<ProductionProjectDevicesDto> {
        const project = await this.projects.getProject(tenantId, projectId);
        if (!project) throw productionError('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });

        const [orders, allItems, tenants, source] = await Promise.all([
            this.projects.listOrders(tenantId, [project.id]),
            this.projects.listItems(tenantId, { projectIds: [project.id] }),
            this.tenants.list(),
            this.readSource(project),
        ]);
        const items = allItems.filter((item) => item.isActive);
        const positionIds = items.filter((item) => item.sourceType === 'POSITION').map((item) => item.sourceId);
        const intakeByPosition = await this.intake.byPosition(tenantId, positionIds);

        const tenantName = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
        const orderById = new Map(orders.map((order) => [order.id, order]));
        const rank = orderRanks(orders);

        const devices = [...items]
            .sort((a, b) =>
                (rank.get(a.productionOrderId) ?? 0) - (rank.get(b.productionOrderId) ?? 0)
                || a.sortOrder - b.sortOrder
                || String(a.positionNumber ?? '').localeCompare(String(b.positionNumber ?? ''), undefined, { numeric: true }))
            .map((item): ProductionDeviceRowDto => {
                const order = orderById.get(item.productionOrderId) ?? null;
                const intake = item.sourceType === 'POSITION' ? intakeByPosition.get(item.sourceId) ?? [] : [];
                return {
                    id: item.id,
                    kind: item.kind,
                    positionNumber: item.positionNumber,
                    name: item.name,
                    description: item.description,
                    articleCode: item.articleCode,
                    quantity: item.quantity,
                    unit: item.unit,
                    salesOrderNumber: order?.orderNumber ?? null,
                    orderKind: order?.orderKind ?? null,
                    intake: intake.map((entry) => ({
                        purchaseOrderId: entry.purchaseOrderId,
                        referenceNumber: entry.referenceNumber,
                        sourceTenantName: tenantName.get(entry.sourceTenantId) ?? null,
                        status: entry.status,
                        quantity: entry.quantity,
                    })),
                };
            });

        return {
            project: { ...projectDto(project), sourceTenantName: tenantName.get(project.sourceTenantId) ?? null },
            devices,
            counts: {
                devices: devices.filter((row) => row.kind === 'DEVICE').length,
                services: devices.filter((row) => row.kind === 'SERVICE').length,
            },
            details: detailsOf(project, source, orders, rank, devices),
        };
    }

    /** Die Quelle ist Beiwerk: fällt sie aus, zeigt die Seite trotzdem ihre Geräte. */
    private async readSource(project: ProductionProject): Promise<ProductionProjectSource | null> {
        try {
            return await this.sources.read(project);
        } catch (error) {
            console.warn('[production] project source unreadable', project.id, (error as Error)?.message);
            return null;
        }
    }
}

const iso = (value: Date | null | undefined): string | null => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const detailsOf = (
    project: ProductionProject,
    source: ProductionProjectSource | null,
    orders: ProductionProjectOrder[],
    rank: Map<string, number>,
    devices: ProductionDeviceRowDto[],
): ProductionProjectDetailsDto => {
    const intake = new Map<string, ProductionProjectDetailsDto['intake'][number]>();
    for (const device of devices) {
        for (const entry of device.intake) {
            if (!intake.has(entry.purchaseOrderId)) {
                intake.set(entry.purchaseOrderId, {
                    purchaseOrderId: entry.purchaseOrderId,
                    referenceNumber: entry.referenceNumber,
                    sourceTenantName: entry.sourceTenantName,
                });
            }
        }
    }
    return {
        managerName: source?.managerName ?? null,
        salespersonName: source?.salespersonName ?? null,
        startDate: iso(source?.startDate),
        endDate: iso(source?.endDate),
        deliveryDate: iso(source?.deliveryDate),
        installationAddress: source?.installationAddress ?? null,
        deliveryAddress: source?.deliveryAddress ?? null,
        commissionNumber: source?.commissionNumber ?? null,
        customerReference: source?.customerReference ?? null,
        orders: [...orders]
            .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
            .map((order) => ({
                id: order.id,
                orderNumber: order.orderNumber,
                orderKind: order.orderKind,
                orderDate: iso(order.orderDate),
                status: order.status,
                isActive: order.isActive,
            })),
        intake: [...intake.values()],
        syncedAt: iso(project.syncedAt),
    };
};

/** Hauptaufträge nach Datum, jeder gefolgt von seinen Nachträgen. */
const orderRanks = (orders: ProductionProjectOrder[]): Map<string, number> => {
    const byDate = (a: ProductionProjectOrder, b: ProductionProjectOrder) =>
        (a.orderDate?.getTime() ?? 0) - (b.orderDate?.getTime() ?? 0) || a.orderNumber.localeCompare(b.orderNumber);
    const mains = orders.filter((order) => !order.parentSalesOrderId).sort(byDate);
    const ranks = new Map<string, number>();
    let next = 0;
    for (const main of mains) {
        ranks.set(main.id, next++);
        orders
            .filter((order) => order.parentSalesOrderId === main.sourceSalesOrderId)
            .sort(byDate)
            .forEach((addon) => ranks.set(addon.id, next++));
    }
    for (const order of orders) if (!ranks.has(order.id)) ranks.set(order.id, next++);
    return ranks;
};
