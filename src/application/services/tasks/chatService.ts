import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import { assertManager, type TasksActor } from './taskActor';
import { NOTIFY, TASK_LIMITS, roomLinkUrl, type ChatSystemEvent } from './taskConstants';
import { runTasksTransaction, type TasksDb } from './taskDb';
import { taskBadRequest, taskForbidden, taskNotFound } from './taskErrors';
import {
    ATTACHMENT_SELECT,
    collectAttachmentRefs,
    prepareTaskFiles,
    removeStoredFiles,
    storeTaskFiles,
    toAttachmentDto,
    type AttachmentDto,
    type IncomingTaskFile,
} from './taskFiles';
import { notifyTaskPeople, queueTaskNotification } from './taskNotify';
import { assertNotOnboardingTasks } from './taskOnboarding';
import {
    assertAssignablePeople,
    getTasksPeople,
    loadPersonName,
    loadPersonRefs,
    personDisplayName,
    type PersonRef,
    type TasksPerson,
} from './taskPeople';
import { rawBool, rawDate, rawJson, rawNumber, rawString, visibleTasksSql } from './taskRows';

/**
 * ── CHAT-RÄUME DES GÖREVLER-MODULS (Görevly chat.js, serverseitig) ──────────
 *
 * Räume gehören der ausgewählten Firma. Hineinsehen darf NUR, wer Mitglied
 * ist — auch die Leitung hat keine Hintertür (Görevly `forUser`). Anlegen darf
 * die Leitung; umbenennen, löschen, Mitglieder und Aufgaben verknüpfen darf
 * sie nur in Räumen, in denen sie selbst Mitglied ist.
 *
 * Systemnachrichten (Raum angelegt, Person hinzugefügt/entfernt, Aufgabe
 * verknüpft) tragen in `meta` das Ereignis und die Kennungen: die Oberfläche
 * baut daraus den Satz in der Sprache der Leserin, `text` ist nur das deutsche
 * Rückfallnetz.
 *
 * Ungelesen = TEXT-Nachrichten anderer, neuer als der eigene Lesestand (ohne
 * Lesestand: seit dem Beitritt). Systemnachrichten zählen nie.
 *
 * REIHENFOLGE: Wer Nachrichten schreibt, sperrt ZUERST die Raumzeile
 * (`FOR UPDATE`) und vergibt Zeitpunkte mindestens 1 ms nach der letzten
 * Nachricht des Raums. So folgt (createdAt, id) der Reihenfolge des
 * Festschreibens, und der Abruf «neuer als» (`after`) überspringt nie eine
 * Nachricht, die ein gleichzeitiger Absender einen Augenblick später
 * festschreibt. Die Sperre am Anfang verhindert zugleich, dass zwei Absender
 * sich über Fremdschlüssel-Prüfung und Raum-Update gegenseitig blockieren.
 */

/* ── Ausgabeformen ──────────────────────────────────────────────────────── */

export interface ChatRoomDto {
    id: string;
    name: string;
    createdById: string | null;
    createdAt: Date;
    lastMessageAt: Date | null;
}

export interface ChatMemberDto {
    employeeId: string;
    addedById: string | null;
    createdAt: Date;
}

export interface ChatRoomTaskDto {
    id: string;
    title: string;
    status: string;
    /** Darf die handelnde Person die Aufgabe öffnen (Leitung, verantwortlich oder angelegt)? */
    canOpen: boolean;
}

export interface RoomDetailDto {
    room: ChatRoomDto;
    members: ChatMemberDto[];
    tasks: ChatRoomTaskDto[];
    people: Record<string, PersonRef>;
}

export interface ChatMessageDto {
    id: string;
    roomId: string;
    /** TEXT | SYSTEM */
    type: string;
    senderId: string | null;
    text: string;
    /** Bei SYSTEM: { event, actorId, targetId? | taskId?, taskTitle? }; bei TEXT null. */
    meta: Record<string, unknown> | null;
    createdAt: Date;
    attachments: AttachmentDto[];
    canDelete: boolean;
}

export interface ChatLastMessageDto {
    id: string;
    type: string;
    senderId: string | null;
    /** Einzeilige Vorschau, höchstens 140 Zeichen. */
    text: string;
    meta: Record<string, unknown> | null;
    hasAttachments: boolean;
    createdAt: Date;
}

export interface ChatRoomListItemDto {
    id: string;
    name: string;
    memberCount: number;
    taskCount: number;
    unreadCount: number;
    lastMessage: ChatLastMessageDto | null;
    lastMessageAt: Date | null;
    createdAt: Date;
}

export interface ChatRoomListDto {
    data: ChatRoomListItemDto[];
    people: Record<string, PersonRef>;
    serverNow: Date;
}

export interface ChatMessagePageQuery {
    /** Kennung der Cursor-Nachricht: neuere laden ('' = kein Cursor). */
    after: string;
    /** Kennung der Cursor-Nachricht: ältere laden ('' = kein Cursor). */
    before: string;
    limit: number;
}

