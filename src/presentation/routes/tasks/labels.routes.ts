import { Router } from 'express';
import { z } from 'zod';

import {
    createTaskLabel,
    deleteTaskLabel,
    listTaskLabels,
    updateTaskLabel,
} from '../../../application/services/tasks/labelService';
import { LABEL_COLORS, TASK_LIMITS } from '../../../application/services/tasks/taskConstants';
import { parseInput, routeParam, taskRoute, zLine, zRequiredLine } from './taskHttp';
import { tasksActor } from './taskMiddleware';

/* ETIKETTEN DER FIRMA, montiert unter /api/v1/tasks/labels. Lesen: jede Person
   des Moduls; anlegen, ändern, löschen: die Leitung (im labelService geprüft). */

const router = Router();

const labelColor = z.enum(LABEL_COLORS);

const createBody = z.object({
    name: zRequiredLine(TASK_LIMITS.labelNameMax),
    color: labelColor.optional(),
});

const patchBody = z.object({
    name: zLine(TASK_LIMITS.labelNameMax).refine((value) => value.length > 0, { message: 'Darf nicht leer sein.' }).optional(),
    color: labelColor.optional(),
});

// GET /labels — alle Etiketten, nach Namen.
router.get('/', taskRoute('tasks.labels.list', async (_req, res) => {
    res.json({ data: await listTaskLabels(tasksActor(res)) });
}));

// POST /labels — { name, color? }; doppelter Name → 409 LABEL_EXISTS.
router.post('/', taskRoute('tasks.labels.create', async (req, res) => {
    const body = parseInput(createBody, req.body);
    const label = await createTaskLabel(tasksActor(res), { name: body.name, color: body.color });
    res.status(201).json({ label });
}));

// PATCH /labels/:labelId — { name?, color? }.
router.patch('/:labelId', taskRoute('tasks.labels.update', async (req, res) => {
    const body = parseInput(patchBody, req.body);
    const label = await updateTaskLabel(tasksActor(res), routeParam(req, 'labelId'), { name: body.name, color: body.color });
    res.json({ label });
}));

// DELETE /labels/:labelId — die Verknüpfungen an Aufgaben gehen per Kaskade mit.
router.delete('/:labelId', taskRoute('tasks.labels.delete', async (req, res) => {
    await deleteTaskLabel(tasksActor(res), routeParam(req, 'labelId'));
    res.status(204).end();
}));

export default router;
