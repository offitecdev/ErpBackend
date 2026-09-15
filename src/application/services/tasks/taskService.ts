import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import { auditLog, type AuditEntry } from '../../../infrastructure/services/AuditLogService';
import { assertCanDelete, assertCompletionAdmin, assertManager, assertSystemAdmin, type TasksActor } from './taskActor';
import { logTaskActivities, logTaskActivity } from './taskActivity';
import {
    ACTIVITY,
    BOARD_POSITION_STEP,
    NOTIFY,
    TASK_LIMITS,
    taskLinkUrl,
    type ActivityType,
    type ManualTaskStatus,
    type TaskPriority,
} from './taskConstants';
import { isTaskOverdue } from './taskAccess';
import { runTasksTransaction, type TasksDb } from './taskDb';
import { taskBadRequest, taskConflict, taskForbidden, taskNotFound } from './taskErrors';
import { collectAttachmentRefs, readStoredFile, removeStoredFiles, storeTaskFiles } from './taskFiles';
import { queueTaskNotification, type TaskNotificationInput } from './taskNotify';
import { loadTaskContent, type ContentBlock } from './taskParts';
import { assertAssignablePeople, getTasksAdminIds, getTasksManagerIds, getTasksPeople, loadPersonName } from './taskPeople';
import { loadTaskEnvelope, type TaskEnvelope } from './taskQueries';
import { loadTaskCore, lockTaskRow, requireVisibleTask, type TaskCore, type VisibleTask } from './taskRows';
import { closeRunningSessionsOnTask, type ClosedSession, type SessionCloseNote } from './taskTimer';

/**
 * ── GÖREVLER: SCHREIBWEGE UND ZUSTANDSMASCHINE ──────────────────────────────
 *
 * Der Server besitzt die Zustände (Görevly services/tasks.js, Vertrag §3):
 *
 *   anlegen                 NOT_STARTED · Prüfung APPROVED — ohne Görev-Talep (15.09.2026)
 *                           (wer anlegt, ist immer selbst verantwortlich; die Administratorrolle weist weitere Personen zu)
 *   Abschluss beantragen    eigene Messung endet · Anfrage PENDING · REVIEW
 *   Anfrage zurückziehen    Anfrage NONE · IN_PROGRESS, wenn je gemessen, sonst NOT_STARTED
 *   Abschluss bestätigen    Anfrage APPROVED · COMPLETED · alle Messungen enden
 *   Abschluss ablehnen      Anfrage REJECTED mit Begründung · IN_PROGRESS
 *   Status von Hand         NOT_STARTED | IN_PROGRESS | COMPLETED | BLOCKED (mit Grund)
 *
 * Jeder Wechsel läuft in EINER Transaktion: Aufgabenzeile sperren, im
 * gesperrten Zustand neu laden, Regel prüfen, schreiben, Verlauf dazu. Erst
 * nach dem Commit gehen Meldungen raus, und die Antwort liest die Aufgabe neu.
 */

/* ── Meldungen ──────────────────────────────────────────────────────────── */

/** Eine Meldung ohne Firma, Link und handelnde Person — die setzt `notifyAfterWrite`. */
type TaskNotice = Pick<TaskNotificationInput, 'type' | 'recipientIds' | 'title' | 'message' | 'params'>;

interface NoticeContext {
    /** Anzeigename der handelnden Person («{actor}»). */
    actor: string;
    managerIds: readonly string[];
    /** Administratorrolle — Empfänger von Abschlussanfragen. */
    adminIds: readonly string[];
}

/**
 * Meldungen gehen erst NACH dem Commit raus und halten die Antwort nicht auf:
 * Name der handelnden Person und Leitung werden im Hintergrund gelesen (die
 * Leitung aus demselben 30-s-Speicher, den taskNotify ohnehin braucht).
 */
const notifyAfterWrite = (actor: TasksActor, taskId: string, build: (context: NoticeContext) => TaskNotice[]): void => {
    void Promise.all([loadPersonName(actor.employeeId), getTasksManagerIds(actor.tenantId), getTasksAdminIds(actor.tenantId)])
        .then(([actorName, managerIds, adminIds]) => {
            for (const notice of build({ actor: actorName, managerIds, adminIds })) {
                queueTaskNotification({
                    ...notice,
                    tenantId: actor.tenantId,
                    actorId: actor.employeeId,
                    linkUrl: taskLinkUrl(taskId),
                    meta: { taskId },
                });
            }
        })
        .catch((error: unknown) => {
            console.warn(`[tasks.notify] Meldung zur Aufgabe ${taskId} nicht vorbereitet`, error);
        });
};

const assignedNotice = (context: NoticeContext, title: string, recipientIds: readonly string[]): TaskNotice => ({
    type: NOTIFY.ASSIGNED,
    recipientIds,
    title: 'Neue Aufgabe',
    message: `${context.actor} hat Ihnen «${title}» zugewiesen.`,
    params: { actor: context.actor, title },
});

const completionRequestNotice = (context: NoticeContext, title: string, note: string | null): TaskNotice => ({
    type: NOTIFY.COMPLETION_REQUEST,
    recipientIds: context.adminIds,
    title: 'Abschluss beantragt',
    message: `${context.actor} möchte «${title}» abschliessen.`,
    params: { actor: context.actor, title, note },
});

const completionApprovedNotice = (context: NoticeContext, task: TaskCore): TaskNotice => ({
    type: NOTIFY.COMPLETION_APPROVED,
    recipientIds: [task.approvalRequestedById],
    title: 'Aufgabe abgeschlossen',
    message: `«${task.title}» wurde als erledigt bestätigt.`,
    params: { actor: context.actor, title: task.title },
});

const completionRejectedNotice = (context: NoticeContext, task: TaskCore, note: string): TaskNotice => ({
    type: NOTIFY.COMPLETION_REJECTED,
    recipientIds: [task.approvalRequestedById],
    title: 'Abschluss abgelehnt',
    message: `«${task.title}»: ${note}`,
    params: { actor: context.actor, title: task.title, note },
});

/** Löschanfragen gehen an die Admins — nicht an die ganze Leitung. */
const notifyAdminsAfterWrite = (actor: TasksActor, taskId: string, build: (actorName: string, adminIds: string[]) => TaskNotice): void => {
    void Promise.all([loadPersonName(actor.employeeId), getTasksAdminIds(actor.tenantId)])
        .then(([actorName, adminIds]) => {
            queueTaskNotification({
                ...build(actorName, adminIds),
                tenantId: actor.tenantId,
                actorId: actor.employeeId,
                linkUrl: taskLinkUrl(taskId),
                meta: { taskId },
            });
        })
        .catch((error: unknown) => {
            console.warn(`[tasks.notify] Löschanfrage zur Aufgabe ${taskId} nicht vorbereitet`, error);
        });
};

/* ── Prüfungen und kleine Bausteine ─────────────────────────────────────── */

const assertDueAfterStart = (startAt: Date | null, dueAt: Date | null): void => {
    if (startAt && dueAt && dueAt.getTime() < startAt.getTime()) {
        throw taskBadRequest('DUE_BEFORE_START', 'Das Ende liegt vor dem Anfang.');
    }
};

