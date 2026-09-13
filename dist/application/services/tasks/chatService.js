"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteChatMessage = exports.sendChatMessage = exports.listChatMessages = exports.unlinkChatTask = exports.linkChatTask = exports.removeChatMember = exports.addChatMember = exports.deleteChatRoom = exports.renameChatRoom = exports.getChatRoom = exports.createChatRoom = exports.markChatRoomRead = exports.getChatUnread = exports.loadChatUnreadByRoom = exports.listChatRooms = void 0;
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskActor_1 = require("./taskActor");
const taskConstants_1 = require("./taskConstants");
const taskDb_1 = require("./taskDb");
const taskErrors_1 = require("./taskErrors");
const taskFiles_1 = require("./taskFiles");
const taskNotify_1 = require("./taskNotify");
const taskPeople_1 = require("./taskPeople");
const taskRows_1 = require("./taskRows");
/* ── Kleine Hilfen ──────────────────────────────────────────────────────── */
const LAST_MESSAGE_PREVIEW_MAX = 140;
/** Rohtext für die Vorschau — reicht, auch wenn Leerraum zusammenfällt. */
const PREVIEW_SOURCE_CHARS = LAST_MESSAGE_PREVIEW_MAX * 4;
/** Görevly: `U.truncate(msg.text, 70)` in der Chatmeldung. */
const NOTIFY_PREVIEW_MAX = 70;
const roomNotFound = () => (0, taskErrors_1.taskNotFound)('ROOM_NOT_FOUND', 'Chat-Raum nicht gefunden.');
const roomForbidden = () => (0, taskErrors_1.taskForbidden)('ROOM_FORBIDDEN', 'Sie sind nicht Mitglied dieses Chat-Raums.');
const messageNotFound = () => (0, taskErrors_1.taskNotFound)('MESSAGE_NOT_FOUND', 'Nachricht nicht gefunden.');
/** Görevly `U.truncate`: zu lang → gekürzt mit «…». */
const truncate = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
/** Einzeilige Vorschau eines Nachrichtentexts. */
const previewText = (text, max) => truncate(text.replace(/\s+/g, ' ').trim(), max);
const asMeta = (value) => {
    const parsed = (0, taskRows_1.rawJson)(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
};
/** Personen, die eine Nachricht nennt: Absender und die Beteiligten einer Systemnachricht. */
const messagePeopleIds = (messages) => messages.flatMap((message) => [message.senderId, message.meta?.actorId, message.meta?.targetId]
    .filter((id) => typeof id === 'string' && id.length > 0));
const sumCounts = (counts) => Object.values(counts).reduce((sum, count) => sum + count, 0);
/**
 * Zeitpunkt der nächsten Nachricht eines Raums: jetzt, aber mindestens 1 ms
 * nach der letzten. Unter der Raumsperre ergibt das eine streng steigende
 * Folge — auch bei Absendern in derselben Millisekunde oder einer
 * zurückgestellten Uhr.
 */
const nextMessageAt = (lastMessageAt) => new Date(Math.max(Date.now(), lastMessageAt ? lastMessageAt.getTime() + 1 : 0));
/** Scheitert das Schreiben, verschwinden die schon abgelegten Dateien wieder — keine Waisen. */
const removeFilesOnFailure = async (fileRefs, work) => {
    try {
        return await work();
    }
    catch (error) {
        await (0, taskFiles_1.removeStoredFiles)(fileRefs);
        throw error;
    }
};
/**
 * Raum + eigene Mitgliedschaft in EINER Anweisung. `lock` sperrt die
 * Raumzeile (nur in einer Transaktion); `cursorId` prüft nebenbei, ob die
 * Cursor-Nachricht des Abrufs noch existiert.
 */
const readRoomAccess = async (db, actor, roomId, options = {}) => {
    if (!roomId)
        return null;
    const cursorColumn = options.cursorId
        ? client_1.Prisma.sql `, EXISTS(SELECT 1 FROM TaskChatMessage c WHERE c.id = ${options.cursorId} AND c.roomId = r.id) AS cursorFound`
        : client_1.Prisma.empty;
    const rows = await db.$queryRaw(client_1.Prisma.sql `
        SELECT r.id, r.name, r.lastMessageAt,
               EXISTS(SELECT 1 FROM TaskChatMember m WHERE m.roomId = r.id AND m.employeeId = ${actor.employeeId}) AS isMember
               ${cursorColumn}
        FROM TaskChatRoom r
        WHERE r.id = ${roomId} AND r.tenantId = ${actor.tenantId}
        ${options.lock ? client_1.Prisma.sql `FOR UPDATE` : client_1.Prisma.empty}
    `);
    const row = rows[0];
    if (!row)
        return null;
    return {
        id: String(row.id),
        name: String(row.name ?? ''),
        lastMessageAt: (0, taskRows_1.rawDate)(row.lastMessageAt),
        isMember: (0, taskRows_1.rawBool)(row.isMember),
        cursorFound: (0, taskRows_1.rawBool)(row.cursorFound),
    };
};
/** 404, wenn es den Raum in der Firma nicht gibt; 403, wenn die Person nicht Mitglied ist. */
const requireRoomMember = async (db, actor, roomId, options = {}) => {
    const access = await readRoomAccess(db, actor, roomId, options);
    if (!access)
        throw roomNotFound();
    if (!access.isMember)
        throw roomForbidden();
    return access;
};
const systemMessage = {
    roomCreated: () => ({ event: 'ROOM_CREATED', text: 'Raum angelegt.', details: {} }),
    memberAdded: (targetId, name) => ({
        event: 'MEMBER_ADDED',
        text: `${name || 'Eine Person'} wurde hinzugefügt.`,
        details: { targetId },
    }),
    memberRemoved: (targetId, name) => ({
        event: 'MEMBER_REMOVED',
        text: `${name || 'Eine Person'} wurde entfernt.`,
        details: { targetId },
    }),
    taskLinked: (taskId, taskTitle) => ({
        event: 'TASK_LINKED',
        text: `Mit «${taskTitle}» verknüpft.`,
        details: { taskId, taskTitle },
    }),
};
/** Zeilen für Systemnachrichten in ihrer Reihenfolge: je 1 ms Abstand ab `at`. */
const systemMessageRows = (actor, roomId, at, messages) => messages.map((message, index) => ({
    id: (0, nanoid_1.nanoid)(12),
    tenantId: actor.tenantId,
    roomId,
    type: 'SYSTEM',
    senderId: actor.employeeId,
    text: message.text,
    meta: { event: message.event, actorId: actor.employeeId, ...message.details },
    createdAt: new Date(at.getTime() + index),
}));
/** EINE Systemnachricht an einen bestehenden Raum hängen. Der Aufrufer hält die Raumsperre. */
const appendSystemMessage = async (tx, actor, roomId, at, message) => {
    await tx.taskChatMessage.createMany({ data: systemMessageRows(actor, roomId, at, [message]) });
    await tx.taskChatRoom.updateMany({ where: { id: roomId, tenantId: actor.tenantId }, data: { lastMessageAt: at } });
};
const roomTaskColumns = (employeeId) => client_1.Prisma.sql `
    t.id, t.title, t.status, t.createdById,
    EXISTS(SELECT 1 FROM TaskAssignee a WHERE a.taskId = t.id AND a.employeeId = ${employeeId}) AS isAssignee
`;
const mapRoomTaskRow = (row) => ({
    id: String(row.id),
    title: String(row.title ?? ''),
    status: String(row.status ?? 'NOT_STARTED'),
    createdById: String(row.createdById ?? ''),
    isAssignee: (0, taskRows_1.rawBool)(row.isAssignee),
});
/** Die verknüpften Aufgaben eines Raums, in der Reihenfolge des Verknüpfens. */
const loadRoomTasks = async (actor, roomId) => (await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT ${roomTaskColumns(actor.employeeId)}
        FROM TaskChatRoomTask rt
        JOIN Task t ON t.id = rt.taskId AND t.tenantId = ${actor.tenantId}
        WHERE rt.roomId = ${roomId} AND rt.tenantId = ${actor.tenantId}
        ORDER BY rt.createdAt ASC, rt.id ASC
    `)).map(mapRoomTaskRow);
/** Aufgaben der Firma nach Kennung (Prüfung beim Anlegen eines Raums). */
const loadTenantTasks = async (actor, taskIds) => {
    if (!taskIds.length)
        return [];
    return (await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT ${roomTaskColumns(actor.employeeId)}
        FROM Task t
        WHERE ${(0, taskRows_1.visibleTasksSql)(actor)} AND t.id IN (${client_1.Prisma.join([...taskIds])})
    `)).map(mapRoomTaskRow);
};
const ROOM_SELECT = {
    id: true,
    name: true,
    createdById: true,
    createdAt: true,
    lastMessageAt: true,
};
const MEMBER_SELECT = { employeeId: true, addedById: true, createdAt: true };
/** Raum, Mitglieder und Aufgaben parallel; null = kein Raum dieser Firma. */
const readRoomParts = async (actor, roomId) => {
    if (!roomId)
        return null;
    const [room, members, tasks] = await Promise.all([
        prisma_client_1.default.taskChatRoom.findFirst({ where: { id: roomId, tenantId: actor.tenantId }, select: ROOM_SELECT }),
        prisma_client_1.default.taskChatMember.findMany({
            where: { roomId, tenantId: actor.tenantId },
            select: MEMBER_SELECT,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        loadRoomTasks(actor, roomId),
    ]);
    return room ? { room, members, tasks } : null;
};
const toRoomDetail = async (actor, parts) => ({
    room: parts.room,
    members: parts.members,
    tasks: parts.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        // Dieselbe Sichtbarkeit wie canSeeTask: Leitung, verantwortlich oder angelegt.
        canOpen: actor.seesAll || task.createdById === actor.employeeId || task.isAssignee,
    })),
    people: await (0, taskPeople_1.loadPersonRefs)([
        parts.room.createdById,
        ...parts.members.flatMap((member) => [member.employeeId, member.addedById]),
    ]),
});
/** Der Raum nach einer Änderung, frisch gelesen. */
const loadRoomDetail = async (actor, roomId) => {
    const parts = await readRoomParts(actor, roomId);
    if (!parts)
        throw roomNotFound();
    return toRoomDetail(actor, parts);
};
/* ── Benachrichtigungen ─────────────────────────────────────────────────── */
const notifyAddedToRoom = (actor, room, recipientIds, actorName) => {
    if (!recipientIds.length)
        return;
    (0, taskNotify_1.queueTaskNotification)({
        tenantId: actor.tenantId,
        type: taskConstants_1.NOTIFY.CHAT_ADDED,
        recipientIds,
        actorId: actor.employeeId,
        title: 'Zum Chat hinzugefügt',
        message: `${actorName} hat Sie zu «${room.name}» hinzugefügt.`,
        linkUrl: (0, taskConstants_1.roomLinkUrl)(room.id),
        params: { actor: actorName, room: room.name },
        meta: { roomId: room.id },
    });
};
/**
 * Meldung an die übrigen Mitglieder, ohne Warten: die Empfänger werden erst
 * nach der Antwort gelesen, damit die Raumsperre kurz bleibt. `coalesceUnread`
 * frischt eine ungelesene Meldung desselben Raums auf, statt je Nachricht
 * einen Banner zu stapeln.
 */
