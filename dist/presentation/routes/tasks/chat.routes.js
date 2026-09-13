"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const chatService_1 = require("../../../application/services/tasks/chatService");
const taskConstants_1 = require("../../../application/services/tasks/taskConstants");
const AuditLogService_1 = require("../../../infrastructure/services/AuditLogService");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
/**
 * CHAT-RÄUME DES GÖREVLER-MODULS — eingehängt unter `/tasks/chat`.
 * Anmeldung und Modulzugang prüft index.ts davor; Mitgliedschaft und
 * Leitungsrechte prüft chatService. Feste Pfade stehen vor den Pfaden mit
 * Parametern.
 */
const router = (0, express_1.Router)();
const createRoomSchema = zod_1.z.object({
    name: (0, taskHttp_1.zRequiredLine)(taskConstants_1.TASK_LIMITS.roomNameMax),
    memberIds: (0, taskHttp_1.zIdList)().optional(),
    taskIds: (0, taskHttp_1.zIdList)().optional(),
});
const renameRoomSchema = zod_1.z.object({ name: (0, taskHttp_1.zRequiredLine)(taskConstants_1.TASK_LIMITS.roomNameMax) });
const addMemberSchema = zod_1.z.object({ employeeId: taskHttp_1.zId });
const linkTaskSchema = zod_1.z.object({ taskId: taskHttp_1.zId });
/** JSON `{ text }` oder multipart mit dem Feld `text` und Dateien unter `files`. */
const sendMessageSchema = zod_1.z.object({ text: (0, taskHttp_1.zText)(taskConstants_1.TASK_LIMITS.chatMessageMax).optional() });
/* ── Feste Pfade ────────────────────────────────────────────────────────── */
// GET /tasks/chat/rooms — die eigenen Räume mit Ungelesen-Zahl und letzter Nachricht.
router.get('/rooms', (0, taskHttp_1.taskRoute)('tasks.chat.listRooms', async (_req, res) => {
    res.json(await (0, chatService_1.listChatRooms)((0, taskMiddleware_1.tasksActor)(res)));
}));
// POST /tasks/chat/rooms — { name, memberIds?, taskIds? } (Leitung).
router.post('/rooms', (0, taskHttp_1.taskRoute)('tasks.chat.createRoom', async (req, res) => {
    const body = (0, taskHttp_1.parseInput)(createRoomSchema, req.body);
    const room = await (0, chatService_1.createChatRoom)((0, taskMiddleware_1.tasksActor)(res), {
        name: body.name,
        memberIds: body.memberIds ?? [],
        taskIds: body.taskIds ?? [],
    });
    res.status(201).json({ room });
}));
// GET /tasks/chat/unread — { total, rooms: { [roomId]: count } } für Abzeichen.
router.get('/unread', (0, taskHttp_1.taskRoute)('tasks.chat.unread', async (_req, res) => {
    res.json(await (0, chatService_1.getChatUnread)((0, taskMiddleware_1.tasksActor)(res)));
}));
// DELETE /tasks/chat/messages/:messageId — eigene Textnachricht (Leitung: jede).
router.delete('/messages/:messageId', (0, taskHttp_1.taskRoute)('tasks.chat.deleteMessage', async (req, res) => {
    await (0, chatService_1.deleteChatMessage)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'messageId'));
    res.status(204).end();
}));
/* ── Ein Raum ───────────────────────────────────────────────────────────── */
// GET /tasks/chat/rooms/:roomId — Raum, Mitglieder, verknüpfte Aufgaben (Mitglieder).
router.get('/rooms/:roomId', (0, taskHttp_1.taskRoute)('tasks.chat.getRoom', async (req, res) => {
    res.json(await (0, chatService_1.getChatRoom)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'roomId')));
}));
// PATCH /tasks/chat/rooms/:roomId — { name } (Leitung, die Mitglied ist).
router.patch('/rooms/:roomId', (0, taskHttp_1.taskRoute)('tasks.chat.renameRoom', async (req, res) => {
    const body = (0, taskHttp_1.parseInput)(renameRoomSchema, req.body);
    const room = await (0, chatService_1.renameChatRoom)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'roomId'), body.name);
    res.json({ room });
}));
/* DELETE /tasks/chat/rooms/:roomId — endgültig, samt Nachrichten und Dateien
   (Leitung, die Mitglied ist). Steht darum im Audit-Protokoll. */
