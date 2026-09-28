import type {
    IProductionDeviceTaskRepository,
    IProductionTaskDirectory,
    IProductionTaskNotifier,
    IProductionTaskTemplateRepository,
} from '../../../domain/repositories/IProductionTaskRepository';
import type {
    ProductionDeviceTask,
    ProductionDeviceTaskPlan,
    ProductionSubtask,
    ProductionTaskDevice,
    ProductionTaskPerson,
} from '../../../domain/entities/ProductionTask';
import {
    areaTotals,
    assigneeIdsFrom,
    assignmentNews,
    fileVersionFor,
    hasSubtaskDocument,
    isProductionTaskStatus,
    isWorkingStatus,
    newSubtaskFileId,
    SUBTASK_FILE_LIMITS,
    withoutDeviceRecord,
    orderTasks,
    reopenedSubtasks,
    tasksInputFrom,
    withAddedStage,
    withChecklistItem,
    today,
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

/** Die Ablage der Dateien an Unteraufgaben (dieselbe Art wie die der BOM). */
export interface ProductionTaskFileStore {
    accepts(contentType: string): boolean;
    store(tenantId: string, body: Buffer, contentType: string): Promise<string>;
    read(reference: string): Promise<Buffer>;
    remove(reference: string): Promise<void>;
}

/** Was an eine Unteraufgabe darf: nur PDF (28.09.2026: «the users only upload PDF. no image»). */
const SUBTASK_FILE_TYPES = new Set(['application/pdf']);

/** Alle Verweise in die Ablage, die ein Plan hält. */
const fileRefsOf = (tasks: ReadonlyArray<{ subtasks: ReadonlyArray<ProductionSubtask> }>): Set<string> =>
    new Set(tasks.flatMap((task) => task.subtasks.flatMap((subtask) => subtask.files.map((file) => file.ref))));

/**
 * Abgeschlossen («Complete the task», die Verwaltung): gesperrt — den Stand
 * ändert danach niemand mehr, Dateien nur noch die Verwaltung (28.09.2026:
 * «after completion no one can change the statuses, and upload files only admin can»).
 */
const isCompleted = (subtask: ProductionSubtask): boolean => subtask.completedById !== null;

/**
 * Die Dateien sind zu: freigegeben (gesperrt) oder «wartet auf Freigabe»
 * (28.09.2026: «on pending approval, the subtask should be locked») — bis
 * die Verwaltung freigibt oder zur Überarbeitung zurückgibt. Für ALLE.
 */
const assertFilesOpen = (subtask: ProductionSubtask): void => {
    if (isCompleted(subtask)) {
        throw productionTaskError('SUBTASK_LOCKED', 'Freigegeben und gesperrt — erst die Sperre aufheben.', { status: 409 });
    }
    if (subtask.status === 'PENDING') {
        throw productionTaskError('SUBTASK_AWAITING', 'Wartet auf die Freigabe — gesperrt, bis die Verwaltung freigibt oder zurückgibt.', { status: 409 });
    }
};

/**
 * Der neue Stand einer Unteraufgabe — oder ein Fehler (28.09.2026):
 *   · abgeschlossen → niemand ändert ihn mehr
 *   · «Approval» → fertig heisst «wartet auf Freigabe» (PENDING); erledigt
 *     nur über «Complete the task» der Verwaltung
 *   · PENDING gibt es nur mit «Approval»
 *   · «Document» → fertig (erledigt oder wartend) erst mit mindestens einem PDF
 */
const subtaskStatusChange = (subtask: ProductionSubtask, status: ProductionSubtask['status']): ProductionSubtask => {
    if (isCompleted(subtask)) {
        throw productionTaskError('SUBTASK_LOCKED', 'Abgeschlossen — der Stand bleibt.', { status: 409 });
    }
    if (status === 'DONE' && subtask.requiresApproval) {
        throw productionTaskError('APPROVAL_REQUIRED', 'Diese Unteraufgabe schliesst die Verwaltung mit «Complete the task» ab.', { status: 409 });
    }
    if (status === 'PENDING' && !subtask.requiresApproval) {
        throw productionTaskError('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
    }
    // «To make it pending approval it should be in progress» (28.09.2026) — oder zur Überarbeitung zurück.
    if (status === 'PENDING' && !isWorkingStatus(subtask.status) && subtask.status !== 'PENDING') {
        throw productionTaskError('NOT_IN_PROGRESS', 'Erst in Arbeit, dann zur Freigabe.', { status: 409 });
    }
    /* «No one can change statuses manually» (28.09.2026) — nur noch der Weg:
       ▶ offen → in Arbeit; ■ in Arbeit → offen; «Complete the task» in Arbeit
       (oder zur Überarbeitung zurück) → wartet (mit «Approval») bzw. erledigt.
       Sonst zurück nur über «Request revision» (→ REVISION) und das Aufheben
       der Sperre (eigene Wege). Derselbe Stand noch einmal ändert nichts. */
    if (status !== subtask.status) {
        const allowed = (status === 'IN_PROGRESS' && subtask.status === 'TODO')
            || (status === 'TODO' && subtask.status === 'IN_PROGRESS')
            || ((status === 'PENDING' || status === 'DONE') && isWorkingStatus(subtask.status));
        if (!allowed) {
            throw productionTaskError('STATUS_FLOW', 'Diesen Schritt gibt es nicht — ▶ startet, «Complete the task» schliesst ab.', { status: 409 });
        }
    }
    if ((status === 'DONE' || status === 'PENDING') && subtask.requiresDocument && !hasSubtaskDocument(subtask)) {
        throw productionTaskError('DOCUMENT_REQUIRED', 'Ohne PDF wird sie nicht erledigt.', { status: 409 });
    }
    return { ...subtask, status };
};

const cleanFileName = (value: string): string =>
    (value || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200) || 'file';

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
        private readonly files: ProductionTaskFileStore,
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

        const check = templateCheck(template.sections, areaTotals(template.sections, template.tasks));
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
        const tasks = orderTasks(template.tasks, template.sections).map((task) => ({
            area: task.area,
            stage: task.stage,
            code: task.code,
            name: task.name,
            weight: task.weight,
            assigneeIds: task.assigneeIds.filter((id) => active.has(id)),
            startDate: task.startDate,
            dueDate: task.dueDate,
            // Am Gerät entsteht die Kopie heute — Aufgabe wie Unteraufgaben.
            createdAt: today(),
            // Am Gerät beginnt jede Unteraufgabe offen, ohne Dateien und Abschluss.
            subtasks: task.subtasks.map((subtask) => ({ ...withoutDeviceRecord(subtask), createdAt: today() })),
        }));

        let plan: ProductionDeviceTaskPlan;
        try {
            plan = await this.plans.replacePlan(tenantId, {
                device,
                templateId: template.id,
                templateName: template.name,
                sections: template.sections,
                actorId: actor.id,
                tasks,
            });
        } catch (error) {
            // Zwei gleichzeitige Ladungen auf dasselbe Gerät: die zweite verliert.
            if (isUniqueViolation(error)) throw this.planExists(template.name);
            throw error;
        }

        // Ein ersetzter Plan nimmt seine Dateien mit.
        if (existing) this.dropFiles(fileRefsOf(existing.tasks), fileRefsOf(plan.tasks));

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

    /**
     * Die Aufgaben des Geräts anpassen (28.09.2026, nur Administratorrolle):
     * «admin should be able to customize the tasks and subtasks — it shouldn't
     * change the template, only the version that the project uses». Name,
     * Gewicht, Tage, Personen und Unteraufgaben; neue Aufgaben in einer Stufe,
     * entfernte fallen weg. Wer neu in einer Aufgabe steht, bekommt eine
     * Nachricht.
     */
    async updateTasks(tenantId: string, actor: ProductionTaskActor, itemId: string, body: unknown): Promise<ProductionDeviceTasksDto> {
        const [device, existing] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.plans.getPlan(tenantId, itemId),
        ]);
        if (!device) throw this.deviceNotFound();
        if (!existing) throw productionTaskError('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });

        const input = tasksInputFrom(objectOf(body).tasks, existing.sections, true);
        const active = await this.directory.activePeople(tenantId, assigneesOf(input));
        const tasks = orderTasks(input, existing.sections).map((task) => ({
            ...task,
            assigneeIds: task.assigneeIds.filter((id) => active.has(id)),
        }));

        const plan = await this.plans.replaceTasks(tenantId, itemId, tasks, actor.id);
        if (!plan) throw productionTaskError('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        // Entfernte Unteraufgaben nehmen ihre Dateien mit.
        this.dropFiles(fileRefsOf(existing.tasks), fileRefsOf(plan.tasks));

        void this.notifier.assigned({
            tenantId,
            device,
            actorId: actor.id,
            actorName: actor.name,
            news: assignmentNews(existing.tasks, plan.tasks),
        });
        // Neue Pflichten öffnen begonnene Unteraufgaben wieder — die Leute der Aufgabe erfahren es.
        const reopened = reopenedSubtasks(existing.tasks, plan.tasks);
        if (reopened.length) {
            void this.notifier.reopened({ tenantId, device, actorId: actor.id, actorName: actor.name, subtasks: reopened });
        }
        return this.dto(tenantId, device, plan);
    }

    /**
     * Eine neue Stufe in einem Bereich der Kopie am Gerät (28.09.2026, nur Administratorrolle —
     * der Weg sichert es mit ADMIN): nur solange die Aufgaben des Bereichs unter 100 % wiegen.
     * Die Vorlage bleibt, wie sie ist; Aufgaben, Stände und Dateien bleiben unberührt.
     */
    async addStage(tenantId: string, itemId: string, body: unknown): Promise<ProductionDeviceTasksDto> {
        const input = objectOf(body);
        const [device, existing] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.plans.getPlan(tenantId, itemId),
        ]);
        if (!device) throw this.deviceNotFound();
        if (!existing) throw productionTaskError('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        const sections = withAddedStage(existing.sections, input.area, input.name, existing.tasks);
        const plan = await this.plans.setSections(tenantId, itemId, sections);
        if (!plan) throw productionTaskError('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        return this.dto(tenantId, device, plan);
    }

    /**
     * Der Stand einer Aufgabe (28.09.2026): offen, in Arbeit, erledigt. Setzen
     * darf ihn die Administratorrolle und jede Person, die in der Aufgabe steht.
     */
    async setStatus(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        body: unknown,
    ): Promise<{ task: ProductionTaskDto }> {
        const status = objectOf(body).status;
        // «Wartet auf Freigabe» gibt es nur an Unteraufgaben mit «Approval».
        // «Wartet auf Freigabe» und «zur Überarbeitung» gibt es nur an Unteraufgaben.
        if (!isProductionTaskStatus(status) || status === 'PENDING' || status === 'REVISION') {
            throw productionTaskError('STATUS_INVALID', 'Unbekannter Stand.');
        }
        const current = await this.plans.getTask(tenantId, itemId, taskId);
        if (!current) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        if (!isAdmin && !current.assigneeIds.includes(actor.id)) {
            throw productionTaskError('STATUS_FORBIDDEN', 'Den Stand setzen nur die Verwaltung und wer in der Aufgabe steht.', { status: 403 });
        }
        // Mit Unteraufgaben folgt die Aufgabe ihnen — ihren Stand setzt niemand direkt (28.09.2026).
        if (current.subtasks.length > 0) {
            throw productionTaskError('STATUS_FLOW', 'Der Stand dieser Aufgabe folgt ihren Unteraufgaben.', { status: 409 });
        }
        const task = await this.plans.setStatus(tenantId, itemId, taskId, status, actor.id);
        if (!task) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        return { task: taskDto(task) };
    }

    /**
     * Der Stand einer Unteraufgabe (28.09.2026) — dieselben Leute wie beim
     * Stand der Aufgabe: die Verwaltung und wer in der Aufgabe steht. Die
     * Aufgabe folgt ihren Unteraufgaben (alle erledigt → erledigt).
     *
     * Regeln siehe `subtaskStatusChange`: abgeschlossen = gesperrt für alle;
     * «Approval» schliesst nur «Complete the task»; «Document» braucht ein PDF.
     */
    async setSubtaskStatus(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        subtaskId: string,
        body: unknown,
    ): Promise<{ task: ProductionTaskDto }> {
        const status = objectOf(body).status;
        if (!isProductionTaskStatus(status)) {
            throw productionTaskError('STATUS_INVALID', 'Unbekannter Stand.');
        }
        const current = await this.plans.getTask(tenantId, itemId, taskId);
        if (!current) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        if (!isAdmin && !current.assigneeIds.includes(actor.id)) {
            throw productionTaskError('STATUS_FORBIDDEN', 'Den Stand setzen nur die Verwaltung und wer in der Aufgabe steht.', { status: 403 });
        }
        const task = await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => subtaskStatusChange(subtask, status), actor.id);
        return { task: taskDto(this.found(task)) };
    }

    /**
     * «Complete the task» (28.09.2026) — nur die Verwaltung, nur eine
     * Unteraufgabe mit «Approval». Trägt sie «Document», braucht sie ein PDF.
     * Erledigt, mit wem, wann und kurzer Notiz; danach gesperrt.
     */
    async completeSubtask(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        subtaskId: string,
        body: unknown,
    ): Promise<{ task: ProductionTaskDto }> {
        if (!isAdmin) throw productionTaskError('STATUS_FORBIDDEN', 'Abschliessen darf nur die Verwaltung.', { status: 403 });
        const input = objectOf(body);
        const rawNote = input.note;
        const note = typeof rawNote === 'string' ? rawNote.replace(/\r\n/g, '\n').trim().slice(0, 500) : '';
        // Die abgehakten Punkte der Freigabe-Checkliste — geprüft wird hier, nicht nur im Browser.
        const checked = new Set(Array.isArray(input.checked) ? input.checked.filter((id): id is string => typeof id === 'string') : []);
        const task = await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!subtask.requiresApproval) {
                throw productionTaskError('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
            }
            if (isCompleted(subtask)) throw productionTaskError('ALREADY_COMPLETED', 'Schon abgeschlossen.', { status: 409 });
            // Freigeben nur, was auf die Freigabe wartet (28.09.2026).
            if (subtask.status !== 'PENDING') {
                throw productionTaskError('NOT_PENDING', 'Erst «Complete the task» — dann wartet sie auf die Freigabe.', { status: 409 });
            }
            if (subtask.requiresDocument && !hasSubtaskDocument(subtask)) {
                throw productionTaskError('DOCUMENT_REQUIRED', 'Ohne PDF schliesst sie nicht ab.', { status: 409 });
            }
            // Jeder Punkt der Checkliste muss abgehakt sein (28.09.2026) — sonst keine Freigabe.
            if (subtask.approvalChecklist.some((item) => !checked.has(item.id))) {
                throw productionTaskError('CHECKLIST_INCOMPLETE', 'Erst alle Punkte der Freigabe-Checkliste abhaken.', { status: 409 });
            }
            return {
                ...subtask,
                status: 'DONE',
                completedById: actor.id,
                completedByName: actor.name,
                completedAt: new Date().toISOString(),
                completionNote: note || null,
                revisionById: null,
                revisionByName: null,
                revisionAt: null,
                revisionNote: null,
            };
        }, actor.id);
        return { task: taskDto(this.found(task)) };
    }

    /**
     * Ein Punkt mehr in der Freigabe-Checkliste — aus «Approve the files»
     * (28.09.2026), nur die Verwaltung, nur an einer offenen Unteraufgabe mit
     * «Approval». Der Stand bleibt; der neue Punkt muss vor der Freigabe
     * abgehakt werden (das prüft `completeSubtask`).
     */
    async addSubtaskChecklistItem(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        subtaskId: string,
        body: unknown,
    ): Promise<{ task: ProductionTaskDto }> {
        if (!isAdmin) throw productionTaskError('STATUS_FORBIDDEN', 'Die Checkliste ergänzt nur die Verwaltung.', { status: 403 });
        const rawText = objectOf(body).text;
        const task = await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!subtask.requiresApproval) {
                throw productionTaskError('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
            }
            if (isCompleted(subtask)) {
                throw productionTaskError('SUBTASK_LOCKED', 'Freigegeben und gesperrt — erst die Sperre aufheben.', { status: 409 });
            }
            return withChecklistItem(subtask, rawText);
        }, actor.id);
        return { task: taskDto(this.found(task)) };
    }

    /**
     * Die Sperre aufheben (28.09.2026) — nur die Verwaltung, ein Klick auf das
     * Schloss einer freigegebenen ODER wartenden Unteraufgabe: sie ist wieder
     * in Arbeit («when the admin removes the lock the status should be in
     * progress»); Dateien lassen sich wieder ändern, «Complete the task»
     * schickt sie erneut zur Freigabe.
     */
    async unlockSubtask(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        subtaskId: string,
    ): Promise<{ task: ProductionTaskDto }> {
        if (!isAdmin) throw productionTaskError('STATUS_FORBIDDEN', 'Die Sperre hebt nur die Verwaltung auf.', { status: 403 });
        const task = await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!isCompleted(subtask) && subtask.status !== 'PENDING') {
                throw productionTaskError('NOT_LOCKED', 'Nicht gesperrt.', { status: 409 });
            }
            return {
                ...subtask,
                status: 'IN_PROGRESS',
                completedById: null,
                completedByName: null,
                completedAt: null,
                completionNote: null,
            };
        }, actor.id);
        return { task: taskDto(this.found(task)) };
    }

    /**
     * «Request revision» (28.09.2026) — beim Prüfen der Dateien, nur die
     * Verwaltung, nur eine offene Unteraufgabe mit «Approval»: zurück in
     * Arbeit, mit wem, wann und was zu ändern ist.
     */
    async requestSubtaskRevision(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        subtaskId: string,
        body: unknown,
    ): Promise<{ task: ProductionTaskDto }> {
        if (!isAdmin) throw productionTaskError('STATUS_FORBIDDEN', 'Zurückgeben darf nur die Verwaltung.', { status: 403 });
        const rawNote = objectOf(body).note;
        const note = typeof rawNote === 'string' ? rawNote.replace(/\r\n/g, '\n').trim().slice(0, 500) : '';
        const task = await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!subtask.requiresApproval) {
                throw productionTaskError('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
            }
            if (isCompleted(subtask)) throw productionTaskError('ALREADY_COMPLETED', 'Schon abgeschlossen.', { status: 409 });
            // Zurückgeben lässt sich nur, was auf die Freigabe wartet.
            if (subtask.status !== 'PENDING') {
                throw productionTaskError('NOT_PENDING', 'Nur eine wartende Unteraufgabe lässt sich zurückgeben.', { status: 409 });
            }
            const at = new Date().toISOString();
            return {
                ...subtask,
                // Sichtbar als eigener Stand «Revision requested» (28.09.2026).
                status: 'REVISION',
                revisionById: actor.id,
                revisionByName: actor.name,
                revisionAt: at,
                revisionNote: note || null,
                // … und im Verlauf, der auch nach der Freigabe bleibt (Prüfansicht).
                revisionHistory: [...subtask.revisionHistory, { byId: actor.id, byName: actor.name, at, note: note || null }].slice(-50),
            };
        }, actor.id);
        return { task: taskDto(this.found(task)) };
    }

    /**
     * Eine Datei an eine Unteraufgabe (28.09.2026) — die Verwaltung und wer
     * in der Aufgabe steht; an eine freigegebene (gesperrte) niemand.
     */
    async uploadSubtaskFile(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        subtaskId: string,
        file: { body: Buffer; contentType: string; fileName: string } | null,
        /** Neue Fassung dieser Datei (28.09.2026) — null: eine neue Datei. */
        revisionOf: string | null = null,
        /** Was sich geändert hat — Pflicht für eine neue Fassung (28.09.2026). */
        rawRevisionNote: unknown = null,
    ): Promise<{ task: ProductionTaskDto }> {
        await this.assertOnTask(tenantId, actor, isAdmin, itemId, taskId, 'FILE_FORBIDDEN');
        const revisionNote = typeof rawRevisionNote === 'string' ? rawRevisionNote.replace(/\r\n/g, '\n').trim().slice(0, 500) : '';
        if (revisionOf && !revisionNote) {
            throw productionTaskError('REVISION_NOTE_REQUIRED', 'Zu einer neuen Fassung gehört eine Notiz, was sich geändert hat.');
        }
        if (!file || !file.body?.length) throw productionTaskError('FILE_REQUIRED', 'Keine Datei empfangen.');
        const contentType = String(file.contentType || '').toLowerCase();
        if (!SUBTASK_FILE_TYPES.has(contentType) || !this.files.accepts(contentType)) {
            throw productionTaskError('FILE_TYPE', 'Erlaubt sind nur PDF-Dateien.');
        }
        if (file.body.length > SUBTASK_FILE_LIMITS.bytes) {
            throw productionTaskError('FILE_TOO_LARGE', 'Die Datei ist zu gross.', { status: 413, params: { max: 25 } });
        }
        const ref = await this.files.store(tenantId, file.body, contentType);
        try {
            const task = await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
                // Gesperrt heisst für ALLE gesperrt (28.09.2026) — auch solange sie auf die Freigabe wartet.
                assertFilesOpen(subtask);
                if (subtask.files.length >= SUBTASK_FILE_LIMITS.files) {
                    throw productionTaskError('FILES_TOO_MANY', 'Zu viele Dateien.', { status: 409, params: { max: SUBTASK_FILE_LIMITS.files } });
                }
                const id = newSubtaskFileId();
                // Neue Datei oder nächste Fassung einer vorhandenen (dieselbe groupId).
                const { groupId, version } = fileVersionFor(subtask.files, id, revisionOf);
                return {
                    ...subtask,
                    files: [...subtask.files, {
                        id,
                        ref,
                        groupId,
                        version,
                        // Nur eine neue Fassung trägt eine Notiz; die erste Fassung keine.
                        revisionNote: version > 1 ? revisionNote : null,
                        name: cleanFileName(file.fileName),
                        type: contentType,
                        size: file.body.length,
                        uploadedById: actor.id,
                        uploadedByName: actor.name,
                        uploadedAt: new Date().toISOString(),
                    }],
                };
            }, actor.id);
            return { task: taskDto(this.found(task)) };
        } catch (error) {
            await this.files.remove(ref).catch(() => undefined);
            throw error;
        }
    }

    /** Eine Datei lesen — wer die Produktion sieht. */
    async readSubtaskFile(
        tenantId: string,
        itemId: string,
        taskId: string,
        subtaskId: string,
        fileId: string,
    ): Promise<{ body: Buffer; contentType: string; fileName: string }> {
        const task = await this.plans.getTask(tenantId, itemId, taskId);
        if (!task) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        const subtask = task.subtasks.find((entry) => entry.id === subtaskId);
        if (!subtask) throw productionTaskError('SUBTASK_NOT_FOUND', 'Unteraufgabe nicht gefunden.', { status: 404 });
        const file = subtask.files.find((entry) => entry.id === fileId);
        if (!file) throw productionTaskError('FILE_NOT_FOUND', 'Datei nicht gefunden.', { status: 404 });
        return { body: await this.files.read(file.ref), contentType: file.type, fileName: file.name };
    }

    /**
     * Eine Datei entfernen — die Verwaltung; sonst wer sie hochgeladen hat
     * und noch in der Aufgabe steht, solange die Unteraufgabe offen ist.
     */
    async removeSubtaskFile(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        subtaskId: string,
        fileId: string,
    ): Promise<{ task: ProductionTaskDto }> {
        await this.assertOnTask(tenantId, actor, isAdmin, itemId, taskId, 'FILE_FORBIDDEN');
        let removed: string | null = null;
        const task = await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            const file = subtask.files.find((entry) => entry.id === fileId);
            if (!file) throw productionTaskError('FILE_NOT_FOUND', 'Datei nicht gefunden.', { status: 404 });
            assertFilesOpen(subtask);
            if (!isAdmin && file.uploadedById !== actor.id) {
                throw productionTaskError('FILE_FORBIDDEN', 'Diese Datei entfernt nur die Verwaltung.', { status: 403 });
            }
            removed = file.ref;
            return { ...subtask, files: subtask.files.filter((entry) => entry.id !== fileId) };
        }, actor.id);
        const result = { task: taskDto(this.found(task)) };
        if (removed) await this.files.remove(removed).catch(() => undefined);
        return result;
    }

    async unload(tenantId: string, itemId: string): Promise<{ deleted: true }> {
        const existing = await this.plans.getPlan(tenantId, itemId);
        if (!(await this.plans.deletePlan(tenantId, itemId))) {
            throw productionTaskError('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        }
        if (existing) this.dropFiles(fileRefsOf(existing.tasks), new Set());
        return { deleted: true };
    }

    /* ── intern ─────────────────────────────────────────────────────── */

    /** Die Verwaltung oder wer in der Aufgabe steht — sonst `code` (403). */
    private async assertOnTask(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        code: 'FILE_FORBIDDEN' | 'STATUS_FORBIDDEN',
    ): Promise<ProductionDeviceTask> {
        const task = await this.plans.getTask(tenantId, itemId, taskId);
        if (!task) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        if (!isAdmin && !task.assigneeIds.includes(actor.id)) {
            throw productionTaskError(code, 'Nur die Verwaltung und wer in der Aufgabe steht.', { status: 403 });
        }
        return task;
    }

    private found(task: ProductionDeviceTask | null | 'no-subtask'): ProductionDeviceTask {
        if (task === 'no-subtask') throw productionTaskError('SUBTASK_NOT_FOUND', 'Unteraufgabe nicht gefunden.', { status: 404 });
        if (!task) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        return task;
    }

    /** Dateien, die der Plan nicht mehr hält, aus der Ablage nehmen (im Hintergrund). */
    private dropFiles(before: ReadonlySet<string>, after: ReadonlySet<string>): void {
        for (const ref of before) {
            if (!after.has(ref)) void this.files.remove(ref).catch(() => undefined);
        }
    }

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