const notifyChatMessage = (actor, room, message, actorName) => {
    const preview = previewText(message.text, NOTIFY_PREVIEW_MAX);
    void prisma_client_1.default.taskChatMember
        .findMany({ where: { tenantId: actor.tenantId, roomId: room.id }, select: { employeeId: true } })
        .then((members) => (0, taskNotify_1.notifyTaskPeople)({
        tenantId: actor.tenantId,
        type: taskConstants_1.NOTIFY.CHAT_MESSAGE,
        recipientIds: members.map((member) => member.employeeId),
        actorId: actor.employeeId,
        title: room.name,
        message: `${actorName}: ${preview || 'Datei'}`,
        linkUrl: (0, taskConstants_1.roomLinkUrl)(room.id),
        params: { actor: actorName, room: room.name, text: preview, fileCount: message.attachments.length },
        meta: { roomId: room.id },
        coalesceUnread: true,
    }))
        .catch((error) => {
        console.warn('[tasks.chat] Chatmeldung konnte nicht verschickt werden', error);
    });
};
/* ── Raumliste und Ungelesen ────────────────────────────────────────────── */
/**
 * Ungelesene Textnachrichten EINES Raums — korrelierte Unterabfrage über das
 * Mitglied `m`. Dieselbe Regel wie `unreadChatCount` der Zusammenfassung.
 */
