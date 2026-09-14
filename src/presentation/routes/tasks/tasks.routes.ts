import { Router } from 'express';
import { z } from 'zod';

import { MANUAL_TASK_STATUSES, TASK_LIMITS, TASK_PRIORITIES } from '../../../application/services/tasks/taskConstants';
import {
    SORT_DIRECTIONS,
    TASK_LIST_FILTERS,
    TASK_LIST_SCOPES,
    TASK_LIST_SORTS,
    TASK_LIST_VIEWS,
    getTaskDetail,
    getTasksBootstrap,
    getTasksSummary,
    listTaskActivity,
    listTaskApprovals,
    listTasks,
    searchTasks,
    type TaskListQuery,
} from '../../../application/services/tasks/taskQueries';
import {
    approveTaskCompletion,
    approveTaskReview,
    blockTask,
    cancelTaskCompletionRequest,
    cancelTaskDeletionRequest,
    createTask,
    deleteTask,
    duplicateTask,
    moveTask,
    rejectTaskCompletion,
    rejectTaskDeletion,
    rejectTaskReview,
    requestTaskCompletion,
    requestTaskDeletion,
    setTaskAssignees,
    setTaskLabels,
    setTaskStatus,
    updateTask,
} from '../../../application/services/tasks/taskService';
import { getActiveTimer, pauseTaskTimer, startTaskTimer } from '../../../application/services/tasks/taskTimer';
import { auditLog } from '../../../infrastructure/services/AuditLogService';
import {
    parseInput,
    queryFlag,
    queryInt,
    queryString,
    routeParam,
    taskRoute,
    zId,
    zIdList,
    zLine,
    zNullableDate,
    zRequiredLine,
    zText,
} from './taskHttp';
import { assertSystemAdmin } from '../../../application/services/tasks/taskActor';
import { tasksActor } from './taskMiddleware';
import { completeTaskOnboarding } from '../../../application/services/tasks/taskOnboarding';
import { responseCache } from '../../middlewares/ResponseCacheMiddleware';

/* AUFGABEN (Görevler), montiert unter /api/v1/tasks: Start und Zähler, Liste,
   Pano und Suche, Anfragen der Leitung, Anlegen, Detail, Bearbeiten, Löschen,
   Duplizieren, alle Zustandswechsel, Verantwortliche, Etiketten, Verlauf und
   Zeitmessung. Anmeldung und Modulzugang prüft index.ts davor; wer was darf,
   entscheiden taskService (schreiben) und taskQueries (lesen).
   Feste Pfade vor Parameterpfaden. */

const router = Router();

/* ── Eingaben ───────────────────────────────────────────────────────────── */

/** Vertrag: höchstens 50 Verantwortliche je Aufgabe. */
const ASSIGNEES_MAX = 50;

const dateField = zNullableDate.optional();
const noteText = zText(TASK_LIMITS.noteMax);

const createBody = z.object({
    title: zRequiredLine(TASK_LIMITS.titleMax),
    description: zText(TASK_LIMITS.descriptionMax).nullable().optional(),
    assigneeIds: zIdList(ASSIGNEES_MAX).optional(),
    startAt: dateField,
    dueAt: dateField,
    reminderAt: dateField,
    flagged: z.boolean().optional(),
    labelIds: zIdList().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
});

const updateBody = z.object({
    title: zRequiredLine(TASK_LIMITS.titleMax).optional(),
    description: zText(TASK_LIMITS.descriptionMax).nullable().optional(),
    startAt: dateField,
    dueAt: dateField,
    reminderAt: dateField,
    flagged: z.boolean().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
});

const duplicateBody = z.object({ title: zLine(TASK_LIMITS.titleMax).optional() });
const noteBody = z.object({ note: noteText.optional() });
const statusBody = z.object({ status: z.enum(MANUAL_TASK_STATUSES), reason: noteText.optional() });
/** `reason` muss mitkommen: leer oder null hebt die Blockade auf — ein vergessenes Feld soll das nicht. */
const blockBody = z.object({ reason: noteText.nullable() });
const assigneesBody = z.object({ employeeIds: zIdList(ASSIGNEES_MAX) });
const labelsBody = z.object({ labelIds: zIdList() });
const moveBody = z.object({
    status: z.enum(MANUAL_TASK_STATUSES).optional(),
    reason: noteText.optional(),
    beforeTaskId: zId.nullable().optional(),
    afterTaskId: zId.nullable().optional(),
});

