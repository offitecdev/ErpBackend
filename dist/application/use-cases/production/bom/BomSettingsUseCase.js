"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BomSettingsUseCase = void 0;
const productionBom_1 = require("../../../../domain/services/productionBom");
/**
 * ── ÜRETİM MODÜL AYARLARI · BOM (27.09.2026) ────────────────────────────────
 *
 * «Bom liste için açılacak max bom belirlenir, bu da üretim modül
 *  ayarlarında olur … max 2'ye ayarlı olsun.» Seit der Hierarchie (gleicher
 * Tag): höchstens so viele ALT-BOMs unter der Haupt-BOM eines Geräts je
 * Bereich — und hier stehen die Alt-BOM-Kodes («alt BOM kodları ayarlardan
 * Mekanik ve Elektrik için ayrı ayrı belirlenir»). Lesen darf, wer die
 * Produktion sieht; ändern die Administratorrolle.
 *
 * KATEGORIEN (02.10.2026): neben Mekanik (MEK) und Elektrik (ELK), die es
 * immer gibt, legt die Administratorrolle eigene an — Name und Kod (HYD →
 * BOM-HYD-00001), darunter ihre Alt-BOM-Kodes wie bei den festen. Löschen
 * lässt sich eine Kategorie nur, solange keine BOM, keine BOM-Vorlage und
 * keine Görevlendirme-Vorlage (als Bereich) sie trägt.
 */
class BomSettingsUseCase {
    settings;
    categories;
    constructor(settings, categories) {
        this.settings = settings;
        this.categories = categories;
    }
    get(tenantId) {
        return this.settings.get(tenantId);
    }
    async save(tenantId, actor, body) {
        this.assertAdmin(actor);
        const input = (body && typeof body === 'object' ? body : {});
        const current = await this.settings.get(tenantId);
        // Nur mitgeschickte Teile ändern sich (die Seite speichert Zahl und Kodes getrennt).
        let maxPerArea = current.maxPerArea;
        if (input.maxPerArea !== undefined) {
            const raw = Number(input.maxPerArea);
            if (!Number.isInteger(raw) || raw < 1 || raw > productionBom_1.BOM_LIMITS.maxPerAreaCeiling) {
                throw (0, productionBom_1.bomError)('SETTINGS_INVALID', `Zwischen 1 und ${productionBom_1.BOM_LIMITS.maxPerAreaCeiling}.`, {
                    params: { min: 1, max: productionBom_1.BOM_LIMITS.maxPerAreaCeiling },
                });
            }
            maxPerArea = raw;
        }
        const codes = input.codes !== undefined ? (0, productionBom_1.codesFrom)(input.codes, current.categories) : current.codes;
        return this.settings.save(tenantId, { maxPerArea, codes }, actor.id);
    }
    /* ── Eigene Kategorien ─────────────────────────────────────────────── */
    async createCategory(tenantId, actor, body) {
        this.assertAdmin(actor);
        const input = (0, productionBom_1.categoryInputFrom)(body);
        const existing = await this.categories.list(tenantId);
        if (existing.length >= productionBom_1.BOM_CATEGORY_LIMITS.categories) {
            throw (0, productionBom_1.bomError)('CATEGORY_LIMIT', `Höchstens ${productionBom_1.BOM_CATEGORY_LIMITS.categories} eigene Kategorien.`, {
                status: 409,
                params: { max: productionBom_1.BOM_CATEGORY_LIMITS.categories },
            });
        }
        this.assertNameFree(existing, input.name);
        const created = await this.categories.create(tenantId, { id: (0, productionBom_1.newBomCategoryId)(), ...input }, actor.id);
        if (!created)
            throw (0, productionBom_1.bomError)('CATEGORY_CODE_TAKEN', `${input.code} ist schon vergeben.`, { status: 409, params: { code: input.code } });
        return created;
    }
    /**
     * Name jederzeit; den Kod nur, solange die Kategorie keine BOM trägt —
     * er steht in den Nummern ihrer Haupt-BOMs (BOM-HYD-00001).
     */
    async updateCategory(tenantId, actor, id, body) {
        this.assertAdmin(actor);
        const current = await this.requireCategory(tenantId, id);
        const input = (0, productionBom_1.categoryInputFrom)(body);
        this.assertNameFree((await this.categories.list(tenantId)).filter((entry) => entry.id !== id), input.name);
        const patch = { name: input.name };
        if (input.code !== current.code) {
            const usage = await this.categories.usage(tenantId, id);
            if (usage.boms) {
                throw (0, productionBom_1.bomError)('CATEGORY_IN_USE', 'Der Kod steht schon in BOM-Nummern — er bleibt.', { status: 409, params: { boms: usage.boms } });
            }
            patch.code = input.code;
        }
        const updated = await this.categories.update(tenantId, id, patch, actor.id);
        if (updated === 'CODE_TAKEN')
            throw (0, productionBom_1.bomError)('CATEGORY_CODE_TAKEN', `${input.code} ist schon vergeben.`, { status: 409, params: { code: input.code } });
        if (!updated)
            throw (0, productionBom_1.bomError)('CATEGORY_NOT_FOUND', 'Diese BOM-Kategorie gibt es nicht (mehr).', { status: 404 });
        return updated;
    }
    async deleteCategory(tenantId, actor, id) {
        this.assertAdmin(actor);
        await this.requireCategory(tenantId, id);
        const usage = await this.categories.usage(tenantId, id);
        if (usage.boms || usage.templates || usage.taskTemplates) {
            throw (0, productionBom_1.bomError)('CATEGORY_IN_USE', 'Die Kategorie trägt noch BOMs oder Vorlagen.', { status: 409, params: { ...usage } });
        }
        await this.categories.remove(tenantId, id);
        return { removed: true };
    }
    assertAdmin(actor) {
        if (!actor.isAdmin)
            throw (0, productionBom_1.bomError)('FORBIDDEN', 'Die Einstellungen ändert die Administratorrolle.', { status: 403 });
    }
    async requireCategory(tenantId, id) {
        const category = await this.categories.get(tenantId, id);
        if (!category)
            throw (0, productionBom_1.bomError)('CATEGORY_NOT_FOUND', 'Diese BOM-Kategorie gibt es nicht (mehr).', { status: 404 });
        return category;
    }
    assertNameFree(others, name) {
        const key = (value) => value.toLocaleLowerCase('tr-TR');
        if (others.some((entry) => key(entry.name) === key(name))) {
            throw (0, productionBom_1.bomError)('CATEGORY_NAME_TAKEN', `«${name}» gibt es schon.`, { status: 409, params: { name } });
        }
    }
}
exports.BomSettingsUseCase = BomSettingsUseCase;
//# sourceMappingURL=BomSettingsUseCase.js.map