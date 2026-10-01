"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaWarehouseSettingsRepository = exports.PrismaWarehouseGroupRepository = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const warehouseCodes_1 = require("../../domain/services/warehouseCodes");
const WarehouseRepository_1 = require("./WarehouseRepository");
const toGroup = (row) => ({
    id: row.id,
    tenantId: row.tenantId,
    categoryId: row.categoryId,
    categoryName: row.categoryName ?? '',
    categoryCode: row.categoryCode ?? '',
    name: row.name,
    code: row.code ?? null,
    lastNumber: (0, WarehouseRepository_1.num)(row.lastNumber),
    sortOrder: (0, WarehouseRepository_1.num)(row.sortOrder),
});
const toCategory = (row, bomArea = 'BOTH') => ({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    code: row.code,
    bomArea,
    sortOrder: (0, WarehouseRepository_1.num)(row.sortOrder),
});
/** Die Spalte `bomArea` fehlt, solange die Migration vom 01.10.2026 nicht lief. */
const isMissingColumn = (error) => /Unknown column|ER_BAD_FIELD_ERROR|1054/i.test(String(error?.message ?? error));
const bomAreaOf = (value) => value === 'MECHANICAL' || value === 'ELECTRICAL' ? value : 'BOTH';
/**
 * BOM-Bereich je Kategorie — roh gelesen (01.10.2026): ein älterer Prisma-
 * Client kennt die Spalte nicht, und ohne Migration gilt überall BOTH.
 */
const bomAreasOf = async (tenantId, id) => {
    try {
        const rows = id
            ? await prisma_client_1.default.$queryRaw `
                SELECT id, bomArea FROM depo_ana_kategoriler WHERE tenantId = ${tenantId} AND id = ${id}`
            : await prisma_client_1.default.$queryRaw `
                SELECT id, bomArea FROM depo_ana_kategoriler WHERE tenantId = ${tenantId}`;
        return new Map(rows.map((row) => [row.id, bomAreaOf(row.bomArea)]));
    }
    catch (error) {
        if (isMissingColumn(error))
            return new Map();
        throw error;
    }
};
const GROUP_SELECT = client_1.Prisma.sql `
    SELECT g.id, g.tenantId, g.categoryId, c.name AS categoryName, c.code AS categoryCode,
           g.name, g.code, g.lastNumber, g.sortOrder
      FROM depo_malzeme_gruplari g
      JOIN depo_ana_kategoriler c ON c.id = g.categoryId`;
