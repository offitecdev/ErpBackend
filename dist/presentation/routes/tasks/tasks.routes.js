"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const taskConstants_1 = require("../../../application/services/tasks/taskConstants");
const taskQueries_1 = require("../../../application/services/tasks/taskQueries");
const taskService_1 = require("../../../application/services/tasks/taskService");
const taskTimer_1 = require("../../../application/services/tasks/taskTimer");
const AuditLogService_1 = require("../../../infrastructure/services/AuditLogService");
const taskHttp_1 = require("./taskHttp");
const taskActor_1 = require("../../../application/services/tasks/taskActor");
const taskMiddleware_1 = require("./taskMiddleware");
const taskOnboarding_1 = require("../../../application/services/tasks/taskOnboarding");
const ResponseCacheMiddleware_1 = require("../../middlewares/ResponseCacheMiddleware");
const taskTime_1 = require("../../../application/services/tasks/taskTime");
/* AUFGABEN (Görevler), montiert unter /api/v1/tasks: Start und Zähler, Liste,
   Pano und Suche, Anfragen der Leitung, Anlegen, Detail, Bearbeiten, Löschen,
   Duplizieren, alle Zustandswechsel, Verantwortliche, Etiketten, Verlauf und
   Zeitmessung. Anmeldung und Modulzugang prüft index.ts davor; wer was darf,
   entscheiden taskService (schreiben) und taskQueries (lesen).
   Feste Pfade vor Parameterpfaden. */
