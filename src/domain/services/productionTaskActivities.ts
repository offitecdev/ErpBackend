import type { ProductionTaskNotice } from '../repositories/IProductionTaskRepository';
import type {
    ProductionDeviceTask,
    ProductionSubtask,
    ProductionSubtaskFile,
    ProductionTaskActivityDraft,
    ProductionTaskActivityKind,
    ProductionTaskStatus,
} from '../entities/ProductionTask';

/**
 * ── DER VERLAUF EINER STUFE · WAS EINE ZEILE TRÄGT (30.09.2026) ─────────────
 *
 * Reine Regeln, ohne Datenbank: aus einer Handlung (oder aus dem Unterschied
 * vor/nach einer Anpassung am Gerät) werden Zeilen des Verlaufs. Wer handelt
 * und an welchem Gerät, setzt der Anwendungsfall dazu (`ActivityScope`).
 */

/** Wer an welchem Gerät handelt — gleich für alle Zeilen einer Handlung. */
export interface ActivityScope {
    tenantId: string;
    productionItemId: string;
    actorId: string | null;
    actorName: string | null;
}

type TaskRef = Pick<ProductionDeviceTask, 'id' | 'area' | 'stage' | 'code' | 'name'> & {
    subtasks: ReadonlyArray<Pick<ProductionSubtask, 'id' | 'name'>>;
};

/** «M-01.2» — wie die Oberfläche die Unteraufgabe nennt (Platz in der Aufgabe). */
const subtaskCodeOf = (task: TaskRef, subtaskId: string): string | null => {
    const index = task.subtasks.findIndex((entry) => entry.id === subtaskId);
    return index < 0 ? null : `${task.code}.${index + 1}`;
};

/** Eine Zeile an einer Aufgabe (und ggf. ihrer Unteraufgabe), mit Kürzeln und Namen von JETZT. */
export const activityAt = (
    scope: ActivityScope,
    kind: ProductionTaskActivityKind,
    task: TaskRef,
    subtask: Pick<ProductionSubtask, 'id' | 'name'> | null,
    details: Record<string, unknown> | null = null,
): ProductionTaskActivityDraft => ({
    tenantId: scope.tenantId,
    productionItemId: scope.productionItemId,
    area: task.area,
    stage: task.stage,
    taskId: task.id,
    taskCode: task.code,
    taskName: task.name,
    subtaskId: subtask?.id ?? null,
    subtaskCode: subtask ? subtaskCodeOf(task, subtask.id) : null,
    subtaskName: subtask?.name ?? null,
    kind,
    actorId: scope.actorId,
    actorName: scope.actorName,
    details,
});

/** Eine Zeile am ganzen Gerät (Vorlage geladen, Aufgaben entfernt) — steht in jeder Stufe. */
export const deviceActivity = (
    scope: ActivityScope,
    kind: ProductionTaskActivityKind,
    details: Record<string, unknown> | null = null,
): ProductionTaskActivityDraft => ({
    tenantId: scope.tenantId,
    productionItemId: scope.productionItemId,
    area: null,
    stage: null,
    taskId: null,
    taskCode: null,
    taskName: null,
    subtaskId: null,
    subtaskCode: null,
    subtaskName: null,
    kind,
    actorId: scope.actorId,
    actorName: scope.actorName,
    details,
});

/**
 * Welcher Schritt war es? — ▶ gestartet, ■ angehalten, zur Freigabe geschickt,
 * erledigt. Derselbe Stand noch einmal ist kein Schritt (null).
 */
export const subtaskStepKind = (from: ProductionTaskStatus, to: ProductionTaskStatus): ProductionTaskActivityKind | null => {
    if (from === to) return null;
    if (to === 'IN_PROGRESS') return 'SUBTASK_STARTED';
    if (to === 'TODO') return 'SUBTASK_STOPPED';
    if (to === 'PENDING') return 'SUBTASK_SUBMITTED';
    if (to === 'DONE') return 'SUBTASK_DONE';
    return null;
};