const unreadCountSql = (employeeId) => client_1.Prisma.sql `(
    SELECT COUNT(*) FROM TaskChatMessage um
    WHERE um.roomId = m.roomId
      AND um.type = 'TEXT'
      AND um.senderId <> ${employeeId}
      AND um.createdAt > COALESCE(m.lastReadAt, m.createdAt)
)`;
const mapRoomListRow = (row) => {
    const lastId = (0, taskRows_1.rawString)(row.lastId);
    const lastCreatedAt = (0, taskRows_1.rawDate)(row.lastCreatedAt);
    return {
        id: String(row.id),
        name: String(row.name ?? ''),
        memberCount: (0, taskRows_1.rawNumber)(row.memberCount),
        taskCount: (0, taskRows_1.rawNumber)(row.taskCount),
        unreadCount: (0, taskRows_1.rawNumber)(row.unreadCount),
        lastMessage: lastId && lastCreatedAt
            ? {
                id: lastId,
                type: String(row.lastType ?? 'TEXT'),
                senderId: (0, taskRows_1.rawString)(row.lastSenderId),
                text: previewText(String(row.lastText ?? ''), LAST_MESSAGE_PREVIEW_MAX),
                meta: asMeta(row.lastMeta),
                hasAttachments: (0, taskRows_1.rawBool)(row.lastHasAttachments),
                createdAt: lastCreatedAt,
            }
            : null,
        lastMessageAt: (0, taskRows_1.rawDate)(row.lastMessageAt),
        createdAt: (0, taskRows_1.rawDate)(row.createdAt) ?? new Date(0),
    };
};
/**
 * Die eigenen Räume, zuletzt aktive zuerst. Letzte Nachricht wie Görevly
 * `lastMessage`: die letzte TEXT-Nachricht, sonst die letzte überhaupt.
 * Zwei Anweisungen: Räume samt Zählern und letzter Nachricht, dann die Namen.
 */
