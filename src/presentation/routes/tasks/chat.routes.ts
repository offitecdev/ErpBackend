import { Router } from 'express';
import { z } from 'zod';

import {
    addChatMember,
    createChatRoom,
    deleteChatMessage,
    deleteChatRoom,
    getChatRoom,
    getChatUnread,
    linkChatTask,
    listChatMessages,
    listChatRooms,
    markChatRoomRead,
    removeChatMember,
    renameChatRoom,
    sendChatMessage,
    unlinkChatTask,
} from '../../../application/services/tasks/chatService';
import { TASK_LIMITS } from '../../../application/services/tasks/taskConstants';
import { auditLog } from '../../../infrastructure/services/AuditLogService';
import {
    parseInput,
    queryInt,
    queryString,
    routeParam,
    taskRoute,
    uploadedFiles,
    withTaskUpload,
    zId,
    zIdList,
    zRequiredLine,
    zText,
} from './taskHttp';
import { tasksActor } from './taskMiddleware';

/**
 * CHAT-RÄUME DES GÖREVLER-MODULS — eingehängt unter `/tasks/chat`.
 * Anmeldung und Modulzugang prüft index.ts davor; Mitgliedschaft und
 * Leitungsrechte prüft chatService. Feste Pfade stehen vor den Pfaden mit
 * Parametern.
 */

const router = Router();

const createRoomSchema = z.object({
    name: zRequiredLine(TASK_LIMITS.roomNameMax),
    memberIds: zIdList().optional(),
    taskIds: zIdList().optional(),
});

const renameRoomSchema = z.object({ name: zRequiredLine(TASK_LIMITS.roomNameMax) });

const addMemberSchema = z.object({ employeeId: zId });

const linkTaskSchema = z.object({ taskId: zId });

/** JSON `{ text }` oder multipart mit dem Feld `text` und Dateien unter `files`. */
const sendMessageSchema = z.object({ text: zText(TASK_LIMITS.chatMessageMax).optional() });

/* ── Feste Pfade ────────────────────────────────────────────────────────── */

// GET /tasks/chat/rooms — die eigenen Räume mit Ungelesen-Zahl und letzter Nachricht.
router.get('/rooms', taskRoute('tasks.chat.listRooms', async (_req, res) => {
    res.json(await listChatRooms(tasksActor(res)));
}));

// POST /tasks/chat/rooms — { name, memberIds?, taskIds? } (Leitung).
router.post('/rooms', taskRoute('tasks.chat.createRoom', async (req, res) => {
    const body = parseInput(createRoomSchema, req.body);
    const room = await createChatRoom(tasksActor(res), {
        name: body.name,
        memberIds: body.memberIds ?? [],
        taskIds: body.taskIds ?? [],
    });
    res.status(201).json({ room });
}));

// GET /tasks/chat/unread — { total, rooms: { [roomId]: count } } für Abzeichen.
router.get('/unread', taskRoute('tasks.chat.unread', async (_req, res) => {
    res.json(await getChatUnread(tasksActor(res)));
}));

// DELETE /tasks/chat/messages/:messageId — eigene Textnachricht (Leitung: jede).
router.delete('/messages/:messageId', taskRoute('tasks.chat.deleteMessage', async (req, res) => {
    await deleteChatMessage(tasksActor(res), routeParam(req, 'messageId'));
    res.status(204).end();
}));

/* ── Ein Raum ───────────────────────────────────────────────────────────── */

// GET /tasks/chat/rooms/:roomId — Raum, Mitglieder, verknüpfte Aufgaben (Mitglieder).
router.get('/rooms/:roomId', taskRoute('tasks.chat.getRoom', async (req, res) => {
    res.json(await getChatRoom(tasksActor(res), routeParam(req, 'roomId')));
}));

// PATCH /tasks/chat/rooms/:roomId — { name } (Leitung, die Mitglied ist).
router.patch('/rooms/:roomId', taskRoute('tasks.chat.renameRoom', async (req, res) => {
    const body = parseInput(renameRoomSchema, req.body);
    const room = await renameChatRoom(tasksActor(res), routeParam(req, 'roomId'), body.name);
    res.json({ room });
}));