export interface ChatMessagePageDto {
    /** Immer aufsteigend (älteste zuerst). */
    data: ChatMessageDto[];
    /** Ohne Cursor und mit `before`: es gibt ältere; mit `after`: es gibt noch neuere. */
    hasMore: boolean;
    people: Record<string, PersonRef>;
    serverNow: Date;
}

export interface ChatUnreadDto {
    total: number;
    /** Jeder eigene Raum der Firma, auch mit 0. */
    rooms: Record<string, number>;
}

/* ── Kleine Hilfen ──────────────────────────────────────────────────────── */

const LAST_MESSAGE_PREVIEW_MAX = 140;
/** Rohtext für die Vorschau — reicht, auch wenn Leerraum zusammenfällt. */
const PREVIEW_SOURCE_CHARS = LAST_MESSAGE_PREVIEW_MAX * 4;
/** Görevly: `U.truncate(msg.text, 70)` in der Chatmeldung. */
const NOTIFY_PREVIEW_MAX = 70;

const roomNotFound = () => taskNotFound('ROOM_NOT_FOUND', 'Chat-Raum nicht gefunden.');
const roomForbidden = () => taskForbidden('ROOM_FORBIDDEN', 'Sie sind nicht Mitglied dieses Chat-Raums.');
const messageNotFound = () => taskNotFound('MESSAGE_NOT_FOUND', 'Nachricht nicht gefunden.');

/** Görevly `U.truncate`: zu lang → gekürzt mit «…». */
const truncate = (value: string, max: number): string =>
    value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** Einzeilige Vorschau eines Nachrichtentexts. */
const previewText = (text: string, max: number): string => truncate(text.replace(/\s+/g, ' ').trim(), max);

