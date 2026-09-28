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
 */
class BomSettingsUseCase {
    settings;
    constructor(settings) {
        this.settings = settings;
    }
    get(tenantId) {
        return this.settings.get(tenantId);
    }
    async save(tenantId, actor, body) {
        if (!actor.isAdmin)
            throw (0, productionBom_1.bomError)('FORBIDDEN', 'Die Einstellungen ändert die Administratorrolle.', { status: 403 });
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
        const codes = input.codes !== undefined ? (0, productionBom_1.codesFrom)(input.codes) : current.codes;
        return this.settings.save(tenantId, { maxPerArea, codes }, actor.id);
    }
}
exports.BomSettingsUseCase = BomSettingsUseCase;
//# sourceMappingURL=BomSettingsUseCase.js.map