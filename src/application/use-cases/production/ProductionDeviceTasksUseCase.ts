import type {
    IProductionDeviceTaskRepository,
    IProductionTaskDirectory,
    IProductionTaskNotifier,
    IProductionTaskTemplateRepository,
} from '../../../domain/repositories/IProductionTaskRepository';
import type {
    ProductionDeviceTaskPlan,
    ProductionTaskDevice,
    ProductionTaskPerson,
} from '../../../domain/entities/ProductionTask';
import {
    areaTotals,
    assigneeIdsFrom,
    assignmentNews,
    orderTasks,
    productionTaskError,
    templateCheck,
} from '../../../domain/services/productionTasks';
import {
    assigneesOf,
    deviceTasksDto,
    taskDto,
    type ProductionDeviceTasksDto,
    type ProductionTaskDto,
} from './productionTaskReadModel';
import { isUniqueViolation, type ProductionTaskActor } from './ProductionTaskTemplatesUseCase';

const objectOf = (body: unknown): Record<string, unknown> =>
    (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

/**
 * ── DIE AUFGABEN EINES GERÄTS (26.09.2026, Vorgabe Samet) ──────────────────
 *
 * «Üretimde görevlere eğer administrator isek görevleri yükleyebiliyoruz …
 *  her aşamada büyük olmayacak şekilde görevlendirme kartı olması lazım, ve
 *  bu görevlere yüklendiğinde ve kişilere özel atandığında gelmesi lazım.»
 *
 *   lesen      jede Person mit Produktionsrecht (die Karten der Stufen)
 *   laden      nur die Administratorrolle: eine VOLLSTÄNDIGE Vorlage wird
 *              als Kopie auf das Gerät gelegt (ein bestehender Plan nur mit
 *              ausdrücklichem «ersetzen»)
 *   zuweisen   nur die Administratorrolle: Personen einer Aufgabe
 *   entfernen  nur die Administratorrolle
 *
 * Wer neu in einer Aufgabe steht, bekommt eine Nachricht (Glocke).
 */
export class ProductionDeviceTasksUseCase {
    constructor(
        private readonly plans: IProductionDeviceTaskRepository,
        private readonly templates: IProductionTaskTemplateRepository,
        private readonly directory: IProductionTaskDirectory,
        private readonly notifier: IProductionTaskNotifier,
    ) {}

    async get(tenantId: string, itemId: string): Promise<ProductionDeviceTasksDto> {
        const [device, plan] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.plans.getPlan(tenantId, itemId),
        ]);
        if (!device) throw this.deviceNotFound();
        return this.dto(tenantId, device, plan);
    }

    async load(tenantId: string, actor: ProductionTaskActor, itemId: string, body: unknown): Promise<ProductionDeviceTasksDto> {
        const input = objectOf(body);
        const templateId = typeof input.templateId === 'string' ? input.templateId.trim() : '';
        if (!templateId) throw productionTaskError('TEMPLATE_REQUIRED', 'Bitte eine Vorlage wählen.');
        const replace = input.replace === true;

        const [device, template, existing] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.templates.get(tenantId, templateId),
            this.plans.getPlan(tenantId, itemId),
        ]);
        if (!device) throw this.deviceNotFound();
        if (!template) throw productionTaskError('TEMPLATE_NOT_FOUND', 'Vorlage nicht gefunden.', { status: 404 });

        const check = templateCheck(template.areaShares, areaTotals(template.tasks));
        if (!check.valid) {
            throw productionTaskError('TEMPLATE_INCOMPLETE', `Die Vorlage «${template.name}» geht noch nicht auf (Anteile und Gewichte je 100 %).`, {
                status: 409,
                params: { name: template.name },
                details: check,
            });
        }
        if (existing && !replace) throw this.planExists(existing.templateName);

        // Nur wer heute noch aktiv in der Firma ist, kommt mit auf das Gerät.
        const active = await this.directory.activePeople(tenantId, assigneesOf(template.tasks));
        const tasks = orderTasks(template.tasks).map((task) => ({
            area: task.area,
            stage: task.stage,
            code: task.code,
            name: task.name,
            weight: task.weight,
            assigneeIds: task.assigneeIds.filter((id) => active.has(id)),
        }));

        let plan: ProductionDeviceTaskPlan;
        try {
            plan = await this.plans.replacePlan(tenantId, {
                device,
                templateId: template.id,
                templateName: template.name,
                areaShares: template.areaShares,
                actorId: actor.id,
                tasks,
            });
        } catch (error) {
            // Zwei gleichzeitige Ladungen auf dasselbe Gerät: die zweite verliert.
            if (isUniqueViolation(error)) throw this.planExists(template.name);
            throw error;
        }

        void this.notifier.assigned({
            tenantId,
            device,
            actorId: actor.id,
            actorName: actor.name,
            news: assignmentNews(existing?.tasks ?? [], plan.tasks),
        });
        return this.dto(tenantId, device, plan);
    }

    async assign(
        tenantId: string,
        actor: ProductionTaskActor,
        itemId: string,
        taskId: string,
        body: unknown,
    ): Promise<{ task: ProductionTaskDto; people: ProductionTaskPerson[] }> {
        const wanted = assigneeIdsFrom(objectOf(body).assigneeIds);
        const [device, active] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.directory.activePeople(tenantId, wanted),
        ]);
        if (!device) throw this.deviceNotFound();
        const kept = wanted.filter((id) => active.has(id));

        const result = await this.plans.setAssignees(tenantId, itemId, taskId, kept, actor.id);
        if (!result) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });

        const { task } = result;
        const news = assignmentNews([{ code: task.code, assigneeIds: result.previous }], [task]);
        if (news.size) {
            void this.notifier.assigned({ tenantId, device, actorId: actor.id, actorName: actor.name, news });
        }
        const people = await this.directory.people(tenantId, task.assigneeIds);
        return { task: taskDto(task), people };
    }

    async unload(tenantId: string, itemId: string): Promise<{ deleted: true }> {
        if (!(await this.plans.deletePlan(tenantId, itemId))) {
            throw productionTaskError('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        }
        return { deleted: true };
    }

    /* ── intern ─────────────────────────────────────────────────────── */

    private async dto(tenantId: string, device: ProductionTaskDevice, plan: ProductionDeviceTaskPlan | null): Promise<ProductionDeviceTasksDto> {
        const [people, loadedByName] = await Promise.all([
            this.directory.people(tenantId, plan ? assigneesOf(plan.tasks) : []),
            plan?.loadedById ? this.directory.personName(plan.loadedById) : Promise.resolve(null),
        ]);
        return deviceTasksDto(device, plan, people, loadedByName);
    }

    private deviceNotFound() {
        return productionTaskError('DEVICE_NOT_FOUND', 'Gerät nicht gefunden.', { status: 404 });
    }

    private planExists(templateName: string) {
        return productionTaskError('PLAN_EXISTS', `Auf diesem Gerät liegen schon Aufgaben (Vorlage «${templateName}»).`, {
            status: 409,
            params: { name: templateName },
        });
    }
}
