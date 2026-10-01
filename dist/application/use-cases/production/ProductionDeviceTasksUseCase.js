"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionDeviceTasksUseCase = void 0;
const productionTasks_1 = require("../../../domain/services/productionTasks");
const productionTaskActivities_1 = require("../../../domain/services/productionTaskActivities");
const productionTaskReadModel_1 = require("./productionTaskReadModel");
const ProductionTaskTemplatesUseCase_1 = require("./ProductionTaskTemplatesUseCase");
const objectOf = (body) => (body && typeof body === 'object' ? body : {});
/** Was an eine Unteraufgabe darf: nur PDF (28.09.2026: «the users only upload PDF. no image»). */
const SUBTASK_FILE_TYPES = new Set(['application/pdf']);
/** Alle Verweise in die Ablage, die ein Plan hält. */
const fileRefsOf = (tasks) => new Set(tasks.flatMap((task) => task.subtasks.flatMap((subtask) => subtask.files.map((file) => file.ref))));
/**
 * Abgeschlossen («Complete the task», die Verwaltung): gesperrt — den Stand
 * ändert danach niemand mehr, Dateien nur noch die Verwaltung (28.09.2026:
 * «after completion no one can change the statuses, and upload files only admin can»).
 */
const isCompleted = (subtask) => subtask.completedById !== null;
/**
 * Die Dateien sind zu: freigegeben (gesperrt) oder «wartet auf Freigabe»
 * (28.09.2026: «on pending approval, the subtask should be locked») — bis
 * die Verwaltung freigibt oder zur Überarbeitung zurückgibt. Für ALLE.
 */
