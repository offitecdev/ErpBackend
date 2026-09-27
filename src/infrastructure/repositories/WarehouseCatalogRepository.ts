import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type {
    IWarehouseGroupRepository,
    IWarehouseSettingsRepository,
} from '../../domain/repositories/IWarehouseRepository';
import type {
    WarehouseCategory,
    WarehouseCategoryWithGroups,
    WarehouseLabelSettings,
    WarehouseMaterialGroup,
    WarehouseMaterialGroupWithCount,
    WarehouseSettings,
} from '../../domain/entities/Warehouse';
import { storedLabelSettings } from '../../domain/services/warehouseCodes';
import { newId, num } from './WarehouseRepository';

/**
 * ── DEPO: KATEGORIEN, GRUPPEN, EINSTELLUNGEN (26.09.2026, 2. Durchgang) ─────
 *
 * «ilk başta ana kategori ekleme ve onun kısaltmasını ekleme … onu seçince de
 *  alt bir tab olması lazım: malzeme grupları … teker teker olacak, ekledikçe
 *  eklenmesi gerekiyor.»
 *
 * Die Reihenfolge ist die des Anlegens (`sortOrder` = nächste Zahl). Namen
 * und Kürzel vergleicht die Datenbank ohne Gross/Klein (utf8mb4_unicode_ci);
 * die eindeutigen Schlüssel fangen gleichzeitiges Anlegen ab.
 */

type GroupRow = {
    id: string;
    tenantId: string;
    categoryId: string;
    categoryName: string | null;
    categoryCode: string | null;
    name: string;
    code: string | null;
    lastNumber: unknown;
    sortOrder: unknown;
};

const toGroup = (row: GroupRow): WarehouseMaterialGroup => ({
    id: row.id,
    tenantId: row.tenantId,
    categoryId: row.categoryId,
    categoryName: row.categoryName ?? '',
    categoryCode: row.categoryCode ?? '',
    name: row.name,
    code: row.code ?? null,
    lastNumber: num(row.lastNumber),
    sortOrder: num(row.sortOrder),
});

const toCategory = (row: { id: string; tenantId: string; name: string; code: string; sortOrder: unknown }): WarehouseCategory => ({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    code: row.code,
    sortOrder: num(row.sortOrder),
});

const GROUP_SELECT = Prisma.sql`
    SELECT g.id, g.tenantId, g.categoryId, c.name AS categoryName, c.code AS categoryCode,
           g.name, g.code, g.lastNumber, g.sortOrder
      FROM depo_malzeme_gruplari g
      JOIN depo_ana_kategoriler c ON c.id = g.categoryId`;

export class PrismaWarehouseGroupRepository implements IWarehouseGroupRepository {
    async tree(tenantId: string): Promise<{ categories: WarehouseCategoryWithGroups[]; ungroupedCount: number }> {
        const [categories, groups, ungrouped] = await Promise.all([
            prisma.warehouseCategory.findMany({
                where: { tenantId },
                orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            }),
            prisma.$queryRaw<Array<GroupRow & { productCount: unknown; uncodedCount: unknown }>>`
                SELECT g.id, g.tenantId, g.categoryId, NULL AS categoryName, NULL AS categoryCode,
                       g.name, g.code, g.lastNumber, g.sortOrder,
                       COUNT(p.id) AS productCount,
                       COALESCE(SUM(CASE WHEN p.id IS NOT NULL AND p.erpCode IS NULL THEN 1 ELSE 0 END), 0) AS uncodedCount
                  FROM depo_malzeme_gruplari g
                  LEFT JOIN depo_urun_kartlari p ON p.materialGroupId = g.id AND p.tenantId = g.tenantId
                 WHERE g.tenantId = ${tenantId}
                 GROUP BY g.id, g.tenantId, g.categoryId, g.name, g.code, g.lastNumber, g.sortOrder
                 ORDER BY g.sortOrder ASC, g.name ASC`,
            prisma.warehouseProduct.count({ where: { tenantId, materialGroupId: null } }),
        ]);
        const byCategory = new Map<string, WarehouseMaterialGroupWithCount[]>();
        const categoryOf = new Map(categories.map((category) => [category.id, category]));
        for (const row of groups) {
            const category = categoryOf.get(row.categoryId);
            const group: WarehouseMaterialGroupWithCount = {
                ...toGroup({ ...row, categoryName: category?.name ?? '', categoryCode: category?.code ?? '' }),
                productCount: num(row.productCount),
                uncodedCount: num(row.uncodedCount),
            };
            const list = byCategory.get(row.categoryId) ?? [];
            list.push(group);
            byCategory.set(row.categoryId, list);
        }
        return {
            categories: categories.map((category) => ({ ...toCategory(category), groups: byCategory.get(category.id) ?? [] })),
            ungroupedCount: ungrouped,
        };
    }

    async listGroups(tenantId: string): Promise<WarehouseMaterialGroup[]> {
        const rows = await prisma.$queryRaw<GroupRow[]>`${GROUP_SELECT}
            WHERE g.tenantId = ${tenantId}
            ORDER BY c.sortOrder ASC, g.sortOrder ASC, g.name ASC`;
        return rows.map(toGroup);
    }

    /* ── Hauptkategorien ─────────────────────────────────────────────── */

    async getCategory(tenantId: string, id: string): Promise<WarehouseCategory | null> {
        const row = await prisma.warehouseCategory.findFirst({ where: { id, tenantId } });
        return row ? toCategory(row) : null;
    }

