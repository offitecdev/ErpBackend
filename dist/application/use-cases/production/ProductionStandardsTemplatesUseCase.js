"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionStandardsTemplatesUseCase = void 0;
const productionTasks_1 = require("../../../domain/services/productionTasks");
/**
 * ── VORLAGEN DER DOKUMENT-STANDARDS (02.10.2026) ────────────────────────────
 *
 * «In the Document standards the admin should be able to add a template for
 *  standard and select a standard with a combobox.» Lesen darf, wer die
 * Produktion sieht (die Auswahl im Fenster der Standards); anlegen, ändern und
 * löschen die Verwaltung (der Weg sichert es). Eine Unteraufgabe übernimmt beim
 * Wählen eine KOPIE von Text und PDF-Verweis — spätere Änderungen an der
 * Vorlage ändern keine Unteraufgabe.
 */
class ProductionStandardsTemplatesUseCase {
    templates;
    constructor(templates) {
        this.templates = templates;
    }
    async list(tenantId) {
        return { items: await this.templates.list(tenantId) };
    }
    async create(tenantId, actorId, body) {
        const input = (0, productionTasks_1.standardsTemplateInputFrom)(body, tenantId);
        await this.assertNameFree(tenantId, input.name);
        const created = await this.templates.create(tenantId, input, actorId);
        if (created === 'NAME_TAKEN')
            throw this.nameTaken(input.name);
        return { template: created };
    }
    async update(tenantId, actorId, id, body) {
        const input = (0, productionTasks_1.standardsTemplateInputFrom)(body, tenantId);
        await this.assertNameFree(tenantId, input.name, id);
        const updated = await this.templates.update(tenantId, id, input, actorId);
        if (updated === 'NAME_TAKEN')
            throw this.nameTaken(input.name);
        if (!updated)
            throw this.notFound();
        return { template: updated };
    }
    async remove(tenantId, id) {
        if (!(await this.templates.remove(tenantId, id)))
            throw this.notFound();
        return { removed: true };
    }
    /** Gross/klein und İ/i gelten als gleich (wie die Namen der Görevlendirme-Vorlagen). */
    async assertNameFree(tenantId, name, exceptId) {
        const key = (value) => value.toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');
        const taken = (await this.templates.list(tenantId)).some((entry) => entry.id !== exceptId && key(entry.name) === key(name));
        if (taken)
            throw this.nameTaken(name);
    }
    nameTaken(name) {
        return (0, productionTasks_1.productionTaskError)('NAME_TAKEN', `«${name}» gibt es schon.`, { status: 409, params: { name } });
    }
    notFound() {
        return (0, productionTasks_1.productionTaskError)('STANDARDS_TEMPLATE_NOT_FOUND', 'Diese Vorlage gibt es nicht (mehr).', { status: 404 });
    }
}
exports.ProductionStandardsTemplatesUseCase = ProductionStandardsTemplatesUseCase;
//# sourceMappingURL=ProductionStandardsTemplatesUseCase.js.map