/** Erlaubter Wert aus der Abfragezeile, sonst der Standard. */
const queryChoice = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => {
    const raw = queryString(value, 32);
    return allowed.find((option) => option === raw) ?? fallback;
};

/** Zeitraum aus `from`/`to` (ISO); unvollständig, verkehrt oder über 400 Tage = ohne Zeitraum. */
const queryRange = (fromRaw: unknown, toRaw: unknown): { from: Date | null; to: Date | null } => {
    const from = new Date(queryString(fromRaw, 40));
    const to = new Date(queryString(toRaw, 40));
    const valid = Number.isFinite(from.getTime()) && Number.isFinite(to.getTime())
        && to.getTime() >= from.getTime() && to.getTime() - from.getTime() <= 400 * 86_400_000;
    return valid ? { from, to } : { from: null, to: null };
};

const parseListQuery = (query: Record<string, unknown>): TaskListQuery => ({
    filter: queryChoice(query.filter, TASK_LIST_FILTERS, 'open'),
    scope: queryChoice(query.scope, TASK_LIST_SCOPES, 'all'),
    view: queryChoice(query.view, TASK_LIST_VIEWS, 'list'),
    sort: queryChoice(query.sort, TASK_LIST_SORTS, 'due'),
    dir: queryChoice(query.dir, SORT_DIRECTIONS, 'asc'),
    assigneeId: queryString(query.assigneeId, 64),
    labelId: queryString(query.labelId, 64),
    status: queryString(query.status, 24),
    flagged: queryFlag(query.flagged),
    q: queryString(query.q, 100),
    ...queryRange(query.from, query.to),
    page: queryInt(query.page, 1, 1, 1_000_000),
    pageSize: queryInt(query.pageSize, TASK_LIMITS.listPageSizeDefault, 1, TASK_LIMITS.listPageSizeMax),
});

/* ── Feste Pfade ────────────────────────────────────────────────────────── */

// GET /bootstrap — Start der Seite: Rolle, Etiketten, eigene Einstellungen, Zähler.
router.get('/bootstrap', taskRoute('tasks.bootstrap', async (_req, res) => {
    res.json(await getTasksBootstrap(tasksActor(res)));
}));

// GET /summary — Zähler der Seitenleiste und die eigene laufende Messung.
router.get('/summary', responseCache({ namespaces: ['tasks'], ttlSec: 15 }), taskRoute('tasks.summary', async (_req, res) => {
    res.json(await getTasksSummary(tasksActor(res)));
}));

// POST /onboarding/complete — role-specific guide finished; idempotent.
router.post('/onboarding/complete', taskRoute('tasks.onboarding.complete', async (_req, res) => {
    res.json(await completeTaskOnboarding(tasksActor(res)));
}));

// GET /approvals — offene Abschlussanfragen und Vorschläge (Leitung).
router.get('/approvals', responseCache({ namespaces: ['tasks'], ttlSec: 15 }), taskRoute('tasks.approvals.list', async (_req, res) => {
    // Onaylar-Seite: nur die Administratorrolle.
    assertSystemAdmin(tasksActor(res));
    res.json(await listTaskApprovals(tasksActor(res)));
}));

// POST /timer/pause — die eigene laufende Messung beenden, an welcher Aufgabe auch immer.
router.post('/timer/pause', taskRoute('tasks.timer.pauseAny', async (_req, res) => {
    const stopped = await pauseTaskTimer(tasksActor(res));
    res.json({ stopped, serverNow: new Date() });
}));

// GET /timer/active — was ich gerade messe (auch in einer anderen Firma).
router.get('/timer/active', taskRoute('tasks.timer.active', async (_req, res) => {
    const active = await getActiveTimer(tasksActor(res).employeeId);
    res.json({ active, serverNow: new Date() });
}));

