import { Prisma } from '@prisma/client';

import type { TasksActor } from './taskActor';
import type { TasksDb } from './taskDb';
import { effectiveTaskStatus, isTaskOverdue, taskPermissions, type TaskPermissions } from './taskAccess';
import { taskForbidden, taskNotFound } from './taskErrors';
import { liveDurationMs } from './taskTime';

/**
 * ── AUFGABENZEILEN: LADEN UND AUSGEBEN ──────────────────────────────────────
 *
 * EINE Anweisung liefert Aufgabe + Verantwortliche + Etiketten + Zähler
 * (Checkliste, Kommentare, Dateien, gemessene Zeit) über korrelierte
 * Unterabfragen — die Datenbank ist fern, jeder Rundgang kostet 50–170 ms.
 * Laufende Messungen kommen in einer zweiten, gebündelten Anweisung dazu.
 *
 * Werte aus `$queryRaw` kommen je nach Spaltentyp als bigint, Decimal, Zahl,
 * boolean oder String an — darum laufen alle durch die Wandler unten.
 */

export const rawNumber = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

export const rawBool = (value: unknown): boolean =>
    value === true || value === 1 || value === '1' || (typeof value === 'bigint' && value === 1n);

export const rawDate = (value: unknown): Date | null => {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
};

export const rawString = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);

export const rawCsv = (value: unknown): string[] =>
    typeof value === 'string' && value.length ? value.split(',').filter(Boolean) : [];

