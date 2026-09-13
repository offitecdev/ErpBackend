"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const checklistService_1 = require("../../../application/services/tasks/checklistService");
const contentService_1 = require("../../../application/services/tasks/contentService");
const taskConstants_1 = require("../../../application/services/tasks/taskConstants");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
/**
 * ── INHALT UND CHECKLISTEN (Görevler, Reiter «İçerik») ─────────────────────
 *
 * Unter `/api/v1/tasks`, hinter requireAuth + requireTasksAccess. Die Wege
 * prüfen nur die Form der Eingabe; wer was darf und was gespeichert wird,
 * entscheiden contentService und checklistService. Feste Pfade stehen vor
 * `/:taskId…`.
 */
const router = (0, express_1.Router)();
const contentSchema = zod_1.z.object({
    /** Roh — jede Regel steht in normalizeContentBlocks. */
    blocks: zod_1.z.array(zod_1.z.unknown()),
    baseVersion: zod_1.z.number().int().min(0),
});
const newChecklistSchema = zod_1.z.object({
    title: (0, taskHttp_1.zLine)(taskConstants_1.TASK_LIMITS.checklistTitleMax).optional(),
    appendBlock: zod_1.z.boolean().optional(),
    afterBlockId: zod_1.z.string().max(taskConstants_1.TASK_LIMITS.blockIdMax).nullish(),
});
/* Leer erlaubt (13.09.2026, Samet): kein vorgegebener Titel — die Oberfläche
   zeigt dann nur einen blassen Platzhalter. */
const renameChecklistSchema = zod_1.z.object({
    title: (0, taskHttp_1.zLine)(taskConstants_1.TASK_LIMITS.checklistTitleMax),
});
const newItemSchema = zod_1.z.object({
    /** Vom Browser vergebene Kennung (sofort sichtbarer Punkt, kein Tausch nach der Antwort). */
    id: zod_1.z.string().regex(/^[A-Za-z0-9_-]{12,21}$/).optional(),
    text: (0, taskHttp_1.zRequiredLine)(taskConstants_1.TASK_LIMITS.checklistItemTextMax),
    afterItemId: taskHttp_1.zId.nullish(),
    assigneeId: taskHttp_1.zId.nullish(),
    dueAt: taskHttp_1.zNullableDate.optional(),
    reminderAt: taskHttp_1.zNullableDate.optional(),
    flagged: zod_1.z.boolean().optional(),
});
/** Görevly speichert auch einen geleerten Punkt — darum darf `text` hier leer sein. */
const itemPatchSchema = zod_1.z.object({
    text: (0, taskHttp_1.zLine)(taskConstants_1.TASK_LIMITS.checklistItemTextMax).optional(),
    assigneeId: taskHttp_1.zId.nullable().optional(),
    dueAt: taskHttp_1.zNullableDate.optional(),
    reminderAt: taskHttp_1.zNullableDate.optional(),
    flagged: zod_1.z.boolean().optional(),
});
const toggleSchema = zod_1.z.object({ done: zod_1.z.boolean().optional() });
const moveSchema = zod_1.z.object({ direction: zod_1.z.enum(['up', 'down']) });
/* ── Checklisten ────────────────────────────────────────────────────────── */
router.patch('/checklists/:checklistId', (0, taskHttp_1.taskRoute)('tasks.checklist.rename', async (req, res) => {
    const { title } = (0, taskHttp_1.parseInput)(renameChecklistSchema, req.body);
    res.json(await (0, checklistService_1.renameChecklist)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'checklistId'), title));
}));
router.delete('/checklists/:checklistId', (0, taskHttp_1.taskRoute)('tasks.checklist.delete', async (req, res) => {
    res.json(await (0, checklistService_1.deleteChecklist)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'checklistId')));
}));
router.post('/checklists/:checklistId/items', (0, taskHttp_1.taskRoute)('tasks.checklistItem.create', async (req, res) => {
    const input = (0, taskHttp_1.parseInput)(newItemSchema, req.body);
    res.status(201).json(await (0, checklistService_1.addChecklistItem)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'checklistId'), input));
}));
router.post('/checklists/:checklistId/check-all', (0, taskHttp_1.taskRoute)('tasks.checklist.checkAll', async (req, res) => {
    res.json(await (0, checklistService_1.checkAllItems)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'checklistId')));
}));
router.post('/checklists/:checklistId/clear-done', (0, taskHttp_1.taskRoute)('tasks.checklist.clearDone', async (req, res) => {
    res.json(await (0, checklistService_1.clearDoneItems)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'checklistId')));
}));
/* ── Checklistenpunkte ──────────────────────────────────────────────────── */
router.patch('/checklist-items/:itemId', (0, taskHttp_1.taskRoute)('tasks.checklistItem.update', async (req, res) => {
    const patch = (0, taskHttp_1.parseInput)(itemPatchSchema, req.body);
    res.json(await (0, checklistService_1.updateChecklistItem)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'itemId'), patch));
}));
router.delete('/checklist-items/:itemId', (0, taskHttp_1.taskRoute)('tasks.checklistItem.delete', async (req, res) => {
    res.json(await (0, checklistService_1.deleteChecklistItem)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'itemId')));
}));
router.post('/checklist-items/:itemId/toggle', (0, taskHttp_1.taskRoute)('tasks.checklistItem.toggle', async (req, res) => {
    const { done } = (0, taskHttp_1.parseInput)(toggleSchema, req.body);
    res.json(await (0, checklistService_1.toggleChecklistItem)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'itemId'), done));
}));
router.post('/checklist-items/:itemId/move', (0, taskHttp_1.taskRoute)('tasks.checklistItem.move', async (req, res) => {
    const { direction } = (0, taskHttp_1.parseInput)(moveSchema, req.body);
    res.json(await (0, checklistService_1.moveChecklistItem)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'itemId'), direction));
}));
/* ── Je Aufgabe ─────────────────────────────────────────────────────────── */
router.put('/:taskId/content', (0, taskHttp_1.taskRoute)('tasks.content.save', async (req, res) => {
    const input = (0, taskHttp_1.parseInput)(contentSchema, req.body);
    res.json(await (0, contentService_1.saveTaskContent)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), input));
}));
router.post('/:taskId/checklists', (0, taskHttp_1.taskRoute)('tasks.checklist.create', async (req, res) => {
    const input = (0, taskHttp_1.parseInput)(newChecklistSchema, req.body);
    res.status(201).json(await (0, checklistService_1.addChecklist)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), input));
}));
exports.default = router;
//# sourceMappingURL=content.routes.js.map