    async findCategory(tenantId: string, by: { name?: string; code?: string }, excludeId?: string): Promise<WarehouseCategory | null> {
        const or: Prisma.WarehouseCategoryWhereInput[] = [];
        if (by.name) or.push({ name: by.name });
        if (by.code) or.push({ code: by.code });
        if (!or.length) return null;
        const row = await prisma.warehouseCategory.findFirst({
            where: { tenantId, OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) },
        });
        return row ? toCategory(row) : null;
    }

    async createCategory(tenantId: string, input: { name: string; code: string }): Promise<WarehouseCategory> {
        const last = await prisma.warehouseCategory.aggregate({ where: { tenantId }, _max: { sortOrder: true } });
        const row = await prisma.warehouseCategory.create({
            data: { id: newId(), tenantId, name: input.name, code: input.code, sortOrder: (last._max.sortOrder ?? 0) + 1 },
        });
        return toCategory(row);
    }

    async updateCategory(tenantId: string, id: string, patch: { name?: string; code?: string }): Promise<WarehouseCategory | null> {
        const data: Prisma.WarehouseCategoryUpdateManyMutationInput = {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.code !== undefined ? { code: patch.code } : {}),
        };
        if (Object.keys(data).length) {
            const [result] = await prisma.$transaction([
                prisma.warehouseCategory.updateMany({ where: { id, tenantId }, data }),
                // Ein neues Kürzel: es gibt noch keinen Code damit — die Zähler beginnen neu.
                ...(patch.code !== undefined
                    ? [prisma.warehouseMaterialGroup.updateMany({ where: { tenantId, categoryId: id }, data: { lastNumber: 0 } })]
                    : []),
            ]);
            if (!result.count) return null;
        }
        return this.getCategory(tenantId, id);
    }

    async deleteCategory(tenantId: string, id: string): Promise<boolean> {
        const result = await prisma.warehouseCategory.deleteMany({ where: { id, tenantId } });
        return result.count > 0;
    }

    groupCount(tenantId: string, categoryId: string): Promise<number> {
        return prisma.warehouseMaterialGroup.count({ where: { tenantId, categoryId } });
    }

    codedInCategory(tenantId: string, categoryId: string): Promise<number> {
        return prisma.warehouseProduct.count({
            where: { tenantId, erpCode: { not: null }, materialGroup: { categoryId } },
        });
    }

    /* ── Materialgruppen ─────────────────────────────────────────────── */

    async getGroup(tenantId: string, id: string): Promise<WarehouseMaterialGroup | null> {
        const rows = await prisma.$queryRaw<GroupRow[]>`${GROUP_SELECT}
            WHERE g.tenantId = ${tenantId} AND g.id = ${id}
            LIMIT 1`;
        return rows[0] ? toGroup(rows[0]) : null;
    }

    async findGroup(
        tenantId: string,
        categoryId: string,
        by: { name?: string; code?: string },
        excludeId?: string,
    ): Promise<WarehouseMaterialGroup | null> {
        const or: Prisma.WarehouseMaterialGroupWhereInput[] = [];
        if (by.name) or.push({ name: by.name });
        if (by.code) or.push({ code: by.code });
        if (!or.length) return null;
        const row = await prisma.warehouseMaterialGroup.findFirst({
            where: { tenantId, categoryId, OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) },
            select: { id: true },
        });
        return row ? this.getGroup(tenantId, row.id) : null;
    }

    async createGroup(tenantId: string, input: { categoryId: string; name: string; code: string }): Promise<WarehouseMaterialGroup> {
        const last = await prisma.warehouseMaterialGroup.aggregate({
            where: { tenantId, categoryId: input.categoryId },
            _max: { sortOrder: true },
        });
        const id = newId();
        await prisma.warehouseMaterialGroup.create({
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
        if (!created) throw new Error('Depo: neue Materialgruppe nicht lesbar.');
        return created;
    }

    async updateGroup(
        tenantId: string,
        id: string,
        patch: { name?: string; code?: string; categoryId?: string },
    ): Promise<WarehouseMaterialGroup | null> {
        const prefixChanged = patch.code !== undefined || patch.categoryId !== undefined;
        const data: Prisma.WarehouseMaterialGroupUncheckedUpdateManyInput = {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.code !== undefined ? { code: patch.code } : {}),
            ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
            // Ein neues Präfix: es gibt noch keinen Code damit — der Zähler beginnt neu.
            ...(prefixChanged ? { lastNumber: 0 } : {}),
        };
        if (Object.keys(data).length) {
            const result = await prisma.warehouseMaterialGroup.updateMany({ where: { id, tenantId }, data });
            if (!result.count) return null;
        }
        return this.getGroup(tenantId, id);
    }

    productCount(tenantId: string, id: string): Promise<number> {
        return prisma.warehouseProduct.count({ where: { tenantId, materialGroupId: id } });
    }

    codedCount(tenantId: string, id: string): Promise<number> {
        return prisma.warehouseProduct.count({ where: { tenantId, materialGroupId: id, erpCode: { not: null } } });
    }

    async deleteGroup(tenantId: string, id: string): Promise<boolean> {
        const result = await prisma.warehouseMaterialGroup.deleteMany({ where: { id, tenantId } });
        return result.count > 0;
    }
}

export class PrismaWarehouseSettingsRepository implements IWarehouseSettingsRepository {
    async get(tenantId: string): Promise<WarehouseSettings> {
        const row = await prisma.warehouseSettings.findUnique({ where: { tenantId } });
        return {
            tenantId,
            barcodeLastNumber: row ? Number(row.barcodeLastNumber) : 0,
            label: storedLabelSettings(row?.labelSettings ?? null),
        };
    }

    async saveLabel(tenantId: string, label: WarehouseLabelSettings): Promise<WarehouseSettings> {
        const value = label as unknown as Prisma.InputJsonValue;
        await prisma.warehouseSettings.upsert({
            where: { tenantId },
            create: { tenantId, labelSettings: value },
            update: { labelSettings: value },
        });
        return this.get(tenantId);
    }
}