// GET / — Liste, Pano (`view=board`) oder Schnellsuche (`view=search`).
router.get('/', responseCache({ namespaces: ['tasks'], ttlSec: 15 }), taskRoute('tasks.task.list', async (req, res) => {
    const actor = tasksActor(res);
    const query = parseListQuery(req.query);
    res.json(query.view === 'search' ? await searchTasks(actor, query) : await listTasks(actor, query));
}));

// POST / — anlegen; ein Teammitglied legt einen Vorschlag für die Leitung an.
router.post('/', taskRoute('tasks.task.create', async (req, res) => {
    const created = await createTask(tasksActor(res), parseInput(createBody, req.body));
    res.status(201).json(created);
}));

/* ── Eine Aufgabe ───────────────────────────────────────────────────────── */

// GET /:taskId — Detail mit Rechten, Inhalt, Checklisten, Dateien, Räumen, Prognose (Zeiten nur Leitung).
router.get('/:taskId', taskRoute('tasks.task.detail', async (req, res) => {
    res.json(await getTaskDetail(tasksActor(res), routeParam(req, 'taskId')));
}));

// PATCH /:taskId — Titel, Beschreibung, Termine, Fahne, Priorität.
router.patch('/:taskId', taskRoute('tasks.task.update', async (req, res) => {
    res.json(await updateTask(tasksActor(res), routeParam(req, 'taskId'), parseInput(updateBody, req.body)));
}));

// DELETE /:taskId — endgültig (tasks.delete); Dateien gehen mit, Eintrag im Prüfprotokoll.
router.delete('/:taskId', taskRoute('tasks.task.delete', async (req, res) => {
    await deleteTask(tasksActor(res), routeParam(req, 'taskId'), auditLog.context(req));
    res.status(204).end();
}));

// POST /:taskId/delete-request — Löschen beantragen (Nicht-Admins: verantwortlich oder angelegt).
router.post('/:taskId/delete-request', taskRoute('tasks.delete.request', async (req, res) => {
    res.json(await requestTaskDeletion(tasksActor(res), routeParam(req, 'taskId'), parseInput(noteBody, req.body)));
}));

// DELETE /:taskId/delete-request — Löschanfrage zurückziehen.
router.delete('/:taskId/delete-request', taskRoute('tasks.delete.cancel', async (req, res) => {
    res.json(await cancelTaskDeletionRequest(tasksActor(res), routeParam(req, 'taskId')));
}));

// POST /:taskId/delete-request/reject — Löschanfrage ablehnen (Admin). Bestätigen = DELETE /:taskId.
router.post('/:taskId/delete-request/reject', taskRoute('tasks.delete.reject', async (req, res) => {
    res.json(await rejectTaskDeletion(tasksActor(res), routeParam(req, 'taskId'), parseInput(noteBody, req.body)));
}));

// POST /:taskId/duplicate — Kopie mit Checklisten, Dateien und Inhalt (Leitung).
router.post('/:taskId/duplicate', taskRoute('tasks.task.duplicate', async (req, res) => {
    const created = await duplicateTask(tasksActor(res), routeParam(req, 'taskId'), parseInput(duplicateBody, req.body));
    res.status(201).json(created);
}));

// POST /:taskId/status — Status von Hand (Leitung); BLOCKED braucht einen Grund.
router.post('/:taskId/status', taskRoute('tasks.task.status', async (req, res) => {
    res.json(await setTaskStatus(tasksActor(res), routeParam(req, 'taskId'), parseInput(statusBody, req.body)));
}));

// POST /:taskId/block — «Yapılamadı» mit Grund; leerer Grund hebt die Blockade auf (Leitung).
router.post('/:taskId/block', taskRoute('tasks.task.block', async (req, res) => {
    res.json(await blockTask(tasksActor(res), routeParam(req, 'taskId'), parseInput(blockBody, req.body)));
}));