/** Eine Datei, wie der Verlauf sie festhält — ohne Verweis in die Ablage. */
export const fileDetails = (file: ProductionSubtaskFile) => ({
    fileId: file.id,
    groupId: file.groupId,
    name: file.name,
    type: file.type,
    size: file.size,
    version: file.version,
    revisionNote: file.revisionNote,
    uploadedById: file.uploadedById,
    uploadedByName: file.uploadedByName,
    uploadedAt: file.uploadedAt,
});

export type PersonRef = { id: string; name: string };

/** Wer neu dazukam und wer ging — null, wenn sich an den Personen nichts änderte. */
export const assigneeChange = (
    before: readonly string[],
    after: readonly string[],
    nameOf: (id: string) => string,
): { added: PersonRef[]; removed: PersonRef[] } | null => {
    const had = new Set(before);
    const has = new Set(after);
    const added = after.filter((id) => !had.has(id)).map((id) => ({ id, name: nameOf(id) }));
    const removed = before.filter((id) => !has.has(id)).map((id) => ({ id, name: nameOf(id) }));
    return added.length || removed.length ? { added, removed } : null;
};

/** Eine geänderte Angabe: welches Feld, vorher, nachher. */
export type FieldChange = { field: string; from: unknown; to: unknown };

const changed = (field: string, from: unknown, to: unknown): FieldChange[] =>
    (JSON.stringify(from ?? null) === JSON.stringify(to ?? null) ? [] : [{ field, from: from ?? null, to: to ?? null }]);

/** Was an einer Unteraufgabe anders ist — Personen zählen eigens (SUBTASK_ASSIGNED). */
const subtaskChanges = (before: ProductionSubtask, after: ProductionSubtask): FieldChange[] => {
    const checklistBefore = new Map(before.approvalChecklist.map((item) => [item.id, item.text]));
    const checklistAfter = new Map(after.approvalChecklist.map((item) => [item.id, item.text]));
    const checklist = {
        added: after.approvalChecklist.filter((item) => !checklistBefore.has(item.id)).map((item) => item.text),
        removed: before.approvalChecklist.filter((item) => !checklistAfter.has(item.id)).map((item) => item.text),
        edited: after.approvalChecklist
            .filter((item) => checklistBefore.has(item.id) && checklistBefore.get(item.id) !== item.text)
            .map((item) => ({ from: checklistBefore.get(item.id) ?? '', to: item.text })),
    };
    const checklistChanged = checklist.added.length || checklist.removed.length || checklist.edited.length;
    return [
        ...changed('name', before.name, after.name),
        ...changed('weight', before.weight, after.weight),
        ...changed('startDate', before.startDate, after.startDate),
        ...changed('dueDate', before.dueDate, after.dueDate),
        ...changed('requiresDocument', before.requiresDocument, after.requiresDocument),
        ...changed('requiresApproval', before.requiresApproval, after.requiresApproval),
        ...(checklistChanged ? [{ field: 'checklist', from: null, to: checklist }] : []),
        // Eine neue Pflicht öffnet sie wieder (mergeDeviceRecord) — der Verlauf sagt es.
        ...(before.status !== 'TODO' && after.status === 'TODO' ? [{ field: 'status', from: before.status, to: after.status }] : []),
    ];
};

/** Die Angaben einer neuen Unteraufgabe, wie der Klick sie zeigt. */
const subtaskSnapshot = (subtask: ProductionSubtask, nameOf: (id: string) => string) => ({
    weight: subtask.weight,
    startDate: subtask.startDate,
    dueDate: subtask.dueDate,
    requiresDocument: subtask.requiresDocument,
    requiresApproval: subtask.requiresApproval,
    checklist: subtask.approvalChecklist.map((item) => item.text),
    assignees: subtask.assigneeIds.map((id) => ({ id, name: nameOf(id) })),
});

/**
 * Die Anpassung der Kopie am Gerät (PUT /tasks) als Zeilen des Verlaufs: je
 * Aufgabe angelegt / geändert / verschoben / gelöscht, je Unteraufgabe
 * angelegt / geändert / gelöscht und neue oder entfernte Personen. Gleiche
 * Kennung = dieselbe Aufgabe bzw. Unteraufgabe.
 */
