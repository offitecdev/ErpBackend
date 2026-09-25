"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetProductionProjectDevicesUseCase = void 0;
const productionErrors_1 = require("./productionErrors");
const productionReadModel_1 = require("./productionReadModel");
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
class GetProductionProjectDevicesUseCase {
    projects;
    intake;
    tenants;
    sources;
    constructor(projects, intake, tenants, sources) {
        this.projects = projects;
        this.intake = intake;
        this.tenants = tenants;
        this.sources = sources;
    }
    async execute(tenantId, projectId) {
        const project = await this.projects.getProject(tenantId, projectId);
        if (!project)
            throw (0, productionErrors_1.productionError)('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });
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
            .sort((a, b) => (rank.get(a.productionOrderId) ?? 0) - (rank.get(b.productionOrderId) ?? 0)
            || a.sortOrder - b.sortOrder
            || String(a.positionNumber ?? '').localeCompare(String(b.positionNumber ?? ''), undefined, { numeric: true }))
            .map((item) => {
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
            project: { ...(0, productionReadModel_1.projectDto)(project), sourceTenantName: tenantName.get(project.sourceTenantId) ?? null },
            devices,
            counts: {
                devices: devices.filter((row) => row.kind === 'DEVICE').length,
                services: devices.filter((row) => row.kind === 'SERVICE').length,
            },
            details: detailsOf(project, source, orders, rank, devices),
        };
    }
    /** Die Quelle ist Beiwerk: fällt sie aus, zeigt die Seite trotzdem ihre Geräte. */
    async readSource(project) {
        try {
            return await this.sources.read(project);
        }
        catch (error) {
            console.warn('[production] project source unreadable', project.id, error?.message);
            return null;
        }
    }
}
exports.GetProductionProjectDevicesUseCase = GetProductionProjectDevicesUseCase;
const iso = (value) => {
    if (!value)
        return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const detailsOf = (project, source, orders, rank, devices) => {
    const intake = new Map();
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
const orderRanks = (orders) => {
    const byDate = (a, b) => (a.orderDate?.getTime() ?? 0) - (b.orderDate?.getTime() ?? 0) || a.orderNumber.localeCompare(b.orderNumber);
    const mains = orders.filter((order) => !order.parentSalesOrderId).sort(byDate);
    const ranks = new Map();
    let next = 0;
    for (const main of mains) {
        ranks.set(main.id, next++);
        orders
            .filter((order) => order.parentSalesOrderId === main.sourceSalesOrderId)
            .sort(byDate)
            .forEach((addon) => ranks.set(addon.id, next++));
    }
    for (const order of orders)
        if (!ranks.has(order.id))
            ranks.set(order.id, next++);
    return ranks;
};
//# sourceMappingURL=GetProductionProjectDevicesUseCase.js.map