/** Ablehnen braucht eine Begründung (Görevly: Pflichtfeld «Gerekçe»). */
const requireNote = (note: string | undefined): string => {
    if (!note) throw taskBadRequest('NOTE_REQUIRED', 'Bitte eine Begründung angeben.');
    return note;
};

const requireReason = (reason: string): void => {
    if (!reason) throw taskBadRequest('REASON_REQUIRED', 'Bitte angeben, warum die Aufgabe nicht machbar ist.');
};

const noPendingRequest = () => taskConflict('NO_PENDING_REQUEST', 'Es gibt keine offene Abschlussanfrage.');
const editForbidden = () => taskForbidden('TASK_EDIT_FORBIDDEN', 'Diese Aufgabe dürfen Sie nicht bearbeiten.');

/** Etiketten müssen der ausgewählten Firma gehören. */
const requireTenantLabels = async (db: TasksDb, tenantId: string, labelIds: readonly string[]): Promise<string[]> => {
    const wanted = [...new Set(labelIds)];
    if (!wanted.length) return [];
    const rows = await db.taskLabel.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true } });
    const known = new Set(rows.map((row) => row.id));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length) {
        throw taskBadRequest('LABEL_NOT_FOUND', 'Dieses Etikett gibt es in der ausgewählten Firma nicht.', { labelIds: missing });
    }
    return wanted;
};

/*
 * Verantwortliche und Etiketten bekommen createdAt in Eingangsreihenfolge
 * (+1 ms je Zeile): die Zeilen sortieren danach, und bei derselben
 * Millisekunde entschiede der Zufall der Kennung. Die erste verantwortliche
 * Person bekommt auch die Checklisten-Erinnerungen ohne eigene Zuweisung.
 */
const addAssignees = async (tx: TasksDb, tenantId: string, taskId: string, employeeIds: readonly string[]): Promise<void> => {
    if (!employeeIds.length) return;
    const base = Date.now();
    await tx.taskAssignee.createMany({
        data: employeeIds.map((employeeId, index) => ({
            id: nanoid(12), tenantId, taskId, employeeId, createdAt: new Date(base + index),
        })),
    });
};

const addLabelLinks = async (tx: TasksDb, tenantId: string, taskId: string, labelIds: readonly string[]): Promise<void> => {
    if (!labelIds.length) return;
    const base = Date.now();
    await tx.taskLabelLink.createMany({
        data: labelIds.map((labelId, index) => ({
            id: nanoid(12), tenantId, taskId, labelId, createdAt: new Date(base + index),
        })),
    });
};

/** Neue Karten stehen oben auf der Pano: kleinste Position der Firma minus ein Schritt. */
const topBoardPosition = async (tenantId: string): Promise<number> => {
    const { _min } = await prisma.task.aggregate({ where: { tenantId }, _min: { boardPosition: true } });
    return _min.boardPosition === null ? 0 : _min.boardPosition - BOARD_POSITION_STEP;
};

/* ── Zustandswechsel: Rahmen und Pläne ──────────────────────────────────── */

/** Ein Wechsel als Daten: was an der Aufgabe geschrieben und im Verlauf vermerkt wird. */
interface TransitionPlan {
    /** Laufende Messungen an der Aufgabe beenden — alle oder nur die genannten Personen. */
    closeSessions?: { note: SessionCloseNote; employeeIds?: readonly string[] };
    data: Prisma.TaskUpdateManyMutationInput;
    activity: { type: ActivityType; meta?: Record<string, unknown> };
}

/** Anfang jedes Wechsels: Zeile sperren, gesperrten Stand laden, Sichtbarkeit prüfen. */
const withLockedTask = <T>(
    actor: TasksActor,
    taskId: string,
    work: (tx: TasksDb, task: VisibleTask) => Promise<T>,
): Promise<T> => runTasksTransaction(async (tx) => {
    if (!(await lockTaskRow(tx, actor.tenantId, taskId))) throw taskNotFound();
    return work(tx, await requireVisibleTask(tx, actor, taskId));
});

/** Führt einen Plan auf der gesperrten Aufgabe aus; liefert die beendeten Messungen. */
const applyPlan = async (
    tx: TasksDb,
    actor: TasksActor,
    taskId: string,
    plan: TransitionPlan,
    extra: Prisma.TaskUpdateManyMutationInput = {},
): Promise<ClosedSession[]> => {
    const closed = plan.closeSessions
        ? await closeRunningSessionsOnTask(
            tx, actor.tenantId, taskId, actor.employeeId, plan.closeSessions.note, plan.closeSessions.employeeIds,
        )
        : [];
    await tx.task.updateMany({ where: { id: taskId, tenantId: actor.tenantId }, data: { ...plan.data, ...extra } });
    await logTaskActivity(tx, actor.tenantId, actor.employeeId, { taskId, ...plan.activity });
    return closed;
};

/** Görevly: wer schon gemessen hat, arbeitet daran — sonst ist sie nicht begonnen. */
const resumedStatus = (task: TaskCore): 'IN_PROGRESS' | 'NOT_STARTED' =>
    task.sessionCount > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

const statusActivity = (from: string, to: string): TransitionPlan['activity'] =>
    ({ type: ACTIVITY.STATUS, meta: { from, to } });

const planApproveCompletion = (actorId: string, note: string | null, now: Date): TransitionPlan => ({
    // Mit dem Abschluss enden alle laufenden Messungen — die Zeit bleibt gebucht.
    closeSessions: { note: 'TASK_COMPLETED' },
    data: {
        approvalState: 'APPROVED',
        approvalDecidedById: actorId,
        approvalDecidedAt: now,
        approvalDecisionNote: note,
        status: 'COMPLETED',
        completedAt: now,
    },
    activity: { type: ACTIVITY.COMPLETION_APPROVED, meta: { note } },
});

/** Status von Hand (Menü «Durum», Spalte der Pano); null = nichts zu tun. */
const planManualStatus = (
    task: TaskCore,
    target: ManualTaskStatus,
    reason: string,
    actorId: string,
    now: Date,
): TransitionPlan | null => {
    // «Erledigt» auf eine offene Anfrage IST ihre Bestätigung (Görevly quickComplete).
    if (target === 'COMPLETED' && task.approvalState === 'PENDING') return planApproveCompletion(actorId, null, now);
    if (target === 'BLOCKED') {
        if (task.status === 'BLOCKED' && task.blockReason === reason) return null;
        // Laufende Messungen laufen weiter (Görevly setBlockReason).
        return { data: { status: 'BLOCKED', blockReason: reason }, activity: { type: ACTIVITY.BLOCKED, meta: { reason } } };
    }
    if (task.status === target) return null;
    if (target === 'COMPLETED') {
        return {
            closeSessions: { note: 'TASK_COMPLETED' },
            data: { status: 'COMPLETED', completedAt: now, blockReason: null },
            activity: statusActivity(task.status, target),
        };
    }
    return {
        data: { status: target, blockReason: null, completedAt: null },
        activity: statusActivity(task.status, target),
    };
};

