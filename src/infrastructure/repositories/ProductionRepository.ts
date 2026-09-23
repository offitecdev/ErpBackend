import { nanoid } from 'nanoid';
import prisma from '../database/prisma.client';
import type {
    IProductionProjectRepository,
    IProductionPurchaseRepository,
    IProductionSettingsRepository,
    ITenantDirectory,
    ProductionLineFilter,
    ProductionProjectFilter,
    ProductionWriteClient,
    TenantDirectoryEntry,
} from '../../domain/repositories/IProductionRepository';
import type {
    ProductionAssignment,
    ProductionItem,
    ProductionItemKind,
    ProductionItemSource,
    ProductionOrderKind,
    ProductionOrderLine,
    ProductionProject,
    ProductionProjectOrder,
    ProductionSourceKind,
    ProductionTransferSettings,
} from '../../domain/entities/Production';
import {
    itemSourceKey,
    parseAssignmentItemIds,
    type ExistingProductionIds,
    type SnapshotPlan,
} from '../../domain/services/production';

/* ── Kleinzeug für die Sammelanweisungen ────────────────────────────────────
   Der Abgleich schreibt hunderte Zeilen. Einzelne `update`-Aufrufe kosteten je
   einen Rundgang zur fernen Datenbank (~45 ms); darum EINE Anweisung je
   Tabelle und Stück: `INSERT … ON DUPLICATE KEY UPDATE`. Zeitpunkte gehen als
   UTC-Text hinein — so liest Prisma sie wieder, unabhängig von der Zeitzone
   des Datenbankrechners. */

const CHUNK = 400;

const chunks = <T,>(list: T[], size = CHUNK): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
};

export const sqlDateTime = (value: Date): string => value.toISOString().slice(0, 23).replace('T', ' ');

const toStringArray = (value: unknown): string[] => {
    let raw = value;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { raw = []; }
    }
    return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
};