const asMeta = (value: unknown): Record<string, unknown> | null => {
    const parsed = rawJson(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
};

/** Personen, die eine Nachricht nennt: Absender und die Beteiligten einer Systemnachricht. */
const messagePeopleIds = (messages: ReadonlyArray<{ senderId: string | null; meta: Record<string, unknown> | null }>): string[] =>
    messages.flatMap((message) => [message.senderId, message.meta?.actorId, message.meta?.targetId]
        .filter((id): id is string => typeof id === 'string' && id.length > 0));

const sumCounts = (counts: Record<string, number>): number =>
    Object.values(counts).reduce((sum, count) => sum + count, 0);

/**
 * Zeitpunkt der nächsten Nachricht eines Raums: jetzt, aber mindestens 1 ms
 * nach der letzten. Unter der Raumsperre ergibt das eine streng steigende
 * Folge — auch bei Absendern in derselben Millisekunde oder einer
 * zurückgestellten Uhr.
 */
const nextMessageAt = (lastMessageAt: Date | null): Date =>
    new Date(Math.max(Date.now(), lastMessageAt ? lastMessageAt.getTime() + 1 : 0));

/** Scheitert das Schreiben, verschwinden die schon abgelegten Dateien wieder — keine Waisen. */
const removeFilesOnFailure = async <T>(fileRefs: readonly string[], work: () => Promise<T>): Promise<T> => {
    try {
        return await work();
    } catch (error) {
        await removeStoredFiles(fileRefs);
        throw error;
    }
};

/* ── Zugang ─────────────────────────────────────────────────────────────── */

interface RoomAccess {
    id: string;
    name: string;
    lastMessageAt: Date | null;
    isMember: boolean;
    /** Nur mit `cursorId`: liegt die Cursor-Nachricht in diesem Raum? */
    cursorFound: boolean;
}

/**
 * Raum + eigene Mitgliedschaft in EINER Anweisung. `lock` sperrt die
 * Raumzeile (nur in einer Transaktion); `cursorId` prüft nebenbei, ob die
 * Cursor-Nachricht des Abrufs noch existiert.
 */
const readRoomAccess = async (
    db: TasksDb,
    actor: TasksActor,
    roomId: string,
    options: { lock?: boolean; cursorId?: string } = {},
): Promise<RoomAccess | null> => {
    if (!roomId) return null;
    const cursorColumn = options.cursorId
        ? Prisma.sql`, EXISTS(SELECT 1 FROM TaskChatMessage c WHERE c.id = ${options.cursorId} AND c.roomId = r.id) AS cursorFound`
        : Prisma.empty;
    const rows = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT r.id, r.name, r.lastMessageAt,
               EXISTS(SELECT 1 FROM TaskChatMember m WHERE m.roomId = r.id AND m.employeeId = ${actor.employeeId}) AS isMember
               ${cursorColumn}
        FROM TaskChatRoom r
        WHERE r.id = ${roomId} AND r.tenantId = ${actor.tenantId}
        ${options.lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
    `);
    const row = rows[0];
    if (!row) return null;
    return {
        id: String(row.id),
        name: String(row.name ?? ''),
        lastMessageAt: rawDate(row.lastMessageAt),
        isMember: rawBool(row.isMember),
        cursorFound: rawBool(row.cursorFound),
    };
};

/** 404, wenn es den Raum in der Firma nicht gibt; 403, wenn die Person nicht Mitglied ist. */
const requireRoomMember = async (
    db: TasksDb,
    actor: TasksActor,
    roomId: string,
    options: { lock?: boolean; cursorId?: string } = {},
): Promise<RoomAccess> => {
    const access = await readRoomAccess(db, actor, roomId, options);
    if (!access) throw roomNotFound();
    if (!access.isMember) throw roomForbidden();
    return access;
};

/* ── Systemnachrichten ──────────────────────────────────────────────────── */

interface SystemMessageInput {
    event: ChatSystemEvent;
    /** Deutsches Rückfallnetz. */
    text: string;
    /** Kennungen für die Oberfläche (zusätzlich zu event und actorId). */
    details: Record<string, string>;
}

const systemMessage = {
    roomCreated: (): SystemMessageInput => ({ event: 'ROOM_CREATED', text: 'Raum angelegt.', details: {} }),
    memberAdded: (targetId: string, name: string): SystemMessageInput => ({
        event: 'MEMBER_ADDED',
        text: `${name || 'Eine Person'} wurde hinzugefügt.`,
        details: { targetId },
    }),
    memberRemoved: (targetId: string, name: string): SystemMessageInput => ({
        event: 'MEMBER_REMOVED',
        text: `${name || 'Eine Person'} wurde entfernt.`,
        details: { targetId },
    }),
    taskLinked: (taskId: string, taskTitle: string): SystemMessageInput => ({
        event: 'TASK_LINKED',
        text: `Mit «${taskTitle}» verknüpft.`,
        details: { taskId, taskTitle },
    }),
};

/** Zeilen für Systemnachrichten in ihrer Reihenfolge: je 1 ms Abstand ab `at`. */
const systemMessageRows = (
    actor: TasksActor,
    roomId: string,
    at: Date,
    messages: readonly SystemMessageInput[],
): Prisma.TaskChatMessageCreateManyInput[] =>
    messages.map((message, index) => ({
        id: nanoid(12),
        tenantId: actor.tenantId,
        roomId,
        type: 'SYSTEM',
        senderId: actor.employeeId,
        text: message.text,
        meta: { event: message.event, actorId: actor.employeeId, ...message.details },
        createdAt: new Date(at.getTime() + index),
    }));

/** EINE Systemnachricht an einen bestehenden Raum hängen. Der Aufrufer hält die Raumsperre. */
const appendSystemMessage = async (tx: TasksDb, actor: TasksActor, roomId: string, at: Date, message: SystemMessageInput): Promise<void> => {
    await tx.taskChatMessage.createMany({ data: systemMessageRows(actor, roomId, at, [message]) });
    await tx.taskChatRoom.updateMany({ where: { id: roomId, tenantId: actor.tenantId }, data: { lastMessageAt: at } });
};

/* ── Raumdetail ─────────────────────────────────────────────────────────── */

interface RoomTaskRow {
    id: string;
    title: string;
    status: string;
    createdById: string;
    isAssignee: boolean;
}

const roomTaskColumns = (employeeId: string): Prisma.Sql => Prisma.sql`
    t.id, t.title, t.status, t.createdById,
    EXISTS(SELECT 1 FROM TaskAssignee a WHERE a.taskId = t.id AND a.employeeId = ${employeeId}) AS isAssignee
`;

const mapRoomTaskRow = (row: Record<string, unknown>): RoomTaskRow => ({
    id: String(row.id),
    title: String(row.title ?? ''),
    status: String(row.status ?? 'NOT_STARTED'),
    createdById: String(row.createdById ?? ''),
    isAssignee: rawBool(row.isAssignee),
});

/** Die verknüpften Aufgaben eines Raums, in der Reihenfolge des Verknüpfens. */
const loadRoomTasks = async (actor: TasksActor, roomId: string): Promise<RoomTaskRow[]> =>
    (await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${roomTaskColumns(actor.employeeId)}
        FROM TaskChatRoomTask rt
        JOIN Task t ON t.id = rt.taskId AND t.tenantId = ${actor.tenantId}
        WHERE rt.roomId = ${roomId} AND rt.tenantId = ${actor.tenantId}
        ORDER BY rt.createdAt ASC, rt.id ASC
    `)).map(mapRoomTaskRow);

/** Aufgaben der Firma nach Kennung (Prüfung beim Anlegen eines Raums). */
const loadTenantTasks = async (actor: TasksActor, taskIds: readonly string[]): Promise<RoomTaskRow[]> => {
    if (!taskIds.length) return [];
    return (await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${roomTaskColumns(actor.employeeId)}
        FROM Task t
        WHERE ${visibleTasksSql(actor)} AND t.id IN (${Prisma.join([...taskIds])})
    `)).map(mapRoomTaskRow);
};

interface RoomParts {
    room: ChatRoomDto;
    members: ChatMemberDto[];
    tasks: RoomTaskRow[];
}

const ROOM_SELECT = {
    id: true,
    name: true,
    createdById: true,
    createdAt: true,
    lastMessageAt: true,
} satisfies Prisma.TaskChatRoomSelect;

const MEMBER_SELECT = { employeeId: true, addedById: true, createdAt: true } satisfies Prisma.TaskChatMemberSelect;

/** Raum, Mitglieder und Aufgaben parallel; null = kein Raum dieser Firma. */
const readRoomParts = async (actor: TasksActor, roomId: string): Promise<RoomParts | null> => {
    if (!roomId) return null;
    const [room, members, tasks] = await Promise.all([
        prisma.taskChatRoom.findFirst({ where: { id: roomId, tenantId: actor.tenantId }, select: ROOM_SELECT }),
        prisma.taskChatMember.findMany({
            where: { roomId, tenantId: actor.tenantId },
            select: MEMBER_SELECT,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        loadRoomTasks(actor, roomId),
    ]);
    return room ? { room, members, tasks } : null;
};

const toRoomDetail = async (actor: TasksActor, parts: RoomParts): Promise<RoomDetailDto> => ({
    room: parts.room,
    members: parts.members,
    tasks: parts.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        // Dieselbe Sichtbarkeit wie canSeeTask: Administratorrolle, verantwortlich oder angelegt.
        canOpen: actor.seesAll || task.isAssignee || task.createdById === actor.employeeId,
    })),
    people: await loadPersonRefs([
        parts.room.createdById,
        ...parts.members.flatMap((member) => [member.employeeId, member.addedById]),
    ]),
});

/** Der Raum nach einer Änderung, frisch gelesen. */
const loadRoomDetail = async (actor: TasksActor, roomId: string): Promise<RoomDetailDto> => {
    const parts = await readRoomParts(actor, roomId);
    if (!parts) throw roomNotFound();
    return toRoomDetail(actor, parts);
};

/* ── Benachrichtigungen ─────────────────────────────────────────────────── */

const notifyAddedToRoom = (
    actor: TasksActor,
    room: { id: string; name: string },
    recipientIds: readonly string[],
    actorName: string,
): void => {
    if (!recipientIds.length) return;
    queueTaskNotification({
        tenantId: actor.tenantId,
        type: NOTIFY.CHAT_ADDED,
        recipientIds,
        actorId: actor.employeeId,
        title: 'Zum Chat hinzugefügt',
        message: `${actorName} hat Sie zu «${room.name}» hinzugefügt.`,
        linkUrl: roomLinkUrl(room.id),
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
const notifyChatMessage = (
    actor: TasksActor,
    room: { id: string; name: string },
    message: ChatMessageDto,
    actorName: string,
): void => {
    const preview = previewText(message.text, NOTIFY_PREVIEW_MAX);
    void prisma.taskChatMember
        .findMany({ where: { tenantId: actor.tenantId, roomId: room.id }, select: { employeeId: true } })
        .then((members) => notifyTaskPeople({
            tenantId: actor.tenantId,
            type: NOTIFY.CHAT_MESSAGE,
            recipientIds: members.map((member) => member.employeeId),
            actorId: actor.employeeId,
            title: room.name,
            message: `${actorName}: ${preview || 'Datei'}`,
            linkUrl: roomLinkUrl(room.id),
            params: { actor: actorName, room: room.name, text: preview, fileCount: message.attachments.length },
            meta: { roomId: room.id },
            coalesceUnread: true,
        }))
        .catch((error: unknown) => {
            console.warn('[tasks.chat] Chatmeldung konnte nicht verschickt werden', error);
        });
};

/* ── Raumliste und Ungelesen ────────────────────────────────────────────── */

/**
 * Ungelesene Textnachrichten EINES Raums — korrelierte Unterabfrage über das
 * Mitglied `m`. Dieselbe Regel wie `unreadChatCount` der Zusammenfassung.
 */
const unreadCountSql = (employeeId: string): Prisma.Sql => Prisma.sql`(
    SELECT COUNT(*) FROM TaskChatMessage um
    WHERE um.roomId = m.roomId
      AND um.type = 'TEXT'
      AND um.senderId <> ${employeeId}
      AND um.createdAt > COALESCE(m.lastReadAt, m.createdAt)
)`;

const mapRoomListRow = (row: Record<string, unknown>): ChatRoomListItemDto => {
    const lastId = rawString(row.lastId);
    const lastCreatedAt = rawDate(row.lastCreatedAt);
    return {
        id: String(row.id),
        name: String(row.name ?? ''),
        memberCount: rawNumber(row.memberCount),
        taskCount: rawNumber(row.taskCount),
        unreadCount: rawNumber(row.unreadCount),
        lastMessage: lastId && lastCreatedAt
            ? {
                id: lastId,
                type: String(row.lastType ?? 'TEXT'),
                senderId: rawString(row.lastSenderId),
                text: previewText(String(row.lastText ?? ''), LAST_MESSAGE_PREVIEW_MAX),
                meta: asMeta(row.lastMeta),
                hasAttachments: rawBool(row.lastHasAttachments),
                createdAt: lastCreatedAt,
            }
            : null,
        lastMessageAt: rawDate(row.lastMessageAt),
        createdAt: rawDate(row.createdAt) ?? new Date(0),
    };
};

/**
 * Die eigenen Räume, zuletzt aktive zuerst. Letzte Nachricht wie Görevly
 * `lastMessage`: die letzte TEXT-Nachricht, sonst die letzte überhaupt.
 * Zwei Anweisungen: Räume samt Zählern und letzter Nachricht, dann die Namen.
 */
export const listChatRooms = async (actor: TasksActor): Promise<ChatRoomListDto> => {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
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
    const people = await loadPersonRefs(messagePeopleIds(data.flatMap((room) => (room.lastMessage ? [room.lastMessage] : []))));
    return { data, people, serverNow: new Date() };
};

/** Ungelesene Textnachrichten je eigenem Raum der Firma (Räume ohne Ungelesenes mit 0). */
export const loadChatUnreadByRoom = async (tenantId: string, employeeId: string): Promise<Record<string, number>> => {
    const rows = await prisma.$queryRaw<Array<{ roomId: string; unreadCount: unknown }>>(Prisma.sql`
        SELECT m.roomId, ${unreadCountSql(employeeId)} AS unreadCount
        FROM TaskChatMember m
        WHERE m.tenantId = ${tenantId} AND m.employeeId = ${employeeId}
    `);
    return Object.fromEntries(rows.map((row) => [row.roomId, rawNumber(row.unreadCount)]));
};

export const getChatUnread = async (actor: TasksActor): Promise<ChatUnreadDto> => {
    const rooms = await loadChatUnreadByRoom(actor.tenantId, actor.employeeId);
    return { total: sumCounts(rooms), rooms };
};

/** Lesestand auf jetzt; die Antwort trägt gleich die neue Gesamtzahl für das Abzeichen. */
export const markChatRoomRead = async (actor: TasksActor, roomId: string): Promise<{ ok: true; unreadTotal: number }> => {
    const { count } = await prisma.taskChatMember.updateMany({
        where: { tenantId: actor.tenantId, roomId, employeeId: actor.employeeId },
        data: { lastReadAt: new Date() },
    });
    // Nichts geändert: der Fehler sagt, ob der Raum fehlt oder die Mitgliedschaft.
    if (!count) await requireRoomMember(prisma, actor, roomId);
    const rooms = await loadChatUnreadByRoom(actor.tenantId, actor.employeeId);
    return { ok: true, unreadTotal: sumCounts(rooms) };
};

/* ── Räume verwalten (Leitung, die selbst Mitglied ist) ────────────────── */

export interface CreateChatRoomInput {
    name: string;
    memberIds: readonly string[];
    taskIds: readonly string[];
}

/**
 * Raum anlegen (Görevly `Ch.create`): die Anlegende ist automatisch Mitglied,
 * weitere Personen müssen zur Firma gehören und das Modul benutzen dürfen,
 * Aufgaben müssen Aufgaben der Firma sein. Systemnachrichten in fester
 * Folge: angelegt → je Person hinzugefügt → je Aufgabe verknüpft.
 */
export const createChatRoom = async (actor: TasksActor, input: CreateChatRoomInput): Promise<RoomDetailDto> => {
    assertManager(actor);
    const me = actor.employeeId;
    const taskIds = [...new Set(input.taskIds)];
    assertNotOnboardingTasks(taskIds);
    const [memberIds, taskRows] = await Promise.all([
        assertAssignablePeople(actor.tenantId, input.memberIds.filter((id) => id !== me)),
        loadTenantTasks(actor, taskIds),
    ]);

    const taskById = new Map(taskRows.map((task) => [task.id, task]));
    const missing = taskIds.filter((id) => !taskById.has(id));
    if (missing.length) {
        throw taskBadRequest('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { taskIds: missing });
    }
    const tasks = taskIds.flatMap((id) => taskById.get(id) ?? []);
    // Frisch geprüft ⇒ aus dem 30-s-Zwischenspeicher, kein zusätzlicher Rundgang.
    const staff = memberIds.length ? await getTasksPeople(actor.tenantId) : new Map<string, TasksPerson>();

    const roomId = nanoid(12);
    const at = new Date();
    const messages = [
        systemMessage.roomCreated(),
        ...memberIds.map((id) => systemMessage.memberAdded(id, personDisplayName(staff.get(id)))),
        ...tasks.map((task) => systemMessage.taskLinked(task.id, task.title)),
    ];
    const lastMessageAt = new Date(at.getTime() + messages.length - 1);
    const room: ChatRoomDto = { id: roomId, name: input.name, createdById: me, createdAt: at, lastMessageAt };
    const members: ChatMemberDto[] = [me, ...memberIds].map((employeeId) => ({
        employeeId,
        addedById: employeeId === me ? null : me,
        createdAt: at,
    }));

    await runTasksTransaction(async (tx) => {
        // createMany auch für die eine Raumzeile: ohne das Rücklesen, das create kostet.
        await tx.taskChatRoom.createMany({ data: [{ ...room, tenantId: actor.tenantId }] });
        await tx.taskChatMember.createMany({
            data: members.map((member) => ({ id: nanoid(12), tenantId: actor.tenantId, roomId, ...member })),
        });
        if (tasks.length) {
            await tx.taskChatRoomTask.createMany({
                data: tasks.map((task) => ({ id: nanoid(12), tenantId: actor.tenantId, roomId, taskId: task.id, linkedById: me, createdAt: at })),
            });
        }
        await tx.taskChatMessage.createMany({ data: systemMessageRows(actor, roomId, at, messages) });
    });

    const detail = await toRoomDetail(actor, { room, members, tasks });
    notifyAddedToRoom(actor, room, memberIds, detail.people[me]?.name ?? '');
    return detail;
};

export const getChatRoom = async (actor: TasksActor, roomId: string): Promise<RoomDetailDto> => {
    const parts = await readRoomParts(actor, roomId);
    if (!parts) throw roomNotFound();
    if (!parts.members.some((member) => member.employeeId === actor.employeeId)) throw roomForbidden();
    return toRoomDetail(actor, parts);
};

export const renameChatRoom = async (actor: TasksActor, roomId: string, name: string): Promise<RoomDetailDto> => {
    assertManager(actor);
    await requireRoomMember(prisma, actor, roomId);
    await prisma.taskChatRoom.updateMany({ where: { id: roomId, tenantId: actor.tenantId }, data: { name } });
    return loadRoomDetail(actor, roomId);
};

/**
 * Raum löschen: Mitglieder, Verknüpfungen, Nachrichten und Dateizeilen gehen
 * per Kaskade mit — die Ablage kennt keine Kaskade, darum werden die Verweise
 * unter der Raumsperre gesammelt (ein gleichzeitiger Absender wartet und
 * scheitert danach sauber) und nach dem Löschen entfernt.
 * Gibt Name und Dateizahl für das Audit-Protokoll zurück.
 */
export const deleteChatRoom = async (actor: TasksActor, roomId: string): Promise<{ name: string; fileCount: number }> => {
    assertManager(actor);
    const removed = await runTasksTransaction(async (tx) => {
        const access = await requireRoomMember(tx, actor, roomId, { lock: true });
        const fileRefs = await collectAttachmentRefs(tx, { tenantId: actor.tenantId, roomId });
        await tx.taskChatRoom.deleteMany({ where: { id: roomId, tenantId: actor.tenantId } });
        return { name: access.name, fileRefs };
    });
    await removeStoredFiles(removed.fileRefs);
    return { name: removed.name, fileCount: removed.fileRefs.length };
};

/** Person aufnehmen (Görevly `Ch.addMember`); schon Mitglied ⇒ unverändert, ohne Nachricht. */
export const addChatMember = async (actor: TasksActor, roomId: string, employeeId: string): Promise<RoomDetailDto> => {
    assertManager(actor);
    const [targetId] = await assertAssignablePeople(actor.tenantId, [employeeId]);
    if (!targetId) throw taskBadRequest('PERSON_NOT_ASSIGNABLE', 'Keine Person angegeben.');
    const staff = await getTasksPeople(actor.tenantId);

    const addedTo = await runTasksTransaction(async (tx) => {
        const access = await requireRoomMember(tx, actor, roomId, { lock: true });
        const at = nextMessageAt(access.lastMessageAt);
        const { count } = await tx.taskChatMember.createMany({
            data: [{ id: nanoid(12), tenantId: actor.tenantId, roomId, employeeId: targetId, addedById: actor.employeeId, createdAt: at }],
            skipDuplicates: true,
        });
        if (!count) return null;
        await appendSystemMessage(tx, actor, roomId, at, systemMessage.memberAdded(targetId, personDisplayName(staff.get(targetId))));
        return access;
    });

    const detail = await loadRoomDetail(actor, roomId);
    if (addedTo) notifyAddedToRoom(actor, addedTo, [targetId], detail.people[actor.employeeId]?.name ?? '');
    return detail;
};

/**
 * Person entfernen (Görevly `Ch.removeMember`). Ohne Personalprüfung: auch
 * ehemalige Mitarbeitende müssen sich austragen lassen. Kein Mitglied ⇒
 * unverändert, ohne Nachricht.
 */
export const removeChatMember = async (actor: TasksActor, roomId: string, employeeId: string): Promise<RoomDetailDto> => {
    assertManager(actor);
    const name = await loadPersonName(employeeId);
    await runTasksTransaction(async (tx) => {
        const access = await requireRoomMember(tx, actor, roomId, { lock: true });
        const { count } = await tx.taskChatMember.deleteMany({ where: { tenantId: actor.tenantId, roomId, employeeId } });
        if (count) {
            await appendSystemMessage(tx, actor, roomId, nextMessageAt(access.lastMessageAt), systemMessage.memberRemoved(employeeId, name));
        }
    });
    return loadRoomDetail(actor, roomId);
};

/** Aufgabe verknüpfen (Görevly `Ch.linkTask`); schon verknüpft ⇒ unverändert, ohne Nachricht. */
export const linkChatTask = async (actor: TasksActor, roomId: string, taskId: string): Promise<RoomDetailDto> => {
    assertManager(actor);
    assertNotOnboardingTasks([taskId]);
    const [task] = taskId ? await loadTenantTasks(actor, [taskId]) : [];
    if (!task) throw taskBadRequest('TASK_NOT_FOUND', 'Aufgabe nicht gefunden.', { taskIds: [taskId] });

    await runTasksTransaction(async (tx) => {
        const access = await requireRoomMember(tx, actor, roomId, { lock: true });
        const at = nextMessageAt(access.lastMessageAt);
        const { count } = await tx.taskChatRoomTask.createMany({
            data: [{ id: nanoid(12), tenantId: actor.tenantId, roomId, taskId: task.id, linkedById: actor.employeeId, createdAt: at }],
            skipDuplicates: true,
        });
        if (count) await appendSystemMessage(tx, actor, roomId, at, systemMessage.taskLinked(task.id, task.title));
    });
    return loadRoomDetail(actor, roomId);
};

/** Verknüpfung lösen (Görevly `Ch.unlinkTask`) — ohne Systemnachricht. */
export const unlinkChatTask = async (actor: TasksActor, roomId: string, taskId: string): Promise<RoomDetailDto> => {
    assertManager(actor);
    await requireRoomMember(prisma, actor, roomId);
    await prisma.taskChatRoomTask.deleteMany({ where: { tenantId: actor.tenantId, roomId, taskId } });
    return loadRoomDetail(actor, roomId);
};

/* ── Nachrichten ────────────────────────────────────────────────────────── */

type MessageRow = Omit<ChatMessageDto, 'attachments' | 'canDelete'>;

const MESSAGE_COLUMNS = Prisma.sql`x.id, x.roomId, x.type, x.senderId, x.text, x.meta, x.createdAt`;

const mapMessageRow = (row: Record<string, unknown>): MessageRow => ({
    id: String(row.id),
    roomId: String(row.roomId),
    type: String(row.type ?? 'TEXT'),
    senderId: rawString(row.senderId),
    text: String(row.text ?? ''),
    meta: asMeta(row.meta),
    createdAt: rawDate(row.createdAt) ?? new Date(0),
});

const toMessageDto = (actor: TasksActor, message: MessageRow, attachments: AttachmentDto[]): ChatMessageDto => ({
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
const messagePageSql = (tenantId: string, roomId: string, query: ChatMessagePageQuery): Prisma.Sql => {
    const take = query.limit + 1;
    if (query.after) {
        return Prisma.sql`
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
        return Prisma.sql`
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
    return Prisma.sql`
        SELECT ${MESSAGE_COLUMNS}
        FROM TaskChatMessage x
        WHERE x.roomId = ${roomId} AND x.tenantId = ${tenantId}
        ORDER BY x.createdAt DESC, x.id DESC
        LIMIT ${take}
    `;
};

const loadMessageAttachments = async (
    tenantId: string,
    roomId: string,
    messageIds: readonly string[],
): Promise<Map<string, AttachmentDto[]>> => {
    const byMessage = new Map<string, AttachmentDto[]>();
    if (!messageIds.length) return byMessage;
    const rows = await prisma.taskAttachment.findMany({
        where: { tenantId, roomId, kind: 'CHAT', messageId: { in: [...messageIds] } },
        select: ATTACHMENT_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const row of rows) {
        if (!row.messageId) continue;
        const list = byMessage.get(row.messageId) ?? [];
        list.push(toAttachmentDto(row));
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
export const listChatMessages = async (
    actor: TasksActor,
    roomId: string,
    query: ChatMessagePageQuery,
): Promise<ChatMessagePageDto> => {
    if (query.after && query.before) {
        throw taskBadRequest('CURSOR_CONFLICT', 'Bitte entweder «after» oder «before» angeben.');
    }
    const cursorId = query.after || query.before;
    const access = await requireRoomMember(prisma, actor, roomId, cursorId ? { cursorId } : {});
    if (cursorId && !access.cursorFound) throw messageNotFound();

    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(messagePageSql(actor.tenantId, roomId, query));
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit).map(mapMessageRow);
    // Ohne Cursor und mit `before` kommt die Seite absteigend aus der Datenbank.
    if (!query.after) page.reverse();

    const [attachments, people] = await Promise.all([
        loadMessageAttachments(actor.tenantId, roomId, page.map((message) => message.id)),
        loadPersonRefs(messagePeopleIds(page)),
    ]);
    return {
        data: page.map((message) => toMessageDto(actor, message, attachments.get(message.id) ?? [])),
        hasMore,
        people,
        serverNow: new Date(),
    };
};

export interface SendChatMessageInput {
    /** Bereinigter Klartext ('' = nur Dateien). */
    text: string;
    files: readonly IncomingTaskFile[];
}

/**
 * Nachricht senden (Görevly `Ch.send`): Text und/oder Dateien. Die Dateien
 * liegen in der Ablage, bevor die Transaktion Nachricht, Dateizeilen,
 * `lastMessageAt` des Raums und den eigenen Lesestand schreibt; scheitert sie,
 * werden die Dateien wieder entfernt.
 */
export const sendChatMessage = async (
    actor: TasksActor,
    roomId: string,
    input: SendChatMessageInput,
): Promise<{ message: ChatMessageDto; people: Record<string, PersonRef> }> => {
    const prepared = prepareTaskFiles(input.files, TASK_LIMITS.chatFilesMax);
    if (!input.text && !prepared.length) throw taskBadRequest('MESSAGE_EMPTY', 'Die Nachricht ist leer.');
    // Dateien erst ablegen, wenn feststeht, dass die Person hier schreiben darf.
    if (prepared.length) await requireRoomMember(prisma, actor, roomId);
    const fileRefs = await storeTaskFiles(actor.tenantId, prepared);

    const written = await removeFilesOnFailure(fileRefs, () => runTasksTransaction(async (tx) => {
        // Unter der Sperre erneut: wer inzwischen entfernt wurde, schreibt nicht mehr.
        const access = await requireRoomMember(tx, actor, roomId, { lock: true });
        const at = nextMessageAt(access.lastMessageAt);
        const messageId = nanoid(12);
        const attachmentRows = prepared.map((file, index) => ({
            id: nanoid(12),
            tenantId: actor.tenantId,
            kind: 'CHAT',
            roomId,
            messageId,
            fileName: file.fileName,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            // storeTaskFiles liefert je Datei genau einen Verweis, in Eingangsreihenfolge.
            fileRef: fileRefs[index] as string,
            uploadedById: actor.employeeId,
            // Je 1 ms Abstand: die Dateien behalten ihre Reihenfolge.
            createdAt: new Date(at.getTime() + index),
        }));

        await tx.taskChatMessage.createMany({
            data: [{ id: messageId, tenantId: actor.tenantId, roomId, type: 'TEXT', senderId: actor.employeeId, text: input.text, createdAt: at }],
        });
        if (attachmentRows.length) await tx.taskAttachment.createMany({ data: attachmentRows });
        await tx.taskChatRoom.updateMany({ where: { id: roomId, tenantId: actor.tenantId }, data: { lastMessageAt: at } });
        await tx.taskChatMember.updateMany({
            where: { tenantId: actor.tenantId, roomId, employeeId: actor.employeeId },
            data: { lastReadAt: at },
        });

        const message: ChatMessageDto = {
            id: messageId,
            roomId,
            type: 'TEXT',
            senderId: actor.employeeId,
            text: input.text,
            meta: null,
            createdAt: at,
            attachments: attachmentRows.map(toAttachmentDto),
            canDelete: true,
        };
        return { message, room: { id: access.id, name: access.name } };
    }));

    const people = await loadPersonRefs([actor.employeeId]);
    notifyChatMessage(actor, written.room, written.message, people[actor.employeeId]?.name ?? '');
    return { message: written.message, people };
};

/**
 * Nachricht löschen (Görevly `Ch.removeMessage`): nur Mitglieder des Raums,
 * nur Textnachrichten, nur die eigene — die Leitung jede. Die Dateizeilen
 * gehen per Kaskade mit, die Dateien werden danach aus der Ablage entfernt.
 */
export const deleteChatMessage = async (actor: TasksActor, messageId: string): Promise<void> => {
    const rows = messageId
        ? await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT x.type, x.senderId,
                   EXISTS(SELECT 1 FROM TaskChatMember m WHERE m.roomId = x.roomId AND m.employeeId = ${actor.employeeId}) AS isMember
            FROM TaskChatMessage x
            WHERE x.id = ${messageId} AND x.tenantId = ${actor.tenantId}
        `)
        : [];
    const row = rows[0];
    if (!row) throw messageNotFound();
    if (!rawBool(row.isMember)) throw roomForbidden();
    if (String(row.type) !== 'TEXT') {
        throw taskBadRequest('SYSTEM_MESSAGE', 'Systemnachrichten lassen sich nicht löschen.');
    }
    if (rawString(row.senderId) !== actor.employeeId && !actor.isManager) {
        throw taskForbidden('MESSAGE_DELETE_FORBIDDEN', 'Nur eigene Nachrichten lassen sich löschen.');
    }

    const fileRefs = await collectAttachmentRefs(prisma, { tenantId: actor.tenantId, messageId });
    await prisma.taskChatMessage.deleteMany({ where: { id: messageId, tenantId: actor.tenantId } });
    await removeStoredFiles(fileRefs);
};
