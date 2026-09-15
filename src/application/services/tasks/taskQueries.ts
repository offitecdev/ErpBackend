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
import { getTasksPeople, loadPersonRefs, personDisplayName, type PersonRef, type TasksPerson } from './taskPeople';
import {
    fetchTaskCores,
    fetchTaskListRows,
    loadRunningSessionsByTask,
    loadTaskCore,
    memberVisibilitySql,
    rawDate,
    rawNumber,
    requireVisibleTask,
    taskPeopleIds,
    toTaskDetailDto,
    visibleTasksSql,
    type RunningSessionRef,
    type TaskCore,
    type TaskDetailDto,
    type TaskListRowDto,
} from './taskRows';
import { endOfLocalDay, liveDurationMs, resolveDayWindow, windowedMs, type DayWindow } from './taskTime';
import { getActiveTimer, type ActiveTimerInfo } from './taskTimer';
import { ensureTaskOnboarding, knownOnboardingTaskId, type TaskOnboardingDto } from './taskOnboarding';

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
 * Zeiten (ms): die Leitung sieht alle Personen; ein Teammitglied nur die
 * EIGENEN Messungen (14.09.2026) — nie die Zeit oder Namen anderer.
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
    const [core, ownClosedMs] = await Promise.all([
        loadTaskCore(prisma, actor.tenantId, taskId),
        actor.isManager ? Promise.resolve(undefined) : loadOwnClosedMs(actor, taskId),
    ]);
    if (!core) throw taskNotFound();
    const { running, people } = await loadRunningSessionsAndPeople(actor, [core]);
    const now = new Date();
    return { task: toTaskDetailDto(core, actor, running.get(core.id) ?? [], now, ownClosedMs), people, serverNow: now };
};

/** Summe der eigenen abgeschlossenen Messungen an einer Aufgabe (Teammitglieder sehen nur ihre Zeit). */
const loadOwnClosedMs = async (actor: TasksActor, taskId: string): Promise<number> => {
    const rows = await prisma.$queryRaw<Array<{ ms: unknown }>>(Prisma.sql`
        SELECT COALESCE(SUM(durationMs), 0) AS ms
        FROM TaskTimeSession
        WHERE tenantId = ${actor.tenantId} AND taskId = ${taskId} AND employeeId = ${actor.employeeId} AND endedAt IS NOT NULL
    `);
    return rawNumber(rows[0]?.ms);
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
                    ${actor.isSystemAdmin ? Prisma.sql`OR t.partnerRequestedAt IS NOT NULL` : Prisma.empty}
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
        // Anfragen entscheidet nur die Administratorrolle — nur sie sieht den Zähler.
        pendingApprovalCount: actor.isSystemAdmin ? rawNumber(counts.pendingCount) : 0,
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
    /** Kalendertag des Browsers — die Zeilen zeigen die Zeit DIESES Tages. */
    day: DayWindow;
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
    data: TaskListRowDto[];
    total: number;
    page: number;
    pageSize: number;
    /** Nur Anzeigenamen der genannten Personen. */
    people: Record<string, { id: string; name: string }>;
    serverNow: Date;
}

