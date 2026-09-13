import { Router } from 'express';
import { z } from 'zod';

import {
    addChecklist,
    addChecklistItem,
    checkAllItems,
    clearDoneItems,
    deleteChecklist,
    deleteChecklistItem,
    moveChecklistItem,
    renameChecklist,
    toggleChecklistItem,
    updateChecklistItem,
} from '../../../application/services/tasks/checklistService';
import { saveTaskContent } from '../../../application/services/tasks/contentService';
import { TASK_LIMITS } from '../../../application/services/tasks/taskConstants';
import { parseInput, routeParam, taskRoute, zId, zLine, zNullableDate, zRequiredLine } from './taskHttp';
import { tasksActor } from './taskMiddleware';

/**
 * ── INHALT UND CHECKLISTEN (Görevler, Reiter «İçerik») ─────────────────────
 *
 * Unter `/api/v1/tasks`, hinter requireAuth + requireTasksAccess. Die Wege
 * prüfen nur die Form der Eingabe; wer was darf und was gespeichert wird,
 * entscheiden contentService und checklistService. Feste Pfade stehen vor
 * `/:taskId…`.
 */

const router = Router();

const contentSchema = z.object({
    /** Roh — jede Regel steht in normalizeContentBlocks. */
    blocks: z.array(z.unknown()),
    baseVersion: z.number().int().min(0),
});

const newChecklistSchema = z.object({
    title: zLine(TASK_LIMITS.checklistTitleMax).optional(),
    appendBlock: z.boolean().optional(),
    afterBlockId: z.string().max(TASK_LIMITS.blockIdMax).nullish(),
});

/* Leer erlaubt (13.09.2026, Samet): kein vorgegebener Titel — die Oberfläche
   zeigt dann nur einen blassen Platzhalter. */
const renameChecklistSchema = z.object({
    title: zLine(TASK_LIMITS.checklistTitleMax),
});

const newItemSchema = z.object({
    /** Vom Browser vergebene Kennung (sofort sichtbarer Punkt, kein Tausch nach der Antwort). */
    id: z.string().regex(/^[A-Za-z0-9_-]{12,21}$/).optional(),
    text: zRequiredLine(TASK_LIMITS.checklistItemTextMax),
    afterItemId: zId.nullish(),
    assigneeId: zId.nullish(),
    dueAt: zNullableDate.optional(),
    reminderAt: zNullableDate.optional(),
    flagged: z.boolean().optional(),
});

/** Görevly speichert auch einen geleerten Punkt — darum darf `text` hier leer sein. */
const itemPatchSchema = z.object({
    text: zLine(TASK_LIMITS.checklistItemTextMax).optional(),
    assigneeId: zId.nullable().optional(),
    dueAt: zNullableDate.optional(),
    reminderAt: zNullableDate.optional(),
    flagged: z.boolean().optional(),
});

const toggleSchema = z.object({ done: z.boolean().optional() });

const moveSchema = z.object({ direction: z.enum(['up', 'down']) });

/* ── Checklisten ────────────────────────────────────────────────────────── */

router.patch('/checklists/:checklistId', taskRoute('tasks.checklist.rename', async (req, res) => {
    const { title } = parseInput(renameChecklistSchema, req.body);
    res.json(await renameChecklist(tasksActor(res), routeParam(req, 'checklistId'), title));
}));

router.delete('/checklists/:checklistId', taskRoute('tasks.checklist.delete', async (req, res) => {
    res.json(await deleteChecklist(tasksActor(res), routeParam(req, 'checklistId')));
}));

router.post('/checklists/:checklistId/items', taskRoute('tasks.checklistItem.create', async (req, res) => {
    const input = parseInput(newItemSchema, req.body);
    res.status(201).json(await addChecklistItem(tasksActor(res), routeParam(req, 'checklistId'), input));
}));

router.post('/checklists/:checklistId/check-all', taskRoute('tasks.checklist.checkAll', async (req, res) => {
    res.json(await checkAllItems(tasksActor(res), routeParam(req, 'checklistId')));
}));

router.post('/checklists/:checklistId/clear-done', taskRoute('tasks.checklist.clearDone', async (req, res) => {
    res.json(await clearDoneItems(tasksActor(res), routeParam(req, 'checklistId')));
}));

/* ── Checklistenpunkte ──────────────────────────────────────────────────── */

router.patch('/checklist-items/:itemId', taskRoute('tasks.checklistItem.update', async (req, res) => {
    const patch = parseInput(itemPatchSchema, req.body);
    res.json(await updateChecklistItem(tasksActor(res), routeParam(req, 'itemId'), patch));
}));

router.delete('/checklist-items/:itemId', taskRoute('tasks.checklistItem.delete', async (req, res) => {
    res.json(await deleteChecklistItem(tasksActor(res), routeParam(req, 'itemId')));
}));

router.post('/checklist-items/:itemId/toggle', taskRoute('tasks.checklistItem.toggle', async (req, res) => {
    const { done } = parseInput(toggleSchema, req.body);
    res.json(await toggleChecklistItem(tasksActor(res), routeParam(req, 'itemId'), done));
}));

router.post('/checklist-items/:itemId/move', taskRoute('tasks.checklistItem.move', async (req, res) => {
    const { direction } = parseInput(moveSchema, req.body);
    res.json(await moveChecklistItem(tasksActor(res), routeParam(req, 'itemId'), direction));
}));

/* ── Je Aufgabe ─────────────────────────────────────────────────────────── */

router.put('/:taskId/content', taskRoute('tasks.content.save', async (req, res) => {
    const input = parseInput(contentSchema, req.body);
    res.json(await saveTaskContent(tasksActor(res), routeParam(req, 'taskId'), input));
}));

router.post('/:taskId/checklists', taskRoute('tasks.checklist.create', async (req, res) => {
    const input = parseInput(newChecklistSchema, req.body);
    res.status(201).json(await addChecklist(tasksActor(res), routeParam(req, 'taskId'), input));
}));

export default router;
