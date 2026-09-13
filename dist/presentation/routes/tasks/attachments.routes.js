"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const attachmentService_1 = require("../../../application/services/tasks/attachmentService");
const taskConstants_1 = require("../../../application/services/tasks/taskConstants");
const taskFiles_1 = require("../../../application/services/tasks/taskFiles");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
/* DATEIEN DES GÖREVLER-MODULS, montiert unter /api/v1/tasks: der Reiter
   «Dosyalar» einer Aufgabe und der EINE Weg, auf dem der Browser die Bytes
   irgendeiner Moduldatei liest (Aufgabe, Kommentar, Chat). Anmeldung und
   Modulzugang prüft index.ts davor, die Regeln stehen im attachmentService.
   Feste Pfade vor Parameterpfaden. */
const router = (0, express_1.Router)();
/* GET /attachments/:attachmentId/content — Bilder und PDFs zeigt der Browser
   an, alles andere lädt er herunter; `?download=1` erzwingt den Download.
   Nur privat zwischengespeichert: ob jemand die Datei sehen darf, gilt je Person. */
router.get('/attachments/:attachmentId/content', (0, taskHttp_1.taskRoute)('tasks.attachments.content', async (req, res) => {
    const download = (0, taskHttp_1.queryFlag)(req.query.download);
    // Bild/PDF in R2 zum Ansehen: nach der Prüfung direkt zu Cloudflare weiterleiten.
    const direct = download ? null : await (0, attachmentService_1.attachmentPublicUrl)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'attachmentId'));
    if (direct) {
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.redirect(302, direct);
        return;
    }
    const file = await (0, attachmentService_1.readAttachmentContent)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'attachmentId'));
    const inline = (0, taskFiles_1.isInlineContentType)(file.contentType) && !download;
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('Content-Disposition', (0, taskFiles_1.contentDisposition)(file.fileName, inline));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(file.body);
}));
// DELETE /attachments/:attachmentId — die Regel je Art (Aufgabe, Kommentar, Chat) steht im Dienst.
router.delete('/attachments/:attachmentId', (0, taskHttp_1.taskRoute)('tasks.attachments.delete', async (req, res) => {
    await (0, attachmentService_1.deleteAttachment)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'attachmentId'));
    res.status(204).end();
}));
// GET /:taskId/attachments — die Dateien des Reiters «Dosyalar».
router.get('/:taskId/attachments', (0, taskHttp_1.taskRoute)('tasks.attachments.list', async (req, res) => {
    res.json(await (0, attachmentService_1.listTaskAttachments)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId')));
}));
// POST /:taskId/attachments — multipart `files`.
router.post('/:taskId/attachments', (0, taskHttp_1.withTaskUpload)(taskConstants_1.TASK_LIMITS.filesPerUpload), (0, taskHttp_1.taskRoute)('tasks.attachments.upload', async (req, res) => {
    const created = await (0, attachmentService_1.uploadTaskAttachments)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), (0, taskHttp_1.uploadedFiles)(req));
    res.status(201).json(created);
}));
exports.default = router;
//# sourceMappingURL=attachments.routes.js.map