export const rawJson = (value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

export interface TaskCore {
    id: string;
    tenantId: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    origin: string;
    flagged: boolean;
    startAt: Date | null;
    dueAt: Date | null;
    reminderAt: Date | null;
    completedAt: Date | null;
    blockReason: string | null;
    approvalState: string;
    approvalRequestedById: string | null;
    approvalRequestedAt: Date | null;
    approvalNote: string | null;
    approvalDecidedById: string | null;
    approvalDecidedAt: Date | null;
    approvalDecisionNote: string | null;
    reviewState: string;
    reviewRequestedById: string | null;
    reviewRequestedAt: Date | null;
    reviewDecidedById: string | null;
    reviewDecidedAt: Date | null;
    reviewNote: string | null;
    deleteRequestedById: string | null;
    deleteRequestedAt: Date | null;
    deleteRequestNote: string | null;
    boardPosition: number;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
    assigneeIds: string[];
    labelIds: string[];
    checkTotal: number;
    checkDone: number;
    commentCount: number;
    attachmentCount: number;
    /** Summe der ABGESCHLOSSENEN Messungen. */
    closedMs: number;
    /** Anzahl aller Messungen (auch laufender). */
    sessionCount: number;
}

/** Spaltenliste über `Task t` — für jede Abfrage, die TaskCore-Zeilen liefert. */
export const TASK_CORE_COLUMNS = Prisma.sql`
    t.id, t.tenantId, t.title, t.description, t.status, t.priority, t.origin, t.flagged,
    t.startAt, t.dueAt, t.reminderAt, t.completedAt, t.blockReason,
    t.approvalState, t.approvalRequestedById, t.approvalRequestedAt, t.approvalNote,
    t.approvalDecidedById, t.approvalDecidedAt, t.approvalDecisionNote,
    t.reviewState, t.reviewRequestedById, t.reviewRequestedAt, t.reviewDecidedById,
    t.reviewDecidedAt, t.reviewNote, t.deleteRequestedById, t.deleteRequestedAt, t.deleteRequestNote,
    t.boardPosition, t.createdById, t.createdAt, t.updatedAt,
    (SELECT GROUP_CONCAT(ta.employeeId ORDER BY ta.createdAt, ta.id SEPARATOR ',')
       FROM TaskAssignee ta WHERE ta.taskId = t.id) AS assigneeCsv,
    (SELECT GROUP_CONCAT(tl.labelId ORDER BY tl.createdAt, tl.id SEPARATOR ',')
       FROM TaskLabelLink tl WHERE tl.taskId = t.id) AS labelCsv,
    (SELECT COUNT(*) FROM TaskChecklistItem ci WHERE ci.taskId = t.id) AS checkTotal,
    (SELECT COUNT(*) FROM TaskChecklistItem ci WHERE ci.taskId = t.id AND ci.done = 1) AS checkDone,
    (SELECT COUNT(*) FROM TaskComment tc WHERE tc.taskId = t.id) AS commentCount,
    (SELECT COUNT(*) FROM TaskAttachment tf WHERE tf.taskId = t.id AND tf.kind = 'TASK') AS attachmentCount,
    (SELECT COALESCE(SUM(ts.durationMs), 0) FROM TaskTimeSession ts
      WHERE ts.taskId = t.id AND ts.endedAt IS NOT NULL) AS closedMs,
    (SELECT COUNT(*) FROM TaskTimeSession ts WHERE ts.taskId = t.id) AS sessionCount
`;

export const mapTaskCore = (row: Record<string, unknown>): TaskCore => ({
    id: String(row.id),
    tenantId: String(row.tenantId),
    title: String(row.title ?? ''),
    description: rawString(row.description),
    status: String(row.status ?? 'NOT_STARTED'),
    priority: String(row.priority ?? 'MEDIUM'),
    origin: String(row.origin ?? 'MANAGER'),
    flagged: rawBool(row.flagged),
    startAt: rawDate(row.startAt),
    dueAt: rawDate(row.dueAt),
    reminderAt: rawDate(row.reminderAt),
    completedAt: rawDate(row.completedAt),
    blockReason: rawString(row.blockReason),
    approvalState: String(row.approvalState ?? 'NONE'),
    approvalRequestedById: rawString(row.approvalRequestedById),
    approvalRequestedAt: rawDate(row.approvalRequestedAt),
    approvalNote: rawString(row.approvalNote),
    approvalDecidedById: rawString(row.approvalDecidedById),
    approvalDecidedAt: rawDate(row.approvalDecidedAt),
    approvalDecisionNote: rawString(row.approvalDecisionNote),
    reviewState: String(row.reviewState ?? 'APPROVED'),
    reviewRequestedById: rawString(row.reviewRequestedById),
    reviewRequestedAt: rawDate(row.reviewRequestedAt),
    reviewDecidedById: rawString(row.reviewDecidedById),
    reviewDecidedAt: rawDate(row.reviewDecidedAt),
    reviewNote: rawString(row.reviewNote),
    deleteRequestedById: rawString(row.deleteRequestedById),
    deleteRequestedAt: rawDate(row.deleteRequestedAt),
    deleteRequestNote: rawString(row.deleteRequestNote),
    boardPosition: rawNumber(row.boardPosition),
    createdById: String(row.createdById ?? ''),
    createdAt: rawDate(row.createdAt) ?? new Date(0),
    updatedAt: rawDate(row.updatedAt) ?? new Date(0),
    assigneeIds: rawCsv(row.assigneeCsv),
    labelIds: rawCsv(row.labelCsv),
    checkTotal: rawNumber(row.checkTotal),
    checkDone: rawNumber(row.checkDone),
    commentCount: rawNumber(row.commentCount),
    attachmentCount: rawNumber(row.attachmentCount),
    closedMs: rawNumber(row.closedMs),
    sessionCount: rawNumber(row.sessionCount),
});

export interface TaskCoreQuery {
    /** Bedingung über `t` — MUSS die Firma enthalten (t.tenantId = …). */
    where: Prisma.Sql;
    orderBy?: Prisma.Sql;
    limit?: number;
    offset?: number;
}

export const fetchTaskCores = async (db: TasksDb, query: TaskCoreQuery): Promise<TaskCore[]> => {
    const order = query.orderBy ?? Prisma.sql`t.createdAt DESC, t.id ASC`;
    const limit = query.limit !== undefined ? Prisma.sql`LIMIT ${query.limit} OFFSET ${query.offset ?? 0}` : Prisma.empty;
    const rows = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${TASK_CORE_COLUMNS}
        FROM Task t
        WHERE ${query.where}
        ORDER BY ${order}
        ${limit}
    `);
    return rows.map(mapTaskCore);
};

export const fetchTaskCoresByIds = async (db: TasksDb, tenantId: string, ids: readonly string[]): Promise<TaskCore[]> => {
    if (!ids.length) return [];
    return fetchTaskCores(db, { where: Prisma.sql`t.tenantId = ${tenantId} AND t.id IN (${Prisma.join([...ids])})` });
};

export const loadTaskCore = async (db: TasksDb, tenantId: string, taskId: string): Promise<TaskCore | null> => {
    if (!taskId) return null;
    const [core] = await fetchTaskCores(db, { where: Prisma.sql`t.tenantId = ${tenantId} AND t.id = ${taskId}`, limit: 1 });
    return core ?? null;
};

/** Sperrt die Aufgabenzeile in einer Transaktion (Zustandswechsel nacheinander). */
export const lockTaskRow = async (tx: TasksDb, tenantId: string, taskId: string): Promise<boolean> => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM Task WHERE id = ${taskId} AND tenantId = ${tenantId} FOR UPDATE
    `);
    return rows.length > 0;
};