class PrismaWarehouseGroupRepository {
    async tree(tenantId) {
        const [categories, groups, ungrouped, areas] = await Promise.all([
            prisma_client_1.default.warehouseCategory.findMany({
                where: { tenantId },
                orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            }),
            prisma_client_1.default.$queryRaw `
                SELECT g.id, g.tenantId, g.categoryId, NULL AS categoryName, NULL AS categoryCode,
                       g.name, g.code, g.lastNumber, g.sortOrder,
                       COUNT(p.id) AS productCount,
                       COALESCE(SUM(CASE WHEN p.id IS NOT NULL AND p.erpCode IS NULL THEN 1 ELSE 0 END), 0) AS uncodedCount
                  FROM depo_malzeme_gruplari g
                  LEFT JOIN depo_urun_kartlari p ON p.materialGroupId = g.id AND p.tenantId = g.tenantId
                 WHERE g.tenantId = ${tenantId}
                 GROUP BY g.id, g.tenantId, g.categoryId, g.name, g.code, g.lastNumber, g.sortOrder
                 ORDER BY g.sortOrder ASC, g.name ASC`,
            prisma_client_1.default.warehouseProduct.count({ where: { tenantId, materialGroupId: null } }),
            bomAreasOf(tenantId),
        ]);
        const byCategory = new Map();
        const categoryOf = new Map(categories.map((category) => [category.id, category]));
        for (const row of groups) {
            const category = categoryOf.get(row.categoryId);
            const group = {
                ...toGroup({ ...row, categoryName: category?.name ?? '', categoryCode: category?.code ?? '' }),
                productCount: (0, WarehouseRepository_1.num)(row.productCount),
                uncodedCount: (0, WarehouseRepository_1.num)(row.uncodedCount),
            };
            const list = byCategory.get(row.categoryId) ?? [];
            list.push(group);
            byCategory.set(row.categoryId, list);
        }
        return {
            categories: categories.map((category) => ({ ...toCategory(category, areas.get(category.id)), groups: byCategory.get(category.id) ?? [] })),
            ungroupedCount: ungrouped,
        };
    }
    async listGroups(tenantId) {
        const rows = await prisma_client_1.default.$queryRaw `${GROUP_SELECT}
            WHERE g.tenantId = ${tenantId}
            ORDER BY c.sortOrder ASC, g.sortOrder ASC, g.name ASC`;
        return rows.map(toGroup);
    }
    /* ── Hauptkategorien ─────────────────────────────────────────────── */
    async getCategory(tenantId, id) {
        const [row, areas] = await Promise.all([
            prisma_client_1.default.warehouseCategory.findFirst({ where: { id, tenantId } }),
            bomAreasOf(tenantId, id),
        ]);
        return row ? toCategory(row, areas.get(row.id)) : null;
    }
    async findCategory(tenantId, by, excludeId) {
        const or = [];
        if (by.name)
            or.push({ name: by.name });
        if (by.code)
            or.push({ code: by.code });
        if (!or.length)
            return null;
        const row = await prisma_client_1.default.warehouseCategory.findFirst({
            where: { tenantId, OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) },
        });
        return row ? toCategory(row) : null;
    }
    async createCategory(tenantId, input) {
        const last = await prisma_client_1.default.warehouseCategory.aggregate({ where: { tenantId }, _max: { sortOrder: true } });
        const row = await prisma_client_1.default.warehouseCategory.create({
            data: { id: (0, WarehouseRepository_1.newId)(), tenantId, name: input.name, code: input.code, sortOrder: (last._max.sortOrder ?? 0) + 1 },
        });
        if (input.bomArea && input.bomArea !== 'BOTH') {
            await this.setBomArea(tenantId, row.id, input.bomArea);
            return toCategory(row, input.bomArea);
        }
        return toCategory(row);
    }
    /** Roh geschrieben — die Spalte kennt ein älterer Prisma-Client nicht. */
    async setBomArea(tenantId, id, bomArea) {
        return prisma_client_1.default.$executeRaw `
            UPDATE depo_ana_kategoriler SET bomArea = ${bomArea}, updatedAt = NOW(3)
             WHERE tenantId = ${tenantId} AND id = ${id}`;
    }
    async updateCategory(tenantId, id, patch) {
        if (patch.bomArea !== undefined && !(await this.setBomArea(tenantId, id, patch.bomArea)))
            return null;
        const data = {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.code !== undefined ? { code: patch.code } : {}),
        };
        if (Object.keys(data).length) {
            const [result] = await prisma_client_1.default.$transaction([
                prisma_client_1.default.warehouseCategory.updateMany({ where: { id, tenantId }, data }),
                // Ein neues Kürzel: es gibt noch keinen Code damit — die Zähler beginnen neu.
                ...(patch.code !== undefined
                    ? [prisma_client_1.default.warehouseMaterialGroup.updateMany({ where: { tenantId, categoryId: id }, data: { lastNumber: 0 } })]
                    : []),
            ]);
            if (!result.count)
                return null;
        }
        return this.getCategory(tenantId, id);
    }
    async deleteCategory(tenantId, id) {
        const result = await prisma_client_1.default.warehouseCategory.deleteMany({ where: { id, tenantId } });
        return result.count > 0;
    }
    groupCount(tenantId, categoryId) {
        return prisma_client_1.default.warehouseMaterialGroup.count({ where: { tenantId, categoryId } });
    }
    codedInCategory(tenantId, categoryId) {
        return prisma_client_1.default.warehouseProduct.count({
            where: { tenantId, erpCode: { not: null }, materialGroup: { categoryId } },
        });
    }
    /* ── Materialgruppen ─────────────────────────────────────────────── */
    async getGroup(tenantId, id) {
        const rows = await prisma_client_1.default.$queryRaw `${GROUP_SELECT}
            WHERE g.tenantId = ${tenantId} AND g.id = ${id}
            LIMIT 1`;
        return rows[0] ? toGroup(rows[0]) : null;
    }
    async findGroup(tenantId, categoryId, by, excludeId) {
        const or = [];
        if (by.name)
            or.push({ name: by.name });
        if (by.code)
            or.push({ code: by.code });
        if (!or.length)
            return null;
        const row = await prisma_client_1.default.warehouseMaterialGroup.findFirst({
            where: { tenantId, categoryId, OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) },
            select: { id: true },
        });
        return row ? this.getGroup(tenantId, row.id) : null;
    }
    async createGroup(tenantId, input) {
        const last = await prisma_client_1.default.warehouseMaterialGroup.aggregate({
            where: { tenantId, categoryId: input.categoryId },
            _max: { sortOrder: true },
        });
        const id = (0, WarehouseRepository_1.newId)();
        await prisma_client_1.default.warehouseMaterialGroup.create({
            data: {
                id,
                tenantId,
                categoryId: input.categoryId,
                name: input.name,
                code: input.code,
                sortOrder: (last._max.sortOrder ?? 0) + 1,
            },
        });
        const created = await this.getGroup(tenantId, id);
        if (!created)
            throw new Error('Depo: neue Materialgruppe nicht lesbar.');
        return created;
    }
    async updateGroup(tenantId, id, patch) {
        const prefixChanged = patch.code !== undefined || patch.categoryId !== undefined;
        const data = {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.code !== undefined ? { code: patch.code } : {}),
            ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
            // Ein neues Präfix: es gibt noch keinen Code damit — der Zähler beginnt neu.
            ...(prefixChanged ? { lastNumber: 0 } : {}),
        };
        if (Object.keys(data).length) {
            const result = await prisma_client_1.default.warehouseMaterialGroup.updateMany({ where: { id, tenantId }, data });
            if (!result.count)
                return null;
        }
        return this.getGroup(tenantId, id);
    }
    productCount(tenantId, id) {
        return prisma_client_1.default.warehouseProduct.count({ where: { tenantId, materialGroupId: id } });
    }
    codedCount(tenantId, id) {
        return prisma_client_1.default.warehouseProduct.count({ where: { tenantId, materialGroupId: id, erpCode: { not: null } } });
    }
    async deleteGroup(tenantId, id) {
        const result = await prisma_client_1.default.warehouseMaterialGroup.deleteMany({ where: { id, tenantId } });
        return result.count > 0;
    }
}
exports.PrismaWarehouseGroupRepository = PrismaWarehouseGroupRepository;
class PrismaWarehouseSettingsRepository {
    async get(tenantId) {
        const row = await prisma_client_1.default.warehouseSettings.findUnique({ where: { tenantId } });
        return {
            tenantId,
            barcodeLastNumber: row ? Number(row.barcodeLastNumber) : 0,
            label: (0, warehouseCodes_1.storedLabelSettings)(row?.labelSettings ?? null),
        };
    }
    async saveLabel(tenantId, label) {
        const value = label;
        await prisma_client_1.default.warehouseSettings.upsert({
            where: { tenantId },
            create: { tenantId, labelSettings: value },
            update: { labelSettings: value },
        });
        return this.get(tenantId);
    }
}
exports.PrismaWarehouseSettingsRepository = PrismaWarehouseSettingsRepository;
//# sourceMappingURL=WarehouseCatalogRepository.js.map