/** Blockade aufheben: weiter, wo sie stand. null = sie war nicht blockiert (nichts wieder öffnen). */
const planUnblock = (task: TaskCore): TransitionPlan | null => {
    if (task.status !== 'BLOCKED') return null;
    const to = resumedStatus(task);
    return { data: { status: to, blockReason: null }, activity: statusActivity(task.status, to) };
};

/** Eine von Hand bestätigte Abschlussanfrage meldet sich bei der Person, die sie gestellt hat. */
const notifyIfCompletionApproved = (actor: TasksActor, task: TaskCore, plan: TransitionPlan | null): void => {
    if (plan?.activity.type !== ACTIVITY.COMPLETION_APPROVED) return;
    notifyAfterWrite(actor, task.id, (context) => [completionApprovedNotice(context, task)]);
};

/* ── Anlegen ────────────────────────────────────────────────────────────── */

export interface CreateTaskInput {
    title: string;
    description?: string | null | undefined;
    assigneeIds?: readonly string[] | undefined;
    startAt?: Date | null | undefined;
    dueAt?: Date | null | undefined;
    reminderAt?: Date | null | undefined;
    flagged?: boolean | undefined;
    labelIds?: readonly string[] | undefined;
    priority?: TaskPriority | undefined;
}

/**
 * Jede Aufgabe ist sofort freigegeben — kein Görev-Talep, keine Ablehnung
 * (15.09.2026, Samet: «görev oluşturma talebini kaldır, direkt oluşturulsun»).
 * Wer anlegt, ist immer selbst verantwortlich; nur die Administratorrolle
 * weist weitere Personen zu.
 */
export const createTask = async (actor: TasksActor, input: CreateTaskInput): Promise<TaskEnvelope> => {
    const now = new Date();
    const startAt = input.startAt ?? now;
    const dueAt = input.dueAt ?? null;
    assertDueAfterStart(startAt, dueAt);

    // Wer anlegt, ist immer auch verantwortlich — die Leitung eingeschlossen (14.09.2026,
    // Samet: «biri görev eklediğinde kendi de otomatik eklensin, yönetici dahil»). Die
    // Leitung wählt weitere Personen dazu; die eigene Kennung wird nicht gegen das
    // Verzeichnis geprüft (wer hier anlegt, benutzt das Modul gerade).
    const [chosenIds, labelIds, boardPosition] = await Promise.all([
        // Zuweisen darf nur die Administratorrolle (15.09.2026); alle anderen legen nur für sich an.
        actor.isSystemAdmin
            ? assertAssignablePeople(actor.tenantId, (input.assigneeIds ?? []).filter((id) => id !== actor.employeeId))
            : [],
        requireTenantLabels(prisma, actor.tenantId, input.labelIds ?? []),
        topBoardPosition(actor.tenantId),
    ]);
    const assigneeIds = [actor.employeeId, ...chosenIds];

    const taskId = nanoid(12);
    await runTasksTransaction(async (tx) => {
        await tx.task.create({
            data: {
                id: taskId,
                tenantId: actor.tenantId,
                title: input.title,
                description: input.description || null,
                status: 'NOT_STARTED',
                priority: input.priority ?? 'MEDIUM',
                origin: actor.isManager ? 'MANAGER' : 'MEMBER',
                flagged: input.flagged ?? false,
                startAt,
                dueAt,
                reminderAt: input.reminderAt ?? null,
                approvalState: 'NONE',
                reviewState: 'APPROVED',
                reviewDecidedById: actor.employeeId,
                reviewDecidedAt: now,
                boardPosition,
                createdById: actor.employeeId,
            },
            select: { id: true },
        });
        await addAssignees(tx, actor.tenantId, taskId, assigneeIds);
        await addLabelLinks(tx, actor.tenantId, taskId, labelIds);
        await logTaskActivity(tx, actor.tenantId, actor.employeeId, {
            taskId,
            type: ACTIVITY.CREATED,
            meta: { title: input.title },
        });
    });

    if (chosenIds.length) {
        // Die Zuweisung an sich selbst meldet niemand.
        notifyAfterWrite(actor, taskId, (context) => [assignedNotice(context, input.title, chosenIds)]);
    }
    return loadTaskEnvelope(actor, taskId);
};

/* ── Bearbeiten ─────────────────────────────────────────────────────────── */

export interface UpdateTaskInput {
    title?: string | undefined;
    description?: string | null | undefined;
    startAt?: Date | null | undefined;
    dueAt?: Date | null | undefined;
    reminderAt?: Date | null | undefined;
    flagged?: boolean | undefined;
    priority?: TaskPriority | undefined;
}

const sameInstant = (a: Date | null, b: Date | null): boolean => (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** Was sich gegenüber der gespeicherten Aufgabe ändert — und was vorher galt (für den Verlauf). */
const diffTaskFields = (
    task: TaskCore,
    input: UpdateTaskInput,
): { data: Prisma.TaskUpdateManyMutationInput; before: Record<string, unknown> } => {
    const data: Prisma.TaskUpdateManyMutationInput = {};
    const before: Record<string, unknown> = {};
    const description = input.description === undefined ? undefined : input.description || null;

    if (input.title !== undefined && input.title !== task.title) {
        data.title = input.title;
        before.title = task.title;
    }
    if (description !== undefined && description !== task.description) {
        data.description = description;
        // Der Verlauf ist kein zweiter Speicher: eine lange Beschreibung nur angeschnitten.
        before.description = task.description?.slice(0, 200) ?? null;
    }
    if (input.startAt !== undefined && !sameInstant(input.startAt, task.startAt)) {
        data.startAt = input.startAt;
        before.startAt = task.startAt;
    }
    if (input.dueAt !== undefined && !sameInstant(input.dueAt, task.dueAt)) {
        data.dueAt = input.dueAt;
        before.dueAt = task.dueAt;
    }
    if (input.reminderAt !== undefined && !sameInstant(input.reminderAt, task.reminderAt)) {
        data.reminderAt = input.reminderAt;
        before.reminderAt = task.reminderAt;
    }
    if (input.flagged !== undefined && input.flagged !== task.flagged) {
        data.flagged = input.flagged;
        before.flagged = task.flagged;
    }
    if (input.priority !== undefined && input.priority !== task.priority) {
        data.priority = input.priority;
        before.priority = task.priority;
    }
    return { data, before };
};

/**
 * Titel, Beschreibung, Termine, Fahne, Priorität. Bearbeiten darf die Leitung
 * oder wer den Vorschlag angelegt hat, solange er geprüft wird; NUR die Fahne
 * setzt auch, wer an der Aufgabe misst (Görevly-Menü «Bayrakla»).
 */
export const updateTask = async (actor: TasksActor, taskId: string, input: UpdateTaskInput): Promise<TaskEnvelope> => {
    const provided = (Object.keys(input) as Array<keyof UpdateTaskInput>).filter((field) => input[field] !== undefined);
    const flagOnly = provided.length === 1 && provided[0] === 'flagged';

    await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (!(flagOnly ? permissions.canFlag : permissions.canEdit)) throw editForbidden();
        if (input.startAt !== undefined || input.dueAt !== undefined) {
            assertDueAfterStart(
                input.startAt !== undefined ? input.startAt : core.startAt,
                input.dueAt !== undefined ? input.dueAt : core.dueAt,
            );
        }
        const { data, before } = diffTaskFields(core, input);
        const fields = Object.keys(before);
        if (!fields.length) return;
        await tx.task.updateMany({ where: { id: taskId, tenantId: actor.tenantId }, data });
        await logTaskActivity(tx, actor.tenantId, actor.employeeId, {
            taskId,
            type: ACTIVITY.UPDATED,
            meta: { fields, before },
        });
    });
    return loadTaskEnvelope(actor, taskId);
};

