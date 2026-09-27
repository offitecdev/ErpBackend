import type {
    IWarehouseDirectory,
    IWarehouseGroupRepository,
    IWarehouseProductRepository,
    IWarehouseSettingsRepository,
} from '../../../domain/repositories/IWarehouseRepository';
import type {
    WarehouseCategory,
    WarehouseDeviceOption,
    WarehouseProjectOption,
    WarehouseSupplierOption,
} from '../../../domain/entities/Warehouse';
import { cleanLine, searchFrom, warehouseError, WAREHOUSE_LIMITS } from '../../../domain/services/warehouse';
import {
    ABBREVIATION_MAX,
    ABBREVIATION_MIN,
    isValidAbbreviation,
    labelSettingsFrom,
    LABEL_LIMITS,
    normalizeAbbreviation,
} from '../../../domain/services/warehouseCodes';
import {
    catalogDto,
    plainGroupDto,
    settingsDto,
    type WarehouseCatalogDto,
    type WarehouseGroupDto,
    type WarehouseSettingsDto,
} from './warehouseReadModel';
import { isUniqueViolation } from './WarehouseProductsUseCase';

const has = (input: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(input, key);

const objectOf = (body: unknown): Record<string, unknown> =>
    (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

/**
 * ── DIE AUSWAHLEN UND EINSTELLUNGEN DES DEPOS ───────────────────────────────
 *
 * Zweiter Durchgang (26.09.2026, Vorgabe Samet):
 *
 *   «Malzeme grupları da depoda Ayarlar bölümü olacak … ilk başta ana
 *    kategori ekleme ve onun kısaltmasını ekleme — Elektrik ELK olarak
 *    tanımlanmalıdır — onu seçince de alt bir tab: malzeme grupları … o adı
 *    girdiğinde filtrelemelerde de olacak.»
 *
 * Hauptkategorien und Gruppen tragen ein Kürzel (2–5 Zeichen A–Z/0–9).
 * Solange noch keine Karte einen Code damit trägt, lässt es sich ändern (der
 * Zähler beginnt dann neu); danach steht es fest — gedruckte Etiketten
 * würden sonst lügen. Löschen nur, was leer ist.
 *
 * Dazu die Etikett-Einstellungen, die Lieferanten (nur lesen) und die
 * Produktionsprojekte mit ihren Geräten.
 */
export class WarehouseCatalogUseCase {
    constructor(
        private groups: IWarehouseGroupRepository,
        private directory: IWarehouseDirectory,
        private products: IWarehouseProductRepository,
        private settingsRepo: IWarehouseSettingsRepository,
    ) {}

    async tree(tenantId: string): Promise<WarehouseCatalogDto> {
        return catalogDto(await this.groups.tree(tenantId));
    }

    /* ── Hauptkategorien ─────────────────────────────────────────────── */

    async createCategory(tenantId: string, body: unknown): Promise<WarehouseCategory> {
        const input = objectOf(body);
        const name = this.categoryName(input.name);
        const code = this.abbreviation(input.code, 'CATEGORY_CODE_INVALID');
        await this.assertCategoryFree(tenantId, { name, code });
        try {
            return await this.groups.createCategory(tenantId, { name, code });
        } catch (error) {
            throw this.categoryUnique(error, { name, code });
        }
    }

    async updateCategory(tenantId: string, id: string, body: unknown): Promise<WarehouseCategory> {
        const input = objectOf(body);
        const current = await this.groups.getCategory(tenantId, id);
        if (!current) throw warehouseError('CATEGORY_NOT_FOUND', 'Hauptkategorie nicht gefunden.', { status: 404 });

        const patch: { name?: string; code?: string } = {};
        if (has(input, 'name')) {
            const name = this.categoryName(input.name);
            if (name !== current.name) patch.name = name;
        }
        if (has(input, 'code')) {
            const code = this.abbreviation(input.code, 'CATEGORY_CODE_INVALID');
            if (code !== current.code) {
                const coded = await this.groups.codedInCategory(tenantId, id);
                if (coded > 0) {
                    throw warehouseError('CATEGORY_CODE_LOCKED', 'Das Kürzel steht fest: es gibt schon Karten mit Code.', {
                        status: 409,
                        params: { count: coded },
                    });
                }
                patch.code = code;
            }
        }
        if (!Object.keys(patch).length) return current;
        await this.assertCategoryFree(tenantId, patch, id);
        try {
            const updated = await this.groups.updateCategory(tenantId, id, patch);
            if (!updated) throw warehouseError('CATEGORY_NOT_FOUND', 'Hauptkategorie nicht gefunden.', { status: 404 });
            return updated;
        } catch (error) {
            throw this.categoryUnique(error, patch);
        }
    }

    async deleteCategory(tenantId: string, id: string): Promise<{ ok: true }> {
        const current = await this.groups.getCategory(tenantId, id);
        if (!current) throw warehouseError('CATEGORY_NOT_FOUND', 'Hauptkategorie nicht gefunden.', { status: 404 });
        const count = await this.groups.groupCount(tenantId, id);
        if (count > 0) {
            throw warehouseError('CATEGORY_IN_USE', 'Die Hauptkategorie hat noch Materialgruppen.', {
                status: 409,
                params: { count },
            });
        }
        await this.groups.deleteCategory(tenantId, id);
        return { ok: true };
    }

    /* ── Materialgruppen ─────────────────────────────────────────────── */

    async createGroup(tenantId: string, body: unknown): Promise<WarehouseGroupDto> {
        const input = objectOf(body);
        const categoryId = String(input.categoryId ?? '').trim();
        const category = categoryId ? await this.groups.getCategory(tenantId, categoryId) : null;
        if (!category) throw warehouseError('CATEGORY_NOT_FOUND', 'Hauptkategorie nicht gefunden.', { status: 400 });
        const name = this.groupName(input.name);
        const code = this.abbreviation(input.code, 'GROUP_CODE_INVALID');
        await this.assertGroupFree(tenantId, category.id, { name, code });
        try {
            return plainGroupDto(await this.groups.createGroup(tenantId, { categoryId: category.id, name, code }));
        } catch (error) {
            throw this.groupUnique(error, { name, code });
        }
    }

    async updateGroup(tenantId: string, id: string, body: unknown): Promise<WarehouseGroupDto> {
        const input = objectOf(body);
        const current = await this.groups.getGroup(tenantId, id);
        if (!current) throw warehouseError('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 404 });

        const patch: { name?: string; code?: string; categoryId?: string } = {};
        if (has(input, 'name')) {
            const name = this.groupName(input.name);
            if (name !== current.name) patch.name = name;
        }
        if (has(input, 'code')) {
            const code = this.abbreviation(input.code, 'GROUP_CODE_INVALID');
            if (code !== current.code) patch.code = code;
        }
        if (has(input, 'categoryId')) {
            const categoryId = String(input.categoryId ?? '').trim();
            if (categoryId && categoryId !== current.categoryId) {
                const category = await this.groups.getCategory(tenantId, categoryId);
                if (!category) throw warehouseError('CATEGORY_NOT_FOUND', 'Hauptkategorie nicht gefunden.', { status: 400 });
                patch.categoryId = category.id;
            }
        }
        if (!Object.keys(patch).length) return plainGroupDto(current);

        if (patch.code !== undefined || patch.categoryId !== undefined) {
            const coded = await this.groups.codedCount(tenantId, id);
            if (coded > 0) {
                throw warehouseError('GROUP_CODE_LOCKED', 'Kürzel und Kategorie stehen fest: es gibt schon Karten mit Code.', {
                    status: 409,
                    params: { count: coded },
                });
            }
        }
        const targetCategory = patch.categoryId ?? current.categoryId;
        await this.assertGroupFree(
            tenantId,
            targetCategory,
            {
                ...(patch.name !== undefined || patch.categoryId !== undefined ? { name: patch.name ?? current.name } : {}),
                ...(patch.code !== undefined || (patch.categoryId !== undefined && current.code) ? { code: patch.code ?? current.code ?? '' } : {}),
            },
            id,
        );
        try {
            const updated = await this.groups.updateGroup(tenantId, id, patch);
            if (!updated) throw warehouseError('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 404 });
            return plainGroupDto(updated);
        } catch (error) {
            throw this.groupUnique(error, { name: patch.name ?? current.name, code: patch.code ?? current.code ?? '' });
        }
    }

    async deleteGroup(tenantId: string, id: string): Promise<{ ok: true }> {
        const group = await this.groups.getGroup(tenantId, id);
        if (!group) throw warehouseError('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 404 });
        const count = await this.groups.productCount(tenantId, id);
        if (count > 0) {
            throw warehouseError('GROUP_IN_USE', 'Die Materialgruppe ist noch Karten zugeordnet.', {
                status: 409,
                params: { count },
            });
        }
        await this.groups.deleteGroup(tenantId, id);
        return { ok: true };
    }

    /**
     * «Kod ver»: Karten der Gruppe, die noch keinen ERP-Code haben
     * (Altbestand), bekommen ihn — in der Reihenfolge des Anlegens
     * («baştan sırayla»).
     */
    async assignCodes(tenantId: string, groupId: string): Promise<{ assigned: number }> {
        const group = await this.groups.getGroup(tenantId, groupId);
        if (!group) throw warehouseError('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 404 });
        if (!group.code) {
            throw warehouseError('GROUP_CODE_MISSING', 'Diese Materialgruppe hat noch kein Kürzel.', {
                status: 409,
                params: { group: group.name },
            });
        }
        return { assigned: await this.products.assignMissingCodes(tenantId, groupId) };
    }

    /* ── Etikett ─────────────────────────────────────────────────────── */

    async settings(tenantId: string): Promise<WarehouseSettingsDto> {
        return settingsDto(await this.settingsRepo.get(tenantId));
    }

    async saveSettings(tenantId: string, body: unknown): Promise<WarehouseSettingsDto> {
        const input = objectOf(body);
        const current = await this.settingsRepo.get(tenantId);
        const label = labelSettingsFrom(input.label ?? input, current.label);
        if (!label) {
            throw warehouseError('LABEL_SIZE_INVALID', 'Das Etikett ist zu klein oder zu gross.', {
                params: {
                    minWidth: LABEL_LIMITS.minWidth,
                    maxWidth: LABEL_LIMITS.maxWidth,
                    minHeight: LABEL_LIMITS.minHeight,
                    maxHeight: LABEL_LIMITS.maxHeight,
                },
            });
        }
        return settingsDto(await this.settingsRepo.saveLabel(tenantId, label));
    }

    /* ── Auswahlen aus anderen Modulen (nur lesen) ───────────────────── */

    suppliers(tenantId: string, rawQuery: unknown): Promise<WarehouseSupplierOption[]> {
        return this.directory.searchSuppliers(tenantId, searchFrom(rawQuery), 20);
    }

    projects(tenantId: string, rawSearch: unknown): Promise<WarehouseProjectOption[]> {
        return this.directory.listProjects(tenantId, searchFrom(rawSearch), 80);
    }

    async devices(tenantId: string, projectId: string): Promise<WarehouseDeviceOption[]> {
        const project = await this.directory.getProject(tenantId, projectId);
        if (!project) throw warehouseError('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });
        return this.directory.listDevices(tenantId, projectId);
    }

    /* ── Hilfen ─────────────────────────────────────────────────────────── */

    private categoryName(raw: unknown): string {
        const name = cleanLine(raw, 'name', WAREHOUSE_LIMITS.categoryName);
        if (!name) throw warehouseError('CATEGORY_NAME_REQUIRED', 'Der Name der Hauptkategorie fehlt.');
        return name;
    }

    private groupName(raw: unknown): string {
        const name = cleanLine(raw, 'name', WAREHOUSE_LIMITS.groupName);
        if (!name) throw warehouseError('GROUP_NAME_REQUIRED', 'Der Name der Materialgruppe fehlt.');
        return name;
    }

    private abbreviation(raw: unknown, code: 'CATEGORY_CODE_INVALID' | 'GROUP_CODE_INVALID'): string {
        const value = normalizeAbbreviation(raw);
        if (!isValidAbbreviation(value)) {
            throw warehouseError(code, 'Das Kürzel braucht 2–5 Buchstaben oder Ziffern.', {
                params: { min: ABBREVIATION_MIN, max: ABBREVIATION_MAX },
            });
        }
        return value;
    }

    private async assertCategoryFree(tenantId: string, by: { name?: string; code?: string }, excludeId?: string): Promise<void> {
        if (by.name) {
            const clash = await this.groups.findCategory(tenantId, { name: by.name }, excludeId);
            if (clash) throw warehouseError('CATEGORY_NAME_TAKEN', 'Diese Hauptkategorie gibt es schon.', { status: 409, params: { name: clash.name } });
        }
        if (by.code) {
            const clash = await this.groups.findCategory(tenantId, { code: by.code }, excludeId);
            if (clash) {
                throw warehouseError('CATEGORY_CODE_TAKEN', 'Dieses Kürzel trägt schon eine andere Hauptkategorie.', {
                    status: 409,
                    params: { code: by.code, name: clash.name },
                });
            }
        }
    }

    private async assertGroupFree(
        tenantId: string,
        categoryId: string,
        by: { name?: string; code?: string },
        excludeId?: string,
    ): Promise<void> {
        if (by.name) {
            const clash = await this.groups.findGroup(tenantId, categoryId, { name: by.name }, excludeId);
            if (clash) throw warehouseError('GROUP_NAME_TAKEN', 'Diese Materialgruppe gibt es in der Kategorie schon.', { status: 409, params: { name: clash.name } });
        }
        if (by.code) {
            const clash = await this.groups.findGroup(tenantId, categoryId, { code: by.code }, excludeId);
            if (clash) {
                throw warehouseError('GROUP_CODE_TAKEN', 'Dieses Kürzel trägt schon eine andere Gruppe der Kategorie.', {
                    status: 409,
                    params: { code: by.code, name: clash.name },
                });
            }
        }
    }

    private categoryUnique(error: unknown, by: { name?: string; code?: string }): unknown {
        if (isUniqueViolation(error, 'code')) {
            return warehouseError('CATEGORY_CODE_TAKEN', 'Dieses Kürzel trägt schon eine andere Hauptkategorie.', {
                status: 409,
                params: { code: by.code ?? '', name: '' },
            });
        }
        if (isUniqueViolation(error, 'name')) {
            return warehouseError('CATEGORY_NAME_TAKEN', 'Diese Hauptkategorie gibt es schon.', { status: 409, params: { name: by.name ?? '' } });
        }
        return error;
    }

    private groupUnique(error: unknown, by: { name: string; code: string }): unknown {
        if (isUniqueViolation(error, 'code')) {
            return warehouseError('GROUP_CODE_TAKEN', 'Dieses Kürzel trägt schon eine andere Gruppe der Kategorie.', {
                status: 409,
                params: { code: by.code, name: '' },
            });
        }
        if (isUniqueViolation(error, 'name')) {
            return warehouseError('GROUP_NAME_TAKEN', 'Diese Materialgruppe gibt es in der Kategorie schon.', { status: 409, params: { name: by.name } });
        }
        return error;
    }
}