router.delete('/rooms/:roomId', (0, taskHttp_1.taskRoute)('tasks.chat.deleteRoom', async (req, res) => {
    const actor = (0, taskMiddleware_1.tasksActor)(res);
    const roomId = (0, taskHttp_1.routeParam)(req, 'roomId');
    const removed = await (0, chatService_1.deleteChatRoom)(actor, roomId);
    AuditLogService_1.auditLog.log({
        action: 'tasks.chatRoom.delete',
        tenantId: actor.tenantId,
        employeeId: actor.employeeId,
        entityType: 'TaskChatRoom',
        entityId: roomId,
        ...AuditLogService_1.auditLog.context(req),
        metadata: { name: removed.name, fileCount: removed.fileCount },
    });
    res.status(204).end();
}));
// POST /tasks/chat/rooms/:roomId/members — { employeeId } (Leitung, die Mitglied ist).
router.post('/rooms/:roomId/members', (0, taskHttp_1.taskRoute)('tasks.chat.addMember', async (req, res) => {
    const body = (0, taskHttp_1.parseInput)(addMemberSchema, req.body);
    const room = await (0, chatService_1.addChatMember)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'roomId'), body.employeeId);
    res.json({ room });
}));
// DELETE /tasks/chat/rooms/:roomId/members/:employeeId (Leitung, die Mitglied ist).
router.delete('/rooms/:roomId/members/:employeeId', (0, taskHttp_1.taskRoute)('tasks.chat.removeMember', async (req, res) => {
    const room = await (0, chatService_1.removeChatMember)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'roomId'), (0, taskHttp_1.routeParam)(req, 'employeeId'));
    res.json({ room });
}));
// POST /tasks/chat/rooms/:roomId/tasks — { taskId } (Leitung, die Mitglied ist).
router.post('/rooms/:roomId/tasks', (0, taskHttp_1.taskRoute)('tasks.chat.linkTask', async (req, res) => {
    const body = (0, taskHttp_1.parseInput)(linkTaskSchema, req.body);
    const room = await (0, chatService_1.linkChatTask)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'roomId'), body.taskId);
    res.json({ room });
}));
// DELETE /tasks/chat/rooms/:roomId/tasks/:taskId (Leitung, die Mitglied ist).
router.delete('/rooms/:roomId/tasks/:taskId', (0, taskHttp_1.taskRoute)('tasks.chat.unlinkTask', async (req, res) => {
    const room = await (0, chatService_1.unlinkChatTask)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'roomId'), (0, taskHttp_1.routeParam)(req, 'taskId'));
    res.json({ room });
}));
/* GET /tasks/chat/rooms/:roomId/messages — ?after=<id> | ?before=<id>, limit
   (Standard 50, höchstens 200). Immer aufsteigend, mit hasMore (Mitglieder). */
router.get('/rooms/:roomId/messages', (0, taskHttp_1.taskRoute)('tasks.chat.listMessages', async (req, res) => {
    res.json(await (0, chatService_1.listChatMessages)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'roomId'), {
        after: (0, taskHttp_1.queryString)(req.query.after, 64),
        before: (0, taskHttp_1.queryString)(req.query.before, 64),
        limit: (0, taskHttp_1.queryInt)(req.query.limit, taskConstants_1.TASK_LIMITS.chatPageDefault, 1, taskConstants_1.TASK_LIMITS.chatPageMax),
    }));
}));
// POST /tasks/chat/rooms/:roomId/messages — JSON { text } oder multipart text + files (Mitglieder).
router.post('/rooms/:roomId/messages', (0, taskHttp_1.withTaskUpload)(taskConstants_1.TASK_LIMITS.chatFilesMax), (0, taskHttp_1.taskRoute)('tasks.chat.sendMessage', async (req, res) => {
    const body = (0, taskHttp_1.parseInput)(sendMessageSchema, req.body);
    const result = await (0, chatService_1.sendChatMessage)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'roomId'), {
        text: body.text ?? '',
        files: (0, taskHttp_1.uploadedFiles)(req),
    });
    res.status(201).json(result);
}));
// POST /tasks/chat/rooms/:roomId/read — Lesestand auf jetzt (Mitglieder).
router.post('/rooms/:roomId/read', (0, taskHttp_1.taskRoute)('tasks.chat.markRead', async (req, res) => {
    res.json(await (0, chatService_1.markChatRoomRead)((0, taskMiddleware_1.tasksActor)(res), (0, taskHttp_1.routeParam)(req, 'roomId')));
}));
exports.default = router;
//# sourceMappingURL=chat.routes.js.map