/* ── Löschen ────────────────────────────────────────────────────────────── */

/**
 * Endgültig (tasks.delete). Die Ablage kennt keine Kaskade: die Verweise —
 * auch die der Kommentardateien, die taskId mittragen — werden VOR dem
 * Löschen gesammelt und danach entfernt.
 */
export const deleteTask = async (
    actor: TasksActor,
    taskId: string,
    request: Pick<AuditEntry, 'ipAddress' | 'userAgent'>,
): Promise<void> => {
    assertCanDelete(actor);
    const [task, fileRefs] = await Promise.all([
        prisma.task.findFirst({ where: { id: taskId, tenantId: actor.tenantId }, select: { title: true, deleteRequestedById: true } }),
        collectAttachmentRefs(prisma, { tenantId: actor.tenantId, taskId }),
    ]);
    if (!task) throw taskNotFound();

    const { count } = await prisma.task.deleteMany({ where: { id: taskId, tenantId: actor.tenantId } });
    // Gleichzeitig schon gelöscht: jene Anfrage räumt die Dateien und protokolliert.
    if (!count) throw taskNotFound();
    auditLog.log({
        action: 'tasks.task.delete',
        tenantId: actor.tenantId,
        employeeId: actor.employeeId,
        entityType: 'Task',
        entityId: taskId,
        metadata: { title: task.title, fileCount: fileRefs.length },
        ...request,
    });
    await removeStoredFiles(fileRefs);
    // Bestätigte Löschanfrage: die Person, die sie gestellt hat, erfährt es (ohne Link — die Aufgabe ist weg).
    if (task.deleteRequestedById) {
        const requesterId = task.deleteRequestedById;
        void loadPersonName(actor.employeeId)
            .then((actorName) => queueTaskNotification({
                type: NOTIFY.DELETE_APPROVED,
                recipientIds: [requesterId],
                title: 'Aufgabe gelöscht',
                message: `«${task.title}» wurde gelöscht.`,
                params: { actor: actorName, title: task.title },
                tenantId: actor.tenantId,
                actorId: actor.employeeId,
                linkUrl: '/tasks',
                meta: { taskId },
            }))
            .catch((error: unknown) => console.warn('[tasks.notify] Löschbestätigung nicht vorbereitet', error));
    }
};

/* ── Löschanfrage (13.09.2026, Samet: «sadece admin silebilir») ─────────── */

/** Wer verantwortlich ist oder die Aufgabe angelegt hat, beantragt das Löschen; ein Admin entscheidet. */
export const requestTaskDeletion = async (
    actor: TasksActor,
    taskId: string,
    input: { note?: string | undefined },
): Promise<TaskEnvelope> => {
    const note = input.note || null;
    const core = await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (core.deleteRequestedById) throw taskConflict('DELETE_ALREADY_REQUESTED', 'Das Löschen ist bereits beantragt.');
        if (!permissions.canRequestDelete) {
            throw taskForbidden('DELETE_REQUEST_FORBIDDEN', 'Das Löschen beantragen nur Verantwortliche oder wer die Aufgabe angelegt hat.');
        }
        await applyPlan(tx, actor, taskId, {
            data: { deleteRequestedById: actor.employeeId, deleteRequestedAt: new Date(), deleteRequestNote: note },
            activity: { type: ACTIVITY.DELETE_REQUESTED, meta: { note } },
        });
        return core;
    });
    notifyAdminsAfterWrite(actor, taskId, (actorName, adminIds) => ({
        type: NOTIFY.DELETE_REQUEST,
        recipientIds: adminIds,
        title: 'Löschung beantragt',
        message: `${actorName} möchte «${core.title}» löschen.`,
        params: { actor: actorName, title: core.title, note },
    }));
    return loadTaskEnvelope(actor, taskId);
};

const noPendingDeleteRequest = () => taskConflict('NO_PENDING_DELETE_REQUEST', 'Es gibt keine offene Löschanfrage.');

/** Anfrage zurückziehen: wer sie gestellt hat (oder ein Admin). */
export const cancelTaskDeletionRequest = async (actor: TasksActor, taskId: string): Promise<TaskEnvelope> => {
    await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (!core.deleteRequestedById) throw noPendingDeleteRequest();
        if (!permissions.canCancelDeleteRequest) {
            throw taskForbidden('DELETE_REQUEST_CANCEL_FORBIDDEN', 'Zurückziehen darf nur, wer das Löschen beantragt hat.');
        }
        await applyPlan(tx, actor, taskId, {
            data: { deleteRequestedById: null, deleteRequestedAt: null, deleteRequestNote: null },
            activity: { type: ACTIVITY.DELETE_REQUEST_CANCELLED },
        });
    });
    return loadTaskEnvelope(actor, taskId);
};

/** Admin lehnt ab: die Aufgabe bleibt, die Person erfährt den Grund. Bestätigen = DELETE /:taskId. */
export const rejectTaskDeletion = async (
    actor: TasksActor,
    taskId: string,
    input: { note?: string | undefined },
): Promise<TaskEnvelope> => {
    assertCanDelete(actor);
    const note = input.note || null;
    const result = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (!core.deleteRequestedById) throw noPendingDeleteRequest();
        await applyPlan(tx, actor, taskId, {
            data: { deleteRequestedById: null, deleteRequestedAt: null, deleteRequestNote: null },
            activity: { type: ACTIVITY.DELETE_REJECTED, meta: { note } },
        });
        return { title: core.title, requesterId: core.deleteRequestedById };
    });
    notifyAfterWrite(actor, taskId, (context) => [{
        type: NOTIFY.DELETE_REJECTED,
        recipientIds: [result.requesterId],
        title: 'Löschung abgelehnt',
        message: note ? `«${result.title}»: ${note}` : `«${result.title}» bleibt bestehen.`,
        params: { actor: context.actor, title: result.title, note },
    }]);
    return loadTaskEnvelope(actor, taskId);
};

/* ── Ortak-ekle-Anfrage (15.09.2026, Samet: «administratör olmayan kişi ortak
   ekleme talebi yöneticiye gönderilsin, yönetici kabul etsin; tek seferde bir
   istek ve bir kişi») ───────────────────────────────────────────────────── */

const noPendingPartnerRequest = () => taskConflict('NO_PENDING_PARTNER_REQUEST', 'Es gibt keine offene Ortak-Anfrage.');

