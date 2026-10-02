import type { ProductionStandardsTemplate } from '../../../domain/entities/ProductionTask';
import type { IProductionStandardsTemplateRepository } from '../../../domain/repositories/IProductionTaskRepository';
import { productionTaskError, standardsTemplateInputFrom } from '../../../domain/services/productionTasks';

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
export class ProductionStandardsTemplatesUseCase {
    constructor(private templates: IProductionStandardsTemplateRepository) {}

    async list(tenantId: string): Promise<{ items: ProductionStandardsTemplate[] }> {
        return { items: await this.templates.list(tenantId) };
    }

    async create(tenantId: string, actorId: string, body: unknown): Promise<{ template: ProductionStandardsTemplate }> {
        const input = standardsTemplateInputFrom(body, tenantId);
        await this.assertNameFree(tenantId, input.name);
        const created = await this.templates.create(tenantId, input, actorId);
        if (created === 'NAME_TAKEN') throw this.nameTaken(input.name);
        return { template: created };
    }

    async update(tenantId: string, actorId: string, id: string, body: unknown): Promise<{ template: ProductionStandardsTemplate }> {
        const input = standardsTemplateInputFrom(body, tenantId);
        await this.assertNameFree(tenantId, input.name, id);
        const updated = await this.templates.update(tenantId, id, input, actorId);
        if (updated === 'NAME_TAKEN') throw this.nameTaken(input.name);
        if (!updated) throw this.notFound();
        return { template: updated };
    }

    async remove(tenantId: string, id: string): Promise<{ removed: true }> {
        if (!(await this.templates.remove(tenantId, id))) throw this.notFound();
        return { removed: true };
    }

    /** Gross/klein und İ/i gelten als gleich (wie die Namen der Görevlendirme-Vorlagen). */
    private async assertNameFree(tenantId: string, name: string, exceptId?: string): Promise<void> {
        const key = (value: string) => value.toLocaleLowerCase('tr-TR').replace(/ı/g, 'i');
        const taken = (await this.templates.list(tenantId)).some((entry) => entry.id !== exceptId && key(entry.name) === key(name));
        if (taken) throw this.nameTaken(name);
    }

    private nameTaken(name: string) {
        return productionTaskError('NAME_TAKEN', `«${name}» gibt es schon.`, { status: 409, params: { name } });
    }

    private notFound() {
        return productionTaskError('STANDARDS_TEMPLATE_NOT_FOUND', 'Diese Vorlage gibt es nicht (mehr).', { status: 404 });
    }
}