export const planChangeActivities = (
    scope: ActivityScope,
    before: readonly ProductionDeviceTask[],
    after: readonly ProductionDeviceTask[],
    nameOf: (id: string) => string,
): ProductionTaskActivityDraft[] => {
    const rows: ProductionTaskActivityDraft[] = [];
    const earlier = new Map(before.map((task) => [task.id, task]));
    const later = new Set(after.map((task) => task.id));

    for (const task of after) {
        const previous = earlier.get(task.id);
        if (!previous) {
            rows.push(activityAt(scope, 'TASK_CREATED', task, null, {
                weight: task.weight,
                startDate: task.startDate,
                dueDate: task.dueDate,
                subtasks: task.subtasks.map((subtask, index) => ({ code: `${task.code}.${index + 1}`, name: subtask.name })),
            }));
            // Ihre Unteraufgaben erscheinen mit ihren Angaben — und wer an ihnen steht, als eigene Zeile.
            for (const subtask of task.subtasks) {
                rows.push(activityAt(scope, 'SUBTASK_CREATED', task, subtask, subtaskSnapshot(subtask, nameOf)));
                const people = assigneeChange([], subtask.assigneeIds, nameOf);
                if (people) rows.push(activityAt(scope, 'SUBTASK_ASSIGNED', task, subtask, people));
            }
            continue;
        }

        // In eine andere Stufe gelegt: in beiden Stufen sichtbar.
        if (previous.area !== task.area || previous.stage !== task.stage) {
            const move = { fromArea: previous.area, fromStage: previous.stage, toArea: task.area, toStage: task.stage };
            rows.push(activityAt(scope, 'TASK_MOVED', previous, null, move));
            rows.push(activityAt(scope, 'TASK_MOVED', task, null, move));
        }

        const taskChanges = [
            ...changed('code', previous.code, task.code),
            ...changed('name', previous.name, task.name),
            ...changed('weight', previous.weight, task.weight),
            ...changed('startDate', previous.startDate, task.startDate),
            ...changed('dueDate', previous.dueDate, task.dueDate),
        ];
        if (taskChanges.length) rows.push(activityAt(scope, 'TASK_UPDATED', task, null, { changes: taskChanges }));

        const oldSubtasks = new Map(previous.subtasks.map((subtask) => [subtask.id, subtask]));
        const newIds = new Set(task.subtasks.map((subtask) => subtask.id));
        for (const subtask of task.subtasks) {
            const old = oldSubtasks.get(subtask.id);
            if (!old) {
                rows.push(activityAt(scope, 'SUBTASK_CREATED', task, subtask, subtaskSnapshot(subtask, nameOf)));
                // Beim Anlegen gesetzte Personen sind eine Zuweisung (30.09.2026: «when the admin assigns
                // someone … the activities doesn't show it») — eigene Zeile, nicht nur in den Einzelheiten.
                const people = assigneeChange([], subtask.assigneeIds, nameOf);
                if (people) rows.push(activityAt(scope, 'SUBTASK_ASSIGNED', task, subtask, people));
                continue;
            }
            const changes = subtaskChanges(old, subtask);
            if (changes.length) rows.push(activityAt(scope, 'SUBTASK_UPDATED', task, subtask, { changes }));
            const people = assigneeChange(old.assigneeIds, subtask.assigneeIds, nameOf);
            if (people) rows.push(activityAt(scope, 'SUBTASK_ASSIGNED', task, subtask, people));
        }
        for (const old of previous.subtasks) {
            if (newIds.has(old.id)) continue;
            // Gelöscht: die Zeile trägt Kürzel und Namen von vorher.
            rows.push(activityAt(scope, 'SUBTASK_DELETED', previous, old, {
                status: old.status,
                files: old.files.map(fileDetails),
            }));
        }
    }

    for (const task of before) {
        if (later.has(task.id)) continue;
        rows.push(activityAt(scope, 'TASK_DELETED', task, null, {
            weight: task.weight,
            subtasks: task.subtasks.map((subtask, index) => ({
                code: `${task.code}.${index + 1}`,
                name: subtask.name,
                status: subtask.status,
                fileCount: subtask.files.length,
            })),
        }));
    }
    return rows;
};