const clearPartnerRequest = { partnerRequestedById: null, partnerRequestEmployeeId: null, partnerRequestedAt: null };

/** Eine verantwortliche Nicht-Admin-Person schlägt GENAU EINE weitere Person vor; die Administratorrolle entscheidet. */
export const requestTaskPartner = async (
    actor: TasksActor,
    taskId: string,
    input: { employeeId: string },
): Promise<TaskEnvelope> => {
    const employeeId = input.employeeId;
    await assertAssignablePeople(actor.tenantId, [employeeId]);
    const core = await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (core.partnerRequestedById) {
            throw taskConflict('PARTNER_ALREADY_REQUESTED', 'Für diese Aufgabe ist schon eine Ortak-Anfrage offen.');
        }
        if (!permissions.canRequestPartner) {
            throw taskForbidden('PARTNER_REQUEST_FORBIDDEN', 'Eine Ortak-Anfrage stellen nur Verantwortliche einer offenen Aufgabe.');
        }
        if (core.assigneeIds.includes(employeeId)) {
            throw taskBadRequest('PARTNER_ALREADY_ASSIGNED', 'Diese Person ist schon verantwortlich.', { employeeId });
        }
        await applyPlan(tx, actor, taskId, {
            data: { partnerRequestedById: actor.employeeId, partnerRequestEmployeeId: employeeId, partnerRequestedAt: new Date() },
            activity: { type: ACTIVITY.PARTNER_REQUESTED, meta: { employeeId } },
        });
        return core;
    });
    void loadPersonName(employeeId)
        .then((personName) => notifyAdminsAfterWrite(actor, taskId, (actorName, adminIds) => ({
            type: NOTIFY.PARTNER_REQUEST,
            recipientIds: adminIds,
            title: 'Ortak-Anfrage',
            message: `${actorName} möchte ${personName} zu «${core.title}» hinzufügen.`,
            params: { actor: actorName, person: personName, title: core.title },
        })))
        .catch((error: unknown) => console.warn('[tasks.notify] Ortak-Anfrage nicht vorbereitet', error));
    return loadTaskEnvelope(actor, taskId);
};

/** Anfrage zurückziehen: wer sie gestellt hat (oder die Administratorrolle). */
export const cancelTaskPartnerRequest = async (actor: TasksActor, taskId: string): Promise<TaskEnvelope> => {
    await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (!core.partnerRequestedById) throw noPendingPartnerRequest();
        if (!permissions.canCancelPartnerRequest) {
            throw taskForbidden('PARTNER_REQUEST_CANCEL_FORBIDDEN', 'Zurückziehen darf nur, wer die Anfrage gestellt hat.');
        }
        await applyPlan(tx, actor, taskId, {
            data: clearPartnerRequest,
            activity: { type: ACTIVITY.PARTNER_REQUEST_CANCELLED, meta: { employeeId: core.partnerRequestEmployeeId } },
        });
    });
    return loadTaskEnvelope(actor, taskId);
};

/** Administratorrolle nimmt die vorgeschlagene Person als Verantwortliche auf. */
export const approveTaskPartner = async (actor: TasksActor, taskId: string): Promise<TaskEnvelope> => {
    assertSystemAdmin(actor);
    const result = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (!core.partnerRequestedById || !core.partnerRequestEmployeeId) throw noPendingPartnerRequest();
        const employeeId = core.partnerRequestEmployeeId;
        // Die Person muss das Modul noch benutzen dürfen.
        await assertAssignablePeople(actor.tenantId, [employeeId]);
        const added = !core.assigneeIds.includes(employeeId);
        if (added) await addAssignees(tx, actor.tenantId, taskId, [employeeId]);
        await tx.task.update({ where: { id: taskId }, data: clearPartnerRequest, select: { id: true } });
        if (added) {
            await logTaskActivity(tx, actor.tenantId, actor.employeeId, { taskId, type: ACTIVITY.ASSIGNED, meta: { employeeId } });
        }
        return { core, employeeId, requesterId: core.partnerRequestedById, added };
    });
    notifyAfterWrite(actor, taskId, (context) => [
        ...(result.added ? [assignedNotice(context, result.core.title, [result.employeeId])] : []),
        {
            type: NOTIFY.PARTNER_APPROVED,
            recipientIds: [result.requesterId],
            title: 'Ortak-Anfrage angenommen',
            message: `«${result.core.title}»: die Person wurde hinzugefügt.`,
            params: { actor: context.actor, title: result.core.title },
        },
    ]);
    return loadTaskEnvelope(actor, taskId);
};

/** Administratorrolle lehnt ab: niemand kommt dazu; wer angefragt hat, erfährt es. */
export const rejectTaskPartner = async (
    actor: TasksActor,
    taskId: string,
    input: { note?: string | undefined },
): Promise<TaskEnvelope> => {
    assertSystemAdmin(actor);
    const note = input.note || null;
    const result = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (!core.partnerRequestedById) throw noPendingPartnerRequest();
        await applyPlan(tx, actor, taskId, {
            data: clearPartnerRequest,
            activity: { type: ACTIVITY.PARTNER_REJECTED, meta: { employeeId: core.partnerRequestEmployeeId, note } },
        });
        return { title: core.title, requesterId: core.partnerRequestedById };
    });
    notifyAfterWrite(actor, taskId, (context) => [{
        type: NOTIFY.PARTNER_REJECTED,
        recipientIds: [result.requesterId],
        title: 'Ortak-Anfrage abgelehnt',
        message: note ? `«${result.title}»: ${note}` : `«${result.title}»: niemand wurde hinzugefügt.`,
        params: { actor: context.actor, title: result.title, note },
    }]);
    return loadTaskEnvelope(actor, taskId);
};

/* ── Duplizieren ────────────────────────────────────────────────────────── */

interface AttachmentSource {
    id: string;
    fileName: string;
    contentType: string;
    fileRef: string;
    uploadedById: string | null;
    createdAt: Date;
}

interface AttachmentCopy extends AttachmentSource {
    sourceId: string;
    sizeBytes: number;
}

/**
 * Eigene Kopien der Dateien — eine nach der anderen, damit nie alle Bytes
 * zugleich im Speicher liegen. Scheitert eine, verschwinden die schon
 * abgelegten Kopien wieder, und der Fehler geht weiter.
 */
const copyAttachmentFiles = async (tenantId: string, sources: readonly AttachmentSource[]): Promise<AttachmentCopy[]> => {
    const copies: AttachmentCopy[] = [];
    try {
        for (const source of sources) {
            const body = await readStoredFile(source.fileRef);
            const stored = await storeTaskFiles(tenantId, [
                { fileName: source.fileName, contentType: source.contentType, sizeBytes: body.length, body },
            ]);
            copies.push(...stored.map((fileRef) => ({
                ...source, id: nanoid(12), sourceId: source.id, fileRef, sizeBytes: body.length,
            })));
        }
        return copies;
    } catch (error) {
        await removeStoredFiles(copies.map((copy) => copy.fileRef));
        throw error;
    }
};