const assertFilesOpen = (subtask) => {
    if (isCompleted(subtask)) {
        throw (0, productionTasks_1.productionTaskError)('SUBTASK_LOCKED', 'Freigegeben und gesperrt — erst die Sperre aufheben.', { status: 409 });
    }
    if (subtask.status === 'PENDING') {
        throw (0, productionTasks_1.productionTaskError)('SUBTASK_AWAITING', 'Wartet auf die Freigabe — gesperrt, bis die Verwaltung freigibt oder zurückgibt.', { status: 409 });
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
const subtaskStatusChange = (subtask, status) => {
    if (isCompleted(subtask)) {
        throw (0, productionTasks_1.productionTaskError)('SUBTASK_LOCKED', 'Abgeschlossen — der Stand bleibt.', { status: 409 });
    }
    if (status === 'DONE' && subtask.requiresApproval) {
        throw (0, productionTasks_1.productionTaskError)('APPROVAL_REQUIRED', 'Diese Unteraufgabe schliesst die Verwaltung mit «Complete the task» ab.', { status: 409 });
    }
    if (status === 'PENDING' && !subtask.requiresApproval) {
        throw (0, productionTasks_1.productionTaskError)('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
    }
    // «To make it pending approval it should be in progress» (28.09.2026) — oder zur Überarbeitung zurück.
    if (status === 'PENDING' && !(0, productionTasks_1.isWorkingStatus)(subtask.status) && subtask.status !== 'PENDING') {
        throw (0, productionTasks_1.productionTaskError)('NOT_IN_PROGRESS', 'Erst in Arbeit, dann zur Freigabe.', { status: 409 });
    }
    /* «No one can change statuses manually» (28.09.2026) — nur noch der Weg:
       ▶ offen → in Arbeit; ■ in Arbeit → offen; «Complete the task» in Arbeit
       (oder zur Überarbeitung zurück) → wartet (mit «Approval») bzw. erledigt.
       Sonst zurück nur über «Request revision» (→ REVISION) und das Aufheben
       der Sperre (eigene Wege). Derselbe Stand noch einmal ändert nichts. */
    if (status !== subtask.status) {
        const allowed = (status === 'IN_PROGRESS' && subtask.status === 'TODO')
            || (status === 'TODO' && subtask.status === 'IN_PROGRESS')
            || ((status === 'PENDING' || status === 'DONE') && (0, productionTasks_1.isWorkingStatus)(subtask.status));
        if (!allowed) {
            throw (0, productionTasks_1.productionTaskError)('STATUS_FLOW', 'Diesen Schritt gibt es nicht — ▶ startet, «Complete the task» schliesst ab.', { status: 409 });
        }
    }
    if ((status === 'DONE' || status === 'PENDING') && subtask.requiresDocument && !(0, productionTasks_1.hasSubtaskDocument)(subtask)) {
        throw (0, productionTasks_1.productionTaskError)('DOCUMENT_REQUIRED', 'Ohne PDF wird sie nicht erledigt.', { status: 409 });
    }
    return { ...subtask, status };
};
const requestDto = (row) => ({
    id: row.id,
    kind: row.kind,
    area: row.area,
    stage: row.stage,
    taskId: row.taskId,
    taskCode: row.taskCode,
    taskName: row.taskName,
    subtaskId: row.subtaskId,
    subtaskCode: row.subtaskCode,
    subtaskName: row.subtaskName,
    note: row.note,
    requestedById: row.requestedById,
    requestedByName: row.requestedByName,
    createdAt: row.createdAt.toISOString(),
    solvedAt: row.solvedAt ? row.solvedAt.toISOString() : null,
    solvedByName: row.solvedByName,
    resolution: row.resolution,
});
/** So viele Zeilen je Seite des Verlaufs — und höchstens. */
const ACTIVITY_PAGE = 25;
const ACTIVITY_PAGE_MAX = 100;
/** Die Arten, nach denen der Verlauf filtern darf (alles andere fällt weg). */
const ACTIVITY_KINDS = new Set([
    'SUBTASK_STARTED', 'SUBTASK_STOPPED', 'SUBTASK_SUBMITTED', 'SUBTASK_DONE',
    'SUBTASK_APPROVED', 'REVISION_REQUESTED', 'SUBTASK_UNLOCKED', 'CHECKLIST_ITEM_ADDED',
    'FILE_UPLOADED', 'FILE_DELETED', 'SUBTASK_ASSIGNED',
    'TASK_CREATED', 'TASK_UPDATED', 'TASK_DELETED', 'TASK_MOVED', 'TASK_STATUS',
    'SUBTASK_CREATED', 'SUBTASK_UPDATED', 'SUBTASK_DELETED', 'STAGE_ADDED',
    'PLAN_LOADED', 'PLAN_REMOVED',
]);
const scopeOf = (tenantId, itemId, actor) => ({
    tenantId,
    productionItemId: itemId,
    actorId: actor.id,
    actorName: actor.name,
});
/** Die Stelle einer Aufgabe im Weg — Bereich und Stufe. */
const stageKeyOf = (task) => `${task.area}|${task.stage}`;
/** Die Stufen, in denen die Person an einer Unteraufgabe steht (30.09.2026). */
const stagesOf = (tasks, employeeId) => new Set(tasks.filter((task) => task.subtasks.some((subtask) => (0, productionTasks_1.worksOnSubtask)(subtask, employeeId))).map(stageKeyOf));
/** Wer die erste (noch vorhandene) Fassung einer Datei hochgeladen hat. */
const originalUploaderOf = (files, groupId) => {
    const versions = files.filter((file) => file.groupId === groupId).sort((left, right) => left.version - right.version);
    return versions[0]?.uploadedById ?? null;
};
const cleanFileName = (value) => (value || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200) || 'file';
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
    files;
    activities;
    requests;
    constructor(plans, templates, directory, notifier, files, activities, requests) {
        this.plans = plans;
        this.templates = templates;
        this.directory = directory;
        this.notifier = notifier;
        this.files = files;
        this.activities = activities;
        this.requests = requests;
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
        const check = (0, productionTasks_1.templateCheck)(template.sections, template.tasks);
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
        const tasks = (0, productionTasks_1.orderTasks)(template.tasks, template.sections).map((task) => (0, productionTasks_1.withActiveAssignees)({
            area: task.area,
            stage: task.stage,
            code: task.code,
            name: task.name,
            weight: task.weight,
            assigneeIds: task.assigneeIds,
            startDate: task.startDate,
            dueDate: task.dueDate,
            // Am Gerät entsteht die Kopie heute — Aufgabe wie Unteraufgaben.
            createdAt: (0, productionTasks_1.today)(),
            // Am Gerät beginnt jede Unteraufgabe offen, ohne Dateien und Abschluss.
            subtasks: task.subtasks.map((subtask) => ({ ...(0, productionTasks_1.withoutDeviceRecord)(subtask), createdAt: (0, productionTasks_1.today)() })),
        }, active));
        let plan;
        try {
            plan = await this.plans.replacePlan(tenantId, {
                device,
                templateId: template.id,
                templateName: template.name,
                sections: template.sections,
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
        // Ein ersetzter Plan nimmt seine Dateien mit.
        if (existing)
            this.dropFiles(fileRefsOf(existing.tasks), fileRefsOf(plan.tasks));
        // Der Verlauf: die geladene Vorlage — und wer aus ihr an welcher Unteraufgabe steht.
        const loadedPeople = await this.directory.people(tenantId, (0, productionTaskReadModel_1.assigneesOf)(plan.tasks));
        const loadedName = (id) => loadedPeople.find((person) => person.id === id)?.name ?? id;
        await this.log([
            (0, productionTaskActivities_1.deviceActivity)(scopeOf(tenantId, itemId, actor), 'PLAN_LOADED', {
                templateName: template.name,
                previousTemplateName: existing?.templateName ?? null,
                taskCount: plan.tasks.length,
            }),
            ...(0, productionTaskActivities_1.loadedAssignments)(scopeOf(tenantId, itemId, actor), plan.tasks, loadedName),
        ]);
        void this.notifier.assigned({
            tenantId,
            device,
            actorId: actor.id,
            actorName: actor.name,
            news: (0, productionTasks_1.assignmentNews)(existing?.tasks ?? [], plan.tasks),
        });
        // Ersetzt: die Aufgaben des alten Plans sind weg — ihre Leute erfahren es (30.09.2026).
        if (existing) {
            const gone = (0, productionTaskActivities_1.planChangeNotices)(existing.tasks, []);
            if (gone.length)
                void this.notifier.changed({ tenantId, device, actorId: actor.id, actorName: actor.name, notices: gone });
        }
        return this.dto(tenantId, device, plan);
    }
    /**
     * Die Personen einer Unteraufgabe setzen (29.09.2026, nur Administratorrolle —
     * der Weg sichert es mit ADMIN): «they should only assign people to
     * subtasks». Die Aufgabe zeigt danach alle Personen ihrer Unteraufgaben.
     * Wer neu an der Unteraufgabe steht, bekommt eine Nachricht.
     */
    async assignSubtask(tenantId, actor, itemId, taskId, subtaskId, body) {
        const wanted = (0, productionTasks_1.assigneeIdsFrom)(objectOf(body).assigneeIds);
        const [device, active] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.directory.activePeople(tenantId, wanted),
        ]);
        if (!device)
            throw this.deviceNotFound();
        const kept = wanted.filter((id) => active.has(id));
        let previous = [];
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            previous = subtask.assigneeIds;
            return { ...subtask, assigneeIds: kept };
        }, actor.id));
        const before = {
            code: task.code,
            subtasks: task.subtasks.map((subtask) => (subtask.id === subtaskId ? { ...subtask, assigneeIds: previous } : subtask)),
        };
        const news = (0, productionTasks_1.assignmentNews)([before], [task]);
        if (news.size) {
            void this.notifier.assigned({ tenantId, device, actorId: actor.id, actorName: actor.name, news });
        }
        // Die Namen auch derer, die gingen — der Verlauf nennt sie.
        const named = await this.directory.people(tenantId, [...new Set([...task.assigneeIds, ...previous])]);
        const change = (0, productionTaskActivities_1.assigneeChange)(previous, kept, (id) => named.find((person) => person.id === id)?.name ?? id);
        const subtask = task.subtasks.find((entry) => entry.id === subtaskId) ?? null;
        if (change && subtask) {
            await this.log([(0, productionTaskActivities_1.activityAt)(scopeOf(tenantId, itemId, actor), 'SUBTASK_ASSIGNED', task, subtask, change)]);
            // Wer von der Unteraufgabe genommen wurde, erfährt es (30.09.2026).
            if (change.removed.length) {
                const index = task.subtasks.findIndex((entry) => entry.id === subtaskId);
                void this.notifier.changed({
                    tenantId,
                    device,
                    actorId: actor.id,
                    actorName: actor.name,
                    notices: [{ kind: 'REMOVED', recipients: change.removed.map((person) => person.id), code: `${task.code}.${index + 1}`, name: subtask.name, area: task.area, stage: task.stage }],
                });
            }
        }
        const people = named.filter((person) => task.assigneeIds.includes(person.id));
        return { task: (0, productionTaskReadModel_1.taskDto)(task), people };
    }
    /**
     * Die Aufgaben des Geräts anpassen (28.09.2026, nur Administratorrolle):
     * «admin should be able to customize the tasks and subtasks — it shouldn't
     * change the template, only the version that the project uses». Name,
     * Gewicht, Tage und Unteraufgaben samt ihren Personen; neue Aufgaben in
     * einer Stufe, entfernte fallen weg. Wer neu an einer Unteraufgabe steht,
     * bekommt eine Nachricht.
     */
    async updateTasks(tenantId, actor, itemId, body) {
        const [device, existing] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.plans.getPlan(tenantId, itemId),
        ]);
        if (!device)
            throw this.deviceNotFound();
        if (!existing)
            throw (0, productionTasks_1.productionTaskError)('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        // Die Gewichte der Stufen (30.09.2026) kommen mit `sections`; ohne sie bleiben sie, wie sie sind.
        const sections = (0, productionTasks_1.withStageWeights)(existing.sections, objectOf(body).sections);
        const input = (0, productionTasks_1.tasksInputFrom)(objectOf(body).tasks, sections, true);
        const active = await this.directory.activePeople(tenantId, (0, productionTaskReadModel_1.assigneesOf)(input));
        const tasks = (0, productionTasks_1.orderTasks)(input, sections).map((task) => (0, productionTasks_1.withActiveAssignees)(task, active));
        const plan = await this.plans.replaceTasks(tenantId, itemId, tasks, actor.id, sections);
        if (!plan)
            throw (0, productionTasks_1.productionTaskError)('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        // Entfernte Unteraufgaben nehmen ihre Dateien mit.
        this.dropFiles(fileRefsOf(existing.tasks), fileRefsOf(plan.tasks));
        void this.notifier.assigned({
            tenantId,
            device,
            actorId: actor.id,
            actorName: actor.name,
            news: (0, productionTasks_1.assignmentNews)(existing.tasks, plan.tasks),
        });
        // Neue Pflichten öffnen begonnene Unteraufgaben wieder — die Leute der Aufgabe erfahren es.
        const reopened = (0, productionTasks_1.reopenedSubtasks)(existing.tasks, plan.tasks);
        if (reopened.length) {
            void this.notifier.reopened({ tenantId, device, actorId: actor.id, actorName: actor.name, subtasks: reopened });
        }
        // Der Verlauf: was angelegt, geändert, verschoben, gelöscht und wem zugewiesen wurde.
        const named = await this.directory.people(tenantId, [...new Set([...(0, productionTaskReadModel_1.assigneesOf)(existing.tasks), ...(0, productionTaskReadModel_1.assigneesOf)(plan.tasks)])]);
        const nameOf = (id) => named.find((person) => person.id === id)?.name ?? id;
        await this.log((0, productionTaskActivities_1.planChangeActivities)(scopeOf(tenantId, itemId, actor), existing.tasks, plan.tasks, nameOf));
        // Entfernt, gelöscht, geändert — die Leute der Unteraufgaben erfahren es (30.09.2026).
        // Wieder geöffnete Unteraufgaben haben schon ihre Nachricht «neu prüfen» — keine zweite.
        const reopenedCodes = new Set(reopened.map((entry) => entry.code));
        const notices = (0, productionTaskActivities_1.planChangeNotices)(existing.tasks, plan.tasks)
            .filter((notice) => !(notice.kind === 'UPDATED' && reopenedCodes.has(notice.code)));
        if (notices.length)
            void this.notifier.changed({ tenantId, device, actorId: actor.id, actorName: actor.name, notices });
        return this.dto(tenantId, device, plan);
    }
    /**
     * Eine neue Stufe in einem Bereich der Kopie am Gerät (28.09.2026, nur Administratorrolle —
     * der Weg sichert es mit ADMIN): nur solange die Aufgaben des Bereichs unter 100 % wiegen.
     * Die Vorlage bleibt, wie sie ist; Aufgaben, Stände und Dateien bleiben unberührt.
     */
    async addStage(tenantId, actor, itemId, body) {
        const input = objectOf(body);
        const [device, existing] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.plans.getPlan(tenantId, itemId),
        ]);
        if (!device)
            throw this.deviceNotFound();
        if (!existing)
            throw (0, productionTasks_1.productionTaskError)('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        const sections = (0, productionTasks_1.withAddedStage)(existing.sections, input.area, input.name);
        const plan = await this.plans.setSections(tenantId, itemId, sections);
        if (!plan)
            throw (0, productionTasks_1.productionTaskError)('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        // Die neue Stufe: die, die vorher im Bereich nicht war.
        const known = new Set(existing.sections.flatMap((section) => section.stages.map((stage) => `${section.key}|${stage.key}`)));
        const added = plan.sections.flatMap((section) => section.stages
            .filter((stage) => !known.has(`${section.key}|${stage.key}`))
            .map((stage) => ({ area: section.key, stage: stage.key, name: stage.name })));
        await this.log(added.map((entry) => ({
            ...(0, productionTaskActivities_1.deviceActivity)(scopeOf(tenantId, itemId, actor), 'STAGE_ADDED', { name: entry.name }),
            area: entry.area,
            stage: entry.stage,
        })));
        return this.dto(tenantId, device, plan);
    }
    /**
     * Der Stand einer Aufgabe (28.09.2026): offen, in Arbeit, erledigt. Setzen
     * darf ihn nur, wer in der Aufgabe steht — die Verwaltung nicht von Hand
     * (29.09.2026: «admins shouldn't be allowed to change the task statuses
     * manually»). Personen stehen nur an Unteraufgaben; eine Aufgabe ohne
     * Unteraufgaben hat also keine, und mit Unteraufgaben folgt sie ihnen.
     */
    async setStatus(tenantId, actor, itemId, taskId, body) {
        const status = objectOf(body).status;
        // «Wartet auf Freigabe» gibt es nur an Unteraufgaben mit «Approval».
        // «Wartet auf Freigabe» und «zur Überarbeitung» gibt es nur an Unteraufgaben.
        if (!(0, productionTasks_1.isProductionTaskStatus)(status) || status === 'PENDING' || status === 'REVISION') {
            throw (0, productionTasks_1.productionTaskError)('STATUS_INVALID', 'Unbekannter Stand.');
        }
        const current = await this.plans.getTask(tenantId, itemId, taskId);
        if (!current)
            throw (0, productionTasks_1.productionTaskError)('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        if (!current.assigneeIds.includes(actor.id)) {
            throw (0, productionTasks_1.productionTaskError)('STATUS_FORBIDDEN', 'Den Stand setzt nur, wer in der Aufgabe steht.', { status: 403 });
        }
        // Mit Unteraufgaben folgt die Aufgabe ihnen — ihren Stand setzt niemand direkt (28.09.2026).
        if (current.subtasks.length > 0) {
            throw (0, productionTasks_1.productionTaskError)('STATUS_FLOW', 'Der Stand dieser Aufgabe folgt ihren Unteraufgaben.', { status: 409 });
        }
        const task = await this.plans.setStatus(tenantId, itemId, taskId, status, actor.id);
        if (!task)
            throw (0, productionTasks_1.productionTaskError)('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        if (current.status !== status) {
            await this.log([(0, productionTaskActivities_1.activityAt)(scopeOf(tenantId, itemId, actor), 'TASK_STATUS', task, null, { from: current.status, to: status })]);
        }
        return { task: (0, productionTaskReadModel_1.taskDto)(task) };
    }
    /**
     * Der Stand einer Unteraufgabe (28.09.2026) — setzen darf ihn nur, wer an
     * der Unteraufgabe steht; die Verwaltung nicht von Hand (29.09.2026), sie
     * gibt frei, gibt zurück und hebt die Sperre auf. Die Aufgabe folgt ihren
     * Unteraufgaben (alle erledigt → erledigt).
     *
     * Regeln siehe `subtaskStatusChange`: abgeschlossen = gesperrt für alle;
     * «Approval» schliesst nur «Complete the task»; «Document» braucht ein PDF.
     */
    async setSubtaskStatus(tenantId, actor, itemId, taskId, subtaskId, body) {
        const status = objectOf(body).status;
        if (!(0, productionTasks_1.isProductionTaskStatus)(status)) {
            throw (0, productionTasks_1.productionTaskError)('STATUS_INVALID', 'Unbekannter Stand.');
        }
        let from = status;
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!(0, productionTasks_1.worksOnSubtask)(subtask, actor.id)) {
                throw (0, productionTasks_1.productionTaskError)('STATUS_FORBIDDEN', 'Den Stand setzt nur, wer an der Unteraufgabe steht.', { status: 403 });
            }
            from = subtask.status;
            return subtaskStatusChange(subtask, status);
        }, actor.id));
        const kind = (0, productionTaskActivities_1.subtaskStepKind)(from, status);
        if (kind)
            await this.logSubtask(tenantId, itemId, actor, kind, task, subtaskId, { from, to: status });
        // Zur Freigabe geschickt: eine Anfrage an die Verwaltung (30.09.2026) — höchstens eine offene.
        if (kind === 'SUBTASK_SUBMITTED')
            await this.openRequest(tenantId, itemId, actor, task, subtaskId, 'APPROVAL', null);
        return { task: (0, productionTaskReadModel_1.taskDto)(task) };
    }
    /**
     * «Complete the task» (28.09.2026) — nur die Verwaltung, nur eine
     * Unteraufgabe mit «Approval». Trägt sie «Document», braucht sie ein PDF.
     * Erledigt, mit wem, wann und kurzer Notiz; danach gesperrt.
     */
    async completeSubtask(tenantId, actor, isAdmin, itemId, taskId, subtaskId, body) {
        if (!isAdmin)
            throw (0, productionTasks_1.productionTaskError)('STATUS_FORBIDDEN', 'Abschliessen darf nur die Verwaltung.', { status: 403 });
        const input = objectOf(body);
        const rawNote = input.note;
        const note = typeof rawNote === 'string' ? rawNote.replace(/\r\n/g, '\n').trim().slice(0, 500) : '';
        // Die abgehakten Punkte der Freigabe-Checkliste — geprüft wird hier, nicht nur im Browser.
        const checked = new Set(Array.isArray(input.checked) ? input.checked.filter((id) => typeof id === 'string') : []);
        let checklist = [];
        let fileIds = [];
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!subtask.requiresApproval) {
                throw (0, productionTasks_1.productionTaskError)('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
            }
            if (isCompleted(subtask))
                throw (0, productionTasks_1.productionTaskError)('ALREADY_COMPLETED', 'Schon abgeschlossen.', { status: 409 });
            // Freigeben nur, was auf die Freigabe wartet (28.09.2026).
            if (subtask.status !== 'PENDING') {
                throw (0, productionTasks_1.productionTaskError)('NOT_PENDING', 'Erst «Complete the task» — dann wartet sie auf die Freigabe.', { status: 409 });
            }
            if (subtask.requiresDocument && !(0, productionTasks_1.hasSubtaskDocument)(subtask)) {
                throw (0, productionTasks_1.productionTaskError)('DOCUMENT_REQUIRED', 'Ohne PDF schliesst sie nicht ab.', { status: 409 });
            }
            // Jeder Punkt der Checkliste muss abgehakt sein (28.09.2026) — sonst keine Freigabe.
            if (subtask.approvalChecklist.some((item) => !checked.has(item.id))) {
                throw (0, productionTasks_1.productionTaskError)('CHECKLIST_INCOMPLETE', 'Erst alle Punkte der Freigabe-Checkliste abhaken.', { status: 409 });
            }
            checklist = subtask.approvalChecklist.map((item) => item.text);
            fileIds = subtask.files.map((file) => file.id);
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
        }, actor.id));
        // Die Dateien, die freigegeben wurden — der Klick zeigt sie.
        await this.logSubtask(tenantId, itemId, actor, 'SUBTASK_APPROVED', task, subtaskId, { note: note || null, checklist, fileIds });
        await this.notifyChanged(tenantId, itemId, actor, (0, productionTaskActivities_1.subtaskNotice)('APPROVED', task, subtaskId, note || null));
        await this.closeRequests(tenantId, itemId, actor, subtaskId, ['APPROVAL'], 'APPROVED');
        return { task: (0, productionTaskReadModel_1.taskDto)(task) };
    }
    /**
     * Ein Punkt mehr in der Freigabe-Checkliste — aus «Approve the files»
     * (28.09.2026), nur die Verwaltung, nur an einer offenen Unteraufgabe mit
     * «Approval». Der Stand bleibt; der neue Punkt muss vor der Freigabe
     * abgehakt werden (das prüft `completeSubtask`).
     */
    async addSubtaskChecklistItem(tenantId, actor, isAdmin, itemId, taskId, subtaskId, body) {
        if (!isAdmin)
            throw (0, productionTasks_1.productionTaskError)('STATUS_FORBIDDEN', 'Die Checkliste ergänzt nur die Verwaltung.', { status: 403 });
        const rawText = objectOf(body).text;
        let text = '';
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!subtask.requiresApproval) {
                throw (0, productionTasks_1.productionTaskError)('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
            }
            if (isCompleted(subtask)) {
                throw (0, productionTasks_1.productionTaskError)('SUBTASK_LOCKED', 'Freigegeben und gesperrt — erst die Sperre aufheben.', { status: 409 });
            }
            const next = (0, productionTasks_1.withChecklistItem)(subtask, rawText);
            text = next.approvalChecklist[next.approvalChecklist.length - 1]?.text ?? '';
            return next;
        }, actor.id));
        await this.logSubtask(tenantId, itemId, actor, 'CHECKLIST_ITEM_ADDED', task, subtaskId, { text });
        await this.notifyChanged(tenantId, itemId, actor, (0, productionTaskActivities_1.subtaskNotice)('UPDATED', task, subtaskId));
        return { task: (0, productionTaskReadModel_1.taskDto)(task) };
    }
    /**
     * Die Sperre aufheben (28.09.2026) — nur die Verwaltung, ein Klick auf das
     * Schloss einer freigegebenen ODER wartenden Unteraufgabe: sie ist wieder
     * in Arbeit («when the admin removes the lock the status should be in
     * progress»); Dateien lassen sich wieder ändern, «Complete the task»
     * schickt sie erneut zur Freigabe.
     */
    async unlockSubtask(tenantId, actor, isAdmin, itemId, taskId, subtaskId) {
        if (!isAdmin)
            throw (0, productionTasks_1.productionTaskError)('STATUS_FORBIDDEN', 'Die Sperre hebt nur die Verwaltung auf.', { status: 403 });
        let from = 'PENDING';
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!isCompleted(subtask) && subtask.status !== 'PENDING') {
                throw (0, productionTasks_1.productionTaskError)('NOT_LOCKED', 'Nicht gesperrt.', { status: 409 });
            }
            from = subtask.status;
            return {
                ...subtask,
                status: 'IN_PROGRESS',
                completedById: null,
                completedByName: null,
                completedAt: null,
                completionNote: null,
            };
        }, actor.id));
        await this.logSubtask(tenantId, itemId, actor, 'SUBTASK_UNLOCKED', task, subtaskId, { from, to: 'IN_PROGRESS' });
        await this.notifyChanged(tenantId, itemId, actor, (0, productionTaskActivities_1.subtaskNotice)('UNLOCKED', task, subtaskId));
        // Entsperrt: die Bitte darum ist erledigt — und eine wartende Freigabe auch (sie ist wieder in Arbeit).
        await this.closeRequests(tenantId, itemId, actor, subtaskId, ['UNLOCK', 'APPROVAL'], 'UNLOCKED');
        return { task: (0, productionTaskReadModel_1.taskDto)(task) };
    }
    /**
     * «Request revision» (28.09.2026) — beim Prüfen der Dateien, nur die
     * Verwaltung, nur eine offene Unteraufgabe mit «Approval»: zurück in
     * Arbeit, mit wem, wann und was zu ändern ist.
     */
    async requestSubtaskRevision(tenantId, actor, isAdmin, itemId, taskId, subtaskId, body) {
        if (!isAdmin)
            throw (0, productionTasks_1.productionTaskError)('STATUS_FORBIDDEN', 'Zurückgeben darf nur die Verwaltung.', { status: 403 });
        const rawNote = objectOf(body).note;
        const note = typeof rawNote === 'string' ? rawNote.replace(/\r\n/g, '\n').trim().slice(0, 500) : '';
        let fileIds = [];
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!subtask.requiresApproval) {
                throw (0, productionTasks_1.productionTaskError)('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
            }
            if (isCompleted(subtask))
                throw (0, productionTasks_1.productionTaskError)('ALREADY_COMPLETED', 'Schon abgeschlossen.', { status: 409 });
            fileIds = subtask.files.map((file) => file.id);
            // Zurückgeben lässt sich nur, was auf die Freigabe wartet.
            if (subtask.status !== 'PENDING') {
                throw (0, productionTasks_1.productionTaskError)('NOT_PENDING', 'Nur eine wartende Unteraufgabe lässt sich zurückgeben.', { status: 409 });
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
        }, actor.id));
        // Die Dateien, die beim Zurückgeben vorlagen — der Klick zeigt, worauf die Notiz sich bezieht.
        await this.logSubtask(tenantId, itemId, actor, 'REVISION_REQUESTED', task, subtaskId, { note: note || null, fileIds });
        await this.notifyChanged(tenantId, itemId, actor, (0, productionTaskActivities_1.subtaskNotice)('REVISION', task, subtaskId, note || null));
        await this.closeRequests(tenantId, itemId, actor, subtaskId, ['APPROVAL'], 'REVISION');
        return { task: (0, productionTaskReadModel_1.taskDto)(task) };
    }
    /**
     * Eine Datei an eine Unteraufgabe (28.09.2026) — die Verwaltung und wer
     * an der Unteraufgabe steht; an eine freigegebene (gesperrte) niemand.
     */
    async uploadSubtaskFile(tenantId, actor, isAdmin, itemId, taskId, subtaskId, file, 
    /** Neue Fassung dieser Datei (28.09.2026) — null: eine neue Datei. */
    revisionOf = null, 
    /** Was sich geändert hat — Pflicht für eine neue Fassung (28.09.2026). */
    rawRevisionNote = null) {
        await this.assertOnSubtask(tenantId, actor, isAdmin, itemId, taskId, subtaskId);
        const revisionNote = typeof rawRevisionNote === 'string' ? rawRevisionNote.replace(/\r\n/g, '\n').trim().slice(0, 500) : '';
        if (revisionOf && !revisionNote) {
            throw (0, productionTasks_1.productionTaskError)('REVISION_NOTE_REQUIRED', 'Zu einer neuen Fassung gehört eine Notiz, was sich geändert hat.');
        }
        if (!file || !file.body?.length)
            throw (0, productionTasks_1.productionTaskError)('FILE_REQUIRED', 'Keine Datei empfangen.');
        const contentType = String(file.contentType || '').toLowerCase();
        if (!SUBTASK_FILE_TYPES.has(contentType) || !this.files.accepts(contentType)) {
            throw (0, productionTasks_1.productionTaskError)('FILE_TYPE', 'Erlaubt sind nur PDF-Dateien.');
        }
        if (file.body.length > productionTasks_1.SUBTASK_FILE_LIMITS.bytes) {
            throw (0, productionTasks_1.productionTaskError)('FILE_TOO_LARGE', 'Die Datei ist zu gross.', { status: 413, params: { max: 25 } });
        }
        const ref = await this.files.store(tenantId, file.body, contentType);
        let added = null;
        let task;
        try {
            task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
                // Gesperrt heisst für ALLE gesperrt (28.09.2026) — auch solange sie auf die Freigabe wartet.
                assertFilesOpen(subtask);
                if (subtask.files.length >= productionTasks_1.SUBTASK_FILE_LIMITS.files) {
                    throw (0, productionTasks_1.productionTaskError)('FILES_TOO_MANY', 'Zu viele Dateien.', { status: 409, params: { max: productionTasks_1.SUBTASK_FILE_LIMITS.files } });
                }
                const id = (0, productionTasks_1.newSubtaskFileId)();
                // Neue Datei oder nächste Fassung einer vorhandenen (dieselbe groupId).
                const { groupId, version } = (0, productionTasks_1.fileVersionFor)(subtask.files, id, revisionOf);
                /* Eine neue Fassung der Datei eines anderen ist eine Änderung an ihr (30.09.2026: «they
                   can't delete or modify them») — ausser der Verwaltung nur, wer die Datei hochgeladen hat. */
                if (revisionOf && !isAdmin && originalUploaderOf(subtask.files, groupId) !== actor.id) {
                    throw (0, productionTasks_1.productionTaskError)('FILE_FORBIDDEN', 'Eine neue Fassung lädt nur hoch, wer die Datei hochgeladen hat.', { status: 403 });
                }
                const entry = {
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
                };
                added = entry;
                return { ...subtask, files: [...subtask.files, entry] };
            }, actor.id));
        }
        catch (error) {
            await this.files.remove(ref).catch(() => undefined);
            throw error;
        }
        const stored = added;
        if (stored)
            await this.logSubtask(tenantId, itemId, actor, 'FILE_UPLOADED', task, subtaskId, (0, productionTaskActivities_1.fileDetails)(stored));
        return { task: (0, productionTaskReadModel_1.taskDto)(task) };
    }
    /** Eine Datei lesen — wer die Produktion sieht. */
    async readSubtaskFile(tenantId, itemId, taskId, subtaskId, fileId) {
        const task = await this.plans.getTask(tenantId, itemId, taskId);
        if (!task)
            throw (0, productionTasks_1.productionTaskError)('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        const subtask = task.subtasks.find((entry) => entry.id === subtaskId);
        if (!subtask)
            throw (0, productionTasks_1.productionTaskError)('SUBTASK_NOT_FOUND', 'Unteraufgabe nicht gefunden.', { status: 404 });
        const file = subtask.files.find((entry) => entry.id === fileId);
        if (!file)
            throw (0, productionTasks_1.productionTaskError)('FILE_NOT_FOUND', 'Datei nicht gefunden.', { status: 404 });
        return { body: await this.files.read(file.ref), contentType: file.type, fileName: file.name };
    }
    /**
     * Eine Datei entfernen — die Verwaltung; sonst wer sie hochgeladen hat
     * und noch an der Unteraufgabe steht, solange sie offen ist.
     */
    async removeSubtaskFile(tenantId, actor, isAdmin, itemId, taskId, subtaskId, fileId) {
        await this.assertOnSubtask(tenantId, actor, isAdmin, itemId, taskId, subtaskId);
        let removed = null;
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            const file = subtask.files.find((entry) => entry.id === fileId);
            if (!file)
                throw (0, productionTasks_1.productionTaskError)('FILE_NOT_FOUND', 'Datei nicht gefunden.', { status: 404 });
            assertFilesOpen(subtask);
            if (!isAdmin && file.uploadedById !== actor.id) {
                throw (0, productionTasks_1.productionTaskError)('FILE_FORBIDDEN', 'Diese Datei entfernt nur die Verwaltung.', { status: 403 });
            }
            removed = file;
            return { ...subtask, files: subtask.files.filter((entry) => entry.id !== fileId) };
        }, actor.id));
        const gone = removed;
        if (gone) {
            await this.files.remove(gone.ref).catch(() => undefined);
            await this.logSubtask(tenantId, itemId, actor, 'FILE_DELETED', task, subtaskId, (0, productionTaskActivities_1.fileDetails)(gone));
        }
        return { task: (0, productionTaskReadModel_1.taskDto)(task) };
    }
    async unload(tenantId, actor, itemId) {
        const existing = await this.plans.getPlan(tenantId, itemId);
        if (!(await this.plans.deletePlan(tenantId, itemId))) {
            throw (0, productionTasks_1.productionTaskError)('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        }
        if (existing)
            this.dropFiles(fileRefsOf(existing.tasks), new Set());
        await this.log([(0, productionTaskActivities_1.deviceActivity)(scopeOf(tenantId, itemId, actor), 'PLAN_REMOVED', {
                templateName: existing?.templateName ?? null,
                taskCount: existing?.tasks.length ?? 0,
            })]);
        // Die Aufgaben sind weg — wer an ihnen stand, erfährt es (30.09.2026).
        if (existing)
            await this.notifyChanged(tenantId, itemId, actor, (0, productionTaskActivities_1.planChangeNotices)(existing.tasks, []));
        return { deleted: true };
    }
    /**
     * Der Verlauf einer Stufe (30.09.2026): wer was wann tat, neueste zuerst,
     * samt den Handlungen am ganzen Gerät — seitenweise (`page`, `pageSize`),
     * gefiltert nach Arten (`kinds`, durch Komma getrennt), Person (`actorId`)
     * und Zeitraum (`from` einschliesslich, `to` ausschliesslich, je ISO).
     */
    async listActivities(tenantId, itemId, query) {
        const text = (value) => (typeof value === 'string' ? value.trim() : '');
        // Ohne Bereich und Stufe: der Verlauf des ganzen Geräts (30.09.2026, Startseite der Verwaltung).
        const area = text(query.area);
        const stage = text(query.stage);
        if (Boolean(area) !== Boolean(stage))
            throw (0, productionTasks_1.productionTaskError)('STAGE_REQUIRED', 'Bereich und Stufe fehlen.');
        const place = area && stage ? { area, stage } : null;
        const whole = (value, fallback, max) => {
            const number = Math.floor(Number(value));
            return Number.isFinite(number) && number > 0 ? Math.min(max, number) : fallback;
        };
        const pageSize = whole(query.pageSize, ACTIVITY_PAGE, ACTIVITY_PAGE_MAX);
        const page = whole(query.page, 1, 100_000);
        const instant = (value) => {
            const date = text(value) ? new Date(text(value)) : null;
            return date && !Number.isNaN(date.getTime()) ? date : null;
        };
        // Nur bekannte Arten; eine leere Auswahl heisst «alle».
        const kinds = text(query.kinds).split(',').map((kind) => kind.trim()).filter((kind) => ACTIVITY_KINDS.has(kind));
        const device = await this.directory.device(tenantId, itemId);
        if (!device)
            throw this.deviceNotFound();
        const [{ rows, total }, actors] = await Promise.all([
            this.activities.list(tenantId, itemId, place, {
                kinds: kinds.length ? kinds : null,
                actorId: text(query.actorId) || null,
                from: instant(query.from),
                to: instant(query.to),
                offset: (page - 1) * pageSize,
                limit: pageSize,
            }),
            this.activities.actors(tenantId, itemId, place),
        ]);
        return {
            total,
            page,
            pageSize,
            actors,
            items: rows.map((row) => ({
                id: row.id,
                kind: row.kind,
                at: row.createdAt.toISOString(),
                actorId: row.actorId,
                actorName: row.actorName,
                area: row.area,
                stage: row.stage,
                taskId: row.taskId,
                taskCode: row.taskCode,
                taskName: row.taskName,
                subtaskId: row.subtaskId,
                subtaskCode: row.subtaskCode,
                subtaskName: row.subtaskName,
                details: row.details,
            })),
        };
    }
    /**
     * Bitte um das Aufheben der Sperre (30.09.2026, Vorgabe Samet: «the normal employees should be
     * able to send unlock requests to the admins by clicking on the lock icon»). Nur wer an der
     * Unteraufgabe steht, nur an einer gesperrten (freigegeben oder wartend), höchstens eine
     * offene Bitte je Unteraufgabe. Die Verwaltung bekommt eine Nachricht.
     */
    async requestUnlock(tenantId, actor, itemId, taskId, subtaskId, body) {
        const rawNote = objectOf(body).note;
        const note = typeof rawNote === 'string' ? rawNote.replace(/\r\n/g, '\n').trim().slice(0, 500) : '';
        const task = await this.plans.getTask(tenantId, itemId, taskId);
        if (!task)
            throw (0, productionTasks_1.productionTaskError)('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        const subtask = task.subtasks.find((entry) => entry.id === subtaskId);
        if (!subtask)
            throw (0, productionTasks_1.productionTaskError)('SUBTASK_NOT_FOUND', 'Unteraufgabe nicht gefunden.', { status: 404 });
        if (!(0, productionTasks_1.worksOnSubtask)(subtask, actor.id)) {
            throw (0, productionTasks_1.productionTaskError)('STATUS_FORBIDDEN', 'Um das Entsperren bittet nur, wer an der Unteraufgabe steht.', { status: 403 });
        }
        if (!isCompleted(subtask) && subtask.status !== 'PENDING') {
            throw (0, productionTasks_1.productionTaskError)('NOT_LOCKED', 'Nicht gesperrt.', { status: 409 });
        }
        if (await this.requests.findOpen(tenantId, itemId, subtaskId, 'UNLOCK')) {
            throw (0, productionTasks_1.productionTaskError)('UNLOCK_ALREADY_REQUESTED', 'Um das Entsperren wurde schon gebeten.', { status: 409 });
        }
        const index = task.subtasks.findIndex((entry) => entry.id === subtaskId);
        const request = await this.requests.create({
            tenantId,
            productionItemId: itemId,
            area: task.area,
            stage: task.stage,
            taskId: task.id,
            taskCode: task.code,
            taskName: task.name,
            subtaskId,
            subtaskCode: `${task.code}.${index + 1}`,
            subtaskName: subtask.name,
            kind: 'UNLOCK',
            note: note || null,
            requestedById: actor.id,
            requestedByName: actor.name,
        });
        await this.logSubtask(tenantId, itemId, actor, 'UNLOCK_REQUESTED', task, subtaskId, { note: note || null, from: subtask.status });
        const device = await this.directory.device(tenantId, itemId);
        if (device) {
            void this.notifier.unlockRequested({
                tenantId,
                device,
                actorId: actor.id,
                actorName: actor.name,
                code: `${task.code}.${index + 1}`,
                name: subtask.name,
                area: task.area,
                stage: task.stage,
                note: note || null,
            });
        }
        return { request: requestDto(request) };
    }
    /**
     * Die Anfragen einer Stufe (30.09.2026) — Freigaben und Entsperren, neueste zuerst; `status`
     * open (Vorgabe) · solved · all. Dazu, wie viele noch offen sind (die Zahl am Plättchen).
     */
    async listRequests(tenantId, itemId, query) {
        const text = (value) => (typeof value === 'string' ? value.trim() : '');
        // Ohne Bereich und Stufe: die Anfragen des ganzen Geräts (30.09.2026, Startseite der Verwaltung).
        const area = text(query.area);
        const stage = text(query.stage);
        if (Boolean(area) !== Boolean(stage))
            throw (0, productionTasks_1.productionTaskError)('STAGE_REQUIRED', 'Bereich und Stufe fehlen.');
        const place = area && stage ? { area, stage } : null;
        const wanted = text(query.status);
        const status = wanted === 'solved' || wanted === 'all' ? wanted : 'open';
        const [rows, openCount] = await Promise.all([
            this.requests.list(tenantId, itemId, place, status),
            this.requests.countOpen(tenantId, itemId, place),
        ]);
        return { items: rows.map(requestDto), openCount };
    }
    /**
     * Projekte und Geräte mit Aufgaben (30.09.2026) — die Auswahl für Anfragen und Verlauf auf der
     * Startseite der Verwaltung, samt offener Anfragen je Gerät und Projekt.
     */
    async taskDevices(tenantId) {
        const [rows, open] = await Promise.all([this.directory.taskDevices(tenantId), this.requests.openByDevice(tenantId)]);
        const projects = new Map();
        for (const row of rows) {
            const project = projects.get(row.projectId) ?? { id: row.projectId, projectNumber: row.projectNumber, projectName: row.projectName, openRequests: 0, devices: [] };
            const openRequests = open.get(row.deviceId) ?? 0;
            project.devices.push({ id: row.deviceId, name: row.deviceName, positionNumber: row.positionNumber, templateName: row.templateName, taskCount: row.taskCount, openRequests });
            project.openRequests += openRequests;
            projects.set(row.projectId, project);
        }
        const byText = (left, right) => left.localeCompare(right, 'tr', { numeric: true });
        return {
            projects: [...projects.values()]
                .map((project) => ({
                ...project,
                devices: project.devices.sort((left, right) => byText(left.positionNumber ?? '', right.positionNumber ?? '') || byText(left.name, right.name)),
            }))
                .sort((left, right) => byText(right.projectNumber, left.projectNumber)),
        };
    }
    /** «Mark as solved» (30.09.2026) — nur die Verwaltung (der Weg sichert es). */
    async solveRequest(tenantId, actor, itemId, requestId) {
        const solved = await this.requests.solve(tenantId, itemId, requestId, { id: actor.id, name: actor.name }, 'MANUAL');
        if (!solved)
            throw (0, productionTasks_1.productionTaskError)('REQUEST_NOT_FOUND', 'Anfrage nicht gefunden oder schon erledigt.', { status: 404 });
        await this.log([{
                ...(0, productionTaskActivities_1.deviceActivity)(scopeOf(tenantId, itemId, actor), 'REQUEST_SOLVED', {
                    kind: solved.kind,
                    requestedByName: solved.requestedByName,
                    requestedAt: solved.createdAt.toISOString(),
                    note: solved.note,
                }),
                area: solved.area,
                stage: solved.stage,
                taskId: solved.taskId,
                taskCode: solved.taskCode,
                taskName: solved.taskName,
                subtaskId: solved.subtaskId,
                subtaskCode: solved.subtaskCode,
                subtaskName: solved.subtaskName,
            }]);
        return { request: requestDto(solved) };
    }
    /**
     * «Görevlerim» auf der Startseite (30.09.2026, Vorgabe Samet): «the task tables that the
     * employee is added will be shown … the employee should be able to switch between the
     * project task tables». Je Projekt die Geräte, an denen die Person an einer Unteraufgabe
     * steht, und dort NUR diese Aufgaben — samt Bereichen und Stufen, damit die Oberfläche die
     * Tabellen der Stufen zeichnen kann. Keine Produktionsrechte nötig: es sind die eigenen.
     */
    async myTasks(tenantId, actor) {
        const itemIds = await this.plans.itemIdsForAssignee(tenantId, actor.id);
        const found = await Promise.all(itemIds.map(async (itemId) => {
            const [device, plan] = await Promise.all([this.directory.device(tenantId, itemId), this.plans.getPlan(tenantId, itemId)]);
            if (!device || !device.isActive || !plan)
                return null;
            /* Die GANZEN Stufen, in denen die Person an einer Unteraufgabe steht (30.09.2026: «employees
               should be able to see all tasks and subtasks of the stages they are assigned»). Handeln
               darf sie weiter nur an den eigenen — das prüfen die Wege je Unteraufgabe. */
            const stages = stagesOf(plan.tasks, actor.id);
            const tasks = plan.tasks.filter((task) => stages.has(stageKeyOf(task)));
            return tasks.length ? { device, plan, tasks } : null;
        }));
        const entries = found.filter((entry) => entry !== null);
        const people = await this.directory.people(tenantId, (0, productionTaskReadModel_1.assigneesOf)(entries.flatMap((entry) => entry.tasks)));
        const projects = new Map();
        for (const { device, plan, tasks } of entries) {
            const project = projects.get(device.productionProjectId) ?? {
                id: device.productionProjectId,
                projectNumber: device.projectNumber,
                projectName: device.projectName,
                devices: [],
            };
            project.devices.push({
                device: {
                    id: device.id,
                    projectId: device.productionProjectId,
                    name: device.name,
                    positionNumber: device.positionNumber,
                    projectNumber: device.projectNumber,
                    projectName: device.projectName,
                },
                plan: { templateName: plan.templateName, sections: plan.sections },
                tasks: tasks.map(productionTaskReadModel_1.taskDto),
            });
            projects.set(project.id, project);
        }
        const byText = (left, right) => left.localeCompare(right, 'tr', { numeric: true });
        return {
            projects: [...projects.values()]
                .map((project) => ({
                ...project,
                devices: project.devices.sort((left, right) => byText(left.device.positionNumber ?? '', right.device.positionNumber ?? '') || byText(left.device.name, right.device.name)),
            }))
                .sort((left, right) => byText(left.projectNumber, right.projectNumber)),
            people,
        };
    }
    /**
     * Eine Datei lesen — über «Görevlerim» (30.09.2026): wer in DERSELBEN STUFE des Geräts an einer
     * Unteraufgabe steht, öffnet auch die Dateien der anderen («they should be able to open the
     * files uploaded by other employees … but they can't delete or modify them»). Nur lesen.
     */
    async readSubtaskFileAsAssignee(tenantId, actor, itemId, taskId, subtaskId, fileId) {
        const plan = await this.plans.getPlan(tenantId, itemId);
        const task = plan?.tasks.find((entry) => entry.id === taskId);
        if (!plan || !task)
            throw (0, productionTasks_1.productionTaskError)('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        if (!stagesOf(plan.tasks, actor.id).has(stageKeyOf(task))) {
            throw (0, productionTasks_1.productionTaskError)('FILE_FORBIDDEN', 'Nur wer in dieser Stufe an einer Unteraufgabe steht.', { status: 403 });
        }
        return this.readSubtaskFile(tenantId, itemId, taskId, subtaskId, fileId);
    }
    /* ── intern ─────────────────────────────────────────────────────── */
    /**
     * Den Verlauf schreiben (30.09.2026). Die Handlung ist schon geschehen —
     * scheitert das Schreiben, bleibt sie gültig; nur die Zeile fehlt dann.
     */
    async log(entries) {
        if (!entries.length)
            return;
        try {
            await this.activities.record(entries);
        }
        catch (error) {
            console.warn('[production-tasks] Verlauf nicht geschrieben:', error instanceof Error ? error.message : error);
        }
    }
    /** Eine Anfrage öffnen (30.09.2026) — höchstens eine offene je Art und Unteraufgabe; scheitert still. */
    async openRequest(tenantId, itemId, actor, task, subtaskId, kind, note) {
        try {
            if (await this.requests.findOpen(tenantId, itemId, subtaskId, kind))
                return;
            const index = task.subtasks.findIndex((entry) => entry.id === subtaskId);
            const subtask = task.subtasks[index];
            if (!subtask)
                return;
            await this.requests.create({
                tenantId,
                productionItemId: itemId,
                area: task.area,
                stage: task.stage,
                taskId: task.id,
                taskCode: task.code,
                taskName: task.name,
                subtaskId,
                subtaskCode: `${task.code}.${index + 1}`,
                subtaskName: subtask.name,
                kind,
                note,
                requestedById: actor.id,
                requestedByName: actor.name,
            });
        }
        catch (error) {
            console.warn('[production-tasks] Anfrage nicht angelegt:', error instanceof Error ? error.message : error);
        }
    }
    /** Offene Anfragen erledigen, weil die passende Handlung geschah (30.09.2026) — scheitert still. */
    async closeRequests(tenantId, itemId, actor, subtaskId, kinds, resolution) {
        try {
            await this.requests.solveOpenFor(tenantId, itemId, subtaskId, kinds, { id: actor.id, name: actor.name }, resolution);
        }
        catch (error) {
            console.warn('[production-tasks] Anfrage nicht erledigt:', error instanceof Error ? error.message : error);
        }
    }
    /** Nachrichten an die Leute von Unteraufgaben (30.09.2026) — im Hintergrund; das Gerät für den Verweis. */
    async notifyChanged(tenantId, itemId, actor, notices) {
        if (!notices.length)
            return;
        const device = await this.directory.device(tenantId, itemId);
        if (device)
            void this.notifier.changed({ tenantId, device, actorId: actor.id, actorName: actor.name, notices });
    }
    /** Eine Zeile an einer Unteraufgabe — Kürzel und Namen aus der Antwort der Handlung. */
    logSubtask(tenantId, itemId, actor, kind, task, subtaskId, details) {
        const subtask = task.subtasks.find((entry) => entry.id === subtaskId);
        return subtask ? this.log([(0, productionTaskActivities_1.activityAt)(scopeOf(tenantId, itemId, actor), kind, task, subtask, details)]) : Promise.resolve();
    }
    /** Die Verwaltung oder wer an der Unteraufgabe steht — sonst FILE_FORBIDDEN (403). */
    async assertOnSubtask(tenantId, actor, isAdmin, itemId, taskId, subtaskId) {
        const task = await this.plans.getTask(tenantId, itemId, taskId);
        if (!task)
            throw (0, productionTasks_1.productionTaskError)('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        const subtask = task.subtasks.find((entry) => entry.id === subtaskId);
        if (!subtask)
            throw (0, productionTasks_1.productionTaskError)('SUBTASK_NOT_FOUND', 'Unteraufgabe nicht gefunden.', { status: 404 });
        if (!isAdmin && !(0, productionTasks_1.worksOnSubtask)(subtask, actor.id)) {
            throw (0, productionTasks_1.productionTaskError)('FILE_FORBIDDEN', 'Nur die Verwaltung und wer an der Unteraufgabe steht.', { status: 403 });
        }
    }
    found(task) {
        if (task === 'no-subtask')
            throw (0, productionTasks_1.productionTaskError)('SUBTASK_NOT_FOUND', 'Unteraufgabe nicht gefunden.', { status: 404 });
        if (!task)
            throw (0, productionTasks_1.productionTaskError)('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        return task;
    }
    /** Dateien, die der Plan nicht mehr hält, aus der Ablage nehmen (im Hintergrund). */
    dropFiles(before, after) {
        for (const ref of before) {
            if (!after.has(ref))
                void this.files.remove(ref).catch(() => undefined);
        }
    }
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