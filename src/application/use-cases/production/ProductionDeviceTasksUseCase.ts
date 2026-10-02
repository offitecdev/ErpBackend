import type {
    IProductionDeviceTaskRepository,
    IProductionTaskActivityLog,
    IProductionTaskDirectory,
    IProductionTaskRequestRepository,
    ProductionTaskNotice,
    IProductionTaskNotifier,
    IProductionTaskTemplateRepository,
} from '../../../domain/repositories/IProductionTaskRepository';
import type {
    ProductionDeviceTask,
    ProductionDeviceTaskPlan,
    ProductionFileAnalysis,
    ProductionSubtask,
    ProductionSubtaskFile,
    ProductionTaskActivity,
    ProductionTaskActivityDraft,
    ProductionTaskDevice,
    ProductionTaskRequest,
    ProductionTaskRequestKind,
    ProductionTaskRequestResolution,
    ProductionTaskPerson,
} from '../../../domain/entities/ProductionTask';
import {
    assigneeIdsFrom,
    assignmentNews,
    filesToAnalyse,
    fileVersionFor,
    hasDocumentStandards,
    hasSubtaskDocument,
    isAnalysisActive,
    isStandardsRefOf,
    isSubtaskPhotoType,
    photoGroupOf,
    STANDARDS_FILE_MAX_BYTES,
    SUBMISSION_NOTE_MAX,
    feeFrom,
    openPriorSteps,
    priorStepsError,
    subtaskAcceptsType,
    withFileAnalyses,
    isProductionTaskStatus,
    isWorkingStatus,
    newSubtaskFileId,
    SUBTASK_FILE_LIMITS,
    withActiveAssignees,
    withFileAnalysis,
    withoutDeviceRecord,
    withQueuedAnalyses,
    worksOnSubtask,
    orderTasks,
    reopenedSubtasks,
    tasksInputFrom,
    withAddedStage,
    withChecklistItem,
    withStageWeights,
    today,
    productionTaskError,
    templateCheck,
} from '../../../domain/services/productionTasks';
import {
    activityAt,
    assigneeChange,
    deviceActivity,
    fileDetails,
    loadedAssignments,
    planChangeActivities,
    planChangeNotices,
    subtaskNotice,
    subtaskStepKind,
    type ActivityScope,
} from '../../../domain/services/productionTaskActivities';
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

/**
 * Die KI-Prüfung eines PDFs gegen die Standards der Dokumente (01.10.2026) —
 * gpt-5.4-mini; die Antwort ist nur ein Rat für die Verwaltung.
 */
export interface ProductionDocumentReviewer {
    configured(): boolean;
    review(input: {
        /** Das PDF — null, wenn Fotos geprüft werden (02.10.2026). */
        pdf: Buffer | null;
        fileName: string;
        standards: string;
        /** Die Standards als PDF — dazu oder statt des Textes (01.10.2026). */
        standardsPdf?: { body: Buffer; name: string } | null;
        /** Fotos, die ZUSAMMEN geprüft werden (02.10.2026, «Fotoğraf yeterli») — höchstens zehn. */
        images?: Array<{ body: Buffer; type: string; name: string }>;
        /** Die kurze Notiz der Einsendung — auch sie ist ein Beleg (02.10.2026). */
        note?: string | null;
        taskName: string;
        subtaskName: string;
    }): Promise<Pick<ProductionFileAnalysis, 'verdict' | 'summary' | 'checks' | 'model'>>;
}

/** Höchstens so viele Prüfungen gleichzeitig (für alle Firmen) — der Rest wartet. */
const ANALYSIS_PARALLEL = 2;
let analysesRunning = 0;
const analysisQueue: Array<() => void> = [];
const inAnalysisSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (analysesRunning >= ANALYSIS_PARALLEL) await new Promise<void>((resolve) => analysisQueue.push(resolve));
    analysesRunning += 1;
    try {
        return await work();
    } finally {
        analysesRunning -= 1;
        analysisQueue.shift()?.();
    }
};

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

/** Eine Zeile des Verlaufs, wie die Oberfläche sie bekommt (30.09.2026). */
export interface ProductionTaskActivityDto {
    id: string;
    kind: ProductionTaskActivity['kind'];
    /** Zeitpunkt (ISO). */
    at: string;
    actorId: string | null;
    actorName: string | null;
    area: string | null;
    stage: string | null;
    taskId: string | null;
    taskCode: string | null;
    taskName: string | null;
    subtaskId: string | null;
    subtaskCode: string | null;
    subtaskName: string | null;
    details: Record<string, unknown> | null;
}

/** «Görevlerim» (30.09.2026): je Projekt die Geräte mit den eigenen Aufgaben. */
export interface MyProductionTasksDto {
    projects: Array<{
        id: string;
        projectNumber: string;
        projectName: string;
        devices: Array<{
            device: ProductionDeviceTasksDto['device'];
            plan: { templateName: string; sections: ProductionDeviceTaskPlan['sections'] };
            tasks: ProductionTaskDto[];
        }>;
    }>;
    people: ProductionTaskPerson[];
}

/** Eine Anfrage an die Verwaltung, wie die Oberfläche sie bekommt (30.09.2026). */
export interface ProductionTaskRequestDto {
    id: string;
    kind: ProductionTaskRequestKind;
    /** Bereich und Stufe — die Liste des ganzen Geräts nennt sie. */
    area: string;
    stage: string;
    taskId: string;
    taskCode: string;
    taskName: string;
    subtaskId: string;
    subtaskCode: string;
    subtaskName: string;
    note: string | null;
    requestedById: string | null;
    requestedByName: string | null;
    /** Zeitpunkte (ISO). */
    createdAt: string;
    solvedAt: string | null;
    solvedByName: string | null;
    resolution: ProductionTaskRequestResolution | null;
}

