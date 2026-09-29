import type {
    IProductionTaskDirectory,
    IProductionTaskTemplateRepository,
} from '../../../domain/repositories/IProductionTaskRepository';
import type { ProductionTaskDraft, ProductionTaskTemplate, ProductionTaskTemplateInput } from '../../../domain/entities/ProductionTask';
import {
    CHILLER_EXAMPLE,
    CHILLER_EXAMPLE_KEY,
    orderTasks,
    productionTaskError,
    templateInputFrom,
    withActiveAssignees,
} from '../../../domain/services/productionTasks';
import {
    assigneesOf,
    summaryDto,
    templateDto,
    type ProductionTaskTemplateDto,
    type ProductionTaskTemplateSummaryDto,
} from './productionTaskReadModel';

export interface ProductionTaskActor {
    id: string;
    name: string | null;
}

/** Ein Schlüssel ist schon vergeben (Prisma P2002). */
export const isUniqueViolation = (error: unknown): boolean =>
    (error as { code?: string } | null)?.code === 'P2002';

/**
 * ── GÖREVLENDİRME ŞABLONLARI (26.09.2026, Vorgabe Samet) ────────────────────
 *
 * «Üretimde yeni sayfa oluyor: görevlendirme şablonları — bu şablonları
 *  ekleyebiliyoruz.»
 *
 * Lesen darf, wer die Produktion sieht; anlegen, ändern und löschen nur die
 * Administratorrolle (die Wege prüfen das). Beim ersten Öffnen bekommt die
 * Firma das Beispiel «Chiller» — genau einmal: auch gelöscht kommt es nicht
 * wieder (die gelöschte Zeile bleibt stehen, und ihr Beispielschlüssel ist je
 * Firma eindeutig).
 *
 * Personen einer Vorlage müssen aktive Leute der gewählten Firma sein;
 * andere Kennungen fallen beim Speichern still heraus.
 */
export class ProductionTaskTemplatesUseCase {
    /** Firmen, deren Beispiel in diesem Prozess schon geprüft ist. */
    private readonly exampleChecked = new Set<string>();
    private readonly exampleInFlight = new Map<string, Promise<void>>();

    constructor(
        private readonly templates: IProductionTaskTemplateRepository,
        private readonly directory: IProductionTaskDirectory,
    ) {}

    async list(tenantId: string): Promise<ProductionTaskTemplateSummaryDto[]> {
        await this.ensureExample(tenantId);
        const rows = await this.templates.list(tenantId);
        return rows.map(summaryDto);
    }

    async get(tenantId: string, id: string): Promise<ProductionTaskTemplateDto> {
        const template = await this.templates.get(tenantId, id);
        if (!template) throw this.notFound();
        return this.dto(tenantId, template);
    }

    async create(tenantId: string, actor: ProductionTaskActor, body: unknown): Promise<ProductionTaskTemplateDto> {
        const input = await this.inputFrom(tenantId, body);
        if (await this.templates.nameTaken(tenantId, input.name)) throw this.nameTaken(input.name);
        const created = await this.templates.create(tenantId, actor.id, input);
        return this.dto(tenantId, created);
    }

    async update(tenantId: string, actor: ProductionTaskActor, id: string, body: unknown): Promise<ProductionTaskTemplateDto> {
        const input = await this.inputFrom(tenantId, body);
        if (await this.templates.nameTaken(tenantId, input.name, id)) throw this.nameTaken(input.name);
        const saved = await this.templates.replace(tenantId, id, actor.id, input);
        if (!saved) throw this.notFound();
        return this.dto(tenantId, saved);
    }

    async remove(tenantId: string, actor: ProductionTaskActor, id: string): Promise<{ deleted: true }> {
        if (!(await this.templates.softDelete(tenantId, id, actor.id))) throw this.notFound();
        return { deleted: true };
    }

    /* ── intern ─────────────────────────────────────────────────────── */

    /**
     * Das Beispiel «Chiller», wenn die Firma noch NIE eine Vorlage hatte.
     * Gleichzeitige Aufrufe teilen sich einen Vorgang; läuft trotzdem ein
     * zweiter Prozess dazwischen, scheitert sein Anlegen am eindeutigen
     * Beispielschlüssel — das ist dann kein Fehler.
     */
    private async ensureExample(tenantId: string): Promise<void> {
        if (this.exampleChecked.has(tenantId)) return;
        const pending = this.exampleInFlight.get(tenantId);
        if (pending) return pending;
        const run = (async () => {
            if ((await this.templates.countEver(tenantId)) > 0) return;
            try {
                await this.templates.create(tenantId, null, CHILLER_EXAMPLE, CHILLER_EXAMPLE_KEY);
            } catch (error) {
                if (!isUniqueViolation(error)) throw error;
            }
        })();
        this.exampleInFlight.set(tenantId, run);
        try {
            await run;
            this.exampleChecked.add(tenantId);
        } finally {
            this.exampleInFlight.delete(tenantId);
        }
    }

    private async inputFrom(tenantId: string, body: unknown): Promise<ProductionTaskTemplateInput> {
        const input = templateInputFrom(body);
        return { ...input, tasks: orderTasks(await this.keepActivePeople(tenantId, input.tasks), input.sections) };
    }

    private async keepActivePeople(tenantId: string, tasks: ProductionTaskDraft[]): Promise<ProductionTaskDraft[]> {
        const ids = assigneesOf(tasks);
        if (!ids.length) return tasks;
        const active = await this.directory.activePeople(tenantId, ids);
        return tasks.map((task) => withActiveAssignees(task, active));
    }

    private async dto(tenantId: string, template: ProductionTaskTemplate): Promise<ProductionTaskTemplateDto> {
        const [people, updatedByName] = await Promise.all([
            this.directory.people(tenantId, assigneesOf(template.tasks)),
            template.updatedById ? this.directory.personName(template.updatedById) : Promise.resolve(null),
        ]);
        return templateDto(template, people, updatedByName);
    }

    private notFound() {
        return productionTaskError('TEMPLATE_NOT_FOUND', 'Vorlage nicht gefunden.', { status: 404 });
    }

    private nameTaken(name: string) {
        return productionTaskError('NAME_TAKEN', `Es gibt schon eine Vorlage «${name}».`, { status: 409, params: { name } });
    }
}
