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
    hasSubtaskDocument,
    isProductionTaskStatus,
    newSubtaskFileId,
    SUBTASK_FILE_LIMITS,
    withoutDeviceRecord,
    orderTasks,
    tasksInputFrom,
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
        if (!isProductionTaskStatus(status) || status === 'PENDING') {
            throw productionTaskError('STATUS_INVALID', 'Unbekannter Stand.');
        }
        const current = await this.plans.getTask(tenantId, itemId, taskId);
        if (!current) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        if (!isAdmin && !current.assigneeIds.includes(actor.id)) {
            throw productionTaskError('STATUS_FORBIDDEN', 'Den Stand setzen nur die Verwaltung und wer in der Aufgabe steht.', { status: 403 });
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
        const rawNote = objectOf(body).note;
        const note = typeof rawNote === 'string' ? rawNote.replace(/\r\n/g, '\n').trim().slice(0, 500) : '';
        const task = await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!subtask.requiresApproval) {
                throw productionTaskError('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
            }
            if (isCompleted(subtask)) throw productionTaskError('ALREADY_COMPLETED', 'Schon abgeschlossen.', { status: 409 });
            if (subtask.requiresDocument && !hasSubtaskDocument(subtask)) {
                throw productionTaskError('DOCUMENT_REQUIRED', 'Ohne PDF schliesst sie nicht ab.', { status: 409 });
            }
            return {
                ...subtask,
                status: 'DONE',
                completedById: actor.id,
                completedByName: actor.name,
                completedAt: new Date().toISOString(),
                completionNote: note || null,
            };
        }, actor.id);
        return { task: taskDto(this.found(task)) };
    }

    /**
     * Eine Datei an eine Unteraufgabe (28.09.2026) — die Verwaltung und wer
     * in der Aufgabe steht; an eine abgeschlossene nur die Verwaltung.
     */
    async uploadSubtaskFile(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        subtaskId: string,
        file: { body: Buffer; contentType: string; fileName: string } | null,
    ): Promise<{ task: ProductionTaskDto }> {
        await this.assertOnTask(tenantId, actor, isAdmin, itemId, taskId, 'FILE_FORBIDDEN');
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
                if (!isAdmin && isCompleted(subtask)) {
                    throw productionTaskError('SUBTASK_LOCKED', 'Abgeschlossen — nur die Verwaltung ändert sie.', { status: 403 });
                }
                if (subtask.files.length >= SUBTASK_FILE_LIMITS.files) {
                    throw productionTaskError('FILES_TOO_MANY', 'Zu viele Dateien.', { status: 409, params: { max: SUBTASK_FILE_LIMITS.files } });
                }
                return {
                    ...subtask,
                    files: [...subtask.files, {
                        id: newSubtaskFileId(),
                        ref,
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
            if (!isAdmin && (isCompleted(subtask) || file.uploadedById !== actor.id)) {
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