/**
 * Inhaltsblöcke der Kopie: Checklisten- und Datei-/Bildblöcke zeigen auf die
 * NEUEN Kennungen (Görevly übernahm die alten Gruppen). Was sich nicht
 * zuordnen lässt, fällt weg — ein Block ohne Ziel wäre ein leerer Rahmen.
 */
const remapContentBlocks = (
    blocks: readonly ContentBlock[],
    checklistIds: ReadonlyMap<string, string>,
    attachmentIds: ReadonlyMap<string, string>,
): ContentBlock[] => blocks.flatMap((block) => {
    const target = block.type === 'checklist'
        ? { key: 'groupId', ids: checklistIds }
        : block.type === 'image' || block.type === 'file' ? { key: 'attId', ids: attachmentIds } : null;
    if (!target) return [block];
    const ref = block.meta[target.key];
    const mapped = typeof ref === 'string' ? target.ids.get(ref) : undefined;
    return mapped ? [{ ...block, meta: { ...block.meta, [target.key]: mapped } }] : [];
});

/**
 * Kopie als frische Aufgabe der Leitung: Beschreibung, Priorität, Fahne,
 * Termine, Verantwortliche, Etiketten, Checklisten (alle Punkte wieder offen),
 * Dateien und Inhalt. Zeiten, Kommentare, Verlauf und Anfragen kommen nicht
 * mit; wer das Modul nicht mehr benutzen darf, wird nicht mitkopiert.
 */
export const duplicateTask = async (
    actor: TasksActor,
    taskId: string,
    input: { title?: string | undefined },
): Promise<TaskEnvelope> => {
    assertManager(actor);
    const { tenantId } = actor;
    // Nur eine sichtbare Aufgabe (Nicht-Admins: eigene) — 404/403 wie überall.
    const { core: source } = await requireVisibleTask(prisma, actor, taskId);

    const [people, checklists, items, attachments, content, boardPosition] = await Promise.all([
        getTasksPeople(tenantId),
        prisma.taskChecklist.findMany({
            where: { tenantId, taskId: source.id },
            select: { id: true, title: true, position: true, createdById: true, createdAt: true },
        }),
        prisma.taskChecklistItem.findMany({
            where: { tenantId, taskId: source.id },
            select: {
                checklistId: true, text: true, position: true, assigneeId: true, dueAt: true,
                reminderAt: true, flagged: true, createdById: true, createdAt: true,
            },
        }),
        prisma.taskAttachment.findMany({
            where: { tenantId, taskId: source.id, kind: 'TASK' },
            select: { id: true, fileName: true, contentType: true, fileRef: true, uploadedById: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        loadTaskContent(prisma, tenantId, source.id),
        topBoardPosition(tenantId),
    ]);

    const copies = await copyAttachmentFiles(tenantId, attachments);
    const newTaskId = nanoid(12);
    const title = input.title || `${source.title} (kopya)`.slice(0, TASK_LIMITS.titleMax);
    // Die Kopie einer Nicht-Admin-Person gehört nur ihr: zuweisen darf nur die Administratorrolle.
    const assigneeIds = actor.isSystemAdmin ? source.assigneeIds.filter((id) => people.has(id)) : [actor.employeeId];
    const assigneeSet = new Set(assigneeIds);
    const checklistCopies = checklists.map((list) => ({ ...list, sourceId: list.id, id: nanoid(12) }));
    const checklistIds = new Map(checklistCopies.map((copy): [string, string] => [copy.sourceId, copy.id]));
    const attachmentIds = new Map(copies.map((copy): [string, string] => [copy.sourceId, copy.id]));
    const itemRows = items.flatMap((item) => {
        const checklistId = checklistIds.get(item.checklistId);
        if (!checklistId) return [];
        return [{
            id: nanoid(12),
            tenantId,
            taskId: newTaskId,
            checklistId,
            text: item.text,
            position: item.position,
            assigneeId: item.assigneeId && assigneeSet.has(item.assigneeId) ? item.assigneeId : null,
            dueAt: item.dueAt,
            reminderAt: item.reminderAt,
            flagged: item.flagged,
            createdById: item.createdById,
            createdAt: item.createdAt,
        }];
    });
    const blocks = remapContentBlocks(content.blocks, checklistIds, attachmentIds);
    const now = new Date();

    try {
        await runTasksTransaction(async (tx) => {
            await tx.task.create({
                data: {
                    id: newTaskId,
                    tenantId,
                    title,
                    description: source.description,
                    status: 'NOT_STARTED',
                    priority: source.priority,
                    origin: 'MANAGER',
                    flagged: source.flagged,
                    startAt: source.startAt,
                    dueAt: source.dueAt,
                    reminderAt: source.reminderAt,
                    approvalState: 'NONE',
                    reviewState: 'APPROVED',
                    reviewDecidedById: actor.employeeId,
                    reviewDecidedAt: now,
                    boardPosition,
                    createdById: actor.employeeId,
                },
                select: { id: true },
            });
            await addAssignees(tx, tenantId, newTaskId, assigneeIds);
            await addLabelLinks(tx, tenantId, newTaskId, source.labelIds);
            if (checklistCopies.length) {
                await tx.taskChecklist.createMany({
                    data: checklistCopies.map((copy) => ({
                        id: copy.id,
                        tenantId,
                        taskId: newTaskId,
                        title: copy.title,
                        position: copy.position,
                        createdById: copy.createdById,
                        createdAt: copy.createdAt,
                    })),
                });
            }
            if (itemRows.length) await tx.taskChecklistItem.createMany({ data: itemRows });
            if (copies.length) {
                await tx.taskAttachment.createMany({
                    data: copies.map((copy) => ({
                        id: copy.id,
                        tenantId,
                        kind: 'TASK',
                        taskId: newTaskId,
                        fileName: copy.fileName,
                        contentType: copy.contentType,
                        sizeBytes: copy.sizeBytes,
                        fileRef: copy.fileRef,
                        uploadedById: copy.uploadedById,
                        createdAt: copy.createdAt,
                    })),
                });
            }
            if (blocks.length) {
                await tx.taskContent.create({
                    data: {
                        id: nanoid(12),
                        tenantId,
                        taskId: newTaskId,
                        blocks: blocks as unknown as Prisma.InputJsonValue,
                        version: 1,
                        updatedById: actor.employeeId,
                    },
                    select: { id: true },
                });
            }
            await logTaskActivities(tx, tenantId, actor.employeeId, [
                { taskId: newTaskId, type: ACTIVITY.CREATED, meta: { title } },
                { taskId: newTaskId, type: ACTIVITY.DUPLICATED, meta: { fromTaskId: source.id } },
            ]);
        });
    } catch (error) {
        // Ohne Zeilen gehören die Kopien niemandem.
        await removeStoredFiles(copies.map((copy) => copy.fileRef));
        throw error;
    }

    if (assigneeIds.length) {
        notifyAfterWrite(actor, newTaskId, (context) => [assignedNotice(context, title, assigneeIds)]);
    }
    return loadTaskEnvelope(actor, newTaskId);
};

/* ── Status von Hand und Blockade (Leitung) ─────────────────────────────── */

export const setTaskStatus = async (
    actor: TasksActor,
    taskId: string,
    input: { status: ManualTaskStatus; reason?: string | undefined },
): Promise<TaskEnvelope> => {
    assertManager(actor);
    // Abschliessen (auch das Bestätigen einer offenen Anfrage darüber) nur die Administratorrolle.
    if (input.status === 'COMPLETED') assertCompletionAdmin(actor);
    const reason = input.reason ?? '';
    if (input.status === 'BLOCKED') requireReason(reason);

    const { core, plan } = await withLockedTask(actor, taskId, async (tx, { core }) => {
        const plan = planManualStatus(core, input.status, reason, actor.employeeId, new Date());
        if (plan) await applyPlan(tx, actor, taskId, plan);
        return { core, plan };
    });
    notifyIfCompletionApproved(actor, core, plan);
    return loadTaskEnvelope(actor, taskId);
};

/** Mit Grund: «Yapılamadı» (oder neuer Grund). Leerer Grund: Blockade aufheben. */
export const blockTask = async (
    actor: TasksActor,
    taskId: string,
    input: { reason: string | null },
): Promise<TaskEnvelope> => {
    assertManager(actor);
    const reason = input.reason ?? '';
    await withLockedTask(actor, taskId, async (tx, { core }) => {
        const plan = reason ? planManualStatus(core, 'BLOCKED', reason, actor.employeeId, new Date()) : planUnblock(core);
        if (plan) await applyPlan(tx, actor, taskId, plan);
    });
    return loadTaskEnvelope(actor, taskId);
};

/* ── Abschlussanfrage ───────────────────────────────────────────────────── */

/**
 * Eine verantwortliche Person meldet «fertig»: ihre Messung endet, die Leitung entscheidet.
 * Ist der Termin überschritten, geht das NUR mit Gecikme açıklaması (15.09.2026, Samet) —
 * sie bleibt an der Aufgabe stehen, auch nach der Entscheidung.
 */
export const requestTaskCompletion = async (
    actor: TasksActor,
    taskId: string,
    input: { note?: string | undefined; delayReason?: string | undefined },
): Promise<TaskEnvelope> => {
    const note = input.note || null;
    const delayReason = input.delayReason?.trim() || null;
    const core = await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (core.approvalState === 'PENDING') {
            throw taskConflict('COMPLETION_ALREADY_REQUESTED', 'Der Abschluss ist bereits beantragt.');
        }
        if (!permissions.canRequestCompletion) {
            throw taskForbidden('COMPLETION_REQUEST_FORBIDDEN', 'Den Abschluss beantragen Verantwortliche oder die Leitung einer offenen Aufgabe.');
        }
        const now = new Date();
        const overdue = isTaskOverdue(core, now);
        if (overdue && !delayReason) {
            throw taskBadRequest('DELAY_REASON_REQUIRED', 'Die Aufgabe ist überfällig — bitte den Verzug kurz erklären.');
        }
        await applyPlan(tx, actor, taskId, {
            closeSessions: { note: 'COMPLETION_REQUESTED', employeeIds: [actor.employeeId] },
            data: {
                ...(overdue && delayReason ? { delayReason, delayReasonById: actor.employeeId, delayReasonAt: now } : {}),
                approvalState: 'PENDING',
                approvalRequestedById: actor.employeeId,
                approvalRequestedAt: new Date(),
                approvalNote: note,
                approvalDecidedById: null,
                approvalDecidedAt: null,
                approvalDecisionNote: null,
                status: 'REVIEW',
            },
            activity: { type: ACTIVITY.COMPLETION_REQUESTED, meta: overdue ? { note, delayReason } : { note } },
        });
        return core;
    });
    notifyAfterWrite(actor, taskId, (context) => [completionRequestNotice(context, core.title, note)]);
    return loadTaskEnvelope(actor, taskId);
};

/** «Geri al»: nur wer beantragt hat — oder die Leitung (Görevly liess es jedem). */
export const cancelTaskCompletionRequest = async (actor: TasksActor, taskId: string): Promise<TaskEnvelope> => {
    await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (core.approvalState !== 'PENDING') throw noPendingRequest();
        if (!permissions.canCancelCompletionRequest) {
            throw taskForbidden('COMPLETION_CANCEL_FORBIDDEN', 'Zurückziehen darf nur, wer den Abschluss beantragt hat, oder die Leitung.');
        }
        await applyPlan(tx, actor, taskId, {
            data: {
                approvalState: 'NONE',
                approvalRequestedById: null,
                approvalRequestedAt: null,
                approvalNote: null,
                approvalDecidedById: null,
                approvalDecidedAt: null,
                approvalDecisionNote: null,
                status: resumedStatus(core),
            },
            activity: { type: ACTIVITY.COMPLETION_CANCELLED },
        });
    });
    return loadTaskEnvelope(actor, taskId);
};

