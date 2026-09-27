import type { BomSettings } from '../../../../domain/entities/ProductionBom';
import type { IBomSettingsRepository } from '../../../../domain/repositories/IProductionBomRepository';
import { BOM_LIMITS, bomError, codesFrom } from '../../../../domain/services/productionBom';
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
 */
export class BomSettingsUseCase {
    constructor(private settings: IBomSettingsRepository) {}

    get(tenantId: string): Promise<BomSettings> {
        return this.settings.get(tenantId);
    }

    async save(tenantId: string, actor: BomActor, body: unknown): Promise<BomSettings> {
        if (!actor.isAdmin) throw bomError('FORBIDDEN', 'Die Einstellungen ändert die Administratorrolle.', { status: 403 });
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
        const codes = input.codes !== undefined ? codesFrom(input.codes) : current.codes;
        return this.settings.save(tenantId, { maxPerArea, codes }, actor.id);
    }
}