// POST /:taskId/completion-request — Abschluss beantragen (Verantwortliche); die eigene Messung endet.
router.post('/:taskId/completion-request', taskRoute('tasks.completion.request', async (req, res) => {
    res.json(await requestTaskCompletion(tasksActor(res), routeParam(req, 'taskId'), parseInput(noteBody, req.body)));
}));

// DELETE /:taskId/completion-request — Anfrage zurückziehen (wer beantragt hat oder die Leitung).
router.delete('/:taskId/completion-request', taskRoute('tasks.completion.cancel', async (req, res) => {
    res.json(await cancelTaskCompletionRequest(tasksActor(res), routeParam(req, 'taskId')));
}));

// POST /:taskId/completion-request/approve — Abschluss bestätigen (Leitung).
router.post('/:taskId/completion-request/approve', taskRoute('tasks.completion.approve', async (req, res) => {
    res.json(await approveTaskCompletion(tasksActor(res), routeParam(req, 'taskId'), parseInput(noteBody, req.body)));
}));

// POST /:taskId/completion-request/reject — Abschluss ablehnen, mit Begründung (Leitung).
router.post('/:taskId/completion-request/reject', taskRoute('tasks.completion.reject', async (req, res) => {
    res.json(await rejectTaskCompletion(tasksActor(res), routeParam(req, 'taskId'), parseInput(noteBody, req.body)));
}));

// POST /:taskId/review/approve — Vorschlag freigeben (Leitung).
router.post('/:taskId/review/approve', taskRoute('tasks.review.approve', async (req, res) => {
    res.json(await approveTaskReview(tasksActor(res), routeParam(req, 'taskId'), parseInput(noteBody, req.body)));
}));

// POST /:taskId/review/reject — Vorschlag ablehnen, mit Begründung (Leitung).
router.post('/:taskId/review/reject', taskRoute('tasks.review.reject', async (req, res) => {
    res.json(await rejectTaskReview(tasksActor(res), routeParam(req, 'taskId'), parseInput(noteBody, req.body)));
}));

// PUT /:taskId/assignees — Verantwortliche ersetzen (Leitung).
router.put('/:taskId/assignees', taskRoute('tasks.task.assignees', async (req, res) => {
    res.json(await setTaskAssignees(tasksActor(res), routeParam(req, 'taskId'), parseInput(assigneesBody, req.body)));
}));

// PUT /:taskId/labels — Etiketten ersetzen (wer bearbeiten darf).
router.put('/:taskId/labels', taskRoute('tasks.task.labels', async (req, res) => {
    res.json(await setTaskLabels(tasksActor(res), routeParam(req, 'taskId'), parseInput(labelsBody, req.body)));
}));

// POST /:taskId/move — Karte auf der Pano ablegen, auch in eine andere Spalte (Leitung).
router.post('/:taskId/move', taskRoute('tasks.task.move', async (req, res) => {
    res.json(await moveTask(tasksActor(res), routeParam(req, 'taskId'), parseInput(moveBody, req.body)));
}));

// GET /:taskId/activity — Verlauf, neueste zuerst (Leitung).
router.get('/:taskId/activity', responseCache({ namespaces: ['tasks'], ttlSec: 15 }), taskRoute('tasks.task.activity', async (req, res) => {
    res.json(await listTaskActivity(tasksActor(res), routeParam(req, 'taskId')));
}));

// POST /:taskId/timer/start — Messung starten; eine andere laufende endet dabei.
router.post('/:taskId/timer/start', taskRoute('tasks.timer.start', async (req, res) => {
    const timer = await startTaskTimer(tasksActor(res), routeParam(req, 'taskId'));
    res.json({ timer, serverNow: new Date() });
}));

// POST /:taskId/timer/pause — die eigene Messung an genau dieser Aufgabe beenden.
router.post('/:taskId/timer/pause', taskRoute('tasks.timer.pause', async (req, res) => {
    const stopped = await pauseTaskTimer(tasksActor(res), { taskId: routeParam(req, 'taskId') });
    res.json({ stopped, serverNow: new Date() });
}));

export default router;