/**
 * Eine geladene Vorlage bringt Personen mit (30.09.2026): je Unteraufgabe mit Personen eine
 * Zeile «zugewiesen» — so steht im Verlauf der Stufe, wer von Anfang an daran arbeitet.
 */
export const loadedAssignments = (
    scope: ActivityScope,
    tasks: readonly ProductionDeviceTask[],
    nameOf: (id: string) => string,
): ProductionTaskActivityDraft[] =>
    tasks.flatMap((task) => task.subtasks.flatMap((subtask) => {
        const people = assigneeChange([], subtask.assigneeIds, nameOf);
        return people ? [activityAt(scope, 'SUBTASK_ASSIGNED', task, subtask, people)] : [];
    }));

/**
 * Die Nachrichten einer Anpassung am Gerät (30.09.2026): wer von einer Unteraufgabe genommen
 * wurde (REMOVED), wessen Unteraufgabe oder Aufgabe gelöscht wurde (DELETED) und wessen
 * Unteraufgabe sich geändert hat (UPDATED — auch, wenn ihre Aufgabe umbenannt, verschoben oder
 * anders datiert wurde). Wer NEU dazukommt, bekommt die Nachricht «zugewiesen» ohnehin.
 */
export const planChangeNotices = (
    before: readonly ProductionDeviceTask[],
    after: readonly ProductionDeviceTask[],
): ProductionTaskNotice[] => {
    const notices: ProductionTaskNotice[] = [];
    const later = new Map(after.map((task) => [task.id, task]));
    const codeOf = (task: ProductionDeviceTask, subtaskId: string) => `${task.code}.${task.subtasks.findIndex((entry) => entry.id === subtaskId) + 1}`;

    for (const previous of before) {
        const task = later.get(previous.id);
        if (!task) {
            for (const subtask of previous.subtasks) {
                if (subtask.assigneeIds.length) {
                    notices.push({ kind: 'DELETED', recipients: subtask.assigneeIds, code: codeOf(previous, subtask.id), name: subtask.name, area: previous.area, stage: previous.stage });
                }
            }
            continue;
        }
        const taskChanged = previous.name !== task.name || previous.code !== task.code || previous.area !== task.area
            || previous.stage !== task.stage || previous.startDate !== task.startDate || previous.dueDate !== task.dueDate
            || previous.weight !== task.weight;
        const current = new Map(task.subtasks.map((subtask) => [subtask.id, subtask]));
        for (const old of previous.subtasks) {
            const subtask = current.get(old.id);
            if (!subtask) {
                if (old.assigneeIds.length) {
                    notices.push({ kind: 'DELETED', recipients: old.assigneeIds, code: codeOf(previous, old.id), name: old.name, area: previous.area, stage: previous.stage });
                }
                continue;
            }
            const removed = old.assigneeIds.filter((id) => !subtask.assigneeIds.includes(id));
            if (removed.length) {
                notices.push({ kind: 'REMOVED', recipients: removed, code: codeOf(task, subtask.id), name: subtask.name, area: task.area, stage: task.stage });
            }
            // Wer schon daran stand und bleibt — neue Personen hören «zugewiesen».
            const stayed = subtask.assigneeIds.filter((id) => old.assigneeIds.includes(id));
            if (stayed.length && (taskChanged || subtaskChanges(old, subtask).length > 0)) {
                notices.push({ kind: 'UPDATED', recipients: stayed, code: codeOf(task, subtask.id), name: subtask.name, area: task.area, stage: task.stage });
            }
        }
    }
    return notices;
};

/** Eine Nachricht an die Leute EINER Unteraufgabe (Freigabe, Rückgabe, Sperre, Checkliste). */
export const subtaskNotice = (
    kind: ProductionTaskNotice['kind'],
    task: ProductionDeviceTask,
    subtaskId: string,
    note: string | null = null,
): ProductionTaskNotice[] => {
    const index = task.subtasks.findIndex((entry) => entry.id === subtaskId);
    const subtask = task.subtasks[index];
    if (!subtask || !subtask.assigneeIds.length) return [];
    return [{ kind, recipients: subtask.assigneeIds, code: `${task.code}.${index + 1}`, name: subtask.name, area: task.area, stage: task.stage, note }];
};