/** Sichtbarkeitsbedingung eines Teammitglieds über `t` (verantwortlich ODER angelegt). */
export const memberVisibilitySql = (employeeId: string): Prisma.Sql => Prisma.sql`(
    t.createdById = ${employeeId}
    OR EXISTS (SELECT 1 FROM TaskAssignee va WHERE va.taskId = t.id AND va.employeeId = ${employeeId})
)`;

/** Firmen- und Sichtbarkeitsbedingung für die handelnde Person. */
export const visibleTasksSql = (actor: TasksActor): Prisma.Sql => actor.seesAll
    ? Prisma.sql`t.tenantId = ${actor.tenantId}`
    : Prisma.sql`t.tenantId = ${actor.tenantId} AND ${memberVisibilitySql(actor.employeeId)}`;

export interface VisibleTask {
    core: TaskCore;
    permissions: TaskPermissions;
}

/**
 * Die Aufgabe für eine Handlung laden: 404, wenn es sie in der ausgewählten
 * Firma nicht gibt; 403, wenn die Person sie nicht sehen darf.
 */
export const requireVisibleTask = async (db: TasksDb, actor: TasksActor, taskId: string): Promise<VisibleTask> => {
    const core = await loadTaskCore(db, actor.tenantId, taskId);
    if (!core) throw taskNotFound();
    const permissions = taskPermissions(actor, core);
    if (!permissions.canSee) throw taskForbidden('TASK_FORBIDDEN', 'Diese Aufgabe ist für Sie nicht sichtbar.');
    return { core, permissions };
};

/* ── Laufende Messungen ─────────────────────────────────────────────────── */

export interface RunningSessionRef {
    employeeId: string;
    startedAt: Date;
}

export const loadRunningSessionsByTask = async (
    db: TasksDb,
    tenantId: string,
    taskIds: readonly string[],
): Promise<Map<string, RunningSessionRef[]>> => {
    const byTask = new Map<string, RunningSessionRef[]>();
    if (!taskIds.length) return byTask;
    const rows = await db.$queryRaw<Array<{ taskId: string; employeeId: string; startedAt: unknown }>>(Prisma.sql`
        SELECT taskId, employeeId, startedAt
        FROM TaskTimeSession
        WHERE tenantId = ${tenantId} AND endedAt IS NULL AND taskId IN (${Prisma.join([...taskIds])})
    `);
    for (const row of rows) {
        const startedAt = rawDate(row.startedAt);
        if (!startedAt) continue;
        const list = byTask.get(row.taskId) ?? [];
        list.push({ employeeId: row.employeeId, startedAt });
        byTask.set(row.taskId, list);
    }
    return byTask;
};

/* ── Ausgabe ────────────────────────────────────────────────────────────── */

export interface TaskRowDto {
    id: string;
    title: string;
    status: string;
    effectiveStatus: string;
    priority: string;
    origin: string;
    flagged: boolean;
    startAt: Date | null;
    dueAt: Date | null;
    reminderAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    createdById: string;
    approvalState: string;
    reviewState: string;
    blockReason: string | null;
    /** Wer das Löschen beantragt hat (null = keine offene Anfrage). */
    deleteRequestedById: string | null;
    assigneeIds: string[];
    labelIds: string[];
    checklist: { done: number; total: number };
    commentCount: number;
    attachmentCount: number;
    boardPosition: number;
    overdue: boolean;
    /** Nur die EIGENE laufende Messung — Teammitglieder sehen keine Zeiten. */
    timer: { runningForMe: boolean; myStartedAt: Date | null };
    /** Nur für die Leitung: gemessene Zeit (abgeschlossen) + laufende Messungen. */
    work?: { closedMs: number; liveMs: number; totalMs: number; live: RunningSessionRef[] };
}

