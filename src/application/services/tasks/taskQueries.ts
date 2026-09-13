import { Prisma } from '@prisma/client';

import prisma from '../../../infrastructure/database/prisma.client';
import { assertManager, type TasksActor } from './taskActor';
import type { TaskPermissions } from './taskAccess';
import { loadVisibleTaskComments, type CommentDto } from './commentService';
import { CLOSED_TASK_STATUSES, DEFAULT_REMINDER_LEAD_MINUTES, TASK_LIMITS, TASK_STATUSES } from './taskConstants';
import { taskNotFound } from './taskErrors';
import type { AttachmentDto } from './taskFiles';
import { computeTaskForecast, type TaskForecast } from './taskForecast';
import { loadTaskAttachments, loadTaskChecklists, loadTaskContent, type ChecklistDto, type ContentDto } from './taskParts';
import { getTasksPeople, loadPersonRefs, type PersonRef, type TasksPerson } from './taskPeople';
import {
    fetchTaskCores,
    loadRunningSessionsByTask,
    loadTaskCore,
    memberVisibilitySql,
    rawDate,
    rawNumber,
    requireVisibleTask,
    taskPeopleIds,
    toTaskDetailDto,
    toTaskRowDto,
    visibleTasksSql,
    type RunningSessionRef,
    type TaskCore,
    type TaskDetailDto,
    type TaskRowDto,
} from './taskRows';
import { endOfLocalDay, liveDurationMs } from './taskTime';
import { getActiveTimer, type ActiveTimerInfo } from './taskTimer';
import { ensureTaskOnboarding, type TaskOnboardingDto } from './taskOnboarding';

/**
 * ── GÖREVLER: LESEWEGE DER AUFGABEN ─────────────────────────────────────────
 *
 * Start der Seite (bootstrap), Zähler der Seitenleiste (summary), Liste, Pano
 * und Schnellsuche, die Anfragen der Leitung (approvals), die Detailansicht,
 * der Verlauf und die Zeitaufschlüsselung. Hier wird nur GELESEN — die
 * Zustandswechsel stehen in taskService.ts.
 *
 * Die Datenbank ist fern (50–170 ms je Anweisung): die Teile einer Antwort
 * laufen parallel, Aufgabenzeilen kommen aus EINER Anweisung
 * (TASK_CORE_COLUMNS). «Jetzt» ist die Uhr dieses Servers und geht als Wert in
 * die Abfragen — dieselbe Uhr rechnet `overdue` der Zeilen und `serverNow`.
 *
 * Zeiten (ms) sieht nur die Leitung: ein Teammitglied bekommt kein `work`,
 * keine Aufschlüsselung und nicht die Namen derer, die gerade messen.
 */

/* ── Bausteine ──────────────────────────────────────────────────────────── */

/** Offen = weder abgeschlossen noch abgelehnt (Görevly `isOpen`). */
const OPEN_TASK_SQL = Prisma.sql`t.status NOT IN (${Prisma.join([...CLOSED_TASK_STATUSES])})`;

/** Rang eines Zustands — TASK_STATUSES steht in der Reihenfolge von Görevly `STATUS.order`. */
const STATUS_RANK_SQL = Prisma.sql`FIELD(t.status, ${Prisma.join([...TASK_STATUSES])})`;

/** Görevly sortiert hoch vor mittel vor niedrig. */
const PRIORITY_RANK_SQL = Prisma.sql`FIELD(t.priority, 'HIGH', 'MEDIUM', 'LOW')`;

/**
 * Laufende Messungen und Personen der Zeilen in EINEM Rundgang. Messen dürfen
 * nur Verantwortliche, und wer entfernt wird, dessen Messung endet — ihre
 * Namen stehen darum schon in `taskPeopleIds`; nur eine Abweichung davon
 * kostet eine Nachlesung. Teammitglieder brauchen diese Namen nicht.
 */