const requestDto = (row: ProductionTaskRequest): ProductionTaskRequestDto => ({
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
const ACTIVITY_KINDS: ReadonlySet<string> = new Set<ProductionTaskActivity['kind']>([
    'SUBTASK_STARTED', 'SUBTASK_STOPPED', 'SUBTASK_SUBMITTED', 'SUBTASK_DONE',
    'SUBTASK_APPROVED', 'REVISION_REQUESTED', 'SUBTASK_UNLOCKED', 'CHECKLIST_ITEM_ADDED',
    'FILE_UPLOADED', 'FILE_DELETED', 'SUBTASK_ASSIGNED',
    'TASK_CREATED', 'TASK_UPDATED', 'TASK_DELETED', 'TASK_MOVED', 'TASK_STATUS',
    'SUBTASK_CREATED', 'SUBTASK_UPDATED', 'SUBTASK_DELETED', 'STAGE_ADDED',
    'PLAN_LOADED', 'PLAN_REMOVED',
    // Ältere Tagesnotizen (02.10.2026, wieder abgeschafft) — «Çalışma».
    'DAILY_NOTE',
]);

const scopeOf = (tenantId: string, itemId: string, actor: ProductionTaskActor): ActivityScope => ({
    tenantId,
    productionItemId: itemId,
    actorId: actor.id,
    actorName: actor.name,
});

/** Die Stelle einer Aufgabe im Weg — Bereich und Stufe. */
const stageKeyOf = (task: { area: string; stage: string }): string => `${task.area}|${task.stage}`;

/** Die Stufen, in denen die Person an einer Unteraufgabe steht (30.09.2026). */
const stagesOf = (tasks: readonly ProductionDeviceTask[], employeeId: string): Set<string> =>
    new Set(tasks.filter((task) => task.subtasks.some((subtask) => worksOnSubtask(subtask, employeeId))).map(stageKeyOf));

/** Wer die erste (noch vorhandene) Fassung einer Datei hochgeladen hat. */
const originalUploaderOf = (files: readonly ProductionSubtaskFile[], groupId: string): string | null => {
    const versions = files.filter((file) => file.groupId === groupId).sort((left, right) => left.version - right.version);
    return versions[0]?.uploadedById ?? null;
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
        private readonly activities: IProductionTaskActivityLog,
        private readonly requests: IProductionTaskRequestRepository,
        private readonly reviewer: ProductionDocumentReviewer,
        /** Die Ablage der Standards als PDF (01.10.2026) — eigene Art, die Firma im Pfad. */
        private readonly standardsFiles: ProductionTaskFileStore,
    ) {}

    /**
     * Die Standards einer Unteraufgabe als PDF hochladen (01.10.2026) — nur die Verwaltung,
     * aus dem Fenster der Aufgabe (Gerät oder Vorlage). Gespeichert wird gleich; an die
     * Unteraufgabe kommt der Verweis erst mit dem Speichern der Aufgabe.
     */
    async uploadStandardsFile(
        tenantId: string,
        isAdmin: boolean,
        file: { body: Buffer; contentType: string; fileName: string } | null,
    ): Promise<{ file: { ref: string; name: string; size: number; uploadedAt: string } }> {
        if (!isAdmin) throw productionTaskError('STATUS_FORBIDDEN', 'Standards lädt nur die Verwaltung hoch.', { status: 403 });
        if (!file || !file.body?.length) throw productionTaskError('FILE_REQUIRED', 'Keine Datei empfangen.');
        const contentType = String(file.contentType || '').toLowerCase();
        if (!SUBTASK_FILE_TYPES.has(contentType) || !this.standardsFiles.accepts(contentType)) {
            throw productionTaskError('FILE_TYPE', 'Erlaubt sind nur PDF-Dateien.');
        }
        if (file.body.length > STANDARDS_FILE_MAX_BYTES) {
            throw productionTaskError('FILE_TOO_LARGE', 'Die Datei ist zu gross.', { status: 413, params: { max: 10 } });
        }
        const ref = await this.standardsFiles.store(tenantId, file.body, contentType);
        return { file: { ref, name: cleanFileName(file.fileName), size: file.body.length, uploadedAt: new Date().toISOString() } };
    }

    /** Das PDF der Standards lesen — nur aus der eigenen Firma. */
    async readStandardsFile(tenantId: string, ref: string, name: string): Promise<{ body: Buffer; contentType: string; fileName: string }> {
        if (!isStandardsRefOf(ref, tenantId)) {
            throw productionTaskError('STANDARDS_FILE_NOT_FOUND', 'Das PDF der Standards gibt es nicht.', { status: 404 });
        }
        const body = await this.standardsFiles.read(ref).catch(() => null);
        if (!body) throw productionTaskError('STANDARDS_FILE_NOT_FOUND', 'Das PDF der Standards gibt es nicht.', { status: 404 });
        return { body, contentType: 'application/pdf', fileName: cleanFileName(name || 'standards.pdf') };
    }

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

        const check = templateCheck(template.sections, template.tasks);
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
        const tasks = orderTasks(template.tasks, template.sections).map((task) => withActiveAssignees({
            area: task.area,
            stage: task.stage,
            code: task.code,
            name: task.name,
            weight: task.weight,
            assigneeIds: task.assigneeIds,
            startDate: task.startDate,
            dueDate: task.dueDate,
            // Am Gerät entsteht die Kopie heute — Aufgabe wie Unteraufgaben.
            createdAt: today(),
            // Am Gerät beginnt jede Unteraufgabe offen, ohne Dateien und Abschluss.
            subtasks: task.subtasks.map((subtask) => ({ ...withoutDeviceRecord(subtask), createdAt: today() })),
        }, active));

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
        // Der Verlauf: die geladene Vorlage — und wer aus ihr an welcher Unteraufgabe steht.
        const loadedPeople = await this.directory.people(tenantId, assigneesOf(plan.tasks));
        const loadedName = (id: string) => loadedPeople.find((person) => person.id === id)?.name ?? id;
        await this.log([
            deviceActivity(scopeOf(tenantId, itemId, actor), 'PLAN_LOADED', {
                templateName: template.name,
                previousTemplateName: existing?.templateName ?? null,
                taskCount: plan.tasks.length,
            }),
            ...loadedAssignments(scopeOf(tenantId, itemId, actor), plan.tasks, loadedName),
        ]);

        void this.notifier.assigned({
            tenantId,
            device,
            actorId: actor.id,
            actorName: actor.name,
            news: assignmentNews(existing?.tasks ?? [], plan.tasks),
        });
        // Ersetzt: die Aufgaben des alten Plans sind weg — ihre Leute erfahren es (30.09.2026).
        if (existing) {
            const gone = planChangeNotices(existing.tasks, []);
            if (gone.length) void this.notifier.changed({ tenantId, device, actorId: actor.id, actorName: actor.name, notices: gone });
        }
        return this.dto(tenantId, device, plan);
    }

    /**
     * Die Personen einer Unteraufgabe setzen (29.09.2026, nur Administratorrolle —
     * der Weg sichert es mit ADMIN): «they should only assign people to
     * subtasks». Die Aufgabe zeigt danach alle Personen ihrer Unteraufgaben.
     * Wer neu an der Unteraufgabe steht, bekommt eine Nachricht.
     */
    async assignSubtask(
        tenantId: string,
        actor: ProductionTaskActor,
        itemId: string,
        taskId: string,
        subtaskId: string,
        body: unknown,
    ): Promise<{ task: ProductionTaskDto; people: ProductionTaskPerson[] }> {
        const wanted = assigneeIdsFrom(objectOf(body).assigneeIds);
        const [device, active] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.directory.activePeople(tenantId, wanted),
        ]);
        if (!device) throw this.deviceNotFound();
        const kept = wanted.filter((id) => active.has(id));

        let previous: string[] = [];
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            previous = subtask.assigneeIds;
            return { ...subtask, assigneeIds: kept };
        }, actor.id));

        const before = {
            code: task.code,
            subtasks: task.subtasks.map((subtask) => (subtask.id === subtaskId ? { ...subtask, assigneeIds: previous } : subtask)),
        };
        const news = assignmentNews([before], [task]);
        if (news.size) {
            void this.notifier.assigned({ tenantId, device, actorId: actor.id, actorName: actor.name, news });
        }
        // Die Namen auch derer, die gingen — der Verlauf nennt sie.
        const named = await this.directory.people(tenantId, [...new Set([...task.assigneeIds, ...previous])]);
        const change = assigneeChange(previous, kept, (id) => named.find((person) => person.id === id)?.name ?? id);
        const subtask = task.subtasks.find((entry) => entry.id === subtaskId) ?? null;
        if (change && subtask) {
            await this.log([activityAt(scopeOf(tenantId, itemId, actor), 'SUBTASK_ASSIGNED', task, subtask, change)]);
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
        return { task: taskDto(task), people };
    }

    /**
     * Die Aufgaben des Geräts anpassen (28.09.2026, nur Administratorrolle):
     * «admin should be able to customize the tasks and subtasks — it shouldn't
     * change the template, only the version that the project uses». Name,
     * Gewicht, Tage und Unteraufgaben samt ihren Personen; neue Aufgaben in
     * einer Stufe, entfernte fallen weg. Wer neu an einer Unteraufgabe steht,
     * bekommt eine Nachricht.
     */
    async updateTasks(tenantId: string, actor: ProductionTaskActor, itemId: string, body: unknown): Promise<ProductionDeviceTasksDto> {
        const [device, existing] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.plans.getPlan(tenantId, itemId),
        ]);
        if (!device) throw this.deviceNotFound();
        if (!existing) throw productionTaskError('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });

        // Die Gewichte der Stufen (30.09.2026) kommen mit `sections`; ohne sie bleiben sie, wie sie sind.
        const sections = withStageWeights(existing.sections, objectOf(body).sections);
        const input = tasksInputFrom(objectOf(body).tasks, sections, true);
        const active = await this.directory.activePeople(tenantId, assigneesOf(input));
        const tasks = orderTasks(input, sections).map((task) => withActiveAssignees(task, active));

        const plan = await this.plans.replaceTasks(tenantId, itemId, tasks, actor.id, sections);
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
        // Der Verlauf: was angelegt, geändert, verschoben, gelöscht und wem zugewiesen wurde.
        const named = await this.directory.people(tenantId, [...new Set([...assigneesOf(existing.tasks), ...assigneesOf(plan.tasks)])]);
        const nameOf = (id: string) => named.find((person) => person.id === id)?.name ?? id;
        await this.log(planChangeActivities(scopeOf(tenantId, itemId, actor), existing.tasks, plan.tasks, nameOf));
        // Entfernt, gelöscht, geändert — die Leute der Unteraufgaben erfahren es (30.09.2026).
        // Wieder geöffnete Unteraufgaben haben schon ihre Nachricht «neu prüfen» — keine zweite.
        const reopenedCodes = new Set(reopened.map((entry) => entry.code));
        const notices = planChangeNotices(existing.tasks, plan.tasks)
            .filter((notice) => !(notice.kind === 'UPDATED' && reopenedCodes.has(notice.code)));
        if (notices.length) void this.notifier.changed({ tenantId, device, actorId: actor.id, actorName: actor.name, notices });
        return this.dto(tenantId, device, plan);
    }

    /**
     * Eine neue Stufe in einem Bereich der Kopie am Gerät (28.09.2026, nur Administratorrolle —
     * der Weg sichert es mit ADMIN): nur solange die Aufgaben des Bereichs unter 100 % wiegen.
     * Die Vorlage bleibt, wie sie ist; Aufgaben, Stände und Dateien bleiben unberührt.
     */
    async addStage(tenantId: string, actor: ProductionTaskActor, itemId: string, body: unknown): Promise<ProductionDeviceTasksDto> {
        const input = objectOf(body);
        const [device, existing] = await Promise.all([
            this.directory.device(tenantId, itemId),
            this.plans.getPlan(tenantId, itemId),
        ]);
        if (!device) throw this.deviceNotFound();
        if (!existing) throw productionTaskError('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        const sections = withAddedStage(existing.sections, input.area, input.name);
        const plan = await this.plans.setSections(tenantId, itemId, sections);
        if (!plan) throw productionTaskError('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        // Die neue Stufe: die, die vorher im Bereich nicht war.
        const known = new Set(existing.sections.flatMap((section) => section.stages.map((stage) => `${section.key}|${stage.key}`)));
        const added = plan.sections.flatMap((section) => section.stages
            .filter((stage) => !known.has(`${section.key}|${stage.key}`))
            .map((stage) => ({ area: section.key, stage: stage.key, name: stage.name })));
        await this.log(added.map((entry) => ({
            ...deviceActivity(scopeOf(tenantId, itemId, actor), 'STAGE_ADDED', { name: entry.name }),
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
    async setStatus(
        tenantId: string,
        actor: ProductionTaskActor,
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
        if (!current.assigneeIds.includes(actor.id)) {
            throw productionTaskError('STATUS_FORBIDDEN', 'Den Stand setzt nur, wer in der Aufgabe steht.', { status: 403 });
        }
        // Mit Unteraufgaben folgt die Aufgabe ihnen — ihren Stand setzt niemand direkt (28.09.2026).
        if (current.subtasks.length > 0) {
            throw productionTaskError('STATUS_FLOW', 'Der Stand dieser Aufgabe folgt ihren Unteraufgaben.', { status: 409 });
        }
        const task = await this.plans.setStatus(tenantId, itemId, taskId, status, actor.id);
        if (!task) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        if (current.status !== status) {
            await this.log([activityAt(scopeOf(tenantId, itemId, actor), 'TASK_STATUS', task, null, { from: current.status, to: status })]);
        }
        return { task: taskDto(task) };
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
    async setSubtaskStatus(
        tenantId: string,
        actor: ProductionTaskActor,
        itemId: string,
        taskId: string,
        subtaskId: string,
        body: unknown,
    ): Promise<{ task: ProductionTaskDto }> {
        const input = objectOf(body);
        const status = input.status;
        if (!isProductionTaskStatus(status)) {
            throw productionTaskError('STATUS_INVALID', 'Unbekannter Stand.');
        }
        /* Die kurze Notiz beim Einsenden («Görevi tamamla», 02.10.2026) — Messwerte, Nakliye-Preis;
           die KI liest sie mit. Nur beim Fertigmelden; ohne Feld bleibt die Notiz von vorher. */
        const noteGiven = typeof input.note === 'string';
        const sentNote = noteGiven ? String(input.note).replace(/\r\n?/g, '\n').trim().slice(0, SUBMISSION_NOTE_MAX) || null : null;
        /* Der Betrag beim Einsenden («Ücret girilsin», 02.10.2026, OCC-Standard S. 7) — ohne Feld
           bleibt der von vorher. */
        const feeGiven = input.fee !== undefined;
        const sentFee = feeGiven ? feeFrom(input.fee) : null;
        if (sentFee === undefined) throw productionTaskError('FEE_INVALID', 'Der Betrag ist ungültig.');
        // «Sistem kilidi» (02.10.2026): fertig melden erst, wenn die Schritte davor erledigt sind.
        if (status === 'PENDING' || status === 'DONE') await this.assertPriorStepsDone(tenantId, itemId, taskId, subtaskId);
        let fee: number | null = null;
        let from: ProductionSubtask['status'] = status;
        // Zur Freigabe geschickt (01.10.2026): die PDFs warten auf die KI-Prüfung gegen die Standards.
        let queued: string[] = [];
        const requestedAt = new Date().toISOString();
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!worksOnSubtask(subtask, actor.id)) {
                throw productionTaskError('STATUS_FORBIDDEN', 'Den Stand setzt nur, wer an der Unteraufgabe steht.', { status: 403 });
            }
            from = subtask.status;
            const changed = subtaskStatusChange(subtask, status);
            const sending = (status === 'PENDING' || status === 'DONE') && from !== status;
            let next = sending && noteGiven ? { ...changed, submissionNote: sentNote } : changed;
            // «Ücret girilsin»: ohne Betrag kein Einsenden — der neue oder der von vorher.
            if (sending && subtask.feeRequired) {
                fee = feeGiven ? sentFee : subtask.fee;
                if (fee === null) throw productionTaskError('FEE_REQUIRED', 'Bitte den Betrag (CHF) eingeben.', { status: 409 });
                next = { ...next, fee };
            }
            if (status !== 'PENDING' || from === 'PENDING') return next;
            queued = filesToAnalyse(next);
            return withQueuedAnalyses(next, queued, requestedAt);
        }, actor.id));
        const kind = subtaskStepKind(from, status);
        const sent = kind === 'SUBTASK_SUBMITTED' || kind === 'SUBTASK_DONE';
        const withNote = sentNote && sent ? { note: sentNote } : {};
        const withFee = fee !== null && sent ? { fee } : {};
        if (kind) await this.logSubtask(tenantId, itemId, actor, kind, task, subtaskId, { from, to: status, ...withNote, ...withFee });
        // Zur Freigabe geschickt: eine Anfrage an die Verwaltung (30.09.2026) — höchstens eine offene.
        if (kind === 'SUBTASK_SUBMITTED') await this.openRequest(tenantId, itemId, actor, task, subtaskId, 'APPROVAL', sentNote);
        this.startAnalyses(tenantId, itemId, taskId, subtaskId, queued, requestedAt, actor.id);
        return { task: taskDto(task) };
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
        let checklist: string[] = [];
        let fileIds: string[] = [];
        // «Sistem kilidi» (02.10.2026): freigeben erst, wenn die Schritte davor erledigt sind.
        await this.assertPriorStepsDone(tenantId, itemId, taskId, subtaskId);
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
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
            if (subtask.feeRequired && subtask.fee === null) {
                throw productionTaskError('FEE_REQUIRED', 'Ohne Betrag (CHF) schliesst sie nicht ab.', { status: 409 });
            }
            // Jeder Punkt der Checkliste muss abgehakt sein (28.09.2026) — sonst keine Freigabe.
            if (subtask.approvalChecklist.some((item) => !checked.has(item.id))) {
                throw productionTaskError('CHECKLIST_INCOMPLETE', 'Erst alle Punkte der Freigabe-Checkliste abhaken.', { status: 409 });
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
        await this.notifyChanged(tenantId, itemId, actor, subtaskNotice('APPROVED', task, subtaskId, note || null));
        await this.closeRequests(tenantId, itemId, actor, subtaskId, ['APPROVAL'], 'APPROVED');
        return { task: taskDto(task) };
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
        let text = '';
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!subtask.requiresApproval) {
                throw productionTaskError('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
            }
            if (isCompleted(subtask)) {
                throw productionTaskError('SUBTASK_LOCKED', 'Freigegeben und gesperrt — erst die Sperre aufheben.', { status: 409 });
            }
            const next = withChecklistItem(subtask, rawText);
            text = next.approvalChecklist[next.approvalChecklist.length - 1]?.text ?? '';
            return next;
        }, actor.id));
        await this.logSubtask(tenantId, itemId, actor, 'CHECKLIST_ITEM_ADDED', task, subtaskId, { text });
        await this.notifyChanged(tenantId, itemId, actor, subtaskNotice('UPDATED', task, subtaskId));
        return { task: taskDto(task) };
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
        let from: ProductionSubtask['status'] = 'PENDING';
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!isCompleted(subtask) && subtask.status !== 'PENDING') {
                throw productionTaskError('NOT_LOCKED', 'Nicht gesperrt.', { status: 409 });
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
        await this.notifyChanged(tenantId, itemId, actor, subtaskNotice('UNLOCKED', task, subtaskId));
        // Entsperrt: die Bitte darum ist erledigt — und eine wartende Freigabe auch (sie ist wieder in Arbeit).
        await this.closeRequests(tenantId, itemId, actor, subtaskId, ['UNLOCK', 'APPROVAL'], 'UNLOCKED');
        return { task: taskDto(task) };
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
        let fileIds: string[] = [];
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!subtask.requiresApproval) {
                throw productionTaskError('NOT_APPROVABLE', 'Diese Unteraufgabe braucht keine Freigabe.', { status: 409 });
            }
            if (isCompleted(subtask)) throw productionTaskError('ALREADY_COMPLETED', 'Schon abgeschlossen.', { status: 409 });
            fileIds = subtask.files.map((file) => file.id);
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
        }, actor.id));
        // Die Dateien, die beim Zurückgeben vorlagen — der Klick zeigt, worauf die Notiz sich bezieht.
        await this.logSubtask(tenantId, itemId, actor, 'REVISION_REQUESTED', task, subtaskId, { note: note || null, fileIds });
        await this.notifyChanged(tenantId, itemId, actor, subtaskNotice('REVISION', task, subtaskId, note || null));
        await this.closeRequests(tenantId, itemId, actor, subtaskId, ['APPROVAL'], 'REVISION');
        return { task: taskDto(task) };
    }

    /**
     * Eine Datei an eine Unteraufgabe (28.09.2026) — die Verwaltung und wer
     * an der Unteraufgabe steht; an eine freigegebene (gesperrte) niemand.
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
        const target = await this.assertOnSubtask(tenantId, actor, isAdmin, itemId, taskId, subtaskId);
        const revisionNote = typeof rawRevisionNote === 'string' ? rawRevisionNote.replace(/\r\n/g, '\n').trim().slice(0, 500) : '';
        if (revisionOf && !revisionNote) {
            throw productionTaskError('REVISION_NOTE_REQUIRED', 'Zu einer neuen Fassung gehört eine Notiz, was sich geändert hat.');
        }
        if (!file || !file.body?.length) throw productionTaskError('FILE_REQUIRED', 'Keine Datei empfangen.');
        const contentType = String(file.contentType || '').toLowerCase();
        // PDF wie bisher; mit «Fotoğraf yeterli» auch JPEG, PNG, WebP (02.10.2026).
        const wrongType = () => productionTaskError('FILE_TYPE', target.photoAllowed ? 'Erlaubt sind PDF und Fotos (JPEG, PNG, WebP).' : 'Erlaubt sind nur PDF-Dateien.');
        if (!subtaskAcceptsType(target, contentType) || !this.files.accepts(contentType)) throw wrongType();
        if (file.body.length > SUBTASK_FILE_LIMITS.bytes) {
            throw productionTaskError('FILE_TOO_LARGE', 'Die Datei ist zu gross.', { status: 413, params: { max: 25 } });
        }
        const ref = await this.files.store(tenantId, file.body, contentType);
        let added: ProductionSubtaskFile | null = null;
        let task: ProductionDeviceTask;
        try {
            task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
                // Gesperrt heisst für ALLE gesperrt (28.09.2026) — auch solange sie auf die Freigabe wartet.
                assertFilesOpen(subtask);
                // «Fotoğraf yeterli» kann inzwischen weg sein — dann kein Foto mehr.
                if (!subtaskAcceptsType(subtask, contentType)) throw wrongType();
                if (subtask.files.length >= SUBTASK_FILE_LIMITS.files) {
                    throw productionTaskError('FILES_TOO_MANY', 'Zu viele Dateien.', { status: 409, params: { max: SUBTASK_FILE_LIMITS.files } });
                }
                const id = newSubtaskFileId();
                // Neue Datei oder nächste Fassung einer vorhandenen (dieselbe groupId).
                const { groupId, version } = fileVersionFor(subtask.files, id, revisionOf);
                /* Eine neue Fassung der Datei eines anderen ist eine Änderung an ihr (30.09.2026: «they
                   can't delete or modify them») — ausser der Verwaltung nur, wer die Datei hochgeladen hat. */
                if (revisionOf && !isAdmin && originalUploaderOf(subtask.files, groupId) !== actor.id) {
                    throw productionTaskError('FILE_FORBIDDEN', 'Eine neue Fassung lädt nur hoch, wer die Datei hochgeladen hat.', { status: 403 });
                }
                const entry: ProductionSubtaskFile = {
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
                    // Geprüft wird beim Schicken zur Freigabe (01.10.2026).
                    analysis: null,
                };
                added = entry;
                return { ...subtask, files: [...subtask.files, entry] };
            }, actor.id));
        } catch (error) {
            await this.files.remove(ref).catch(() => undefined);
            throw error;
        }
        const stored = added as ProductionSubtaskFile | null;
        if (stored) await this.logSubtask(tenantId, itemId, actor, 'FILE_UPLOADED', task, subtaskId, fileDetails(stored));
        return { task: taskDto(task) };
    }

    /**
     * Die KI-Prüfung eines PDFs noch einmal (01.10.2026) — nur die Verwaltung, aus dem
     * Bericht: wenn sie scheiterte, oder für eine Fassung, die nie geprüft wurde.
     */
    async retryFileAnalysis(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        subtaskId: string,
        fileId: string,
    ): Promise<{ task: ProductionTaskDto }> {
        if (!isAdmin) throw productionTaskError('STATUS_FORBIDDEN', 'Die KI-Prüfung startet nur die Verwaltung.', { status: 403 });
        const requestedAt = new Date().toISOString();
        let queued: string[] = [fileId];
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            if (!hasDocumentStandards(subtask)) {
                throw productionTaskError('NO_STANDARDS', 'Diese Unteraufgabe hat keine Standards für Dokumente.', { status: 409 });
            }
            const file = subtask.files.find((entry) => entry.id === fileId);
            if (!file) throw productionTaskError('FILE_NOT_FOUND', 'Datei nicht gefunden.', { status: 404 });
            // Ein Foto (nur mit «Fotoğraf yeterli», 02.10.2026) prüft seine ganze Gruppe noch einmal.
            const photo = subtask.photoAllowed && isSubtaskPhotoType(file.type);
            if (file.type !== 'application/pdf' && !photo) throw productionTaskError('FILE_TYPE', 'Geprüft werden nur PDF-Dateien.');
            queued = photo ? photoGroupOf(subtask) : [fileId];
            if (!queued.length) queued = [fileId];
            if (queued.some((id) => isAnalysisActive(subtask.files.find((entry) => entry.id === id)?.analysis ?? null))) {
                throw productionTaskError('ANALYSIS_RUNNING', 'Die Prüfung läuft schon.', { status: 409 });
            }
            return withQueuedAnalyses(subtask, queued, requestedAt);
        }, actor.id));
        this.startAnalyses(tenantId, itemId, taskId, subtaskId, queued, requestedAt, actor.id);
        return { task: taskDto(task) };
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
     * und noch an der Unteraufgabe steht, solange sie offen ist.
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
        await this.assertOnSubtask(tenantId, actor, isAdmin, itemId, taskId, subtaskId);
        let removed: ProductionSubtaskFile | null = null;
        const task = this.found(await this.plans.changeSubtask(tenantId, itemId, taskId, subtaskId, (subtask) => {
            const file = subtask.files.find((entry) => entry.id === fileId);
            if (!file) throw productionTaskError('FILE_NOT_FOUND', 'Datei nicht gefunden.', { status: 404 });
            assertFilesOpen(subtask);
            if (!isAdmin && file.uploadedById !== actor.id) {
                throw productionTaskError('FILE_FORBIDDEN', 'Diese Datei entfernt nur die Verwaltung.', { status: 403 });
            }
            removed = file;
            return { ...subtask, files: subtask.files.filter((entry) => entry.id !== fileId) };
        }, actor.id));
        const gone = removed as ProductionSubtaskFile | null;
        if (gone) {
            await this.files.remove(gone.ref).catch(() => undefined);
            await this.logSubtask(tenantId, itemId, actor, 'FILE_DELETED', task, subtaskId, fileDetails(gone));
        }
        return { task: taskDto(task) };
    }

    async unload(tenantId: string, actor: ProductionTaskActor, itemId: string): Promise<{ deleted: true }> {
        const existing = await this.plans.getPlan(tenantId, itemId);
        if (!(await this.plans.deletePlan(tenantId, itemId))) {
            throw productionTaskError('PLAN_NOT_FOUND', 'Auf diesem Gerät liegen keine Aufgaben.', { status: 404 });
        }
        if (existing) this.dropFiles(fileRefsOf(existing.tasks), new Set());
        await this.log([deviceActivity(scopeOf(tenantId, itemId, actor), 'PLAN_REMOVED', {
            templateName: existing?.templateName ?? null,
            taskCount: existing?.tasks.length ?? 0,
        })]);
        // Die Aufgaben sind weg — wer an ihnen stand, erfährt es (30.09.2026).
        if (existing) await this.notifyChanged(tenantId, itemId, actor, planChangeNotices(existing.tasks, []));
        return { deleted: true };
    }

    /**
     * Der Verlauf einer Stufe (30.09.2026): wer was wann tat, neueste zuerst,
     * samt den Handlungen am ganzen Gerät — seitenweise (`page`, `pageSize`),
     * gefiltert nach Arten (`kinds`, durch Komma getrennt), Person (`actorId`)
     * und Zeitraum (`from` einschliesslich, `to` ausschliesslich, je ISO).
     */
    async listActivities(
        tenantId: string,
        itemId: string,
        query: Record<string, unknown>,
    ): Promise<{
        items: ProductionTaskActivityDto[];
        total: number;
        page: number;
        pageSize: number;
        actors: Array<{ id: string; name: string }>;
    }> {
        const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
        // Ohne Bereich und Stufe: der Verlauf des ganzen Geräts (30.09.2026, Startseite der Verwaltung).
        const area = text(query.area);
        const stage = text(query.stage);
        if (Boolean(area) !== Boolean(stage)) throw productionTaskError('STAGE_REQUIRED', 'Bereich und Stufe fehlen.');
        const place = area && stage ? { area, stage } : null;
        const whole = (value: unknown, fallback: number, max: number) => {
            const number = Math.floor(Number(value));
            return Number.isFinite(number) && number > 0 ? Math.min(max, number) : fallback;
        };
        const pageSize = whole(query.pageSize, ACTIVITY_PAGE, ACTIVITY_PAGE_MAX);
        const page = whole(query.page, 1, 100_000);
        const instant = (value: unknown) => {
            const date = text(value) ? new Date(text(value)) : null;
            return date && !Number.isNaN(date.getTime()) ? date : null;
        };
        // Nur bekannte Arten; eine leere Auswahl heisst «alle».
        const kinds = text(query.kinds).split(',').map((kind) => kind.trim()).filter((kind) => ACTIVITY_KINDS.has(kind));

        const device = await this.directory.device(tenantId, itemId);
        if (!device) throw this.deviceNotFound();
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
    async requestUnlock(
        tenantId: string,
        actor: ProductionTaskActor,
        itemId: string,
        taskId: string,
        subtaskId: string,
        body: unknown,
    ): Promise<{ request: ProductionTaskRequestDto }> {
        const rawNote = objectOf(body).note;
        const note = typeof rawNote === 'string' ? rawNote.replace(/\r\n/g, '\n').trim().slice(0, 500) : '';
        const task = await this.plans.getTask(tenantId, itemId, taskId);
        if (!task) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        const subtask = task.subtasks.find((entry) => entry.id === subtaskId);
        if (!subtask) throw productionTaskError('SUBTASK_NOT_FOUND', 'Unteraufgabe nicht gefunden.', { status: 404 });
        if (!worksOnSubtask(subtask, actor.id)) {
            throw productionTaskError('STATUS_FORBIDDEN', 'Um das Entsperren bittet nur, wer an der Unteraufgabe steht.', { status: 403 });
        }
        if (!isCompleted(subtask) && subtask.status !== 'PENDING') {
            throw productionTaskError('NOT_LOCKED', 'Nicht gesperrt.', { status: 409 });
        }
        if (await this.requests.findOpen(tenantId, itemId, subtaskId, 'UNLOCK')) {
            throw productionTaskError('UNLOCK_ALREADY_REQUESTED', 'Um das Entsperren wurde schon gebeten.', { status: 409 });
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
    async listRequests(
        tenantId: string,
        itemId: string,
        query: Record<string, unknown>,
    ): Promise<{ items: ProductionTaskRequestDto[]; openCount: number }> {
        const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
        // Ohne Bereich und Stufe: die Anfragen des ganzen Geräts (30.09.2026, Startseite der Verwaltung).
        const area = text(query.area);
        const stage = text(query.stage);
        if (Boolean(area) !== Boolean(stage)) throw productionTaskError('STAGE_REQUIRED', 'Bereich und Stufe fehlen.');
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
    async taskDevices(tenantId: string): Promise<{
        projects: Array<{
            id: string;
            projectNumber: string;
            projectName: string;
            openRequests: number;
            devices: Array<{ id: string; name: string; positionNumber: string | null; templateName: string; taskCount: number; openRequests: number }>;
        }>;
    }> {
        const [rows, open] = await Promise.all([this.directory.taskDevices(tenantId), this.requests.openByDevice(tenantId)]);
        const projects = new Map<string, { id: string; projectNumber: string; projectName: string; openRequests: number; devices: Array<{ id: string; name: string; positionNumber: string | null; templateName: string; taskCount: number; openRequests: number }> }>();
        for (const row of rows) {
            const project = projects.get(row.projectId) ?? { id: row.projectId, projectNumber: row.projectNumber, projectName: row.projectName, openRequests: 0, devices: [] };
            const openRequests = open.get(row.deviceId) ?? 0;
            project.devices.push({ id: row.deviceId, name: row.deviceName, positionNumber: row.positionNumber, templateName: row.templateName, taskCount: row.taskCount, openRequests });
            project.openRequests += openRequests;
            projects.set(row.projectId, project);
        }
        const byText = (left: string, right: string) => left.localeCompare(right, 'tr', { numeric: true });
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
    async solveRequest(tenantId: string, actor: ProductionTaskActor, itemId: string, requestId: string): Promise<{ request: ProductionTaskRequestDto }> {
        const solved = await this.requests.solve(tenantId, itemId, requestId, { id: actor.id, name: actor.name }, 'MANUAL');
        if (!solved) throw productionTaskError('REQUEST_NOT_FOUND', 'Anfrage nicht gefunden oder schon erledigt.', { status: 404 });
        await this.log([{
            ...deviceActivity(scopeOf(tenantId, itemId, actor), 'REQUEST_SOLVED', {
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
    async myTasks(tenantId: string, actor: ProductionTaskActor): Promise<MyProductionTasksDto> {
        const itemIds = await this.plans.itemIdsForAssignee(tenantId, actor.id);
        const found = await Promise.all(itemIds.map(async (itemId) => {
            const [device, plan] = await Promise.all([this.directory.device(tenantId, itemId), this.plans.getPlan(tenantId, itemId)]);
            if (!device || !device.isActive || !plan) return null;
            /* Die GANZEN Stufen, in denen die Person an einer Unteraufgabe steht (30.09.2026: «employees
               should be able to see all tasks and subtasks of the stages they are assigned»). Handeln
               darf sie weiter nur an den eigenen — das prüfen die Wege je Unteraufgabe. */
            const stages = stagesOf(plan.tasks, actor.id);
            const tasks = plan.tasks.filter((task) => stages.has(stageKeyOf(task)));
            return tasks.length ? { device, plan, tasks } : null;
        }));
        const entries = found.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        const people = await this.directory.people(tenantId, assigneesOf(entries.flatMap((entry) => entry.tasks)));

        const projects = new Map<string, MyProductionTasksDto['projects'][number]>();
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
                tasks: tasks.map(taskDto),
            });
            projects.set(project.id, project);
        }
        const byText = (left: string, right: string) => left.localeCompare(right, 'tr', { numeric: true });
        return {
            projects: [...projects.values()]
                .map((project) => ({
                    ...project,
                    devices: project.devices.sort((left, right) =>
                        byText(left.device.positionNumber ?? '', right.device.positionNumber ?? '') || byText(left.device.name, right.device.name)),
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
    async readSubtaskFileAsAssignee(
        tenantId: string,
        actor: ProductionTaskActor,
        itemId: string,
        taskId: string,
        subtaskId: string,
        fileId: string,
    ): Promise<{ body: Buffer; contentType: string; fileName: string }> {
        const plan = await this.plans.getPlan(tenantId, itemId);
        const task = plan?.tasks.find((entry) => entry.id === taskId);
        if (!plan || !task) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        if (!stagesOf(plan.tasks, actor.id).has(stageKeyOf(task))) {
            throw productionTaskError('FILE_FORBIDDEN', 'Nur wer in dieser Stufe an einer Unteraufgabe steht.', { status: 403 });
        }
        return this.readSubtaskFile(tenantId, itemId, taskId, subtaskId, fileId);
    }

    /* ── intern ─────────────────────────────────────────────────────── */

    /**
     * Den Verlauf schreiben (30.09.2026). Die Handlung ist schon geschehen —
     * scheitert das Schreiben, bleibt sie gültig; nur die Zeile fehlt dann.
     */
    private async log(entries: ProductionTaskActivityDraft[]): Promise<void> {
        if (!entries.length) return;
        try {
            await this.activities.record(entries);
        } catch (error) {
            console.warn('[production-tasks] Verlauf nicht geschrieben:', error instanceof Error ? error.message : error);
        }
    }

    /**
     * «Sistem kilidi» (02.10.2026, OCC-Standard S. 7): trägt die Unteraufgabe «Kilit», muss alles
     * davor erledigt sein — sonst ein Fehler mit den offenen Schritten. Ohne «Kilit» nichts.
     */
    private async assertPriorStepsDone(tenantId: string, itemId: string, taskId: string, subtaskId: string): Promise<void> {
        const current = await this.plans.getTask(tenantId, itemId, taskId);
        if (!current?.subtasks.find((entry) => entry.id === subtaskId)?.priorStepsRequired) return;
        const plan = await this.plans.getPlan(tenantId, itemId);
        if (!plan) return;
        const open = openPriorSteps(plan.sections, plan.tasks, taskId, subtaskId);
        if (open.length) throw priorStepsError(open);
    }

    /** Eine Anfrage öffnen (30.09.2026) — höchstens eine offene je Art und Unteraufgabe; scheitert still. */
    private async openRequest(
        tenantId: string,
        itemId: string,
        actor: ProductionTaskActor,
        task: ProductionDeviceTask,
        subtaskId: string,
        kind: ProductionTaskRequestKind,
        note: string | null,
    ): Promise<void> {
        try {
            if (await this.requests.findOpen(tenantId, itemId, subtaskId, kind)) return;
            const index = task.subtasks.findIndex((entry) => entry.id === subtaskId);
            const subtask = task.subtasks[index];
            if (!subtask) return;
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
        } catch (error) {
            console.warn('[production-tasks] Anfrage nicht angelegt:', error instanceof Error ? error.message : error);
        }
    }

    /** Offene Anfragen erledigen, weil die passende Handlung geschah (30.09.2026) — scheitert still. */
    private async closeRequests(
        tenantId: string,
        itemId: string,
        actor: ProductionTaskActor,
        subtaskId: string,
        kinds: readonly ProductionTaskRequestKind[],
        resolution: ProductionTaskRequestResolution,
    ): Promise<void> {
        try {
            await this.requests.solveOpenFor(tenantId, itemId, subtaskId, kinds, { id: actor.id, name: actor.name }, resolution);
        } catch (error) {
            console.warn('[production-tasks] Anfrage nicht erledigt:', error instanceof Error ? error.message : error);
        }
    }

    /** Nachrichten an die Leute von Unteraufgaben (30.09.2026) — im Hintergrund; das Gerät für den Verweis. */
    private async notifyChanged(tenantId: string, itemId: string, actor: ProductionTaskActor, notices: ProductionTaskNotice[]): Promise<void> {
        if (!notices.length) return;
        const device = await this.directory.device(tenantId, itemId);
        if (device) void this.notifier.changed({ tenantId, device, actorId: actor.id, actorName: actor.name, notices });
    }

    /** Eine Zeile an einer Unteraufgabe — Kürzel und Namen aus der Antwort der Handlung. */
    private logSubtask(
        tenantId: string,
        itemId: string,
        actor: ProductionTaskActor,
        kind: ProductionTaskActivityDraft['kind'],
        task: ProductionDeviceTask,
        subtaskId: string,
        details: Record<string, unknown>,
    ): Promise<void> {
        const subtask = task.subtasks.find((entry) => entry.id === subtaskId);
        return subtask ? this.log([activityAt(scopeOf(tenantId, itemId, actor), kind, task, subtask, details)]) : Promise.resolve();
    }

    /** Die Verwaltung oder wer an der Unteraufgabe steht — sonst FILE_FORBIDDEN (403). Gibt die Unteraufgabe zurück. */
    private async assertOnSubtask(
        tenantId: string,
        actor: ProductionTaskActor,
        isAdmin: boolean,
        itemId: string,
        taskId: string,
        subtaskId: string,
    ): Promise<ProductionSubtask> {
        const task = await this.plans.getTask(tenantId, itemId, taskId);
        if (!task) throw productionTaskError('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { status: 404 });
        const subtask = task.subtasks.find((entry) => entry.id === subtaskId);
        if (!subtask) throw productionTaskError('SUBTASK_NOT_FOUND', 'Unteraufgabe nicht gefunden.', { status: 404 });
        if (!isAdmin && !worksOnSubtask(subtask, actor.id)) {
            throw productionTaskError('FILE_FORBIDDEN', 'Nur die Verwaltung und wer an der Unteraufgabe steht.', { status: 403 });
        }
        return subtask;
    }

    /**
     * Die KI-Prüfung der Dateien im Hintergrund (01.10.2026) — die Antwort an die
     * Oberfläche wartet nicht darauf; sie fragt nach, solange eine Prüfung läuft.
     * Eine Datei nach der anderen, höchstens zwei Prüfungen gleichzeitig.
     */
    private startAnalyses(
        tenantId: string,
        itemId: string,
        taskId: string,
        subtaskId: string,
        fileIds: readonly string[],
        requestedAt: string,
        actorId: string,
    ): void {
        if (!fileIds.length) return;
        void (async () => {
            // Die Fotos gehen ZUSAMMEN in eine Prüfung (02.10.2026), jedes PDF für sich.
            const task = await this.plans.getTask(tenantId, itemId, taskId).catch(() => null);
            const files = task?.subtasks.find((entry) => entry.id === subtaskId)?.files ?? [];
            const photos = fileIds.filter((id) => isSubtaskPhotoType(files.find((file) => file.id === id)?.type ?? ''));
            for (const fileId of fileIds.filter((id) => !photos.includes(id))) {
                await inAnalysisSlot(() => this.analyseFile(tenantId, itemId, taskId, subtaskId, fileId, requestedAt, actorId))
                    .catch((error) => console.error('[production/document-standards] Prüfung abgebrochen', fileId, error));
            }
            if (photos.length) {
                await inAnalysisSlot(() => this.analysePhotos(tenantId, itemId, taskId, subtaskId, photos, requestedAt, actorId))
                    .catch((error) => console.error('[production/document-standards] Prüfung der Fotos abgebrochen', photos.join(','), error));
            }
        })();
    }

    /** Das PDF der Standards, gegen das ein Auftrag prüft — nur aus der eigenen Firma; ohne Verweis null. */
    private async standardsPdfOf(
        tenantId: string,
        subtask: ProductionSubtask,
        standardsRef: string | null,
    ): Promise<{ body: Buffer; name: string } | null> {
        if (!standardsRef) return null;
        const body = isStandardsRefOf(standardsRef, tenantId) ? await this.standardsFiles.read(standardsRef).catch(() => null) : null;
        if (!body) throw productionTaskError('STANDARDS_FILE_NOT_FOUND', 'Das PDF der Standards gibt es nicht.', { status: 404 });
        const known = subtask.documentStandardsFile?.ref === standardsRef ? subtask.documentStandardsFile.name : 'standards.pdf';
        return { body, name: known };
    }

    /**
     * Die Fotos einer Einsendung ZUSAMMEN prüfen (02.10.2026, «Fotoğraf yeterli»): eine Anfrage
     * mit allen Fotos (die KI bekommt sie verkleinert), den Standards und der kurzen Notiz;
     * derselbe Bericht kommt an jedes Foto. Nur DIESER Auftrag schreibt.
     */
    private async analysePhotos(
        tenantId: string,
        itemId: string,
        taskId: string,
        subtaskId: string,
        fileIds: readonly string[],
        requestedAt: string,
        actorId: string,
    ): Promise<void> {
        const task = await this.plans.getTask(tenantId, itemId, taskId);
        const subtask = task?.subtasks.find((entry) => entry.id === subtaskId);
        const photos = (subtask?.files ?? []).filter((file) => fileIds.includes(file.id) && file.analysis?.requestedAt === requestedAt);
        const first = photos[0]?.analysis;
        if (!task || !subtask || !first) return;
        const ids = photos.map((file) => file.id);
        const write = (patch: Partial<ProductionFileAnalysis>) => this.plans.changeSubtask(
            tenantId, itemId, taskId, subtaskId,
            (current) => withFileAnalyses(current, ids, requestedAt, patch),
            actorId,
        );
        if (!this.reviewer.configured()) {
            await write({ status: 'FAILED', finishedAt: new Date().toISOString(), errorCode: 'GPT_NOT_CONFIGURED' });
            return;
        }
        await write({ status: 'RUNNING' });
        try {
            const images = await Promise.all(photos.map(async (file) => ({ body: await this.files.read(file.ref), type: file.type, name: file.name })));
            const report = await this.reviewer.review({
                pdf: null,
                fileName: photos.map((file) => file.name).join(', ').slice(0, 300),
                standards: first.standards,
                standardsPdf: await this.standardsPdfOf(tenantId, subtask, first.standardsFileRef),
                images,
                note: first.note,
                taskName: task.name,
                subtaskName: subtask.name,
            });
            await write({ status: 'DONE', finishedAt: new Date().toISOString(), errorCode: null, ...report });
        } catch (error) {
            const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'ANALYSIS_FAILED';
            console.error('[production/document-standards] photos', ids.join(','), code, (error as Error)?.message ?? error);
            await write({ status: 'FAILED', finishedAt: new Date().toISOString(), errorCode: code.slice(0, 60) });
        }
    }

    private async analyseFile(
        tenantId: string,
        itemId: string,
        taskId: string,
        subtaskId: string,
        fileId: string,
        requestedAt: string,
        actorId: string,
    ): Promise<void> {
        // Nur DIESER Auftrag schreibt — ein neuerer oder eine entfernte Datei bleiben unberührt.
        const write = (patch: Partial<ProductionFileAnalysis>) => this.plans.changeSubtask(
            tenantId, itemId, taskId, subtaskId,
            (subtask) => withFileAnalysis(subtask, fileId, requestedAt, patch),
            actorId,
        );
        const task = await this.plans.getTask(tenantId, itemId, taskId);
        const subtask = task?.subtasks.find((entry) => entry.id === subtaskId);
        const file = subtask?.files.find((entry) => entry.id === fileId);
        if (!task || !subtask || !file?.analysis || file.analysis.requestedAt !== requestedAt) return;
        if (!this.reviewer.configured()) {
            await write({ status: 'FAILED', finishedAt: new Date().toISOString(), errorCode: 'GPT_NOT_CONFIGURED' });
            return;
        }
        await write({ status: 'RUNNING' });
        try {
            // Das PDF der Standards, gegen das dieser Auftrag prüft — nur aus der eigenen Firma.
            const standardsPdf = await this.standardsPdfOf(tenantId, subtask, file.analysis.standardsFileRef);
            const report = await this.reviewer.review({
                pdf: await this.files.read(file.ref),
                fileName: file.name,
                standards: file.analysis.standards,
                standardsPdf,
                // Die kurze Notiz der Einsendung liest die KI mit (02.10.2026) — ohne Notiz wie bisher.
                note: file.analysis.note,
                taskName: task.name,
                subtaskName: subtask.name,
            });
            await write({ status: 'DONE', finishedAt: new Date().toISOString(), errorCode: null, ...report });
        } catch (error) {
            const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'ANALYSIS_FAILED';
            console.error('[production/document-standards]', fileId, code, (error as Error)?.message ?? error);
            await write({ status: 'FAILED', finishedAt: new Date().toISOString(), errorCode: code.slice(0, 60) });
        }
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
