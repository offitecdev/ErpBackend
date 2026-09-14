"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const labelService_1 = require("../../../application/services/tasks/labelService");
const taskConstants_1 = require("../../../application/services/tasks/taskConstants");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
const ResponseCacheMiddleware_1 = require("../../middlewares/ResponseCacheMiddleware");
/* ETIKETTEN DER FIRMA, montiert unter /api/v1/tasks/labels. Lesen: jede Person
   des Moduls; anlegen, ändern, löschen: die Leitung (im labelService geprüft). */
const router = (0, express_1.Router)();
const labelColor = zod_1.z.enum(taskConstants_1.LABEL_COLORS);
const createBody = zod_1.z.object({
    name: (0, taskHttp_1.zRequiredLine)(taskConstants_1.TASK_LIMITS.labelNameMax),
    color: labelColor.optional(),
});
const patchBody = zod_1.z.object({
    name: (0, taskHttp_1.zLine)(taskConstants_1.TASK_LIMITS.labelNameMax).refine((value) => value.length > 0, { message: 'Darf nicht leer sein.' }).optional(),
    color: labelColor.optional(),
});
// GET /labels — alle Etiketten, nach Namen.
router.get('/', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 120 }), (0, taskHttp_1.taskRoute)('tasks.labels.list', async (_req, res) => {
    res.json({ data: await (0, labelService_1.listTaskLabels)((0, taskMiddleware_1.tasksActor)(res)) });
}));
// POST /labels — { name, color? }; doppelter Name → 409 LABEL_EXISTS.
router.post('/', (0, taskHttp_1.taskRoute)('tasks.labels.create', async (req, res) => {
    const body = (0, taskHttp_1.parseInput)(createBody, req.body);
    const label = await (0, labelService_1.createTaskLabel)((0, taskMiddleware_1.tasksActor)(res), { name: body.name, color: body.color });
    res.status(201).json({ label });
}));
// PATCH /labels/:labelId — { name?, color? }.
router.patch('/:labelId', (0, taskHttp_1.taskRoute)('tasks.labels.update', async (req, res) => {
    const body = (0, taskHttp_1.parseInput)(patchBody, req.body);
    const label = await (0, labelService_1.updateTaskLabel)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'labelId'), { name: body.name, color: body.color });
    res.json({ label });
}));
// DELETE /labels/:labelId — die Verknüpfungen an Aufgaben gehen per Kaskade mit.
router.delete('/:labelId', (0, taskHttp_1.taskRoute)('tasks.labels.delete', async (req, res) => {
    await (0, labelService_1.deleteTaskLabel)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'labelId'));
    res.status(204).end();
}));
exports.default = router;
//# sourceMappingURL=labels.routes.js.map