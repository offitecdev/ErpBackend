"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WarehouseCatalogUseCase = void 0;
const warehouse_1 = require("../../../domain/services/warehouse");
const warehouseCodes_1 = require("../../../domain/services/warehouseCodes");
const warehouseReadModel_1 = require("./warehouseReadModel");
const WarehouseProductsUseCase_1 = require("./WarehouseProductsUseCase");
const has = (input, key) => Object.prototype.hasOwnProperty.call(input, key);
const objectOf = (body) => (body && typeof body === 'object' ? body : {});
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
class WarehouseCatalogUseCase {
    groups;
    directory;
    products;
    settingsRepo;
    constructor(groups, directory, products, settingsRepo) {
        this.groups = groups;
        this.directory = directory;
        this.products = products;
        this.settingsRepo = settingsRepo;
    }
    async tree(tenantId) {
        return (0, warehouseReadModel_1.catalogDto)(await this.groups.tree(tenantId));
    }
    /* ── Hauptkategorien ─────────────────────────────────────────────── */
    async createCategory(tenantId, body) {
        const input = objectOf(body);
        const name = this.categoryName(input.name);
        const code = this.abbreviation(input.code, 'CATEGORY_CODE_INVALID');
        await this.assertCategoryFree(tenantId, { name, code });
        try {
            return await this.groups.createCategory(tenantId, { name, code });
        }
        catch (error) {
            throw this.categoryUnique(error, { name, code });
        }
    }
    async updateCategory(tenantId, id, body) {
        const input = objectOf(body);
        const current = await this.groups.getCategory(tenantId, id);
        if (!current)
            throw (0, warehouse_1.warehouseError)('CATEGORY_NOT_FOUND', 'Hauptkategorie nicht gefunden.', { status: 404 });
        const patch = {};
        if (has(input, 'name')) {
            const name = this.categoryName(input.name);
            if (name !== current.name)
                patch.name = name;
        }
        if (has(input, 'code')) {
            const code = this.abbreviation(input.code, 'CATEGORY_CODE_INVALID');
            if (code !== current.code) {
                const coded = await this.groups.codedInCategory(tenantId, id);
                if (coded > 0) {
                    throw (0, warehouse_1.warehouseError)('CATEGORY_CODE_LOCKED', 'Das Kürzel steht fest: es gibt schon Karten mit Code.', {
                        status: 409,
                        params: { count: coded },
                    });
                }
                patch.code = code;
            }
        }
        if (!Object.keys(patch).length)
            return current;
        await this.assertCategoryFree(tenantId, patch, id);
        try {
            const updated = await this.groups.updateCategory(tenantId, id, patch);
            if (!updated)
                throw (0, warehouse_1.warehouseError)('CATEGORY_NOT_FOUND', 'Hauptkategorie nicht gefunden.', { status: 404 });
            return updated;
        }
        catch (error) {
            throw this.categoryUnique(error, patch);
        }
    }
    async deleteCategory(tenantId, id) {
        const current = await this.groups.getCategory(tenantId, id);
        if (!current)
            throw (0, warehouse_1.warehouseError)('CATEGORY_NOT_FOUND', 'Hauptkategorie nicht gefunden.', { status: 404 });
        const count = await this.groups.groupCount(tenantId, id);
        if (count > 0) {
            throw (0, warehouse_1.warehouseError)('CATEGORY_IN_USE', 'Die Hauptkategorie hat noch Materialgruppen.', {
                status: 409,
                params: { count },
            });
        }
        await this.groups.deleteCategory(tenantId, id);
        return { ok: true };
    }
    /* ── Materialgruppen ─────────────────────────────────────────────── */
    async createGroup(tenantId, body) {
        const input = objectOf(body);
        const categoryId = String(input.categoryId ?? '').trim();
        const category = categoryId ? await this.groups.getCategory(tenantId, categoryId) : null;
        if (!category)
            throw (0, warehouse_1.warehouseError)('CATEGORY_NOT_FOUND', 'Hauptkategorie nicht gefunden.', { status: 400 });
        const name = this.groupName(input.name);
        const code = this.abbreviation(input.code, 'GROUP_CODE_INVALID');
        await this.assertGroupFree(tenantId, category.id, { name, code });
        try {
            return (0, warehouseReadModel_1.plainGroupDto)(await this.groups.createGroup(tenantId, { categoryId: category.id, name, code }));
        }
        catch (error) {
            throw this.groupUnique(error, { name, code });
        }
    }
    async updateGroup(tenantId, id, body) {
        const input = objectOf(body);
        const current = await this.groups.getGroup(tenantId, id);
        if (!current)
            throw (0, warehouse_1.warehouseError)('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 404 });
        const patch = {};
        if (has(input, 'name')) {
            const name = this.groupName(input.name);
            if (name !== current.name)
                patch.name = name;
        }
        if (has(input, 'code')) {
            const code = this.abbreviation(input.code, 'GROUP_CODE_INVALID');
            if (code !== current.code)
                patch.code = code;
        }
        if (has(input, 'categoryId')) {
            const categoryId = String(input.categoryId ?? '').trim();
            if (categoryId && categoryId !== current.categoryId) {
                const category = await this.groups.getCategory(tenantId, categoryId);
                if (!category)
                    throw (0, warehouse_1.warehouseError)('CATEGORY_NOT_FOUND', 'Hauptkategorie nicht gefunden.', { status: 400 });
                patch.categoryId = category.id;
            }
        }
        if (!Object.keys(patch).length)
            return (0, warehouseReadModel_1.plainGroupDto)(current);
        if (patch.code !== undefined || patch.categoryId !== undefined) {
            const coded = await this.groups.codedCount(tenantId, id);
            if (coded > 0) {
                throw (0, warehouse_1.warehouseError)('GROUP_CODE_LOCKED', 'Kürzel und Kategorie stehen fest: es gibt schon Karten mit Code.', {
                    status: 409,
                    params: { count: coded },
                });
            }
        }
        const targetCategory = patch.categoryId ?? current.categoryId;
        await this.assertGroupFree(tenantId, targetCategory, {
            ...(patch.name !== undefined || patch.categoryId !== undefined ? { name: patch.name ?? current.name } : {}),
            ...(patch.code !== undefined || (patch.categoryId !== undefined && current.code) ? { code: patch.code ?? current.code ?? '' } : {}),
        }, id);
        try {
            const updated = await this.groups.updateGroup(tenantId, id, patch);
            if (!updated)
                throw (0, warehouse_1.warehouseError)('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 404 });
            return (0, warehouseReadModel_1.plainGroupDto)(updated);
        }
        catch (error) {
            throw this.groupUnique(error, { name: patch.name ?? current.name, code: patch.code ?? current.code ?? '' });
        }
    }
    async deleteGroup(tenantId, id) {
        const group = await this.groups.getGroup(tenantId, id);
        if (!group)
            throw (0, warehouse_1.warehouseError)('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 404 });
        const count = await this.groups.productCount(tenantId, id);
        if (count > 0) {
            throw (0, warehouse_1.warehouseError)('GROUP_IN_USE', 'Die Materialgruppe ist noch Karten zugeordnet.', {
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
    async assignCodes(tenantId, groupId) {
        const group = await this.groups.getGroup(tenantId, groupId);
        if (!group)
            throw (0, warehouse_1.warehouseError)('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 404 });
        if (!group.code) {
            throw (0, warehouse_1.warehouseError)('GROUP_CODE_MISSING', 'Diese Materialgruppe hat noch kein Kürzel.', {
                status: 409,
                params: { group: group.name },
            });
        }
        return { assigned: await this.products.assignMissingCodes(tenantId, groupId) };
    }
    /* ── Etikett ─────────────────────────────────────────────────────── */
    async settings(tenantId) {
        return (0, warehouseReadModel_1.settingsDto)(await this.settingsRepo.get(tenantId));
    }
    async saveSettings(tenantId, body) {
        const input = objectOf(body);
        const current = await this.settingsRepo.get(tenantId);
        const label = (0, warehouseCodes_1.labelSettingsFrom)(input.label ?? input, current.label);
        if (!label) {
            throw (0, warehouse_1.warehouseError)('LABEL_SIZE_INVALID', 'Das Etikett ist zu klein oder zu gross.', {
                params: {
                    minWidth: warehouseCodes_1.LABEL_LIMITS.minWidth,
                    maxWidth: warehouseCodes_1.LABEL_LIMITS.maxWidth,
                    minHeight: warehouseCodes_1.LABEL_LIMITS.minHeight,
                    maxHeight: warehouseCodes_1.LABEL_LIMITS.maxHeight,
                },
            });
        }
        return (0, warehouseReadModel_1.settingsDto)(await this.settingsRepo.saveLabel(tenantId, label));
    }
    /* ── Auswahlen aus anderen Modulen (nur lesen) ───────────────────── */
    suppliers(tenantId, rawQuery) {
        return this.directory.searchSuppliers(tenantId, (0, warehouse_1.searchFrom)(rawQuery), 20);
    }
    projects(tenantId, rawSearch) {
        return this.directory.listProjects(tenantId, (0, warehouse_1.searchFrom)(rawSearch), 80);
    }
    async devices(tenantId, projectId) {
        const project = await this.directory.getProject(tenantId, projectId);
        if (!project)
            throw (0, warehouse_1.warehouseError)('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });
        return this.directory.listDevices(tenantId, projectId);
    }
    /* ── Hilfen ─────────────────────────────────────────────────────────── */
    categoryName(raw) {
        const name = (0, warehouse_1.cleanLine)(raw, 'name', warehouse_1.WAREHOUSE_LIMITS.categoryName);
        if (!name)
            throw (0, warehouse_1.warehouseError)('CATEGORY_NAME_REQUIRED', 'Der Name der Hauptkategorie fehlt.');
        return name;
    }
    groupName(raw) {
        const name = (0, warehouse_1.cleanLine)(raw, 'name', warehouse_1.WAREHOUSE_LIMITS.groupName);
        if (!name)
            throw (0, warehouse_1.warehouseError)('GROUP_NAME_REQUIRED', 'Der Name der Materialgruppe fehlt.');
        return name;
    }
    abbreviation(raw, code) {
        const value = (0, warehouseCodes_1.normalizeAbbreviation)(raw);
        if (!(0, warehouseCodes_1.isValidAbbreviation)(value)) {
            throw (0, warehouse_1.warehouseError)(code, 'Das Kürzel braucht 2–5 Buchstaben oder Ziffern.', {
                params: { min: warehouseCodes_1.ABBREVIATION_MIN, max: warehouseCodes_1.ABBREVIATION_MAX },
            });
        }
        return value;
    }
    async assertCategoryFree(tenantId, by, excludeId) {
        if (by.name) {
            const clash = await this.groups.findCategory(tenantId, { name: by.name }, excludeId);
            if (clash)
                throw (0, warehouse_1.warehouseError)('CATEGORY_NAME_TAKEN', 'Diese Hauptkategorie gibt es schon.', { status: 409, params: { name: clash.name } });
        }
        if (by.code) {
            const clash = await this.groups.findCategory(tenantId, { code: by.code }, excludeId);
            if (clash) {
                throw (0, warehouse_1.warehouseError)('CATEGORY_CODE_TAKEN', 'Dieses Kürzel trägt schon eine andere Hauptkategorie.', {
                    status: 409,
                    params: { code: by.code, name: clash.name },
                });
            }
        }
    }
    async assertGroupFree(tenantId, categoryId, by, excludeId) {
        if (by.name) {
            const clash = await this.groups.findGroup(tenantId, categoryId, { name: by.name }, excludeId);
            if (clash)
                throw (0, warehouse_1.warehouseError)('GROUP_NAME_TAKEN', 'Diese Materialgruppe gibt es in der Kategorie schon.', { status: 409, params: { name: clash.name } });
        }
        if (by.code) {
            const clash = await this.groups.findGroup(tenantId, categoryId, { code: by.code }, excludeId);
            if (clash) {
                throw (0, warehouse_1.warehouseError)('GROUP_CODE_TAKEN', 'Dieses Kürzel trägt schon eine andere Gruppe der Kategorie.', {
                    status: 409,
                    params: { code: by.code, name: clash.name },
                });
            }
        }
    }
    categoryUnique(error, by) {
        if ((0, WarehouseProductsUseCase_1.isUniqueViolation)(error, 'code')) {
            return (0, warehouse_1.warehouseError)('CATEGORY_CODE_TAKEN', 'Dieses Kürzel trägt schon eine andere Hauptkategorie.', {
                status: 409,
                params: { code: by.code ?? '', name: '' },
            });
        }
        if ((0, WarehouseProductsUseCase_1.isUniqueViolation)(error, 'name')) {
            return (0, warehouse_1.warehouseError)('CATEGORY_NAME_TAKEN', 'Diese Hauptkategorie gibt es schon.', { status: 409, params: { name: by.name ?? '' } });
        }
        return error;
    }
    groupUnique(error, by) {
        if ((0, WarehouseProductsUseCase_1.isUniqueViolation)(error, 'code')) {
            return (0, warehouse_1.warehouseError)('GROUP_CODE_TAKEN', 'Dieses Kürzel trägt schon eine andere Gruppe der Kategorie.', {
                status: 409,
                params: { code: by.code, name: '' },
            });
        }
        if ((0, WarehouseProductsUseCase_1.isUniqueViolation)(error, 'name')) {
            return (0, warehouse_1.warehouseError)('GROUP_NAME_TAKEN', 'Diese Materialgruppe gibt es in der Kategorie schon.', { status: 409, params: { name: by.name } });
        }
        return error;
    }
}
exports.WarehouseCatalogUseCase = WarehouseCatalogUseCase;
//# sourceMappingURL=WarehouseCatalogUseCase.js.map