export const listTasks = async (actor: TasksActor, query: TaskListQuery): Promise<TaskListResult> => {
    // Nach der ersten Prüfung im Prozess ohne Rundgang: die Kennung ist deterministisch.
    const onboardingTaskId = knownOnboardingTaskId(actor) ?? (await ensureTaskOnboarding(actor)).taskId;
    const now = new Date();
    const [result, directory] = await Promise.all([
        fetchTaskListRows(prisma, actor, {
            where: listWhereSql(actor, query, now),
            // The unfinished guide is literally the person's first task: keep
            // it above normal sorting until the walkthrough completes.
            orderBy: Prisma.sql`(t.id = ${onboardingTaskId}) DESC, ${listOrderSql(query)}`,
            limit: query.pageSize,
            offset: (query.page - 1) * query.pageSize,
        }, now, query.day),
        getTasksPeople(actor.tenantId),
    ]);
    // Namen aus dem 30-s-Verzeichnis; nur ehemalige Personen kosten eine Nachlesung.
    const people: Record<string, { id: string; name: string }> = {};
    const missing: string[] = [];
    for (const id of result.personIds) {
        const person = directory.get(id);
        if (person) people[id] = { id, name: personDisplayName(person) };
        else missing.push(id);
    }
    if (missing.length) {
        for (const ref of Object.values(await loadPersonRefs(missing))) people[ref.id] = { id: ref.id, name: ref.name };
    }
    return {
        data: result.rows,
        // Eine Seite hinter dem Ende hat keine Zeile, die OVER() trägt.
        total: result.rows.length ? result.total : (query.page - 1) * query.pageSize,
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
    /** Offene Ortak-ekle-Anfragen — nur für die Administratorrolle, sonst leer. */
    partnerRequests: TaskDetailDto[];
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
    // Görev-Talepe UND Abschlussanfragen entscheidet nur die Administratorrolle (14.09.2026).
    const managerPart = actor.isSystemAdmin ? Prisma.sql`t.reviewState = 'PENDING'` : Prisma.sql`FALSE`;
    const completionPart = actor.isSystemAdmin ? Prisma.sql`OR t.approvalState = 'PENDING'` : Prisma.empty;
    const deletePart = actor.canDelete ? Prisma.sql`OR t.deleteRequestedAt IS NOT NULL` : Prisma.empty;
    const partnerPart = actor.isSystemAdmin ? Prisma.sql`OR t.partnerRequestedAt IS NOT NULL` : Prisma.empty;
    const cores = await fetchTaskCores(prisma, {
        where: Prisma.sql`${visibleTasksSql(actor)} AND (${managerPart} ${completionPart} ${deletePart} ${partnerPart})`,
    });
    const { running, people } = await loadRunningSessionsAndPeople(actor, cores);
    const toCard = (core: TaskCore): TaskDetailDto => toTaskDetailDto(core, actor, running.get(core.id) ?? [], now);
    return {
        completionRequests: actor.isSystemAdmin ? cores.filter((core) => core.approvalState === 'PENDING').map(toCard) : [],
        reviewRequests: actor.isSystemAdmin ? cores.filter((core) => core.reviewState === 'PENDING').map(toCard) : [],
        deleteRequests: actor.canDelete ? cores.filter((core) => core.deleteRequestedById).map(toCard) : [],
        partnerRequests: actor.isSystemAdmin ? cores.filter((core) => core.partnerRequestedById).map(toCard) : [],
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
    /** Alle Tage. */
    ms: number;
    /** Nur das Tagesfenster (die Ansicht zeigt den Tag; alles andere steht im Rapport). */
    dayMs: number;
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
    /** Zeit des Tagesfensters über alle gezeigten Personen. */
    dayMs: number;
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
/**
 * KEINE laufende Zeit (14.09.2026, Samet: «kronometre olmayacak, sadece
 * çalışılıyor»): eine laufende Messung setzt nur `live` und zählt nichts —
 * weder `ms` noch `dayMs`. Ihre Dauer entsteht beim Pausieren (Stopp − Start).
 * `ownEmployeeId` bleibt für ältere Aufrufer erhalten und ändert nichts mehr.
 */
export const buildWorkDto = (
    sessions: readonly TaskSessionRow[],
    now: Date,
    day: DayWindow = resolveDayWindow(undefined, undefined, now),
    ownEmployeeId?: string,
): WorkDto => {
    const byPerson = new Map<string, WorkBreakdownEntry>();
    let closedMs = 0;
    let liveMs = 0;
    let dayMs = 0;
    for (const session of sessions) {
        const live = session.endedAt === null;
        void ownEmployeeId;
        const ms = live ? 0 : sessionMs(session, now);
        const inDay = live ? 0 : windowedMs(session.startedAt, session.endedAt, day, now);
        const last = session.endedAt ?? now;
        if (live) liveMs += ms;
        else closedMs += ms;
        dayMs += inDay;

        const entry = byPerson.get(session.employeeId)
            ?? { employeeId: session.employeeId, ms: 0, dayMs: 0, sessions: 0, first: session.startedAt, last, live: false };
        entry.ms += ms;
        entry.dayMs += inDay;
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
        dayMs,
        breakdown: [...byPerson.values()].sort((a, b) => b.dayMs - a.dayMs || b.ms - a.ms),
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
    /** Leitung: alle Personen; Teammitglied: nur die eigenen Messungen. */
    work: WorkDto | null;
    people: Record<string, PersonRef>;
    serverNow: Date;
}

export const getTaskDetail = async (actor: TasksActor, taskId: string, day?: DayWindow): Promise<TaskDetailResult> => {
    /* Aufgabe und alle Teile in EINEM parallelen Schritt (14.09.2026, Samet:
       «görev detayı 350 ms, max 200–250»). Früher lief die Sichtbarkeit als
       eigener Rundgang davor. Jede Teilabfrage ist auf die Firma beschränkt;
       ist die Aufgabe nicht sichtbar, verlässt nichts davon den Server —
       die Prüfung steht vor der Antwort. */
    const [visible, content, checklists, attachments, comments, chatRooms, sessions, directory] = await Promise.all([
        requireVisibleTask(prisma, actor, taskId),
        loadTaskContent(prisma, actor.tenantId, taskId),
        loadTaskChecklists(prisma, actor.tenantId, taskId),
        loadTaskAttachments(prisma, actor.tenantId, taskId),
        loadVisibleTaskComments(actor, taskId),
        loadLinkedChatRooms(actor, taskId),
        loadTaskSessions(actor.tenantId, taskId),
        getTasksPeople(actor.tenantId),
    ]);
    const { core, permissions } = visible;

    const now = new Date();
    const running: RunningSessionRef[] = sessions
        .filter((session) => session.endedAt === null)
        .map((session) => ({ employeeId: session.employeeId, startedAt: session.startedAt }));
    // Leitung: alle Personen; Teammitglied: nur die eigenen Messungen (14.09.2026).
    const ownSessions = sessions.filter((session) => session.employeeId === actor.employeeId);
    const work = buildWorkDto(actor.isManager ? sessions : ownSessions, now, day ?? resolveDayWindow(undefined, undefined, now), actor.employeeId);
    const ownClosedMs = actor.isManager ? undefined : ownSessions.reduce((sum, session) => sum + (session.endedAt ? session.durationMs ?? 0 : 0), 0);
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
        task: toTaskDetailDto(core, actor, running, now, ownClosedMs),
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