export const toTaskRowDto = (
    core: TaskCore,
    actor: TasksActor,
    running: readonly RunningSessionRef[],
    now: Date = new Date(),
): TaskRowDto => {
    const mine = running.find((session) => session.employeeId === actor.employeeId) ?? null;
    const row: TaskRowDto = {
        id: core.id,
        title: core.title,
        status: core.status,
        effectiveStatus: effectiveTaskStatus({ status: core.status, startAt: core.startAt, hasSessions: core.sessionCount > 0 }, now),
        priority: core.priority,
        origin: core.origin,
        flagged: core.flagged,
        startAt: core.startAt,
        dueAt: core.dueAt,
        reminderAt: core.reminderAt,
        completedAt: core.completedAt,
        createdAt: core.createdAt,
        updatedAt: core.updatedAt,
        createdById: core.createdById,
        approvalState: core.approvalState,
        reviewState: core.reviewState,
        blockReason: core.blockReason,
        deleteRequestedById: core.deleteRequestedById,
        assigneeIds: core.assigneeIds,
        labelIds: core.labelIds,
        checklist: { done: core.checkDone, total: core.checkTotal },
        commentCount: core.commentCount,
        attachmentCount: core.attachmentCount,
        boardPosition: core.boardPosition,
        overdue: isTaskOverdue(core, now),
        timer: { runningForMe: Boolean(mine), myStartedAt: mine?.startedAt ?? null },
    };
    if (actor.isManager) {
        const liveMs = running.reduce((sum, session) => sum + liveDurationMs(session.startedAt, now), 0);
        row.work = {
            closedMs: core.closedMs,
            liveMs,
            // Summe über Personen und Messungen — nicht auf die INT-Grenze EINER Messung kappen.
            totalMs: Math.max(0, core.closedMs + liveMs),
            live: [...running],
        };
    }
    return row;
};

export interface TaskDetailDto extends TaskRowDto {
    description: string | null;
    approval: {
        state: string;
        requestedById: string | null;
        requestedAt: Date | null;
        note: string | null;
        decidedById: string | null;
        decidedAt: Date | null;
        decisionNote: string | null;
    };
    review: {
        state: string;
        requestedById: string | null;
        requestedAt: Date | null;
        decidedById: string | null;
        decidedAt: Date | null;
        note: string | null;
    };
    /** Offene Löschanfrage (requestedById null = keine). */
    deleteRequest: {
        requestedById: string | null;
        requestedAt: Date | null;
        note: string | null;
    };
}

export const toTaskDetailDto = (
    core: TaskCore,
    actor: TasksActor,
    running: readonly RunningSessionRef[],
    now: Date = new Date(),
): TaskDetailDto => ({
    ...toTaskRowDto(core, actor, running, now),
    description: core.description,
    approval: {
        state: core.approvalState,
        requestedById: core.approvalRequestedById,
        requestedAt: core.approvalRequestedAt,
        note: core.approvalNote,
        decidedById: core.approvalDecidedById,
        decidedAt: core.approvalDecidedAt,
        decisionNote: core.approvalDecisionNote,
    },
    review: {
        state: core.reviewState,
        requestedById: core.reviewRequestedById,
        requestedAt: core.reviewRequestedAt,
        decidedById: core.reviewDecidedById,
        decidedAt: core.reviewDecidedAt,
        note: core.reviewNote,
    },
    deleteRequest: {
        requestedById: core.deleteRequestedById,
        requestedAt: core.deleteRequestedAt,
        note: core.deleteRequestNote,
    },
});

/** Alle Personenkennungen, die eine Aufgabenausgabe nennt (für die `people`-Karte). */
export const taskPeopleIds = (core: TaskCore, running: readonly RunningSessionRef[] = []): string[] => [
    core.createdById,
    ...core.assigneeIds,
    ...(core.approvalRequestedById ? [core.approvalRequestedById] : []),
    ...(core.approvalDecidedById ? [core.approvalDecidedById] : []),
    ...(core.reviewRequestedById ? [core.reviewRequestedById] : []),
    ...(core.reviewDecidedById ? [core.reviewDecidedById] : []),
    ...(core.deleteRequestedById ? [core.deleteRequestedById] : []),
    ...running.map((session) => session.employeeId),
];