const listChatRooms = async (actor) => {
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT base.id, base.name, base.lastMessageAt, base.createdAt,
               base.memberCount, base.taskCount, base.unreadCount,
               x.id AS lastId, x.type AS lastType, x.senderId AS lastSenderId,
               LEFT(x.text, ${PREVIEW_SOURCE_CHARS}) AS lastText, x.meta AS lastMeta, x.createdAt AS lastCreatedAt,
               EXISTS(SELECT 1 FROM TaskAttachment a WHERE a.messageId = x.id) AS lastHasAttachments
        FROM (
            SELECT r.id, r.name, r.lastMessageAt, r.createdAt,
                   (SELECT COUNT(*) FROM TaskChatMember cm WHERE cm.roomId = r.id) AS memberCount,
                   (SELECT COUNT(*) FROM TaskChatRoomTask rt WHERE rt.roomId = r.id) AS taskCount,
                   ${unreadCountSql(actor.employeeId)} AS unreadCount,
                   COALESCE(
                       (SELECT lt.id FROM TaskChatMessage lt
                         WHERE lt.roomId = r.id AND lt.type = 'TEXT'
                         ORDER BY lt.createdAt DESC, lt.id DESC LIMIT 1),
                       (SELECT la.id FROM TaskChatMessage la
                         WHERE la.roomId = r.id
                         ORDER BY la.createdAt DESC, la.id DESC LIMIT 1)
                   ) AS lastMessageId
            FROM TaskChatMember m
            JOIN TaskChatRoom r ON r.id = m.roomId AND r.tenantId = ${actor.tenantId}
            WHERE m.tenantId = ${actor.tenantId} AND m.employeeId = ${actor.employeeId}
        ) base
        LEFT JOIN TaskChatMessage x ON x.id = base.lastMessageId
        ORDER BY COALESCE(base.lastMessageAt, base.createdAt) DESC, base.id ASC
    `);
    const data = rows.map(mapRoomListRow);
    const people = await (0, taskPeople_1.loadPersonRefs)(messagePeopleIds(data.flatMap((room) => (room.lastMessage ? [room.lastMessage] : []))));
    return { data, people, serverNow: new Date() };
};
exports.listChatRooms = listChatRooms;
/** Ungelesene Textnachrichten je eigenem Raum der Firma (Räume ohne Ungelesenes mit 0). */
const loadChatUnreadByRoom = async (tenantId, employeeId) => {
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT m.roomId, ${unreadCountSql(employeeId)} AS unreadCount
        FROM TaskChatMember m
        WHERE m.tenantId = ${tenantId} AND m.employeeId = ${employeeId}
    `);
    return Object.fromEntries(rows.map((row) => [row.roomId, (0, taskRows_1.rawNumber)(row.unreadCount)]));
};
exports.loadChatUnreadByRoom = loadChatUnreadByRoom;
const getChatUnread = async (actor) => {
    const rooms = await (0, exports.loadChatUnreadByRoom)(actor.tenantId, actor.employeeId);
    return { total: sumCounts(rooms), rooms };
};
exports.getChatUnread = getChatUnread;
/** Lesestand auf jetzt; die Antwort trägt gleich die neue Gesamtzahl für das Abzeichen. */
const markChatRoomRead = async (actor, roomId) => {
    const { count } = await prisma_client_1.default.taskChatMember.updateMany({
        where: { tenantId: actor.tenantId, roomId, employeeId: actor.employeeId },
        data: { lastReadAt: new Date() },
    });
    // Nichts geändert: der Fehler sagt, ob der Raum fehlt oder die Mitgliedschaft.
    if (!count)
        await requireRoomMember(prisma_client_1.default, actor, roomId);
    const rooms = await (0, exports.loadChatUnreadByRoom)(actor.tenantId, actor.employeeId);
    return { ok: true, unreadTotal: sumCounts(rooms) };
};
exports.markChatRoomRead = markChatRoomRead;
/**
 * Raum anlegen (Görevly `Ch.create`): die Anlegende ist automatisch Mitglied,
 * weitere Personen müssen zur Firma gehören und das Modul benutzen dürfen,
 * Aufgaben müssen Aufgaben der Firma sein. Systemnachrichten in fester
 * Folge: angelegt → je Person hinzugefügt → je Aufgabe verknüpft.
 */