export const approveTaskCompletion = async (
    actor: TasksActor,
    taskId: string,
    input: { note?: string | undefined },
): Promise<TaskEnvelope> => {
    assertCompletionAdmin(actor);
    const note = input.note || null;
    const core = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (core.approvalState !== 'PENDING') throw noPendingRequest();
        await applyPlan(tx, actor, taskId, planApproveCompletion(actor.employeeId, note, new Date()));
        return core;
    });
    notifyAfterWrite(actor, taskId, (context) => [completionApprovedNotice(context, core)]);
    return loadTaskEnvelope(actor, taskId);
};

/** Zurück an die Arbeit, mit Begründung für die Person, die beantragt hat. */
export const rejectTaskCompletion = async (
    actor: TasksActor,
    taskId: string,
    input: { note?: string | undefined },
): Promise<TaskEnvelope> => {
    assertCompletionAdmin(actor);
    const note = requireNote(input.note);
    const core = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (core.approvalState !== 'PENDING') throw noPendingRequest();
        await applyPlan(tx, actor, taskId, {
            data: {
                approvalState: 'REJECTED',
                approvalDecidedById: actor.employeeId,
                approvalDecidedAt: new Date(),
                approvalDecisionNote: note,
                status: 'IN_PROGRESS',
            },
            activity: { type: ACTIVITY.COMPLETION_REJECTED, meta: { note } },
        });
        return core;
    });
    notifyAfterWrite(actor, taskId, (context) => [completionRejectedNotice(context, core, note)]);
    return loadTaskEnvelope(actor, taskId);
};

/* ── Verantwortliche und Etiketten ──────────────────────────────────────── */

/**
 * Verantwortliche ersetzen (Leitung). Neue Personen werden geprüft; wer
 * entfernt wird, dessen laufende Messung an der Aufgabe endet (UNASSIGNED).
 * Verlauf und Meldung je Person.
 */