const router = (0, express_1.Router)();
/* ── Eingaben ───────────────────────────────────────────────────────────── */
/** Vertrag: höchstens 50 Verantwortliche je Aufgabe. */
const ASSIGNEES_MAX = 50;
const dateField = taskHttp_1.zNullableDate.optional();
const noteText = (0, taskHttp_1.zText)(taskConstants_1.TASK_LIMITS.noteMax);
const createBody = zod_1.z.object({
    title: (0, taskHttp_1.zRequiredLine)(taskConstants_1.TASK_LIMITS.titleMax),
    description: (0, taskHttp_1.zText)(taskConstants_1.TASK_LIMITS.descriptionMax).nullable().optional(),
    assigneeIds: (0, taskHttp_1.zIdList)(ASSIGNEES_MAX).optional(),
    startAt: dateField,
    dueAt: dateField,
    reminderAt: dateField,
    flagged: zod_1.z.boolean().optional(),
    labelIds: (0, taskHttp_1.zIdList)().optional(),
    priority: zod_1.z.enum(taskConstants_1.TASK_PRIORITIES).optional(),
});
const updateBody = zod_1.z.object({
    title: (0, taskHttp_1.zRequiredLine)(taskConstants_1.TASK_LIMITS.titleMax).optional(),
    description: (0, taskHttp_1.zText)(taskConstants_1.TASK_LIMITS.descriptionMax).nullable().optional(),
    startAt: dateField,
    dueAt: dateField,
    reminderAt: dateField,
    flagged: zod_1.z.boolean().optional(),
    priority: zod_1.z.enum(taskConstants_1.TASK_PRIORITIES).optional(),
});
const duplicateBody = zod_1.z.object({ title: (0, taskHttp_1.zLine)(taskConstants_1.TASK_LIMITS.titleMax).optional() });
const noteBody = zod_1.z.object({ note: noteText.optional() });
/** `delayReason` Pflicht, sobald die Aufgabe überfällig ist (prüft der Dienst). */
const completionRequestBody = zod_1.z.object({ note: noteText.optional(), delayReason: noteText.optional() });
/** Zeitpunkt des Klicks; der Dienst begrenzt ihn gegen die Empfangszeit. */
const statusBody = zod_1.z.object({ status: zod_1.z.enum(taskConstants_1.MANUAL_TASK_STATUSES), reason: noteText.optional() });
/** `reason` muss mitkommen: leer oder null hebt die Blockade auf — ein vergessenes Feld soll das nicht. */
const blockBody = zod_1.z.object({ reason: noteText.nullable() });
const assigneesBody = zod_1.z.object({ employeeIds: (0, taskHttp_1.zIdList)(ASSIGNEES_MAX) });
const labelsBody = zod_1.z.object({ labelIds: (0, taskHttp_1.zIdList)() });
const moveBody = zod_1.z.object({
    status: zod_1.z.enum(taskConstants_1.MANUAL_TASK_STATUSES).optional(),
    reason: noteText.optional(),
    beforeTaskId: taskHttp_1.zId.nullable().optional(),
    afterTaskId: taskHttp_1.zId.nullable().optional(),
});
/** Erlaubter Wert aus der Abfragezeile, sonst der Standard. */
const queryChoice = (value, allowed, fallback) => {
    const raw = (0, taskHttp_1.queryString)(value, 32);
    return allowed.find((option) => option === raw) ?? fallback;
};
/** Zeitraum aus `from`/`to` (ISO); unvollständig, verkehrt oder über 400 Tage = ohne Zeitraum. */
const queryRange = (fromRaw, toRaw) => {
    const from = new Date((0, taskHttp_1.queryString)(fromRaw, 40));
    const to = new Date((0, taskHttp_1.queryString)(toRaw, 40));
    const valid = Number.isFinite(from.getTime()) && Number.isFinite(to.getTime())
        && to.getTime() >= from.getTime() && to.getTime() - from.getTime() <= 400 * 86_400_000;
    return valid ? { from, to } : { from: null, to: null };
};
const parseListQuery = (query) => ({
    filter: queryChoice(query.filter, taskQueries_1.TASK_LIST_FILTERS, 'open'),
    scope: queryChoice(query.scope, taskQueries_1.TASK_LIST_SCOPES, 'all'),
    view: queryChoice(query.view, taskQueries_1.TASK_LIST_VIEWS, 'list'),
    sort: queryChoice(query.sort, taskQueries_1.TASK_LIST_SORTS, 'due'),
    dir: queryChoice(query.dir, taskQueries_1.SORT_DIRECTIONS, 'asc'),
    assigneeId: (0, taskHttp_1.queryString)(query.assigneeId, 64),
    labelId: (0, taskHttp_1.queryString)(query.labelId, 64),
    status: (0, taskHttp_1.queryString)(query.status, 24),
    flagged: (0, taskHttp_1.queryFlag)(query.flagged),
    q: (0, taskHttp_1.queryString)(query.q, 100),
    ...queryRange(query.from, query.to),
    day: (0, taskTime_1.resolveDayWindow)(query.dayFrom, query.dayTo),
    page: (0, taskHttp_1.queryInt)(query.page, 1, 1, 1_000_000),
    pageSize: (0, taskHttp_1.queryInt)(query.pageSize, taskConstants_1.TASK_LIMITS.listPageSizeDefault, 1, taskConstants_1.TASK_LIMITS.listPageSizeMax),
});
/* ── Feste Pfade ────────────────────────────────────────────────────────── */
// GET /bootstrap — Start der Seite: Rolle, Etiketten, eigene Einstellungen, Zähler.
router.get('/bootstrap', (0, taskHttp_1.taskRoute)('tasks.bootstrap', async (_req, res) => {
    res.json(await (0, taskQueries_1.getTasksBootstrap)((0, taskMiddleware_1.tasksActor)(res)));
}));
// GET /summary — Zähler der Seitenleiste und die eigene laufende Messung.
router.get('/summary', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 15 }), (0, taskHttp_1.taskRoute)('tasks.summary', async (_req, res) => {
    res.json(await (0, taskQueries_1.getTasksSummary)((0, taskMiddleware_1.tasksActor)(res)));
}));
// POST /onboarding/complete — role-specific guide finished; idempotent.
router.post('/onboarding/complete', (0, taskHttp_1.taskRoute)('tasks.onboarding.complete', async (_req, res) => {
    res.json(await (0, taskOnboarding_1.completeTaskOnboarding)((0, taskMiddleware_1.tasksActor)(res)));
}));
// GET /approvals — offene Abschlussanfragen und Vorschläge (Leitung).
router.get('/approvals', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 15 }), (0, taskHttp_1.taskRoute)('tasks.approvals.list', async (_req, res) => {
    // Onaylar-Seite: nur die Administratorrolle.
    (0, taskActor_1.assertSystemAdmin)((0, taskMiddleware_1.tasksActor)(res));
    res.json(await (0, taskQueries_1.listTaskApprovals)((0, taskMiddleware_1.tasksActor)(res)));
}));
// POST /timer/pause — die eigene laufende Messung beenden, an welcher Aufgabe auch immer.
router.post('/timer/pause', (0, taskHttp_1.taskRoute)('tasks.timer.pauseAny', async (req, res) => {
    const stopped = await (0, taskTimer_1.pauseTaskTimer)((0, taskMiddleware_1.tasksActor)(res));
    res.json({ stopped, serverNow: new Date() });
}));
// GET /timer/active — was ich gerade messe (auch in einer anderen Firma).
router.get('/timer/active', (0, taskHttp_1.taskRoute)('tasks.timer.active', async (_req, res) => {
    const active = await (0, taskTimer_1.getActiveTimer)((0, taskMiddleware_1.tasksActor)(res).employeeId);
    res.json({ active, serverNow: new Date() });
}));
// GET / — Liste, Pano (`view=board`) oder Schnellsuche (`view=search`).
router.get('/', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 15 }), (0, taskHttp_1.taskRoute)('tasks.task.list', async (req, res) => {
    const actor = (0, taskMiddleware_1.tasksActor)(res);
    const query = parseListQuery(req.query);
    res.json(query.view === 'search' ? await (0, taskQueries_1.searchTasks)(actor, query) : await (0, taskQueries_1.listTasks)(actor, query));
}));
// POST / — anlegen; ein Teammitglied legt einen Vorschlag für die Leitung an.
router.post('/', (0, taskHttp_1.taskRoute)('tasks.task.create', async (req, res) => {
    const created = await (0, taskService_1.createTask)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.parseInput)(createBody, req.body));
    res.status(201).json(created);
}));
/* ── Eine Aufgabe ───────────────────────────────────────────────────────── */
// GET /:taskId — Detail mit Rechten, Inhalt, Checklisten, Dateien, Räumen, Prognose (Zeiten nur Leitung).
router.get('/:taskId', (0, taskHttp_1.taskRoute)('tasks.task.detail', async (req, res) => {
    res.json(await (0, taskQueries_1.getTaskDetail)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskTime_1.resolveDayWindow)(req.query.dayFrom, req.query.dayTo)));
}));
// PATCH /:taskId — Titel, Beschreibung, Termine, Fahne, Priorität.
router.patch('/:taskId', (0, taskHttp_1.taskRoute)('tasks.task.update', async (req, res) => {
    res.json(await (0, taskService_1.updateTask)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(updateBody, req.body)));
}));
// DELETE /:taskId — endgültig (tasks.delete); Dateien gehen mit, Eintrag im Prüfprotokoll.
router.delete('/:taskId', (0, taskHttp_1.taskRoute)('tasks.task.delete', async (req, res) => {
    await (0, taskService_1.deleteTask)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), AuditLogService_1.auditLog.context(req));
    res.status(204).end();
}));
// POST /:taskId/delete-request — Löschen beantragen (Nicht-Admins: verantwortlich oder angelegt).
router.post('/:taskId/delete-request', (0, taskHttp_1.taskRoute)('tasks.delete.request', async (req, res) => {
    res.json(await (0, taskService_1.requestTaskDeletion)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(noteBody, req.body)));
}));
// DELETE /:taskId/delete-request — Löschanfrage zurückziehen.
router.delete('/:taskId/delete-request', (0, taskHttp_1.taskRoute)('tasks.delete.cancel', async (req, res) => {
    res.json(await (0, taskService_1.cancelTaskDeletionRequest)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId')));
}));
// POST /:taskId/delete-request/reject — Löschanfrage ablehnen (Admin). Bestätigen = DELETE /:taskId.
router.post('/:taskId/delete-request/reject', (0, taskHttp_1.taskRoute)('tasks.delete.reject', async (req, res) => {
    res.json(await (0, taskService_1.rejectTaskDeletion)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(noteBody, req.body)));
}));
// POST /:taskId/partner-request — «Ortak ekle» beantragen: GENAU EINE Person (Nicht-Admins, verantwortlich).
const partnerBody = zod_1.z.object({ employeeId: taskHttp_1.zId }).strict();
router.post('/:taskId/partner-request', (0, taskHttp_1.taskRoute)('tasks.partner.request', async (req, res) => {
    res.json(await (0, taskService_1.requestTaskPartner)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(partnerBody, req.body)));
}));
// DELETE /:taskId/partner-request — Ortak-Anfrage zurückziehen.
router.delete('/:taskId/partner-request', (0, taskHttp_1.taskRoute)('tasks.partner.cancel', async (req, res) => {
    res.json(await (0, taskService_1.cancelTaskPartnerRequest)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId')));
}));
// POST /:taskId/partner-request/approve — Person aufnehmen (Administratorrolle).
router.post('/:taskId/partner-request/approve', (0, taskHttp_1.taskRoute)('tasks.partner.approve', async (req, res) => {
    res.json(await (0, taskService_1.approveTaskPartner)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId')));
}));
// POST /:taskId/partner-request/reject — Ortak-Anfrage ablehnen (Administratorrolle).
router.post('/:taskId/partner-request/reject', (0, taskHttp_1.taskRoute)('tasks.partner.reject', async (req, res) => {
    res.json(await (0, taskService_1.rejectTaskPartner)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(noteBody, req.body)));
}));
// POST /:taskId/duplicate — Kopie mit Checklisten, Dateien und Inhalt (Leitung).
router.post('/:taskId/duplicate', (0, taskHttp_1.taskRoute)('tasks.task.duplicate', async (req, res) => {
    const created = await (0, taskService_1.duplicateTask)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(duplicateBody, req.body));
    res.status(201).json(created);
}));
// POST /:taskId/status — Status von Hand (Leitung); BLOCKED braucht einen Grund.
router.post('/:taskId/status', (0, taskHttp_1.taskRoute)('tasks.task.status', async (req, res) => {
    res.json(await (0, taskService_1.setTaskStatus)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(statusBody, req.body)));
}));
// POST /:taskId/block — «Yapılamadı» mit Grund; leerer Grund hebt die Blockade auf (Leitung).
router.post('/:taskId/block', (0, taskHttp_1.taskRoute)('tasks.task.block', async (req, res) => {
    res.json(await (0, taskService_1.blockTask)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(blockBody, req.body)));
}));
// POST /:taskId/completion-request — Abschluss beantragen (Verantwortliche); die eigene Messung endet.
router.post('/:taskId/completion-request', (0, taskHttp_1.taskRoute)('tasks.completion.request', async (req, res) => {
    res.json(await (0, taskService_1.requestTaskCompletion)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(completionRequestBody, req.body)));
}));
// DELETE /:taskId/completion-request — Anfrage zurückziehen (wer beantragt hat oder die Leitung).
router.delete('/:taskId/completion-request', (0, taskHttp_1.taskRoute)('tasks.completion.cancel', async (req, res) => {
    res.json(await (0, taskService_1.cancelTaskCompletionRequest)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId')));
}));
// POST /:taskId/completion-request/approve — Abschluss bestätigen (Leitung).
router.post('/:taskId/completion-request/approve', (0, taskHttp_1.taskRoute)('tasks.completion.approve', async (req, res) => {
    res.json(await (0, taskService_1.approveTaskCompletion)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(noteBody, req.body)));
}));
// POST /:taskId/completion-request/reject — Abschluss ablehnen, mit Begründung (Leitung).
router.post('/:taskId/completion-request/reject', (0, taskHttp_1.taskRoute)('tasks.completion.reject', async (req, res) => {
    res.json(await (0, taskService_1.rejectTaskCompletion)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(noteBody, req.body)));
}));
// POST /:taskId/review/approve — Vorschlag freigeben (Leitung).
router.post('/:taskId/review/approve', (0, taskHttp_1.taskRoute)('tasks.review.approve', async (req, res) => {
    res.json(await (0, taskService_1.approveTaskReview)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(noteBody, req.body)));
}));
// POST /:taskId/review/reject — Vorschlag ablehnen, mit Begründung (Leitung).
router.post('/:taskId/review/reject', (0, taskHttp_1.taskRoute)('tasks.review.reject', async (req, res) => {
    res.json(await (0, taskService_1.rejectTaskReview)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(noteBody, req.body)));
}));
// PUT /:taskId/assignees — Verantwortliche ersetzen (Leitung).
router.put('/:taskId/assignees', (0, taskHttp_1.taskRoute)('tasks.task.assignees', async (req, res) => {
    res.json(await (0, taskService_1.setTaskAssignees)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(assigneesBody, req.body)));
}));
// PUT /:taskId/labels — Etiketten ersetzen (wer bearbeiten darf).
router.put('/:taskId/labels', (0, taskHttp_1.taskRoute)('tasks.task.labels', async (req, res) => {
    res.json(await (0, taskService_1.setTaskLabels)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(labelsBody, req.body)));
}));
// POST /:taskId/move — Karte auf der Pano ablegen, auch in eine andere Spalte (Leitung).
router.post('/:taskId/move', (0, taskHttp_1.taskRoute)('tasks.task.move', async (req, res) => {
    res.json(await (0, taskService_1.moveTask)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.parseInput)(moveBody, req.body)));
}));
// GET /:taskId/activity — Verlauf, neueste zuerst (Leitung).
router.get('/:taskId/activity', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 15 }), (0, taskHttp_1.taskRoute)('tasks.task.activity', async (req, res) => {
    res.json(await (0, taskQueries_1.listTaskActivity)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId')));
}));
// POST /:taskId/timer/start — Messung starten; eine andere laufende endet dabei.
router.post('/:taskId/timer/start', (0, taskHttp_1.taskRoute)('tasks.timer.start', async (req, res) => {
    const timer = await (0, taskTimer_1.startTaskTimer)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'));
    res.json({ timer, serverNow: new Date() });
}));
// POST /:taskId/timer/pause — die eigene Messung an genau dieser Aufgabe beenden.
router.post('/:taskId/timer/pause', (0, taskHttp_1.taskRoute)('tasks.timer.pause', async (req, res) => {
    const stopped = await (0, taskTimer_1.pauseTaskTimer)((0, taskMiddleware_1.tasksActor)(res), { taskId: (0, taskHttp_1.routeParam)(req, 'taskId') });
    res.json({ stopped, serverNow: new Date() });
}));
exports.default = router;
//# sourceMappingURL=tasks.routes.js.map