/** Die Firmen mit Namen — der gemeinsame Baum-Cache (shared/tenantTree) kennt keine Namen. */
export class PrismaTenantDirectory implements ITenantDirectory {
    async list(): Promise<TenantDirectoryEntry[]> {
        const rows = await prisma.tenant.findMany({
            select: { id: true, tenantName: true, parentTenantId: true, isActive: true },
            orderBy: { tenantName: 'asc' },
        });
        return rows.map((row) => ({
            id: row.id,
            name: row.tenantName,
            parentTenantId: row.parentTenantId ?? null,
            isActive: Boolean(row.isActive),
        }));
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Einstellungen → Firmenübertragungen
   ═════════════════════════════════════════════════════════════════════════ */

export class PrismaProductionSettingsRepository implements IProductionSettingsRepository {
    async get(tenantId: string): Promise<ProductionTransferSettings | null> {
        const row = await prisma.productionTransferSetting.findUnique({ where: { tenantId } });
        if (!row) return null;
        return {
            tenantId,
            sourceTenantIds: toStringArray(row.sourceTenantIds),
            lastSyncedAt: row.lastSyncedAt,
            updatedAt: row.updatedAt,
        };
    }

    async save(tenantId: string, sourceTenantIds: string[], updatedById: string): Promise<ProductionTransferSettings> {
        const row = await prisma.productionTransferSetting.upsert({
            where: { tenantId },
            update: { sourceTenantIds, updatedById },
            create: { id: nanoid(12), tenantId, sourceTenantIds, updatedById },
        });
        return {
            tenantId,
            sourceTenantIds: toStringArray(row.sourceTenantIds),
            lastSyncedAt: row.lastSyncedAt,
            updatedAt: row.updatedAt,
        };
    }

    async markSynced(tenantId: string, at: Date): Promise<void> {
        await prisma.productionTransferSetting.upsert({
            where: { tenantId },
            update: { lastSyncedAt: at },
            create: { id: nanoid(12), tenantId, lastSyncedAt: at },
        });
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Produktionsprojekte, Aufträge, Geräte
   ═════════════════════════════════════════════════════════════════════════ */

const toProject = (row: any): ProductionProject => ({
    id: row.id,
    tenantId: row.tenantId,
    sourceTenantId: row.sourceTenantId,
    sourceKey: row.sourceKey,
    sourceKind: row.sourceKind as ProductionSourceKind,
    sourceProjectId: row.sourceProjectId ?? null,
    sourceSalesOrderId: row.sourceSalesOrderId ?? null,
    projectNumber: row.projectNumber,
    projectName: row.projectName,
    customerName: row.customerName ?? null,
    sourceStatus: row.sourceStatus ?? null,
    salesTotal: Number(row.salesTotal) || 0,
    isActive: Boolean(row.isActive),
    syncedAt: row.syncedAt,
});

const toOrder = (row: any): ProductionProjectOrder => ({
    id: row.id,
    productionProjectId: row.productionProjectId,
    sourceSalesOrderId: row.sourceSalesOrderId,
    parentSalesOrderId: row.parentSalesOrderId ?? null,
    orderNumber: row.orderNumber,
    orderType: row.orderType,
    orderKind: row.orderKind as ProductionOrderKind,
    orderDate: row.orderDate ?? null,
    status: row.status,
    totalAmount: Number(row.totalAmount) || 0,
    isActive: Boolean(row.isActive),
});

const toItem = (row: any): ProductionItem => ({
    id: row.id,
    productionProjectId: row.productionProjectId,
    productionOrderId: row.productionOrderId,
    sourceType: row.sourceType as ProductionItemSource,
    sourceId: row.sourceId,
    kind: row.kind as ProductionItemKind,
    positionNumber: row.positionNumber ?? null,
    name: row.name,
    description: row.description ?? null,
    articleId: row.articleId ?? null,
    articleCode: row.articleCode ?? null,
    quantity: Number(row.quantity) || 0,
    unit: row.unit ?? null,
    unitPrice: Number(row.unitPrice) || 0,
    totalPrice: Number(row.totalPrice) || 0,
    sortOrder: Number(row.sortOrder) || 0,
    isActive: Boolean(row.isActive),
});

export class PrismaProductionProjectRepository implements IProductionProjectRepository {
    async existingIds(tenantId: string): Promise<ExistingProductionIds> {
        const [projects, orders, items] = await Promise.all([
            prisma.productionProject.findMany({ where: { tenantId }, select: { id: true, sourceKey: true } }),
            prisma.productionProjectOrder.findMany({ where: { tenantId }, select: { id: true, sourceSalesOrderId: true } }),
            prisma.productionProjectItem.findMany({ where: { tenantId }, select: { id: true, sourceType: true, sourceId: true } }),
        ]);
        return {
            projectIdByKey: new Map(projects.map((row) => [row.sourceKey, row.id])),
            orderIdBySalesOrder: new Map(orders.map((row) => [row.sourceSalesOrderId, row.id])),
            itemIdBySource: new Map(items.map((row) => [itemSourceKey(row.sourceType, row.sourceId), row.id])),
        };
    }

    /**
     * Drei Sammelanweisungen (Projekte → Aufträge → Geräte, in dieser
     * Reihenfolge wegen der Fremdschlüssel), danach legt je Tabelle EINE
     * Anweisung still, was dieser Abgleich nicht mehr berührt hat. Gelöscht
     * wird nie: eine Bestellung darf auf eine Zeile zeigen, die die Quelle
     * nicht mehr führt.
     */
    async applySnapshot(tenantId: string, plan: SnapshotPlan, syncedAt: Date): Promise<void> {
        const at = sqlDateTime(syncedAt);

        for (const part of chunks(plan.projects)) {
            const values = part.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
            const params = part.flatMap((row) => [
                row.id, tenantId, row.sourceTenantId, row.sourceKey, row.sourceKind,
                row.sourceProjectId, row.sourceSalesOrderId, row.projectNumber, row.projectName,
                row.customerName, row.sourceStatus, row.salesTotal, row.isActive ? 1 : 0, at, at, at,
            ]);
            await prisma.$executeRawUnsafe(
                'INSERT INTO `uretim_projeler` (`id`,`tenantId`,`sourceTenantId`,`sourceKey`,`sourceKind`,' +
                '`sourceProjectId`,`sourceSalesOrderId`,`projectNumber`,`projectName`,`customerName`,`sourceStatus`,' +
                '`salesTotal`,`isActive`,`syncedAt`,`createdAt`,`updatedAt`) VALUES ' + values +
                ' ON DUPLICATE KEY UPDATE `sourceTenantId`=VALUES(`sourceTenantId`),`sourceKind`=VALUES(`sourceKind`),' +
                '`sourceProjectId`=VALUES(`sourceProjectId`),`sourceSalesOrderId`=VALUES(`sourceSalesOrderId`),' +
                '`projectNumber`=VALUES(`projectNumber`),`projectName`=VALUES(`projectName`),`customerName`=VALUES(`customerName`),' +
                '`sourceStatus`=VALUES(`sourceStatus`),`salesTotal`=VALUES(`salesTotal`),`isActive`=VALUES(`isActive`),' +
                '`syncedAt`=VALUES(`syncedAt`),`updatedAt`=VALUES(`updatedAt`)',
                ...params,
            );
        }

        for (const part of chunks(plan.orders)) {
            const values = part.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
            const params = part.flatMap((row) => [
                row.id, tenantId, row.productionProjectId, row.sourceSalesOrderId, row.parentSalesOrderId,
                row.orderNumber, row.orderType, row.orderKind, row.orderDate ? sqlDateTime(row.orderDate) : null,
                row.status, row.totalAmount, row.isActive ? 1 : 0, at, at, at,
            ]);
            await prisma.$executeRawUnsafe(
                'INSERT INTO `uretim_proje_siparisleri` (`id`,`tenantId`,`productionProjectId`,`sourceSalesOrderId`,' +
                '`parentSalesOrderId`,`orderNumber`,`orderType`,`orderKind`,`orderDate`,`status`,`totalAmount`,`isActive`,' +
                '`syncedAt`,`createdAt`,`updatedAt`) VALUES ' + values +
                ' ON DUPLICATE KEY UPDATE `productionProjectId`=VALUES(`productionProjectId`),' +
                '`parentSalesOrderId`=VALUES(`parentSalesOrderId`),`orderNumber`=VALUES(`orderNumber`),' +
                '`orderType`=VALUES(`orderType`),`orderKind`=VALUES(`orderKind`),`orderDate`=VALUES(`orderDate`),' +
                '`status`=VALUES(`status`),`totalAmount`=VALUES(`totalAmount`),`isActive`=VALUES(`isActive`),' +
                '`syncedAt`=VALUES(`syncedAt`),`updatedAt`=VALUES(`updatedAt`)',
                ...params,
            );
        }

        for (const part of chunks(plan.items)) {
            const values = part.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
            const params = part.flatMap((row) => [
                row.id, tenantId, row.productionProjectId, row.productionOrderId, row.sourceType, row.sourceId,
                row.kind, row.positionNumber, row.name, row.description, row.articleId, row.articleCode,
                row.quantity, row.unit, row.unitPrice, row.totalPrice, row.sortOrder, row.isActive ? 1 : 0, at, at, at,
            ]);
            await prisma.$executeRawUnsafe(
                'INSERT INTO `uretim_proje_kalemleri` (`id`,`tenantId`,`productionProjectId`,`productionOrderId`,' +
                '`sourceType`,`sourceId`,`kind`,`positionNumber`,`name`,`description`,`articleId`,`articleCode`,' +
                '`quantity`,`unit`,`unitPrice`,`totalPrice`,`sortOrder`,`isActive`,`syncedAt`,`createdAt`,`updatedAt`) VALUES ' +
                values +
                ' ON DUPLICATE KEY UPDATE `productionProjectId`=VALUES(`productionProjectId`),' +
                '`productionOrderId`=VALUES(`productionOrderId`),`kind`=VALUES(`kind`),' +
                '`positionNumber`=VALUES(`positionNumber`),`name`=VALUES(`name`),`description`=VALUES(`description`),' +
                '`articleId`=VALUES(`articleId`),`articleCode`=VALUES(`articleCode`),`quantity`=VALUES(`quantity`),' +
                '`unit`=VALUES(`unit`),`unitPrice`=VALUES(`unitPrice`),`totalPrice`=VALUES(`totalPrice`),' +
                '`sortOrder`=VALUES(`sortOrder`),`isActive`=VALUES(`isActive`),`syncedAt`=VALUES(`syncedAt`),' +
                '`updatedAt`=VALUES(`updatedAt`)',
                ...params,
            );
        }

        // Was dieser Abgleich nicht berührt hat, trägt die Quelle nicht mehr.
        await Promise.all([
            prisma.$executeRawUnsafe(
                'UPDATE `uretim_projeler` SET `isActive` = 0, `salesTotal` = 0, `updatedAt` = ? WHERE `tenantId` = ? AND `syncedAt` < ? AND `isActive` = 1',
                at, tenantId, at,
            ),
            prisma.$executeRawUnsafe(
                'UPDATE `uretim_proje_siparisleri` SET `isActive` = 0, `updatedAt` = ? WHERE `tenantId` = ? AND `syncedAt` < ? AND `isActive` = 1',
                at, tenantId, at,
            ),
            prisma.$executeRawUnsafe(
                'UPDATE `uretim_proje_kalemleri` SET `isActive` = 0, `updatedAt` = ? WHERE `tenantId` = ? AND `syncedAt` < ? AND `isActive` = 1',
                at, tenantId, at,
            ),
        ]);
    }

    async listProjects(tenantId: string, filter: ProductionProjectFilter = {}): Promise<ProductionProject[]> {
        const search = filter.search?.trim();
        const rows = await prisma.productionProject.findMany({
            where: {
                tenantId,
                ...(filter.includeInactive ? {} : { isActive: true }),
                ...(filter.ids ? { id: { in: filter.ids } } : {}),
                ...(search ? {
                    OR: [
                        { projectNumber: { contains: search } },
                        { projectName: { contains: search } },
                        { customerName: { contains: search } },
                    ],
                } : {}),
            },
            orderBy: [{ projectNumber: 'desc' }],
        });
        return rows.map(toProject);
    }

    async getProject(tenantId: string, id: string): Promise<ProductionProject | null> {
        const row = await prisma.productionProject.findFirst({ where: { id, tenantId } });
        return row ? toProject(row) : null;
    }

    async listOrders(tenantId: string, projectIds: string[]): Promise<ProductionProjectOrder[]> {
        if (!projectIds.length) return [];
        const rows = await prisma.productionProjectOrder.findMany({
            where: { tenantId, productionProjectId: { in: projectIds } },
            orderBy: [{ orderDate: 'asc' }, { orderNumber: 'asc' }],
        });
        return rows.map(toOrder);
    }

    async listItems(tenantId: string, filter: { projectIds?: string[]; itemIds?: string[] }): Promise<ProductionItem[]> {
        if (filter.projectIds && !filter.projectIds.length) return [];
        if (filter.itemIds && !filter.itemIds.length) return [];
        const rows = await prisma.productionProjectItem.findMany({
            where: {
                tenantId,
                ...(filter.projectIds ? { productionProjectId: { in: filter.projectIds } } : {}),
                ...(filter.itemIds ? { id: { in: filter.itemIds } } : {}),
            },
            orderBy: [{ sortOrder: 'asc' }, { positionNumber: 'asc' }],
        });
        return rows.map(toItem);
    }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Bestellung ↔ Projekt, und die Zeilen bestätigter Bestellungen
   ═════════════════════════════════════════════════════════════════════════ */

const toLine = (row: any): ProductionOrderLine => ({
    id: row.id,
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderNumber: row.purchaseOrderNumber,
    supplierName: row.supplierName ?? null,
    currency: row.currency || 'CHF',
    productionProjectId: row.productionProjectId,
    productionItemId: row.productionItemId ?? null,
    lineIndex: Number(row.lineIndex) || 0,
    articleId: row.articleId ?? null,
    code: row.code ?? null,
    name: row.name,
    unit: row.unit ?? null,
    quantity: Number(row.quantity) || 0,
    grossPrice: Number(row.grossPrice) || 0,
    discount: Number(row.discount) || 0,
    discount2: Number(row.discount2) || 0,
    netPrice: Number(row.netPrice) || 0,
    lineTotal: Number(row.lineTotal) || 0,
    receivedQuantity: Number(row.receivedQuantity) || 0,
    approvedAt: row.approvedAt,
    approvedById: row.approvedById ?? null,
});

export class PrismaProductionPurchaseRepository implements IProductionPurchaseRepository {
    async getAssignment(tenantId: string, purchaseOrderId: string): Promise<ProductionAssignment | null> {
        const row = await prisma.productionPurchaseAssignment.findUnique({
            where: { tenantId_purchaseOrderId: { tenantId, purchaseOrderId } },
        });
        return row
            ? { purchaseOrderId, productionProjectId: row.productionProjectId, productionItemIds: parseAssignmentItemIds(row.productionItemIds) }
            : null;
    }

    async listAssignments(tenantId: string, filter: { purchaseOrderIds?: string[]; projectIds?: string[] }): Promise<ProductionAssignment[]> {
        if (filter.purchaseOrderIds && !filter.purchaseOrderIds.length) return [];
        if (filter.projectIds && !filter.projectIds.length) return [];
        const rows = await prisma.productionPurchaseAssignment.findMany({
            where: {
                tenantId,
                ...(filter.purchaseOrderIds ? { purchaseOrderId: { in: filter.purchaseOrderIds } } : {}),
                ...(filter.projectIds ? { productionProjectId: { in: filter.projectIds } } : {}),
            },
        });
        return this.withoutDeletedOrders(tenantId, rows.map((row) => ({
            purchaseOrderId: row.purchaseOrderId,
            productionProjectId: row.productionProjectId,
            productionItemIds: parseAssignmentItemIds(row.productionItemIds),
        })));
    }

    async saveAssignment(tenantId: string, assignment: ProductionAssignment, updatedById: string): Promise<void> {
        await prisma.productionPurchaseAssignment.upsert({
            where: { tenantId_purchaseOrderId: { tenantId, purchaseOrderId: assignment.purchaseOrderId } },
            update: {
                productionProjectId: assignment.productionProjectId,
                productionItemIds: assignment.productionItemIds,
                updatedById,
            },
            create: {
                id: nanoid(12),
                tenantId,
                purchaseOrderId: assignment.purchaseOrderId,
                productionProjectId: assignment.productionProjectId,
                productionItemIds: assignment.productionItemIds,
                updatedById,
            },
        });
    }

    async removeForPurchaseOrder(tenantId: string, purchaseOrderId: string, tx?: ProductionWriteClient): Promise<void> {
        const where = { tenantId, purchaseOrderId };
        // Im fremden Vorgang nacheinander: eine Transaktion ist EINE Verbindung.
        if (tx) {
            await tx.productionOrderLine.deleteMany({ where });
            await tx.productionPurchaseAssignment.deleteMany({ where });
            return;
        }
        await Promise.all([
            prisma.productionOrderLine.deleteMany({ where }),
            prisma.productionPurchaseAssignment.deleteMany({ where }),
        ]);
    }

    async removeForPurchaseOrders(tenantId: string, purchaseOrderIds: string[]): Promise<void> {
        if (!purchaseOrderIds.length) return;
        const where = { tenantId, purchaseOrderId: { in: purchaseOrderIds } };
        await Promise.all([
            prisma.productionOrderLine.deleteMany({ where }),
            prisma.productionPurchaseAssignment.deleteMany({ where }),
        ]);
    }

    /**
     * ── RESTE EINER GELÖSCHTEN BESTELLUNG ───────────────────────────────────
     * Zeile und Zuordnung gehen mit der Bestellung (Löschen räumt im selben
     * Vorgang auf). Was trotzdem stehen bleibt — eine Bestellung, die vor
     * dieser Regel verschwand, ein abgebrochener Vorgang —, wäre in der
     * Produktion ein Produkt ohne Bestellung: «boş bağımsız ürün». Darum
     * prüft JEDES Lesen, ob es die Bestellung noch gibt: was fehlt, kommt
     * nicht in die Antwort und wird nebenbei weggeräumt.
     */
    private async withoutDeletedOrders<T extends { purchaseOrderId: string }>(tenantId: string, rows: T[]): Promise<T[]> {
        const ids = [...new Set(rows.map((row) => row.purchaseOrderId))];
        if (!ids.length) return rows;
        const alive = await prisma.purchaseOrder.findMany({
            where: { tenantId, id: { in: ids } },
            select: { id: true },
        });
        if (alive.length === ids.length) return rows;
        const live = new Set(alive.map((row) => row.id));
        void this.removeForPurchaseOrders(tenantId, ids.filter((id) => !live.has(id))).catch(() => undefined);
        return rows.filter((row) => live.has(row.purchaseOrderId));
    }

    async replaceLines(tenantId: string, purchaseOrderId: string, lines: Array<Omit<ProductionOrderLine, 'id'>>): Promise<void> {
        await prisma.$transaction([
            prisma.productionOrderLine.deleteMany({ where: { tenantId, purchaseOrderId } }),
            ...(lines.length
                ? [prisma.productionOrderLine.createMany({
                    data: lines.map((line) => ({ ...line, id: nanoid(12), tenantId })),
                })]
                : []),
        ]);
    }

    async deleteLines(tenantId: string, purchaseOrderId: string): Promise<void> {
        await prisma.productionOrderLine.deleteMany({ where: { tenantId, purchaseOrderId } });
    }

    async listLines(tenantId: string, filter: ProductionLineFilter = {}): Promise<ProductionOrderLine[]> {
        if (filter.projectIds && !filter.projectIds.length) return [];
        if (filter.itemIds && !filter.itemIds.length) return [];
        if (filter.purchaseOrderIds && !filter.purchaseOrderIds.length) return [];
        const search = filter.search?.trim();
        const rows = await prisma.productionOrderLine.findMany({
            where: {
                tenantId,
                ...(filter.projectIds ? { productionProjectId: { in: filter.projectIds } } : {}),
                ...(filter.itemIds ? { productionItemId: { in: filter.itemIds } } : {}),
                ...(filter.purchaseOrderIds ? { purchaseOrderId: { in: filter.purchaseOrderIds } } : {}),
                ...(search ? {
                    OR: [
                        { name: { contains: search } },
                        { code: { contains: search } },
                        { purchaseOrderNumber: { contains: search } },
                        { supplierName: { contains: search } },
                    ],
                } : {}),
            },
            orderBy: [{ approvedAt: 'desc' }, { purchaseOrderNumber: 'desc' }, { lineIndex: 'asc' }],
        });
        return this.withoutDeletedOrders(tenantId, rows.map(toLine));
    }
}