const createChatRoom = async (actor, input) => {
    (0, taskActor_1.assertManager)(actor);
    const me = actor.employeeId;
    const taskIds = [...new Set(input.taskIds)];
    const [memberIds, taskRows] = await Promise.all([
        (0, taskPeople_1.assertAssignablePeople)(actor.tenantId, input.memberIds.filter((id) => id !== me)),
        loadTenantTasks(actor, taskIds),
    ]);
    const taskById = new Map(taskRows.map((task) => [task.id, task]));
    const missing = taskIds.filter((id) => !taskById.has(id));
    if (missing.length) {
        throw (0, taskErrors_1.taskBadRequest)('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { taskIds: missing });
    }
    const tasks = taskIds.flatMap((id) => taskById.get(id) ?? []);
    // Frisch geprüft ⇒ aus dem 30-s-Zwischenspeicher, kein zusätzlicher Rundgang.
    const staff = memberIds.length ? await (0, taskPeople_1.getTasksPeople)(actor.tenantId) : new Map();
    const roomId = (0, nanoid_1.nanoid)(12);
    const at = new Date();
    const messages = [
        systemMessage.roomCreated(),
        ...memberIds.map((id) => systemMessage.memberAdded(id, (0, taskPeople_1.personDisplayName)(staff.get(id)))),
        ...tasks.map((task) => systemMessage.taskLinked(task.id, task.title)),
    ];
    const lastMessageAt = new Date(at.getTime() + messages.length - 1);
    const room = { id: roomId, name: input.name, createdById: me, createdAt: at, lastMessageAt };
    const members = [me, ...memberIds].map((employeeId) => ({
        employeeId,
        addedById: employeeId === me ? null : me,
        createdAt: at,
    }));
    await (0, taskDb_1.runTasksTransaction)(async (tx) => {
        // createMany auch für die eine Raumzeile: ohne das Rücklesen, das create kostet.
        await tx.taskChatRoom.createMany({ data: [{ ...room, tenantId: actor.tenantId }] });
        await tx.taskChatMember.createMany({
            data: members.map((member) => ({ id: (0, nanoid_1.nanoid)(12), tenantId: actor.tenantId, roomId, ...member })),
        });
        if (tasks.length) {
            await tx.taskChatRoomTask.createMany({
                data: tasks.map((task) => ({ id: (0, nanoid_1.nanoid)(12), tenantId: actor.tenantId, roomId, taskId: task.id, linkedById: me, createdAt: at })),
            });
        }
        await tx.taskChatMessage.createMany({ data: systemMessageRows(actor, roomId, at, messages) });
    });
    const detail = await toRoomDetail(actor, { room, members, tasks });
    notifyAddedToRoom(actor, room, memberIds, detail.people[me]?.name ?? '');
    return detail;
};
exports.createChatRoom = createChatRoom;
const getChatRoom = async (actor, roomId) => {
    const parts = await readRoomParts(actor, roomId);
    if (!parts)
        throw roomNotFound();
    if (!parts.members.some((member) => member.employeeId === actor.employeeId))
        throw roomForbidden();
    return toRoomDetail(actor, parts);
};
exports.getChatRoom = getChatRoom;
const renameChatRoom = async (actor, roomId, name) => {
    (0, taskActor_1.assertManager)(actor);
    await requireRoomMember(prisma_client_1.default, actor, roomId);
    await prisma_client_1.default.taskChatRoom.updateMany({ where: { id: roomId, tenantId: actor.tenantId }, data: { name } });
    return loadRoomDetail(actor, roomId);
};
exports.renameChatRoom = renameChatRoom;
/**
 * Raum löschen: Mitglieder, Verknüpfungen, Nachrichten und Dateizeilen gehen
 * per Kaskade mit — die Ablage kennt keine Kaskade, darum werden die Verweise
 * unter der Raumsperre gesammelt (ein gleichzeitiger Absender wartet und
 * scheitert danach sauber) und nach dem Löschen entfernt.
 * Gibt Name und Dateizahl für das Audit-Protokoll zurück.
 */
const deleteChatRoom = async (actor, roomId) => {
    (0, taskActor_1.assertManager)(actor);
    const removed = await (0, taskDb_1.runTasksTransaction)(async (tx) => {
        const access = await requireRoomMember(tx, actor, roomId, { lock: true });
        const fileRefs = await (0, taskFiles_1.collectAttachmentRefs)(tx, { tenantId: actor.tenantId, roomId });
        await tx.taskChatRoom.deleteMany({ where: { id: roomId, tenantId: actor.tenantId } });
        return { name: access.name, fileRefs };
    });
    await (0, taskFiles_1.removeStoredFiles)(removed.fileRefs);
    return { name: removed.name, fileCount: removed.fileRefs.length };
};
exports.deleteChatRoom = deleteChatRoom;
/** Person aufnehmen (Görevly `Ch.addMember`); schon Mitglied ⇒ unverändert, ohne Nachricht. */
const addChatMember = async (actor, roomId, employeeId) => {
    (0, taskActor_1.assertManager)(actor);
    const [targetId] = await (0, taskPeople_1.assertAssignablePeople)(actor.tenantId, [employeeId]);
    if (!targetId)
        throw (0, taskErrors_1.taskBadRequest)('PERSON_NOT_ASSIGNABLE', 'Keine Person angegeben.');
    const staff = await (0, taskPeople_1.getTasksPeople)(actor.tenantId);
    const addedTo = await (0, taskDb_1.runTasksTransaction)(async (tx) => {
        const access = await requireRoomMember(tx, actor, roomId, { lock: true });
        const at = nextMessageAt(access.lastMessageAt);
        const { count } = await tx.taskChatMember.createMany({
            data: [{ id: (0, nanoid_1.nanoid)(12), tenantId: actor.tenantId, roomId, employeeId: targetId, addedById: actor.employeeId, createdAt: at }],
            skipDuplicates: true,
        });
        if (!count)
            return null;
        await appendSystemMessage(tx, actor, roomId, at, systemMessage.memberAdded(targetId, (0, taskPeople_1.personDisplayName)(staff.get(targetId))));
        return access;
    });
    const detail = await loadRoomDetail(actor, roomId);
    if (addedTo)
        notifyAddedToRoom(actor, addedTo, [targetId], detail.people[actor.employeeId]?.name ?? '');
    return detail;
};
exports.addChatMember = addChatMember;
/**
 * Person entfernen (Görevly `Ch.removeMember`). Ohne Personalprüfung: auch
 * ehemalige Mitarbeitende müssen sich austragen lassen. Kein Mitglied ⇒
 * unverändert, ohne Nachricht.
 */
const removeChatMember = async (actor, roomId, employeeId) => {
    (0, taskActor_1.assertManager)(actor);
    const name = await (0, taskPeople_1.loadPersonName)(employeeId);
    await (0, taskDb_1.runTasksTransaction)(async (tx) => {
        const access = await requireRoomMember(tx, actor, roomId, { lock: true });
        const { count } = await tx.taskChatMember.deleteMany({ where: { tenantId: actor.tenantId, roomId, employeeId } });
        if (count) {
            await appendSystemMessage(tx, actor, roomId, nextMessageAt(access.lastMessageAt), systemMessage.memberRemoved(employeeId, name));
        }
    });
    return loadRoomDetail(actor, roomId);
};
exports.removeChatMember = removeChatMember;
/** Aufgabe verknüpfen (Görevly `Ch.linkTask`); schon verknüpft ⇒ unverändert, ohne Nachricht. */
const linkChatTask = async (actor, roomId, taskId) => {
    (0, taskActor_1.assertManager)(actor);
    const [task] = taskId ? await loadTenantTasks(actor, [taskId]) : [];
    if (!task)
        throw (0, taskErrors_1.taskBadRequest)('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { taskIds: [taskId] });
    await (0, taskDb_1.runTasksTransaction)(async (tx) => {
        const access = await requireRoomMember(tx, actor, roomId, { lock: true });
        const at = nextMessageAt(access.lastMessageAt);
        const { count } = await tx.taskChatRoomTask.createMany({
            data: [{ id: (0, nanoid_1.nanoid)(12), tenantId: actor.tenantId, roomId, taskId: task.id, linkedById: actor.employeeId, createdAt: at }],
            skipDuplicates: true,
        });
        if (count)
            await appendSystemMessage(tx, actor, roomId, at, systemMessage.taskLinked(task.id, task.title));
    });
    return loadRoomDetail(actor, roomId);
};
exports.linkChatTask = linkChatTask;
/** Verknüpfung lösen (Görevly `Ch.unlinkTask`) — ohne Systemnachricht. */
const unlinkChatTask = async (actor, roomId, taskId) => {
    (0, taskActor_1.assertManager)(actor);
    await requireRoomMember(prisma_client_1.default, actor, roomId);
    await prisma_client_1.default.taskChatRoomTask.deleteMany({ where: { tenantId: actor.tenantId, roomId, taskId } });
    return loadRoomDetail(actor, roomId);
};
exports.unlinkChatTask = unlinkChatTask;
const MESSAGE_COLUMNS = client_1.Prisma.sql `x.id, x.roomId, x.type, x.senderId, x.text, x.meta, x.createdAt`;
const mapMessageRow = (row) => ({
    id: String(row.id),
    roomId: String(row.roomId),
    type: String(row.type ?? 'TEXT'),
    senderId: (0, taskRows_1.rawString)(row.senderId),
    text: String(row.text ?? ''),
    meta: asMeta(row.meta),
    createdAt: (0, taskRows_1.rawDate)(row.createdAt) ?? new Date(0),
});
const toMessageDto = (actor, message, attachments) => ({
    ...message,
    attachments,
    // Löschen: nur Textnachrichten, und nur die eigenen — ausser für die Leitung.
    canDelete: message.type === 'TEXT' && (message.senderId === actor.employeeId || actor.isManager),
});
/**
 * Eine Seite, sortiert nach (createdAt, id); ein Datensatz mehr als `limit`
 * verrät `hasMore`. Die Cursor-Nachricht wird in SQL gelesen
 * (Selbstverknüpfung) — ihr Zeitpunkt verlässt die Datenbank nie.
 */
const messagePageSql = (tenantId, roomId, query) => {
    const take = query.limit + 1;
    if (query.after) {
        return client_1.Prisma.sql `
            SELECT ${MESSAGE_COLUMNS}
            FROM TaskChatMessage c
            JOIN TaskChatMessage x ON x.roomId = c.roomId
                AND x.createdAt >= c.createdAt
                AND (x.createdAt > c.createdAt OR x.id > c.id)
            WHERE c.id = ${query.after} AND c.roomId = ${roomId} AND c.tenantId = ${tenantId}
            ORDER BY x.createdAt ASC, x.id ASC
            LIMIT ${take}
        `;
    }
    if (query.before) {
        return client_1.Prisma.sql `
            SELECT ${MESSAGE_COLUMNS}
            FROM TaskChatMessage c
            JOIN TaskChatMessage x ON x.roomId = c.roomId
                AND x.createdAt <= c.createdAt
                AND (x.createdAt < c.createdAt OR x.id < c.id)
            WHERE c.id = ${query.before} AND c.roomId = ${roomId} AND c.tenantId = ${tenantId}
            ORDER BY x.createdAt DESC, x.id DESC
            LIMIT ${take}
        `;
    }
    return client_1.Prisma.sql `
        SELECT ${MESSAGE_COLUMNS}
        FROM TaskChatMessage x
        WHERE x.roomId = ${roomId} AND x.tenantId = ${tenantId}
        ORDER BY x.createdAt DESC, x.id DESC
        LIMIT ${take}
    `;
};
const loadMessageAttachments = async (tenantId, roomId, messageIds) => {
    const byMessage = new Map();
    if (!messageIds.length)
        return byMessage;
    const rows = await prisma_client_1.default.taskAttachment.findMany({
        where: { tenantId, roomId, kind: 'CHAT', messageId: { in: [...messageIds] } },
        select: taskFiles_1.ATTACHMENT_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const row of rows) {
        if (!row.messageId)
            continue;
        const list = byMessage.get(row.messageId) ?? [];
        list.push((0, taskFiles_1.toAttachmentDto)(row));
        byMessage.set(row.messageId, list);
    }
    return byMessage;
};
/**
 * Nachrichten eines Raums seitenweise: ohne Cursor die neuesten, mit `after`
 * die neueren (Abfrage im Takt), mit `before` die älteren (Nachladen nach
 * oben). Eine inzwischen gelöschte Cursor-Nachricht ergibt 404
 * MESSAGE_NOT_FOUND — die Oberfläche lädt dann die neueste Seite neu.
 */
const listChatMessages = async (actor, roomId, query) => {
    if (query.after && query.before) {
        throw (0, taskErrors_1.taskBadRequest)('CURSOR_CONFLICT', 'Bitte entweder «after» oder «before» angeben.');
    }
    const cursorId = query.after || query.before;
    const access = await requireRoomMember(prisma_client_1.default, actor, roomId, cursorId ? { cursorId } : {});
    if (cursorId && !access.cursorFound)
        throw messageNotFound();
    const rows = await prisma_client_1.default.$queryRaw(messagePageSql(actor.tenantId, roomId, query));
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).map(mapMessageRow);
    // Ohne Cursor und mit `before` kommt die Seite absteigend aus der Datenbank.
    if (!query.after)
        page.reverse();
    const [attachments, people] = await Promise.all([
        loadMessageAttachments(actor.tenantId, roomId, page.map((message) => message.id)),
        (0, taskPeople_1.loadPersonRefs)(messagePeopleIds(page)),
    ]);
    return {
        data: page.map((message) => toMessageDto(actor, message, attachments.get(message.id) ?? [])),
        hasMore,
        people,
        serverNow: new Date(),
    };
};
exports.listChatMessages = listChatMessages;
/**
 * Nachricht senden (Görevly `Ch.send`): Text und/oder Dateien. Die Dateien
 * liegen in der Ablage, bevor die Transaktion Nachricht, Dateizeilen,
 * `lastMessageAt` des Raums und den eigenen Lesestand schreibt; scheitert sie,
 * werden die Dateien wieder entfernt.
 */
const sendChatMessage = async (actor, roomId, input) => {
    const prepared = (0, taskFiles_1.prepareTaskFiles)(input.files, taskConstants_1.TASK_LIMITS.chatFilesMax);
    if (!input.text && !prepared.length)
        throw (0, taskErrors_1.taskBadRequest)('MESSAGE_EMPTY', 'Die Nachricht ist leer.');
    // Dateien erst ablegen, wenn feststeht, dass die Person hier schreiben darf.
    if (prepared.length)
        await requireRoomMember(prisma_client_1.default, actor, roomId);
    const fileRefs = await (0, taskFiles_1.storeTaskFiles)(actor.tenantId, prepared);
    const written = await removeFilesOnFailure(fileRefs, () => (0, taskDb_1.runTasksTransaction)(async (tx) => {
        // Unter der Sperre erneut: wer inzwischen entfernt wurde, schreibt nicht mehr.
        const access = await requireRoomMember(tx, actor, roomId, { lock: true });
        const at = nextMessageAt(access.lastMessageAt);
        const messageId = (0, nanoid_1.nanoid)(12);
        const attachmentRows = prepared.map((file, index) => ({
            id: (0, nanoid_1.nanoid)(12),
            tenantId: actor.tenantId,
            kind: 'CHAT',
            roomId,
            messageId,
            fileName: file.fileName,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            // storeTaskFiles liefert je Datei genau einen Verweis, in Eingangsreihenfolge.
            fileRef: fileRefs[index],
            uploadedById: actor.employeeId,
            // Je 1 ms Abstand: die Dateien behalten ihre Reihenfolge.
            createdAt: new Date(at.getTime() + index),
        }));
        await tx.taskChatMessage.createMany({
            data: [{ id: messageId, tenantId: actor.tenantId, roomId, type: 'TEXT', senderId: actor.employeeId, text: input.text, createdAt: at }],
        });
        if (attachmentRows.length)
            await tx.taskAttachment.createMany({ data: attachmentRows });
        await tx.taskChatRoom.updateMany({ where: { id: roomId, tenantId: actor.tenantId }, data: { lastMessageAt: at } });
        await tx.taskChatMember.updateMany({
            where: { tenantId: actor.tenantId, roomId, employeeId: actor.employeeId },
            data: { lastReadAt: at },
        });
        const message = {
            id: messageId,
            roomId,
            type: 'TEXT',
            senderId: actor.employeeId,
            text: input.text,
            meta: null,
            createdAt: at,
            attachments: attachmentRows.map(taskFiles_1.toAttachmentDto),
            canDelete: true,
        };
        return { message, room: { id: access.id, name: access.name } };
    }));
    const people = await (0, taskPeople_1.loadPersonRefs)([actor.employeeId]);
    notifyChatMessage(actor, written.room, written.message, people[actor.employeeId]?.name ?? '');
    return { message: written.message, people };
};
exports.sendChatMessage = sendChatMessage;
/**
 * Nachricht löschen (Görevly `Ch.removeMessage`): nur Mitglieder des Raums,
 * nur Textnachrichten, nur die eigene — die Leitung jede. Die Dateizeilen
 * gehen per Kaskade mit, die Dateien werden danach aus der Ablage entfernt.
 */
const deleteChatMessage = async (actor, messageId) => {
    const rows = messageId
        ? await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT x.type, x.senderId,
                   EXISTS(SELECT 1 FROM TaskChatMember m WHERE m.roomId = x.roomId AND m.employeeId = ${actor.employeeId}) AS isMember
            FROM TaskChatMessage x
            WHERE x.id = ${messageId} AND x.tenantId = ${actor.tenantId}
        `)
        : [];
    const row = rows[0];
    if (!row)
        throw messageNotFound();
    if (!(0, taskRows_1.rawBool)(row.isMember))
        throw roomForbidden();
    if (String(row.type) !== 'TEXT') {
        throw (0, taskErrors_1.taskBadRequest)('SYSTEM_MESSAGE', 'Systemnachrichten lassen sich nicht löschen.');
    }
    if ((0, taskRows_1.rawString)(row.senderId) !== actor.employeeId && !actor.isManager) {
        throw (0, taskErrors_1.taskForbidden)('MESSAGE_DELETE_FORBIDDEN', 'Nur eigene Nachrichten lassen sich löschen.');
    }
    const fileRefs = await (0, taskFiles_1.collectAttachmentRefs)(prisma_client_1.default, { tenantId: actor.tenantId, messageId });
    await prisma_client_1.default.taskChatMessage.deleteMany({ where: { id: messageId, tenantId: actor.tenantId } });
    await (0, taskFiles_1.removeStoredFiles)(fileRefs);
};
exports.deleteChatMessage = deleteChatMessage;
//# sourceMappingURL=chatService.js.map