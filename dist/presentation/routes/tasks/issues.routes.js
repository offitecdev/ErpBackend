"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const issueService_1 = require("../../../application/services/tasks/issueService");
const taskConstants_1 = require("../../../application/services/tasks/taskConstants");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
const ResponseCacheMiddleware_1 = require("../../middlewares/ResponseCacheMiddleware");
/* SORULAR & SORUNLAR einer Aufgabe (16.09.2026), montiert unter /api/v1/tasks.
   Anmeldung und Modulzugang prüft index.ts davor, die Regeln stehen im
   issueService. Feste Pfade vor Parameterpfaden. */
const router = (0, express_1.Router)();
/**
 * In einem multipart-Körper ist JEDES Feld eine Zeichenkette — auch die
 * Kennungslisten. Darum nimmt das Schema beides an: eine echte Liste (JSON)
 * oder eine Zeichenkette mit Komma bzw. als JSON-Text. Sonst käme aus dem
 * Fenster mit Datei eine leere Markierung zurück, aus dem ohne Datei nicht.
 */
const looseIds = (max) => zod_1.z.preprocess((value) => {
    if (Array.isArray(value))
        return value;
    if (typeof value !== 'string')
        return [];
    const text = value.trim();
    if (!text)
        return [];
    if (text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    }
    return text.split(',');
}, zod_1.z.array(taskHttp_1.zId).max(max).transform((ids) => [...new Set(ids)]));
/**
 * Der Schalter kommt aus drei Welten: als echtes `true` (JSON), als «true»/«1»
 * (multipart — dort ist jedes Feld eine Zeichenkette) und als 1/0, wenn ein
 * Aufrufer ihn als Zahl schickt. Alle drei gelten; sonst scheitert dieselbe
 * Eingabe je nachdem, ob eine Datei mitgeht.
 */
const looseFlag = zod_1.z.preprocess((value) => {
    if (typeof value === 'string')
        return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    if (typeof value === 'number')
        return value !== 0;
    return value;
}, zod_1.z.boolean().optional().default(false));
const issueBody = zod_1.z.object({
    kind: zod_1.z.enum(taskConstants_1.ISSUE_KINDS),
    title: (0, taskHttp_1.zRequiredLine)(taskConstants_1.TASK_LIMITS.issueTitleMax, 'Eine Frage braucht eine Überschrift.'),
    text: (0, taskHttp_1.zText)(taskConstants_1.TASK_LIMITS.issueTextMax).optional(),
    important: looseFlag,
    personIds: looseIds(taskConstants_1.TASK_LIMITS.issuePeopleMax).optional(),
    taskIds: looseIds(taskConstants_1.TASK_LIMITS.issueTasksMax).optional(),
});
const replyBody = zod_1.z.object({
    text: (0, taskHttp_1.zText)(taskConstants_1.TASK_LIMITS.issueTextMax).optional(),
    personIds: looseIds(taskConstants_1.TASK_LIMITS.issuePeopleMax).optional(),
});
const statusBody = zod_1.z.object({ resolved: zod_1.z.boolean() });
// POST /issues/:issueId/replies — antworten (Text, Dateien oder beides).
router.post('/issues/:issueId/replies', (0, taskHttp_1.withTaskUpload)(taskConstants_1.TASK_LIMITS.issueFilesMax), (0, taskHttp_1.taskRoute)('tasks.issues.reply', async (req, res) => {
    const { text, personIds } = (0, taskHttp_1.parseInput)(replyBody, req.body);
    const created = await (0, issueService_1.replyToTaskIssue)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'issueId'), {
        text: text ?? '',
        personIds: personIds ?? [],
        files: (0, taskHttp_1.uploadedFiles)(req),
    });
    res.status(201).json(created);
}));
// POST /issues/:issueId/status — «Çözüldü» bzw. wieder öffnen.
router.post('/issues/:issueId/status', (0, taskHttp_1.taskRoute)('tasks.issues.status', async (req, res) => {
    const { resolved } = (0, taskHttp_1.parseInput)(statusBody, req.body);
    res.json(await (0, issueService_1.setTaskIssueStatus)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'issueId'), resolved));
}));
// DELETE /issues/:issueId — wer gefragt hat oder die Leitung; die Dateien gehen mit.
router.delete('/issues/:issueId', (0, taskHttp_1.taskRoute)('tasks.issues.delete', async (req, res) => {
    await (0, issueService_1.deleteTaskIssue)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'issueId'));
    res.status(204).end();
}));
// GET /:taskId/issues — beide Reiter auf einmal, älteste zuerst.
router.get('/:taskId/issues', (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['tasks'], ttlSec: 15 }), (0, taskHttp_1.taskRoute)('tasks.issues.list', async (req, res) => {
    res.json(await (0, issueService_1.listTaskIssues)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId')));
}));
// POST /:taskId/issues — eine Frage oder ein Problem eröffnen.
router.post('/:taskId/issues', (0, taskHttp_1.withTaskUpload)(taskConstants_1.TASK_LIMITS.issueFilesMax), (0, taskHttp_1.taskRoute)('tasks.issues.create', async (req, res) => {
    const input = (0, taskHttp_1.parseInput)(issueBody, req.body);
    const created = await (0, issueService_1.createTaskIssue)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'taskId'), {
        kind: input.kind,
        title: input.title,
        text: input.text ?? '',
        important: input.important,
        personIds: input.personIds ?? [],
        taskIds: input.taskIds ?? [],
        files: (0, taskHttp_1.uploadedFiles)(req),
    });
    res.status(201).json(created);
}));
exports.default = router;
//# sourceMappingURL=issues.routes.js.map