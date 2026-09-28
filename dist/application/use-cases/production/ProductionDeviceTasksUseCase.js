"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionDeviceTasksUseCase = void 0;
const productionTasks_1 = require("../../../domain/services/productionTasks");
const productionTaskReadModel_1 = require("./productionTaskReadModel");
const ProductionTaskTemplatesUseCase_1 = require("./ProductionTaskTemplatesUseCase");
const objectOf = (body) => (body && typeof body === 'object' ? body : {});
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
class ProductionDeviceTasksUseCase {
    plans;
    templates;
    directory;
    notifier;
    constructor(plans, templates, directory, notifier) {
        this.plans = plans;
        this.templates = templates;
        this.directory = directory;
        this.notifier = notifier;
    }
    async get(tenantId, itemId) {
        const [device, plan] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.plans.getPlan(tenantId, itemId),
        ]);
        if (!device)
            throw this.deviceNotFound();
        return this.dto(tenantId, device, plan);
    }
    async load(tenantId, actor, itemId, body) {
        const input = objectOf(body);
        const templateId = typeof input.templateId === 'string' ? input.templateId.trim() : '';
        if (!templateId)
            throw (0, productionTasks_1.productionTaskError)('TEMPLATE_REQUIRED', 'Bitte eine Vorlage wählen.');
        const replace = input.replace === true;
        const [device, template, existing] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.templates.get(tenantId, templateId),
            this.plans.getPlan(tenantId, itemId),
        ]);
        if (!device)
            throw this.deviceNotFound();
        if (!template)
            throw (0, productionTasks_1.productionTaskError)('TEMPLATE_NOT_FOUND', 'Vorlage nicht gefunden.', { status: 404 });
        const check = (0, productionTasks_1.templateCheck)(template.areaShares, (0, productionTasks_1.areaTotals)(template.tasks));
        if (!check.valid) {
            throw (0, productionTasks_1.productionTaskError)('TEMPLATE_INCOMPLETE', `Die Vorlage «${template.name}» geht noch nicht auf (Anteile und Gewichte je 100 %).`, {
                status: 409,
                params: { name: template.name },
                details: check,
            });
        }
        if (existing && !replace)
            throw this.planExists(existing.templateName);
        // Nur wer heute noch aktiv in der Firma ist, kommt mit auf das Gerät.
        const active = await this.directory.activePeople(tenantId, (0, productionTaskReadModel_1.assigneesOf)(template.tasks));
        const tasks = (0, productionTasks_1.orderTasks)(template.tasks).map((task) => ({
            area: task.area,
            stage: task.stage,
            code: task.code,
            name: task.name,
            weight: task.weight,
            assigneeIds: task.assigneeIds.filter((id) => active.has(id)),
        }));
        let plan;
        try {
            plan = await this.plans.replacePlan(tenantId, {
                device,
                templateId: template.id,
                templateName: template.name,
                areaShares: template.areaShares,
                actorId: actor.id,
                tasks,
            });
        }
        catch (error) {
            // Zwei gleichzeitige Ladungen auf dasselbe Gerät: die zweite verliert.
            if ((0, ProductionTaskTemplatesUseCase_1.isUniqueViolation)(error))
                throw this.planExists(template.name);
            throw error;
        }
        void this.notifier.assigned({
            tenantId,
            device,
            actorId: actor.id,
            actorName: actor.name,
            news: (0, productionTasks_1.assignmentNews)(existing?.tasks ?? [], plan.tasks),
        });
        return this.dto(tenantId, device, plan);
    }
    async assign(tenantId, actor, itemId, taskId, body) {
        const wanted = (0, productionTasks_1.assigneeIdsFrom)(objectOf(body).assigneeIds);
        const [device, active] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.directory.activePeople(tenantId, wanted),
        ]);
        if (!device)
            throw this.deviceNotFound();
        const kept = wanted.filter((id) => active.has(id));
        const result = await this.plans.setAssignees(tenantId, itemId, taskId, kept, actor.id);
        if (!result)
            throw (0, productionTasks_1.productionTaskError)('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        const { task } = result;
        const news = (0, productionTasks_1.assignmentNews)([{ code: task.code, assigneeIds: result.previous }], [task]);
        if (news.size) {
            void this.notifier.assigned({ tenantId, device, actorId: actor.id, actorName: actor.name, news });
        }
        const people = await this.directory.people(tenantId, task.assigneeIds);
        return { task: (0, productionTaskReadModel_1.taskDto)(task), people };
    }
    async unload(tenantId, itemId) {
        if (!(await this.plans.deletePlan(tenantId, itemId))) {
            throw (0, productionTasks_1.productionTaskError)('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        }
        return { deleted: true };
    }
    /* ── intern ─────────────────────────────────────────────────────── */
    async dto(tenantId, device, plan) {
        const [people, loadedByName] = await Promise.all([
            this.directory.people(tenantId, plan ? (0, productionTaskReadModel_1.assigneesOf)(plan.tasks) : []),
            plan?.loadedById ? this.directory.personName(plan.loadedById) : Promise.resolve(null),
        ]);
        return (0, productionTaskReadModel_1.deviceTasksDto)(device, plan, people, loadedByName);
    }
    deviceNotFound() {
        return (0, productionTasks_1.productionTaskError)('DEVICE_NOT_FOUND', 'Gerät nicht gefunden.', { status: 404 });
    }
    planExists(templateName) {
        return (0, productionTasks_1.productionTaskError)('PLAN_EXISTS', `Auf diesem Gerät liegen schon Aufgaben (Vorlage «${templateName}»).`, {
            status: 409,
            params: { name: templateName },
        });
    }
}
exports.ProductionDeviceTasksUseCase = ProductionDeviceTasksUseCase;
//# sourceMappingURL=ProductionDeviceTasksUseCase.js.map