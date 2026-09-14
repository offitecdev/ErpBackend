"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const commentService_1 = require("../../../application/services/tasks/commentService");
const taskConstants_1 = require("../../../application/services/tasks/taskConstants");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
const ResponseCacheMiddleware_1 = require("../../middlewares/ResponseCacheMiddleware");
/* KOMMENTARE EINER AUFGABE (Reiter «Yorumlar»), montiert unter /api/v1/tasks.
   Anmeldung und Modulzugang prüft index.ts davor, die Regeln stehen im
   commentService. Feste Pfade vor Parameterpfaden. */
const router = (0, express_1.Router)();
/** JSON `{ text }` oder multipart mit dem Textfeld `text` und den Dateien `files`. */
const commentBody = zod_1.z.object({ text: (0, taskHttp_1.zText)(taskConstants_1.TASK_LIMITS.commentMax).optional() });
// DELETE /comments/:commentId — wer ihn geschrieben hat oder die Leitung; die Dateien gehen mit.
router.delete('/comments/:commentId', (0, taskHttp_1.taskRoute)('tasks.comments.delete', async (req, res) => {
    await (0, commentService_1.deleteTaskComment)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'commentId'));
    res.status(204).end();
}));
// GET /:taskId/comments — alle Kommentare samt Dateien, älteste zuerst.
router.get('/:taskId/comments', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 15 }), (0, taskHttp_1.taskRoute)('tasks.comments.list', async (req, res) => {
    res.json(await (0, commentService_1.listTaskComments)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId')));
}));
// POST /:taskId/comments — Text, Dateien oder beides.
router.post('/:taskId/comments', (0, taskHttp_1.withTaskUpload)(taskConstants_1.TASK_LIMITS.commentFilesMax), (0, taskHttp_1.taskRoute)('tasks.comments.create', async (req, res) => {
    const { text } = (0, taskHttp_1.parseInput)(commentBody, req.body);
    const created = await (0, commentService_1.addTaskComment)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), {
        text: text ?? '',
        files: (0, taskHttp_1.uploadedFiles)(req),
    });
    res.status(201).json(created);
}));
exports.default = router;
//# sourceMappingURL=comments.routes.js.map