const loadRunningSessionsAndPeople = async (
    actor: TasksActor,
    cores: readonly TaskCore[],
): Promise<{ running: Map<string, RunningSessionRef[]>; people: Record<string, PersonRef> }> => {
    const [running, people] = await Promise.all([
        loadRunningSessionsByTask(prisma, actor.tenantId, cores.map((core) => core.id)),
        loadPersonRefs(cores.flatMap((core) => taskPeopleIds(core))),
    ]);
    if (actor.isManager) {
        const missing = [...running.values()].flat().map((session) => session.employeeId).filter((id) => !people[id]);
        if (missing.length) Object.assign(people, await loadPersonRefs(missing));
    }
    return { running, people };
};

/* ── Antwort nach einem Schreibweg ──────────────────────────────────────── */

export interface TaskEnvelope {
    task: TaskDetailDto;
    people: Record<string, PersonRef>;
    serverNow: Date;
}

/** Die Aufgabe im Zustand NACH dem Commit — die Antwort jedes Schreibwegs. */
export const loadTaskEnvelope = async (actor: TasksActor, taskId: string): Promise<TaskEnvelope> => {
    const core = await loadTaskCore(prisma, actor.tenantId, taskId);
    if (!core) throw taskNotFound();
    const { running, people } = await loadRunningSessionsAndPeople(actor, [core]);
    const now = new Date();
    return { task: toTaskDetailDto(core, actor, running.get(core.id) ?? [], now), people, serverNow: now };
};

/* ── Zähler der Seitenleiste ────────────────────────────────────────────── */

export interface TasksSummaryDto {
    openCount: number;
    overdueCount: number;
    /** Heute fällig und noch nicht überfällig (Görevly-Gruppe «Bugün»). */
    dueTodayCount: number;
    /** Aufgaben mit offener Abschlussanfrage ODER offenem Vorschlag — nur Leitung, sonst 0. */
    pendingApprovalCount: number;
    unreadChatCount: number;
    activeTimer: ActiveTimerInfo | null;
    serverNow: Date;
}

