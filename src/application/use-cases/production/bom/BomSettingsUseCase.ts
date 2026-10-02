import type { BomCustomCategory, BomSettings } from '../../../../domain/entities/ProductionBom';
import type { IBomCategoryRepository, IBomSettingsRepository } from '../../../../domain/repositories/IProductionBomRepository';
import {
    BOM_CATEGORY_LIMITS,
    BOM_LIMITS,
    bomError,
    categoryInputFrom,
    codesFrom,
    newBomCategoryId,
} from '../../../../domain/services/productionBom';
import type { BomActor } from './BomTemplatesUseCase';

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
export class BomSettingsUseCase {
    constructor(private settings: IBomSettingsRepository, private categories: IBomCategoryRepository) {}

    get(tenantId: string): Promise<BomSettings> {
        return this.settings.get(tenantId);
    }

    async save(tenantId: string, actor: BomActor, body: unknown): Promise<BomSettings> {
        this.assertAdmin(actor);
        const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const current = await this.settings.get(tenantId);
        // Nur mitgeschickte Teile ändern sich (die Seite speichert Zahl und Kodes getrennt).
        let maxPerArea = current.maxPerArea;
        if (input.maxPerArea !== undefined) {
            const raw = Number(input.maxPerArea);
            if (!Number.isInteger(raw) || raw < 1 || raw > BOM_LIMITS.maxPerAreaCeiling) {
                throw bomError('SETTINGS_INVALID', `Zwischen 1 und ${BOM_LIMITS.maxPerAreaCeiling}.`, {
                    params: { min: 1, max: BOM_LIMITS.maxPerAreaCeiling },
                });
            }
            maxPerArea = raw;
        }
        const codes = input.codes !== undefined ? codesFrom(input.codes, current.categories) : current.codes;
        return this.settings.save(tenantId, { maxPerArea, codes }, actor.id);
    }

    /* ── Eigene Kategorien ─────────────────────────────────────────────── */

    async createCategory(tenantId: string, actor: BomActor, body: unknown): Promise<BomCustomCategory> {
        this.assertAdmin(actor);
        const input = categoryInputFrom(body);
        const existing = await this.categories.list(tenantId);
        if (existing.length >= BOM_CATEGORY_LIMITS.categories) {
            throw bomError('CATEGORY_LIMIT', `Höchstens ${BOM_CATEGORY_LIMITS.categories} eigene Kategorien.`, {
                status: 409,
                params: { max: BOM_CATEGORY_LIMITS.categories },
            });
        }
        this.assertNameFree(existing, input.name);
        const created = await this.categories.create(tenantId, { id: newBomCategoryId(), ...input }, actor.id);
        if (!created) throw bomError('CATEGORY_CODE_TAKEN', `${input.code} ist schon vergeben.`, { status: 409, params: { code: input.code } });
        return created;
    }

    /**
     * Name jederzeit; den Kod nur, solange die Kategorie keine BOM trägt —
     * er steht in den Nummern ihrer Haupt-BOMs (BOM-HYD-00001).
     */
    async updateCategory(tenantId: string, actor: BomActor, id: string, body: unknown): Promise<BomCustomCategory> {
        this.assertAdmin(actor);
        const current = await this.requireCategory(tenantId, id);
        const input = categoryInputFrom(body);
        this.assertNameFree((await this.categories.list(tenantId)).filter((entry) => entry.id !== id), input.name);
        const patch: { name: string; code?: string } = { name: input.name };
        if (input.code !== current.code) {
            const usage = await this.categories.usage(tenantId, id);
            if (usage.boms) {
                throw bomError('CATEGORY_IN_USE', 'Der Kod steht schon in BOM-Nummern — er bleibt.', { status: 409, params: { boms: usage.boms } });
            }
            patch.code = input.code;
        }
        const updated = await this.categories.update(tenantId, id, patch, actor.id);
        if (updated === 'CODE_TAKEN') throw bomError('CATEGORY_CODE_TAKEN', `${input.code} ist schon vergeben.`, { status: 409, params: { code: input.code } });
        if (!updated) throw bomError('CATEGORY_NOT_FOUND', 'Diese BOM-Kategorie gibt es nicht (mehr).', { status: 404 });
        return updated;
    }

    async deleteCategory(tenantId: string, actor: BomActor, id: string): Promise<{ removed: true }> {
        this.assertAdmin(actor);
        await this.requireCategory(tenantId, id);
        const usage = await this.categories.usage(tenantId, id);
        if (usage.boms || usage.templates || usage.taskTemplates) {
            throw bomError('CATEGORY_IN_USE', 'Die Kategorie trägt noch BOMs oder Vorlagen.', { status: 409, params: { ...usage } });
        }
        await this.categories.remove(tenantId, id);
        return { removed: true };
    }

    private assertAdmin(actor: BomActor): void {
        if (!actor.isAdmin) throw bomError('FORBIDDEN', 'Die Einstellungen ändert die Administratorrolle.', { status: 403 });
    }

    private async requireCategory(tenantId: string, id: string): Promise<BomCustomCategory> {
        const category = await this.categories.get(tenantId, id);
        if (!category) throw bomError('CATEGORY_NOT_FOUND', 'Diese BOM-Kategorie gibt es nicht (mehr).', { status: 404 });
        return category;
    }

    private assertNameFree(others: readonly BomCustomCategory[], name: string): void {
        const key = (value: string) => value.toLocaleLowerCase('tr-TR');
        if (others.some((entry) => key(entry.name) === key(name))) {
            throw bomError('CATEGORY_NAME_TAKEN', `«${name}» gibt es schon.`, { status: 409, params: { name } });
        }
    }
}
