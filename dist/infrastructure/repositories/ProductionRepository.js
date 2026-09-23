"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaProductionPurchaseRepository = exports.PrismaProductionProjectRepository = exports.PrismaProductionSettingsRepository = exports.PrismaTenantDirectory = exports.sqlDateTime = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const production_1 = require("../../domain/services/production");
/* ── Kleinzeug für die Sammelanweisungen ────────────────────────────────────
   Der Abgleich schreibt hunderte Zeilen. Einzelne `update`-Aufrufe kosteten je
   einen Rundgang zur fernen Datenbank (~45 ms); darum EINE Anweisung je
   Tabelle und Stück: `INSERT … ON DUPLICATE KEY UPDATE`. Zeitpunkte gehen als
   UTC-Text hinein — so liest Prisma sie wieder, unabhängig von der Zeitzone
   des Datenbankrechners. */
const CHUNK = 400;
const chunks = (list, size = CHUNK) => {
    const out = [];
    for (let i = 0; i < list.length; i += size)
        out.push(list.slice(i, i + size));
    return out;
};
const sqlDateTime = (value) => value.toISOString().slice(0, 23).replace('T', ' ');
exports.sqlDateTime = sqlDateTime;
const toStringArray = (value) => {
    let raw = value;
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        }
        catch {
            raw = [];
        }
    }
    return Array.isArray(raw) ? raw.map(String).filter(Boolean) : [];
};
/** Die Firmen mit Namen — der gemeinsame Baum-Cache (shared/tenantTree) kennt keine Namen. */
class PrismaTenantDirectory {
    async list() {
        const rows = await prisma_client_1.default.tenant.findMany({
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
exports.PrismaTenantDirectory = PrismaTenantDirectory;
/* ═══════════════════════════════════════════════════════════════════════════
   Einstellungen → Firmenübertragungen
   ═════════════════════════════════════════════════════════════════════════ */
class PrismaProductionSettingsRepository {
    async get(tenantId) {
        const row = await prisma_client_1.default.productionTransferSetting.findUnique({ where: { tenantId } });
        if (!row)
            return null;
        return {
            tenantId,
            sourceTenantIds: toStringArray(row.sourceTenantIds),
            lastSyncedAt: row.lastSyncedAt,
            updatedAt: row.updatedAt,
        };
    }
    async save(tenantId, sourceTenantIds, updatedById) {
        const row = await prisma_client_1.default.productionTransferSetting.upsert({
            where: { tenantId },
            update: { sourceTenantIds, updatedById },
            create: { id: (0, nanoid_1.nanoid)(12), tenantId, sourceTenantIds, updatedById },
        });
        return {
            tenantId,
            sourceTenantIds: toStringArray(row.sourceTenantIds),
            lastSyncedAt: row.lastSyncedAt,
            updatedAt: row.updatedAt,
        };
    }
    async markSynced(tenantId, at) {
        await prisma_client_1.default.productionTransferSetting.upsert({
            where: { tenantId },
            update: { lastSyncedAt: at },
            create: { id: (0, nanoid_1.nanoid)(12), tenantId, lastSyncedAt: at },
        });
    }
}
exports.PrismaProductionSettingsRepository = PrismaProductionSettingsRepository;
/* ═══════════════════════════════════════════════════════════════════════════
   Produktionsprojekte, Aufträge, Geräte
   ═════════════════════════════════════════════════════════════════════════ */
const toProject = (row) => ({
    id: row.id,
    tenantId: row.tenantId,
    sourceTenantId: row.sourceTenantId,
    sourceKey: row.sourceKey,
    sourceKind: row.sourceKind,
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
const toOrder = (row) => ({
    id: row.id,
    productionProjectId: row.productionProjectId,
    sourceSalesOrderId: row.sourceSalesOrderId,
    parentSalesOrderId: row.parentSalesOrderId ?? null,
    orderNumber: row.orderNumber,
    orderType: row.orderType,
    orderKind: row.orderKind,
    orderDate: row.orderDate ?? null,
    status: row.status,
    totalAmount: Number(row.totalAmount) || 0,
    isActive: Boolean(row.isActive),
});
const toItem = (row) => ({
    id: row.id,
    productionProjectId: row.productionProjectId,
    productionOrderId: row.productionOrderId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    kind: row.kind,
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
class PrismaProductionProjectRepository {
    async existingIds(tenantId) {
        const [projects, orders, items] = await Promise.all([
            prisma_client_1.default.productionProject.findMany({ where: { tenantId }, select: { id: true, sourceKey: true } }),
            prisma_client_1.default.productionProjectOrder.findMany({ where: { tenantId }, select: { id: true, sourceSalesOrderId: true } }),
            prisma_client_1.default.productionProjectItem.findMany({ where: { tenantId }, select: { id: true, sourceType: true, sourceId: true } }),
        ]);
        return {
            projectIdByKey: new Map(projects.map((row) => [row.sourceKey, row.id])),
            orderIdBySalesOrder: new Map(orders.map((row) => [row.sourceSalesOrderId, row.id])),
            itemIdBySource: new Map(items.map((row) => [(0, production_1.itemSourceKey)(row.sourceType, row.sourceId), row.id])),
        };
    }
    /**
     * Drei Sammelanweisungen (Projekte → Aufträge → Geräte, in dieser
     * Reihenfolge wegen der Fremdschlüssel), danach legt je Tabelle EINE
     * Anweisung still, was dieser Abgleich nicht mehr berührt hat. Gelöscht
     * wird nie: eine Bestellung darf auf eine Zeile zeigen, die die Quelle
     * nicht mehr führt.
     */
    async applySnapshot(tenantId, plan, syncedAt) {
        const at = (0, exports.sqlDateTime)(syncedAt);
        for (const part of chunks(plan.projects)) {
            const values = part.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
            const params = part.flatMap((row) => [
                row.id, tenantId, row.sourceTenantId, row.sourceKey, row.sourceKind,
                row.sourceProjectId, row.sourceSalesOrderId, row.projectNumber, row.projectName,
                row.customerName, row.sourceStatus, row.salesTotal, row.isActive ? 1 : 0, at, at, at,
            ]);
            await prisma_client_1.default.$executeRawUnsafe('INSERT INTO `uretim_projeler` (`id`,`tenantId`,`sourceTenantId`,`sourceKey`,`sourceKind`,' +
                '`sourceProjectId`,`sourceSalesOrderId`,`projectNumber`,`projectName`,`customerName`,`sourceStatus`,' +
                '`salesTotal`,`isActive`,`syncedAt`,`createdAt`,`updatedAt`) VALUES ' + values +
                ' ON DUPLICATE KEY UPDATE `sourceTenantId`=VALUES(`sourceTenantId`),`sourceKind`=VALUES(`sourceKind`),' +
                '`sourceProjectId`=VALUES(`sourceProjectId`),`sourceSalesOrderId`=VALUES(`sourceSalesOrderId`),' +
                '`projectNumber`=VALUES(`projectNumber`),`projectName`=VALUES(`projectName`),`customerName`=VALUES(`customerName`),' +
                '`sourceStatus`=VALUES(`sourceStatus`),`salesTotal`=VALUES(`salesTotal`),`isActive`=VALUES(`isActive`),' +
                '`syncedAt`=VALUES(`syncedAt`),`updatedAt`=VALUES(`updatedAt`)', ...params);
        }
        for (const part of chunks(plan.orders)) {
            const values = part.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
            const params = part.flatMap((row) => [
                row.id, tenantId, row.productionProjectId, row.sourceSalesOrderId, row.parentSalesOrderId,
                row.orderNumber, row.orderType, row.orderKind, row.orderDate ? (0, exports.sqlDateTime)(row.orderDate) : null,
                row.status, row.totalAmount, row.isActive ? 1 : 0, at, at, at,
            ]);
            await prisma_client_1.default.$executeRawUnsafe('INSERT INTO `uretim_proje_siparisleri` (`id`,`tenantId`,`productionProjectId`,`sourceSalesOrderId`,' +
                '`parentSalesOrderId`,`orderNumber`,`orderType`,`orderKind`,`orderDate`,`status`,`totalAmount`,`isActive`,' +
                '`syncedAt`,`createdAt`,`updatedAt`) VALUES ' + values +
                ' ON DUPLICATE KEY UPDATE `productionProjectId`=VALUES(`productionProjectId`),' +
                '`parentSalesOrderId`=VALUES(`parentSalesOrderId`),`orderNumber`=VALUES(`orderNumber`),' +
                '`orderType`=VALUES(`orderType`),`orderKind`=VALUES(`orderKind`),`orderDate`=VALUES(`orderDate`),' +
                '`status`=VALUES(`status`),`totalAmount`=VALUES(`totalAmount`),`isActive`=VALUES(`isActive`),' +
                '`syncedAt`=VALUES(`syncedAt`),`updatedAt`=VALUES(`updatedAt`)', ...params);
        }
        for (const part of chunks(plan.items)) {
            const values = part.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
            const params = part.flatMap((row) => [
                row.id, tenantId, row.productionProjectId, row.productionOrderId, row.sourceType, row.sourceId,
                row.kind, row.positionNumber, row.name, row.description, row.articleId, row.articleCode,
                row.quantity, row.unit, row.unitPrice, row.totalPrice, row.sortOrder, row.isActive ? 1 : 0, at, at, at,
            ]);
            await prisma_client_1.default.$executeRawUnsafe('INSERT INTO `uretim_proje_kalemleri` (`id`,`tenantId`,`productionProjectId`,`productionOrderId`,' +
                '`sourceType`,`sourceId`,`kind`,`positionNumber`,`name`,`description`,`articleId`,`articleCode`,' +
                '`quantity`,`unit`,`unitPrice`,`totalPrice`,`sortOrder`,`isActive`,`syncedAt`,`createdAt`,`updatedAt`) VALUES ' +
                values +
                ' ON DUPLICATE KEY UPDATE `productionProjectId`=VALUES(`productionProjectId`),' +
                '`productionOrderId`=VALUES(`productionOrderId`),`kind`=VALUES(`kind`),' +
                '`positionNumber`=VALUES(`positionNumber`),`name`=VALUES(`name`),`description`=VALUES(`description`),' +
                '`articleId`=VALUES(`articleId`),`articleCode`=VALUES(`articleCode`),`quantity`=VALUES(`quantity`),' +
                '`unit`=VALUES(`unit`),`unitPrice`=VALUES(`unitPrice`),`totalPrice`=VALUES(`totalPrice`),' +
                '`sortOrder`=VALUES(`sortOrder`),`isActive`=VALUES(`isActive`),`syncedAt`=VALUES(`syncedAt`),' +
                '`updatedAt`=VALUES(`updatedAt`)', ...params);
        }
        // Was dieser Abgleich nicht berührt hat, trägt die Quelle nicht mehr.
        await Promise.all([
            prisma_client_1.default.$executeRawUnsafe('UPDATE `uretim_projeler` SET `isActive` = 0, `salesTotal` = 0, `updatedAt` = ? WHERE `tenantId` = ? AND `syncedAt` < ? AND `isActive` = 1', at, tenantId, at),
            prisma_client_1.default.$executeRawUnsafe('UPDATE `uretim_proje_siparisleri` SET `isActive` = 0, `updatedAt` = ? WHERE `tenantId` = ? AND `syncedAt` < ? AND `isActive` = 1', at, tenantId, at),
            prisma_client_1.default.$executeRawUnsafe('UPDATE `uretim_proje_kalemleri` SET `isActive` = 0, `updatedAt` = ? WHERE `tenantId` = ? AND `syncedAt` < ? AND `isActive` = 1', at, tenantId, at),
        ]);
    }
    async listProjects(tenantId, filter = {}) {
        const search = filter.search?.trim();
        const rows = await prisma_client_1.default.productionProject.findMany({
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
    async getProject(tenantId, id) {
        const row = await prisma_client_1.default.productionProject.findFirst({ where: { id, tenantId } });
        return row ? toProject(row) : null;
    }
    async listOrders(tenantId, projectIds) {
        if (!projectIds.length)
            return [];
        const rows = await prisma_client_1.default.productionProjectOrder.findMany({
            where: { tenantId, productionProjectId: { in: projectIds } },
            orderBy: [{ orderDate: 'asc' }, { orderNumber: 'asc' }],
        });
        return rows.map(toOrder);
    }
    async listItems(tenantId, filter) {
        if (filter.projectIds && !filter.projectIds.length)
            return [];
        if (filter.itemIds && !filter.itemIds.length)
            return [];
        const rows = await prisma_client_1.default.productionProjectItem.findMany({
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
exports.PrismaProductionProjectRepository = PrismaProductionProjectRepository;
/* ═══════════════════════════════════════════════════════════════════════════
   Bestellung ↔ Projekt, und die Zeilen bestätigter Bestellungen
   ═════════════════════════════════════════════════════════════════════════ */
const toLine = (row) => ({
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
class PrismaProductionPurchaseRepository {
    async getAssignment(tenantId, purchaseOrderId) {
        const row = await prisma_client_1.default.productionPurchaseAssignment.findUnique({
            where: { tenantId_purchaseOrderId: { tenantId, purchaseOrderId } },
        });
        return row
            ? { purchaseOrderId, productionProjectId: row.productionProjectId, productionItemIds: (0, production_1.parseAssignmentItemIds)(row.productionItemIds) }
            : null;
    }
    async listAssignments(tenantId, filter) {
        if (filter.purchaseOrderIds && !filter.purchaseOrderIds.length)
            return [];
        if (filter.projectIds && !filter.projectIds.length)
            return [];
        const rows = await prisma_client_1.default.productionPurchaseAssignment.findMany({
            where: {
                tenantId,
                ...(filter.purchaseOrderIds ? { purchaseOrderId: { in: filter.purchaseOrderIds } } : {}),
                ...(filter.projectIds ? { productionProjectId: { in: filter.projectIds } } : {}),
            },
        });
        return rows.map((row) => ({
            purchaseOrderId: row.purchaseOrderId,
            productionProjectId: row.productionProjectId,
            productionItemIds: (0, production_1.parseAssignmentItemIds)(row.productionItemIds),
        }));
    }
    async saveAssignment(tenantId, assignment, updatedById) {
        await prisma_client_1.default.productionPurchaseAssignment.upsert({
            where: { tenantId_purchaseOrderId: { tenantId, purchaseOrderId: assignment.purchaseOrderId } },
            update: {
                productionProjectId: assignment.productionProjectId,
                productionItemIds: assignment.productionItemIds,
                updatedById,
            },
            create: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId,
                purchaseOrderId: assignment.purchaseOrderId,
                productionProjectId: assignment.productionProjectId,
                productionItemIds: assignment.productionItemIds,
                updatedById,
            },
        });
    }
    async removeForPurchaseOrder(tenantId, purchaseOrderId) {
        await Promise.all([
            prisma_client_1.default.productionOrderLine.deleteMany({ where: { tenantId, purchaseOrderId } }),
            prisma_client_1.default.productionPurchaseAssignment.deleteMany({ where: { tenantId, purchaseOrderId } }),
        ]);
    }
    async replaceLines(tenantId, purchaseOrderId, lines) {
        await prisma_client_1.default.$transaction([
            prisma_client_1.default.productionOrderLine.deleteMany({ where: { tenantId, purchaseOrderId } }),
            ...(lines.length
                ? [prisma_client_1.default.productionOrderLine.createMany({
                        data: lines.map((line) => ({ ...line, id: (0, nanoid_1.nanoid)(12), tenantId })),
                    })]
                : []),
        ]);
    }
    async deleteLines(tenantId, purchaseOrderId) {
        await prisma_client_1.default.productionOrderLine.deleteMany({ where: { tenantId, purchaseOrderId } });
    }
    async listLines(tenantId, filter = {}) {
        if (filter.projectIds && !filter.projectIds.length)
            return [];
        if (filter.itemIds && !filter.itemIds.length)
            return [];
        if (filter.purchaseOrderIds && !filter.purchaseOrderIds.length)
            return [];
        const search = filter.search?.trim();
        const rows = await prisma_client_1.default.productionOrderLine.findMany({
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
        return rows.map(toLine);
    }
}
exports.PrismaProductionPurchaseRepository = PrismaProductionPurchaseRepository;
//# sourceMappingURL=ProductionRepository.js.map