/* DELETE /tasks/chat/rooms/:roomId — endgültig, samt Nachrichten und Dateien
   (Leitung, die Mitglied ist). Steht darum im Audit-Protokoll. */
router.delete('/rooms/:roomId', taskRoute('tasks.chat.deleteRoom', async (req, res) => {
    const actor = tasksActor(res);
    const roomId = routeParam(req, 'roomId');
    const removed = await deleteChatRoom(actor, roomId);
    auditLog.log({
        action: 'tasks.chatRoom.delete',
        tenantId: actor.tenantId,
        employeeId: actor.employeeId,
        entityType: 'TaskChatRoom',
        entityId: roomId,
        ...auditLog.context(req),
        metadata: { name: removed.name, fileCount: removed.fileCount },
    });
    res.status(204).end();
}));

// POST /tasks/chat/rooms/:roomId/members — { employeeId } (Leitung, die Mitglied ist).
router.post('/rooms/:roomId/members', taskRoute('tasks.chat.addMember', async (req, res) => {
    const body = parseInput(addMemberSchema, req.body);
    const room = await addChatMember(tasksActor(res), routeParam(req, 'roomId'), body.employeeId);
    res.json({ room });
}));

// DELETE /tasks/chat/rooms/:roomId/members/:employeeId (Leitung, die Mitglied ist).
router.delete('/rooms/:roomId/members/:employeeId', taskRoute('tasks.chat.removeMember', async (req, res) => {
    const room = await removeChatMember(tasksActor(res), routeParam(req, 'roomId'), routeParam(req, 'employeeId'));
    res.json({ room });
}));

// POST /tasks/chat/rooms/:roomId/tasks — { taskId } (Leitung, die Mitglied ist).
router.post('/rooms/:roomId/tasks', taskRoute('tasks.chat.linkTask', async (req, res) => {
    const body = parseInput(linkTaskSchema, req.body);
    const room = await linkChatTask(tasksActor(res), routeParam(req, 'roomId'), body.taskId);
    res.json({ room });
}));

// DELETE /tasks/chat/rooms/:roomId/tasks/:taskId (Leitung, die Mitglied ist).
router.delete('/rooms/:roomId/tasks/:taskId', taskRoute('tasks.chat.unlinkTask', async (req, res) => {
    const room = await unlinkChatTask(tasksActor(res), routeParam(req, 'roomId'), routeParam(req, 'taskId'));
    res.json({ room });
}));

/* GET /tasks/chat/rooms/:roomId/messages — ?after=<id> | ?before=<id>, limit
   (Standard 50, höchstens 200). Immer aufsteigend, mit hasMore (Mitglieder). */
router.get('/rooms/:roomId/messages', taskRoute('tasks.chat.listMessages', async (req, res) => {
    res.json(await listChatMessages(tasksActor(res), routeParam(req, 'roomId'), {
        after: queryString(req.query.after, 64),
        before: queryString(req.query.before, 64),
        limit: queryInt(req.query.limit, TASK_LIMITS.chatPageDefault, 1, TASK_LIMITS.chatPageMax),
    }));
}));

// POST /tasks/chat/rooms/:roomId/messages — JSON { text } oder multipart text + files (Mitglieder).
router.post(
    '/rooms/:roomId/messages',
    withTaskUpload(TASK_LIMITS.chatFilesMax),
    taskRoute('tasks.chat.sendMessage', async (req, res) => {
        const body = parseInput(sendMessageSchema, req.body);
        const result = await sendChatMessage(tasksActor(res), routeParam(req, 'roomId'), {
            text: body.text ?? '',
            files: uploadedFiles(req),
        });
        res.status(201).json(result);
    }),
);

// POST /tasks/chat/rooms/:roomId/read — Lesestand auf jetzt (Mitglieder).
router.post('/rooms/:roomId/read', taskRoute('tasks.chat.markRead', async (req, res) => {
    res.json(await markChatRoomRead(tasksActor(res), routeParam(req, 'roomId')));
}));

export default router;