export const setTaskAssignees = async (
    actor: TasksActor,
    taskId: string,
    input: { employeeIds: readonly string[] },
): Promise<TaskEnvelope> => {
    // Nur die Administratorrolle (15.09.2026, Samet: «görev atama sadece yönetici yapabilir»).
    assertSystemAdmin(actor);
    const wanted = [...new Set(input.employeeIds)];
    const { core, added } = await withLockedTask(actor, taskId, async (tx, { core }) => {
        const current = new Set(core.assigneeIds);
        const keep = new Set(wanted);
        const added = await assertAssignablePeople(actor.tenantId, wanted.filter((id) => !current.has(id)));
        const removed = core.assigneeIds.filter((id) => !keep.has(id));
        if (removed.length) {
            await closeRunningSessionsOnTask(tx, actor.tenantId, taskId, actor.employeeId, 'UNASSIGNED', removed);
            await tx.taskAssignee.deleteMany({ where: { tenantId: actor.tenantId, taskId, employeeId: { in: removed } } });
        }
        await addAssignees(tx, actor.tenantId, taskId, added);
        await logTaskActivities(tx, actor.tenantId, actor.employeeId, [
            ...added.map((employeeId) => ({ taskId, type: ACTIVITY.ASSIGNED, meta: { employeeId } })),
            ...removed.map((employeeId) => ({ taskId, type: ACTIVITY.UNASSIGNED, meta: { employeeId } })),
        ]);
        return { core, added };
    });
    if (added.length) notifyAfterWrite(actor, taskId, (context) => [assignedNotice(context, core.title, added)]);
    return loadTaskEnvelope(actor, taskId);
};

/** Etiketten ersetzen (wer bearbeiten darf); ohne Verlauf wie Görevly `toggleLabel`. */
export const setTaskLabels = async (
    actor: TasksActor,
    taskId: string,
    input: { labelIds: readonly string[] },
): Promise<TaskEnvelope> => {
    await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (!permissions.canEdit) throw editForbidden();
        const labelIds = await requireTenantLabels(tx, actor.tenantId, input.labelIds);
        const keep = new Set(labelIds);
        const current = new Set(core.labelIds);
        const removed = core.labelIds.filter((id) => !keep.has(id));
        if (removed.length) {
            await tx.taskLabelLink.deleteMany({ where: { tenantId: actor.tenantId, taskId, labelId: { in: removed } } });
        }
        await addLabelLinks(tx, actor.tenantId, taskId, labelIds.filter((id) => !current.has(id)));
    });
    return loadTaskEnvelope(actor, taskId);
};

/* ── Pano ───────────────────────────────────────────────────────────────── */

export interface MoveTaskInput {
    status?: ManualTaskStatus | undefined;
    reason?: string | undefined;
    /** Die Karte ÜBER der Ablagestelle. */
    beforeTaskId?: string | null | undefined;
    /** Die Karte UNTER der Ablagestelle. */
    afterTaskId?: string | null | undefined;
}

/** Enger als das passt zwischen zwei Positionen keine Karte mehr (Gleitkomma). */
const MIN_BOARD_GAP = 1e-6;
const RENUMBER_CHUNK = 500;

/** Spalte neu durchnummerieren — 0, 1, 2 … Schritte in ihrer bisherigen Reihenfolge. */
const renumberBoardColumn = async (tx: TasksDb, tenantId: string, status: string): Promise<Map<string, number>> => {
    const rows = await tx.task.findMany({
        where: { tenantId, status },
        select: { id: true },
        orderBy: [{ boardPosition: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    for (let offset = 0; offset < rows.length; offset += RENUMBER_CHUNK) {
        const chunk = rows.slice(offset, offset + RENUMBER_CHUNK);
        const cases = chunk.map((row, index) => Prisma.sql`WHEN ${row.id} THEN ${(offset + index) * BOARD_POSITION_STEP}`);
        await tx.$executeRaw(Prisma.sql`
            UPDATE Task SET boardPosition = CASE id ${Prisma.join(cases, ' ')} END
            WHERE tenantId = ${tenantId} AND id IN (${Prisma.join(chunk.map((row) => row.id))})
        `);
    }
    return new Map(rows.map((row, index): [string, number] => [row.id, index * BOARD_POSITION_STEP]));
};

/**
 * Position zwischen den Nachbarn: Mitte zwischen der Karte darüber und der
 * darunter, mit nur einer ein Schritt daneben, ohne Nachbarn oben in die
 * Spalte. Nachbarn ausserhalb der Firma oder längst gelöschte zählen nicht.
 */
const resolveBoardPosition = async (
    tx: TasksDb,
    tenantId: string,
    taskId: string,
    status: string,
    beforeTaskId: string | null,
    afterTaskId: string | null,
): Promise<number> => {
    const neighbourIds = [beforeTaskId, afterTaskId].filter((id): id is string => Boolean(id) && id !== taskId);
    const neighbours = neighbourIds.length
        ? await tx.task.findMany({ where: { tenantId, id: { in: neighbourIds } }, select: { id: true, boardPosition: true } })
        : [];
    let positions = new Map(neighbours.map((row): [string, number] => [row.id, row.boardPosition]));
    const positionOf = (id: string | null): number | undefined => (id ? positions.get(id) : undefined);

    let above = positionOf(beforeTaskId);
    let below = positionOf(afterTaskId);
    if (above !== undefined && below !== undefined && below - above < MIN_BOARD_GAP) {
        positions = new Map([...positions, ...(await renumberBoardColumn(tx, tenantId, status))]);
        above = positionOf(beforeTaskId);
        below = positionOf(afterTaskId);
    }
    if (above !== undefined && below !== undefined) return (above + below) / 2;
    if (above !== undefined) return above + BOARD_POSITION_STEP;
    if (below !== undefined) return below - BOARD_POSITION_STEP;

    const { _min } = await tx.task.aggregate({
        where: { tenantId, status, id: { not: taskId } },
        _min: { boardPosition: true },
    });
    return _min.boardPosition === null ? 0 : _min.boardPosition - BOARD_POSITION_STEP;
};

/**
 * Karte auf der Pano ablegen (Leitung). Ein Spaltenwechsel ist ein Status von
 * Hand mit allen Regeln; innerhalb der Spalte bleibt der Status, nur ein neuer
 * Blockadegrund wird übernommen.
 */
export const moveTask = async (actor: TasksActor, taskId: string, input: MoveTaskInput): Promise<TaskEnvelope> => {
    assertManager(actor);
    const reason = input.reason ?? '';
    const { core, plan } = await withLockedTask(actor, taskId, async (tx, { core }) => {
        const column = input.status ?? core.status;
        const changesStatus = column !== core.status;
        if (changesStatus && column === 'BLOCKED') requireReason(reason);
        const plan = input.status && (changesStatus || reason)
            ? planManualStatus(core, input.status, reason, actor.employeeId, new Date())
            : null;
        const boardPosition = await resolveBoardPosition(
            tx, actor.tenantId, taskId, column, input.beforeTaskId ?? null, input.afterTaskId ?? null,
        );
        if (plan) await applyPlan(tx, actor, taskId, plan, { boardPosition });
        else await tx.task.updateMany({ where: { id: taskId, tenantId: actor.tenantId }, data: { boardPosition } });
        return { core, plan };
    });
    notifyIfCompletionApproved(actor, core, plan);
    return loadTaskEnvelope(actor, taskId);
};