export const getTasksSummary = async (actor: TasksActor): Promise<TasksSummaryDto> => {
    const now = new Date();
    const [countRows, unreadRows, activeTimer] = await Promise.all([
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT
                COALESCE(SUM(CASE WHEN ${OPEN_TASK_SQL} THEN 1 ELSE 0 END), 0) AS openCount,
                COALESCE(SUM(CASE WHEN ${OPEN_TASK_SQL} AND t.dueAt < ${now} THEN 1 ELSE 0 END), 0) AS overdueCount,
                COALESCE(SUM(CASE WHEN ${OPEN_TASK_SQL} AND t.dueAt >= ${now} AND t.dueAt <= ${endOfLocalDay(now)}
                    THEN 1 ELSE 0 END), 0) AS dueTodayCount,
                COALESCE(SUM(CASE WHEN t.reviewState = 'PENDING'
                    ${actor.isSystemAdmin ? Prisma.sql`OR t.approvalState = 'PENDING'` : Prisma.empty}
                    ${actor.canDelete ? Prisma.sql`OR t.deleteRequestedAt IS NOT NULL` : Prisma.empty}
                    THEN 1 ELSE 0 END), 0) AS pendingCount
            FROM Task t
            WHERE ${visibleTasksSql(actor)}
        `),
        // Ungelesen = Textnachrichten anderer nach dem eigenen Lesestand (sonst nach dem Beitritt).
        prisma.$queryRaw<Array<{ unread: unknown }>>(Prisma.sql`
            SELECT COUNT(*) AS unread
            FROM TaskChatMember m
            JOIN TaskChatMessage msg ON msg.roomId = m.roomId
            WHERE m.tenantId = ${actor.tenantId}
              AND m.employeeId = ${actor.employeeId}
              AND msg.tenantId = ${actor.tenantId}
              AND msg.type = 'TEXT'
              AND msg.senderId <> ${actor.employeeId}
              AND msg.createdAt > COALESCE(m.lastReadAt, m.createdAt)
        `),
        getActiveTimer(actor.employeeId),
    ]);
    const counts = countRows[0] ?? {};
    return {
        openCount: rawNumber(counts.openCount),
        overdueCount: rawNumber(counts.overdueCount),
        dueTodayCount: rawNumber(counts.dueTodayCount),
        pendingApprovalCount: actor.isManager ? rawNumber(counts.pendingCount) : 0,
        unreadChatCount: rawNumber(unreadRows[0]?.unread),
        activeTimer,
        serverNow: now,
    };
};

/* ── Start der Seite ────────────────────────────────────────────────────── */

export interface LabelDto {
    id: string;
    name: string;
    color: string;
    /** Nur für die Leitung. */
    usageCount?: number;
}

const loadTaskLabels = async (actor: TasksActor): Promise<LabelDto[]> => {
    if (!actor.isManager) {
        return prisma.taskLabel.findMany({
            where: { tenantId: actor.tenantId },
            select: { id: true, name: true, color: true },
            orderBy: [{ name: 'asc' }],
        });
    }
    const rows = await prisma.$queryRaw<Array<{ id: string; name: string; color: string; usageCount: unknown }>>(Prisma.sql`
        SELECT l.id, l.name, l.color, COUNT(k.id) AS usageCount
        FROM TaskLabel l
        LEFT JOIN TaskLabelLink k ON k.labelId = l.id AND k.tenantId = ${actor.tenantId}
        WHERE l.tenantId = ${actor.tenantId}
        GROUP BY l.id, l.name, l.color
        ORDER BY l.name
    `);
    return rows.map((row) => ({ id: row.id, name: row.name, color: row.color, usageCount: rawNumber(row.usageCount) }));
};

/** Einstellungen gelten je Person über alle Firmen; ohne Zeile gilt der Standard. */
const loadReminderLeadMinutes = async (employeeId: string): Promise<number> => {
    const setting = await prisma.taskUserSetting.findUnique({
        where: { employeeId },
        select: { reminderLeadMinutes: true },
    });
    return setting?.reminderLeadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES;
};

export interface TasksBootstrapDto {
    actor: { employeeId: string; isManager: boolean; canDelete: boolean; seesAll: boolean; isSystemAdmin: boolean };
    labels: LabelDto[];
    settings: { reminderLeadMinutes: number };
    summary: TasksSummaryDto;
    onboarding: TaskOnboardingDto;
    serverNow: Date;
}

export const getTasksBootstrap = async (actor: TasksActor): Promise<TasksBootstrapDto> => {
    const onboarding = await ensureTaskOnboarding(actor);
    const [labels, reminderLeadMinutes, summary] = await Promise.all([
        loadTaskLabels(actor),
        loadReminderLeadMinutes(actor.employeeId),
        getTasksSummary(actor),
    ]);
    return {
        actor: { employeeId: actor.employeeId, isManager: actor.isManager, canDelete: actor.canDelete, seesAll: actor.seesAll, isSystemAdmin: actor.isSystemAdmin },
        labels,
        settings: { reminderLeadMinutes },
        summary,
        onboarding,
        serverNow: summary.serverNow,
    };
};

/* ── Liste, Pano, Schnellsuche ──────────────────────────────────────────── */

export const TASK_LIST_FILTERS = ['open', 'done', 'late', 'all'] as const;
export const TASK_LIST_SCOPES = ['all', 'mine'] as const;
export const TASK_LIST_VIEWS = ['list', 'board', 'search'] as const;
export const TASK_LIST_SORTS = ['due', 'created', 'title', 'status', 'priority'] as const;
export const SORT_DIRECTIONS = ['asc', 'desc'] as const;

export interface TaskListQuery {
    filter: typeof TASK_LIST_FILTERS[number];
    /** Nur für die Leitung wirksam — ein Teammitglied sieht ohnehin nur «Meine». */
    scope: typeof TASK_LIST_SCOPES[number];
    view: typeof TASK_LIST_VIEWS[number];
    sort: typeof TASK_LIST_SORTS[number];
    dir: typeof SORT_DIRECTIONS[number];
    /** '' = ohne diese Einschränkung. */
    assigneeId: string;
    labelId: string;
    status: string;
    flagged: boolean;
    q: string;
    /**
     * Zeitraum der Liste («Bugün / Bu hafta / Bu ay», Grenzen aus dem Browser).
     * Eine Aufgabe passt, wenn ihre Spanne Beginn…Termin den Zeitraum berührt
     * (Beginn ersatzweise Anlage, Ende bei Erledigten der Abschluss).
     */
    from: Date | null;
    to: Date | null;
    page: number;
    pageSize: number;
}

/** Suchtext als Teilstring; `%` und `_` gelten wörtlich. */
const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

const listWhereSql = (actor: TasksActor, query: TaskListQuery, now: Date): Prisma.Sql => {
    const conditions: Prisma.Sql[] = [visibleTasksSql(actor)];
    if (actor.seesAll && query.scope === 'mine') conditions.push(memberVisibilitySql(actor.employeeId));
    if (query.filter === 'open') conditions.push(OPEN_TASK_SQL);
    if (query.filter === 'done') conditions.push(Prisma.sql`t.status = 'COMPLETED'`);
    if (query.filter === 'late') conditions.push(Prisma.sql`${OPEN_TASK_SQL} AND t.dueAt < ${now}`);
    if (query.assigneeId) {
        conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM TaskAssignee fa WHERE fa.taskId = t.id AND fa.employeeId = ${query.assigneeId})`);
    }
    if (query.labelId) {
        conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM TaskLabelLink fl WHERE fl.taskId = t.id AND fl.labelId = ${query.labelId})`);
    }
    if (query.status) conditions.push(Prisma.sql`t.status = ${query.status}`);
    if (query.flagged) conditions.push(Prisma.sql`t.flagged = 1`);
    if (query.q) conditions.push(Prisma.sql`t.title LIKE ${likePattern(query.q)}`);
    if (query.from && query.to) {
        conditions.push(Prisma.sql`COALESCE(t.startAt, t.createdAt) <= ${query.to}`);
        conditions.push(Prisma.sql`(CASE WHEN t.status = 'COMPLETED'
            THEN COALESCE(t.completedAt, t.dueAt, t.startAt, t.createdAt)
            ELSE COALESCE(t.dueAt, t.startAt, t.createdAt) END) >= ${query.from}`);
    }
    return Prisma.join(conditions, ' AND ');
};

/**
 * Reihenfolge: die Pano nach Spalte, dann Position (neue Karten oben). Sonst
 * nach Wahl; «Ende» wie Görevly (`dueAt || Infinity`): ohne Termin steht
 * aufsteigend unten, absteigend oben. Gleichstand: neueste zuerst.
 */
const listOrderSql = (query: TaskListQuery): Prisma.Sql => {
    const tieBreak = Prisma.sql`t.createdAt DESC, t.id ASC`;
    if (query.view === 'board') return Prisma.sql`${STATUS_RANK_SQL} ASC, t.boardPosition ASC, ${tieBreak}`;
    const dir = Prisma.raw(query.dir === 'desc' ? 'DESC' : 'ASC');
    switch (query.sort) {
        case 'created': return Prisma.sql`t.createdAt ${dir}, t.id ASC`;
        case 'title': return Prisma.sql`t.title ${dir}, ${tieBreak}`;
        case 'status': return Prisma.sql`${STATUS_RANK_SQL} ${dir}, ${tieBreak}`;
        case 'priority': return Prisma.sql`${PRIORITY_RANK_SQL} ${dir}, ${tieBreak}`;
        default: return Prisma.sql`t.dueAt IS NULL ${dir}, t.dueAt ${dir}, ${tieBreak}`;
    }
};

export interface TaskListResult {
    data: TaskRowDto[];
    total: number;
    page: number;
    pageSize: number;
    people: Record<string, PersonRef>;
    serverNow: Date;
}

export const listTasks = async (actor: TasksActor, query: TaskListQuery): Promise<TaskListResult> => {
    const onboarding = await ensureTaskOnboarding(actor);
    const now = new Date();
    const where = listWhereSql(actor, query, now);
    const [cores, countRows] = await Promise.all([
        fetchTaskCores(prisma, {
            where,
            // The unfinished guide is literally the person's first task: keep
            // it above normal sorting until the walkthrough completes.
            orderBy: Prisma.sql`(t.id = ${onboarding.taskId}) DESC, ${listOrderSql(query)}`,
            limit: query.pageSize,
            offset: (query.page - 1) * query.pageSize,
        }),
        prisma.$queryRaw<Array<{ total: unknown }>>(Prisma.sql`SELECT COUNT(*) AS total FROM Task t WHERE ${where}`),
    ]);
    const { running, people } = await loadRunningSessionsAndPeople(actor, cores);
    return {
        data: cores.map((core) => toTaskRowDto(core, actor, running.get(core.id) ?? [], now)),
        total: rawNumber(countRows[0]?.total),
        page: query.page,
        pageSize: query.pageSize,
        people,
        serverNow: now,
    };
};

export interface TaskSearchHit {
    id: string;
    title: string;
    status: string;
    dueAt: Date | null;
}

/** Schnellsuche (⌘K): schlanke Treffer ohne Zähler und ohne Personen. */
export const searchTasks = async (actor: TasksActor, query: TaskListQuery): Promise<{ data: TaskSearchHit[] }> => {
    const rows = await prisma.$queryRaw<Array<{ id: string; title: string; status: string; dueAt: unknown }>>(Prisma.sql`
        SELECT t.id, t.title, t.status, t.dueAt
        FROM Task t
        WHERE ${listWhereSql(actor, query, new Date())}
        ORDER BY ${listOrderSql(query)}
        LIMIT ${TASK_LIMITS.searchLimit}
    `);
    return { data: rows.map((row) => ({ id: row.id, title: row.title, status: row.status, dueAt: rawDate(row.dueAt) })) };
};

/* ── Anfragen der Leitung («Onaylar») ───────────────────────────────────── */

export interface TaskApprovalsResult {
    completionRequests: TaskDetailDto[];
    reviewRequests: TaskDetailDto[];
    /** Offene Löschanfragen — nur für Admins, sonst leer. */
    deleteRequests: TaskDetailDto[];
    people: Record<string, PersonRef>;
    serverNow: Date;
}

/**
 * Offene Abschlussanfragen und Vorschläge (Leitung, nur sichtbare Aufgaben) und
 * Löschanfragen (nur Admins); eine Aufgabe kann in mehreren Gruppen stehen.
 */
export const listTaskApprovals = async (actor: TasksActor): Promise<TaskApprovalsResult> => {
    if (!actor.isManager && !actor.canDelete) assertManager(actor);
    const now = new Date();
    // Abschlussanfragen entscheidet nur die Administratorrolle; Vorschläge weiter die Leitung.
    const managerPart = actor.isManager ? Prisma.sql`t.reviewState = 'PENDING'` : Prisma.sql`FALSE`;
    const completionPart = actor.isSystemAdmin ? Prisma.sql`OR t.approvalState = 'PENDING'` : Prisma.empty;
    const deletePart = actor.canDelete ? Prisma.sql`OR t.deleteRequestedAt IS NOT NULL` : Prisma.empty;
    const cores = await fetchTaskCores(prisma, {
        where: Prisma.sql`${visibleTasksSql(actor)} AND (${managerPart} ${completionPart} ${deletePart})`,
    });
    const { running, people } = await loadRunningSessionsAndPeople(actor, cores);
    const toCard = (core: TaskCore): TaskDetailDto => toTaskDetailDto(core, actor, running.get(core.id) ?? [], now);
    return {
        completionRequests: actor.isSystemAdmin ? cores.filter((core) => core.approvalState === 'PENDING').map(toCard) : [],
        reviewRequests: cores.filter((core) => core.reviewState === 'PENDING').map(toCard),
        deleteRequests: actor.canDelete ? cores.filter((core) => core.deleteRequestedById).map(toCard) : [],
        people,
        serverNow: now,
    };
};

/* ── Zeitaufschlüsselung ────────────────────────────────────────────────── */

export interface TaskSessionRow {
    employeeId: string;
    startedAt: Date;
    endedAt: Date | null;
    durationMs: number | null;
}

export interface WorkBreakdownEntry {
    employeeId: string;
    ms: number;
    /** Abgeschlossene Messungen; eine laufende setzt `live`. */
    sessions: number;
    first: Date;
    last: Date;
    live: boolean;
}

export interface WorkDto {
    totalMs: number;
    closedMs: number;
    liveMs: number;
    breakdown: WorkBreakdownEntry[];
}

/** Alle Messungen einer Aufgabe, abgeschlossene und laufende. */
export const loadTaskSessions = (tenantId: string, taskId: string): Promise<TaskSessionRow[]> =>
    prisma.taskTimeSession.findMany({
        where: { tenantId, taskId },
        select: { employeeId: true, startedAt: true, endedAt: true, durationMs: true },
        orderBy: [{ startedAt: 'asc' }],
    });

/** Dauer einer Messung — eine laufende zählt bis `now`. */
const sessionMs = (session: TaskSessionRow, now: Date): number =>
    session.endedAt ? session.durationMs ?? 0 : liveDurationMs(session.startedAt, now);

/**
 * Wer wie lange an der Aufgabe gearbeitet hat (Görevly `timer.breakdown`),
 * meiste Zeit zuerst. Summen werden NICHT auf die INT-Grenze einer einzelnen
 * Messung gekürzt — viele Personen über Monate überschreiten sie zu Recht.
 */
export const buildWorkDto = (sessions: readonly TaskSessionRow[], now: Date): WorkDto => {
    const byPerson = new Map<string, WorkBreakdownEntry>();
    let closedMs = 0;
    let liveMs = 0;
    for (const session of sessions) {
        const live = session.endedAt === null;
        const ms = sessionMs(session, now);
        const last = session.endedAt ?? now;
        if (live) liveMs += ms;
        else closedMs += ms;

        const entry = byPerson.get(session.employeeId)
            ?? { employeeId: session.employeeId, ms: 0, sessions: 0, first: session.startedAt, last, live: false };
        entry.ms += ms;
        if (live) entry.live = true;
        else entry.sessions += 1;
        if (session.startedAt.getTime() < entry.first.getTime()) entry.first = session.startedAt;
        if (last.getTime() > entry.last.getTime()) entry.last = last;
        byPerson.set(session.employeeId, entry);
    }
    return {
        totalMs: closedMs + liveMs,
        closedMs,
        liveMs,
        breakdown: [...byPerson.values()].sort((a, b) => b.ms - a.ms),
    };
};

/* ── Detailansicht ──────────────────────────────────────────────────────── */

export interface ChatRoomRef {
    id: string;
    name: string;
}

/** Verknüpfte Räume, in denen ich Mitglied bin — auch die Leitung sieht nur ihre (Görevly). */
const loadLinkedChatRooms = (actor: TasksActor, taskId: string): Promise<ChatRoomRef[]> =>
    prisma.taskChatRoom.findMany({
        where: {
            tenantId: actor.tenantId,
            taskLinks: { some: { taskId } },
            members: { some: { employeeId: actor.employeeId } },
        },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }],
    });

const activePersonRef = (person: TasksPerson): PersonRef => ({
    id: person.id,
    firstName: person.firstName,
    lastName: person.lastName,
    name: `${person.firstName} ${person.lastName}`.trim(),
    title: person.title,
    active: true,
});

export interface TaskDetailResult {
    task: TaskDetailDto;
    permissions: TaskPermissions;
    content: ContentDto;
    checklists: ChecklistDto[];
    attachments: AttachmentDto[];
    /** Bereits mit dem Detail geladen: der Reiter oeffnet ohne zweite Anfrage. */
    comments: CommentDto[];
    chatRooms: ChatRoomRef[];
    forecast: TaskForecast;
    /** Nur für die Leitung, sonst null. */
    work: WorkDto | null;
    people: Record<string, PersonRef>;
    serverNow: Date;
}

export const getTaskDetail = async (actor: TasksActor, taskId: string): Promise<TaskDetailResult> => {
    // Erst die Sichtbarkeit — kein Teil einer fremden Aufgabe wird gelesen.
    const { core, permissions } = await requireVisibleTask(prisma, actor, taskId);
    const [content, checklists, attachments, comments, chatRooms, sessions, directory] = await Promise.all([
        loadTaskContent(prisma, actor.tenantId, core.id),
        loadTaskChecklists(prisma, actor.tenantId, core.id),
        loadTaskAttachments(prisma, actor.tenantId, core.id),
        loadVisibleTaskComments(actor, core.id),
        loadLinkedChatRooms(actor, core.id),
        loadTaskSessions(actor.tenantId, core.id),
        getTasksPeople(actor.tenantId),
    ]);

    const now = new Date();
    const running: RunningSessionRef[] = sessions
        .filter((session) => session.endedAt === null)
        .map((session) => ({ employeeId: session.employeeId, startedAt: session.startedAt }));
    const work = actor.isManager ? buildWorkDto(sessions, now) : null;
    // Prognose aus denselben Checklisten, die die Antwort zeigt; sie nennt keine Zeiten.
    const forecast = computeTaskForecast({
        status: core.status,
        completedAt: core.completedAt,
        dueAt: core.dueAt,
        checkTotal: checklists.reduce((sum, list) => sum + list.progress.total, 0),
        checkDone: checklists.reduce((sum, list) => sum + list.progress.done, 0),
        sessions: sessions.map((session) => ({ startedAt: session.startedAt, ms: sessionMs(session, now) })),
        now,
    });

    const personIds = [...new Set([
        ...taskPeopleIds(core, actor.isManager ? running : []),
        content.updatedById,
        ...checklists.flatMap((list) => [
            list.createdById,
            ...list.items.flatMap((item) => [item.assigneeId, item.doneById, item.createdById]),
        ]),
        ...attachments.map((attachment) => attachment.uploadedById),
        ...comments.personIds,
        ...(work?.breakdown.map((entry) => entry.employeeId) ?? []),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0))];
    const people: Record<string, PersonRef> = {};
    for (const id of personIds) {
        const person = directory.get(id);
        if (person) people[id] = activePersonRef(person);
    }
    // Historische Eintraege behalten den Namen auch nach Austritt/Loeschung.
    // Im Normalfall ist alles bereits im 30-s-Verzeichnis: kein weiterer RTT.
    const historicalIds = personIds.filter((id) => !people[id]);
    if (historicalIds.length) Object.assign(people, await loadPersonRefs(historicalIds));

    return {
        task: toTaskDetailDto(core, actor, running, now),
        permissions,
        content,
        checklists,
        attachments,
        comments: comments.data,
        chatRooms,
        forecast,
        work,
        people,
        serverNow: now,
    };
};

/* ── Verlauf («Geçmiş», nur Leitung) ────────────────────────────────────── */

export interface TaskActivityDto {
    id: string;
    type: string;
    actorId: string | null;
    meta: Prisma.JsonValue | null;
    createdAt: Date;
}

/** Die im Verlauf genannte Person (ASSIGNED/UNASSIGNED, Pause einer anderen Person). */
const activityEmployeeId = (meta: Prisma.JsonValue | null): string | null => {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const employeeId = (meta as Prisma.JsonObject).employeeId;
    return typeof employeeId === 'string' ? employeeId : null;
};

export const listTaskActivity = async (
    actor: TasksActor,
    taskId: string,
): Promise<{ data: TaskActivityDto[]; people: Record<string, PersonRef> }> => {
    assertManager(actor);
    const [task, rows] = await Promise.all([
        prisma.task.findFirst({ where: { id: taskId, tenantId: actor.tenantId }, select: { id: true } })
            // Sichtbarkeit wie überall: keine fremde Aufgabe, auch nicht ihr Verlauf.
            .then(async (found) => (found ? (await requireVisibleTask(prisma, actor, taskId)).core : null)),
        prisma.taskActivity.findMany({
            where: { tenantId: actor.tenantId, taskId },
            select: { id: true, type: true, actorId: true, meta: true, createdAt: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: TASK_LIMITS.activityLimit,
        }),
    ]);
    if (!task) throw taskNotFound();
    const people = await loadPersonRefs(rows.flatMap((row) => [row.actorId, activityEmployeeId(row.meta)]));
    return { data: rows, people };
};
