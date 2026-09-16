import { Prisma } from '@prisma/client';

import type { TasksActor } from './taskActor';
import type { TasksDb } from './taskDb';
import { effectiveTaskStatus, isTaskOverdue, taskPermissions, type TaskPermissions } from './taskAccess';
import { taskForbidden, taskNotFound } from './taskErrors';
import { liveDurationMs, resolveDayWindow, type DayWindow } from './taskTime';

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
    partnerRequestedById: string | null;
    partnerRequestEmployeeId: string | null;
    partnerRequestedAt: Date | null;
    delayReason: string | null;
    delayReasonById: string | null;
    delayReasonAt: Date | null;
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
    /** In «Sorular & Sorunlar» markierte Personen — sie dürfen die Aufgabe sehen. */
    issuePersonIds: string[];
    /** Offene Fäden in «Sorular & Sorunlar» (Marke am Reiter). */
    openIssueCount: number;
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
    t.partnerRequestedById, t.partnerRequestEmployeeId, t.partnerRequestedAt,
    t.delayReason, t.delayReasonById, t.delayReasonAt,
    t.boardPosition, t.createdById, t.createdAt, t.updatedAt,
    (SELECT GROUP_CONCAT(ta.employeeId ORDER BY ta.createdAt, ta.id SEPARATOR ',')
       FROM TaskAssignee ta WHERE ta.taskId = t.id) AS assigneeCsv,
    (SELECT GROUP_CONCAT(tl.labelId ORDER BY tl.createdAt, tl.id SEPARATOR ',')
       FROM TaskLabelLink tl WHERE tl.taskId = t.id) AS labelCsv,
    (SELECT COUNT(*) FROM TaskChecklistItem ci WHERE ci.taskId = t.id) AS checkTotal,
    (SELECT COUNT(*) FROM TaskChecklistItem ci WHERE ci.taskId = t.id AND ci.done = 1) AS checkDone,
    (SELECT COUNT(*) FROM TaskComment tc WHERE tc.taskId = t.id) AS commentCount,
    (SELECT COUNT(*) FROM TaskAttachment tf WHERE tf.taskId = t.id AND tf.kind = 'TASK') AS attachmentCount,
    (SELECT GROUP_CONCAT(DISTINCT ip.employeeId SEPARATOR ',')
       FROM TaskIssuePerson ip JOIN TaskIssue ti ON ti.id = ip.issueId
      WHERE ti.taskId = t.id) AS issuePersonCsv,
    (SELECT COUNT(*) FROM TaskIssue ti WHERE ti.taskId = t.id AND ti.status = 'OPEN') AS openIssueCount,
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
    partnerRequestedById: rawString(row.partnerRequestedById),
    partnerRequestEmployeeId: rawString(row.partnerRequestEmployeeId),
    partnerRequestedAt: rawDate(row.partnerRequestedAt),
    delayReason: rawString(row.delayReason),
    delayReasonById: rawString(row.delayReasonById),
    delayReasonAt: rawDate(row.delayReasonAt),
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
    issuePersonIds: rawCsv(row.issuePersonCsv),
    openIssueCount: rawNumber(row.openIssueCount),
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

/**
 * Sichtbarkeitsbedingung einer Nicht-Admin-Person über `t`: zugewiesen ODER
 * selbst angelegt (15.09.2026, Samet: «yönetici olmadığım sürece sadece bana
 * atanan ve benim oluşturduğum görevleri görebilmeliyim») — ODER in einer Frage
 * bzw. einem Problem dieser Aufgabe markiert (16.09.2026): wer gefragt wird,
 * muss die Aufgabe öffnen und antworten können.
 */
export const memberVisibilitySql = (employeeId: string): Prisma.Sql => Prisma.sql`(
    t.createdById = ${employeeId}
    OR EXISTS (SELECT 1 FROM TaskAssignee va WHERE va.taskId = t.id AND va.employeeId = ${employeeId})
    OR EXISTS (SELECT 1 FROM TaskIssuePerson vp JOIN TaskIssue vi ON vi.id = vp.issueId
                WHERE vi.taskId = t.id AND vp.employeeId = ${employeeId})
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
    /** Liegt eine Gecikme açıklaması vor? (Text nur im Detail.) */
    hasDelayReason: boolean;
    assigneeIds: string[];
    labelIds: string[];
    checklist: { done: number; total: number };
    commentCount: number;
    attachmentCount: number;
    /** Offene Fragen und Probleme — die Marke am Reiter «Sorular & Sorunlar». */
    openIssueCount: number;
    boardPosition: number;
    overdue: boolean;
    /** Nur die EIGENE laufende Messung. */
    timer: { runningForMe: boolean; myStartedAt: Date | null };
    /**
     * Gemessene Zeit (abgeschlossen) + laufende Messungen. Leitung: alle
     * Personen. Teammitglied (14.09.2026, Samet: «yönetici değilse kişi sadece
     * kendisinin süresini görmeli»): nur die eigenen — und nur, wenn der
     * Aufrufer `ownClosedMs` kennt.
     */
    work?: { closedMs: number; liveMs: number; totalMs: number; live: RunningSessionRef[] };
}

export const toTaskRowDto = (
    core: TaskCore,
    actor: TasksActor,
    running: readonly RunningSessionRef[],
    now: Date = new Date(),
    ownClosedMs?: number,
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
        hasDelayReason: Boolean(core.delayReason),
        assigneeIds: core.assigneeIds,
        labelIds: core.labelIds,
        checklist: { done: core.checkDone, total: core.checkTotal },
        commentCount: core.commentCount,
        attachmentCount: core.attachmentCount,
        openIssueCount: core.openIssueCount,
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
    } else if (ownClosedMs !== undefined) {
        const liveMs = mine ? liveDurationMs(mine.startedAt, now) : 0;
        row.work = {
            closedMs: ownClosedMs,
            liveMs,
            totalMs: Math.max(0, ownClosedMs + liveMs),
            live: mine ? [mine] : [],
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
    /** Gecikme açıklaması der verspätet fertig gemeldeten Aufgabe (reason null = keine). */
    delay: {
        reason: string | null;
        byId: string | null;
        at: Date | null;
    };
}

export const toTaskDetailDto = (
    core: TaskCore,
    actor: TasksActor,
    running: readonly RunningSessionRef[],
    now: Date = new Date(),
    ownClosedMs?: number,
): TaskDetailDto => ({
    ...toTaskRowDto(core, actor, running, now, ownClosedMs),
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
    delay: {
        reason: core.delayReason,
        byId: core.delayReasonById,
        at: core.delayReasonAt,
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
    ...(core.delayReasonById ? [core.delayReasonById] : []),
    ...running.map((session) => session.employeeId),
];

/* ── Liste: nur was die Zeile zeigt, in EINEM Rundgang ──────────────────── */

/**
 * Die Görevler-Liste (14.09.2026, Samet: «sadece gerekli olan veriler gelsin,
 * 600 ms çok uzun»). Eine Anweisung liefert die Zeile, die Gesamtzahl
 * (`COUNT(*) OVER()`) und die laufenden Messungen — früher waren das drei
 * Rundgänge (Zeilen · Zählung · Messungen). Nur Spalten, die die Liste liest;
 * Beschreibung, Anfrage-Notizen, Position usw. kommen erst mit dem Detail.
 */
export interface TaskListRowDto {
    id: string;
    title: string;
    status: string;
    effectiveStatus: string;
    flagged: boolean;
    dueAt: Date | null;
    completedAt: Date | null;
    createdById: string;
    approvalState: string;
    reviewState: string;
    blockReason: string | null;
    deleteRequestedById: string | null;
    hasDelayReason: boolean;
    assigneeIds: string[];
    labelIds: string[];
    checklist: { done: number; total: number };
    commentCount: number;
    attachmentCount: number;
    overdue: boolean;
    /** Die EIGENE laufende Messung — ihr Anteil steckt NICHT in `work.dayMs` (der Browser zählt sie ab dem Klick). */
    timer: { runningForMe: boolean; myStartedAt: Date | null };
    /**
     * Zeit des TAGES (Fenster `day`) bis `serverNow` und wie viele Messungen
     * gerade laufen — Teammitglieder: nur die eigenen. Die Summe aller Tage
     * steht im Rapport (14.09.2026, Samet: «her gün baştan başlasın»).
     */
    work?: { dayMs: number; liveCount: number };
}

/** Wessen abgeschlossene Messungen die Zeitsumme zählt: Leitung alle, Teammitglied nur die eigenen. */
const ownSessionsSql = (actor: TasksActor): Prisma.Sql =>
    actor.isManager ? Prisma.sql`TRUE` : Prisma.sql`ts.employeeId = ${actor.employeeId}`;

const taskListColumns = (actor: TasksActor, day: DayWindow) => Prisma.sql`
    t.id, t.title, t.status, t.flagged, t.startAt, t.dueAt, t.completedAt, t.createdById,
    t.approvalState, t.reviewState, t.blockReason, t.deleteRequestedById,
    (t.delayReason IS NOT NULL) AS hasDelayReason,
    (SELECT GROUP_CONCAT(ta.employeeId ORDER BY ta.createdAt, ta.id SEPARATOR ',')
       FROM TaskAssignee ta WHERE ta.taskId = t.id) AS assigneeCsv,
    (SELECT GROUP_CONCAT(tl.labelId ORDER BY tl.createdAt, tl.id SEPARATOR ',')
       FROM TaskLabelLink tl WHERE tl.taskId = t.id) AS labelCsv,
    (SELECT CONCAT(COUNT(*), ',', COALESCE(SUM(ci.done = 1), 0))
       FROM TaskChecklistItem ci WHERE ci.taskId = t.id) AS checkCsv,
    (SELECT COUNT(*) FROM TaskComment tc WHERE tc.taskId = t.id) AS commentCount,
    (SELECT COUNT(*) FROM TaskAttachment tf WHERE tf.taskId = t.id AND tf.kind = 'TASK') AS attachmentCount,
    (SELECT COUNT(*) FROM TaskTimeSession ts WHERE ts.taskId = t.id) AS sessionCount,
    (SELECT COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(MICROSECOND, GREATEST(ts.startedAt, ${day.from}), LEAST(ts.endedAt, ${day.to})) DIV 1000)), 0)
       FROM TaskTimeSession ts
      WHERE ts.taskId = t.id AND ts.endedAt IS NOT NULL AND ${ownSessionsSql(actor)}
        AND ts.startedAt <= ${day.to} AND ts.endedAt >= ${day.from}) AS dayClosedMs,
    (SELECT GROUP_CONCAT(ts.employeeId, '|', TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', ts.startedAt) DIV 1000 SEPARATOR ',')
       FROM TaskTimeSession ts WHERE ts.taskId = t.id AND ts.endedAt IS NULL) AS runningCsv,
    COUNT(*) OVER () AS totalRows
`;

export interface TaskListRowsResult {
    rows: TaskListRowDto[];
    total: number;
    /** Wer in den Zeilen genannt wird (Verantwortliche, Anlegende). */
    personIds: string[];
}

export const fetchTaskListRows = async (
    db: TasksDb,
    actor: TasksActor,
    query: { where: Prisma.Sql; orderBy: Prisma.Sql; limit: number; offset: number },
    now: Date,
    day: DayWindow = resolveDayWindow(undefined, undefined, now),
): Promise<TaskListRowsResult> => {
    const raw = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT ${taskListColumns(actor, day)}
        FROM Task t
        WHERE ${query.where}
        ORDER BY ${query.orderBy}
        LIMIT ${query.limit} OFFSET ${query.offset}
    `);
    const personIds = new Set<string>();
    const rows = raw.map((row): TaskListRowDto => {
        const [checkTotal = 0, checkDone = 0] = rawCsv(row.checkCsv).map(rawNumber);
        const sessionCount = rawNumber(row.sessionCount);
        const dayClosedMs = rawNumber(row.dayClosedMs);
        const running = rawCsv(row.runningCsv).map((entry) => {
            const [employeeId, startedMs] = entry.split('|');
            return { employeeId, startedAt: new Date(rawNumber(startedMs)) };
        });
        const mine = running.find((session) => session.employeeId === actor.employeeId) ?? null;
        const status = String(row.status ?? 'NOT_STARTED');
        const dueAt = rawDate(row.dueAt);
        const createdById = String(row.createdById ?? '');
        const assigneeIds = rawCsv(row.assigneeCsv);
        personIds.add(createdById);
        for (const id of assigneeIds) personIds.add(id);
        const dto: TaskListRowDto = {
            id: String(row.id),
            title: String(row.title ?? ''),
            status,
            effectiveStatus: effectiveTaskStatus({ status, startAt: rawDate(row.startAt), hasSessions: sessionCount > 0 }, now),
            flagged: rawBool(row.flagged),
            dueAt,
            completedAt: rawDate(row.completedAt),
            createdById,
            approvalState: String(row.approvalState ?? 'NONE'),
            reviewState: String(row.reviewState ?? 'APPROVED'),
            blockReason: rawString(row.blockReason),
            deleteRequestedById: rawString(row.deleteRequestedById),
            hasDelayReason: rawBool(row.hasDelayReason),
            assigneeIds,
            labelIds: rawCsv(row.labelCsv),
            checklist: { done: checkDone, total: checkTotal },
            commentCount: rawNumber(row.commentCount),
            attachmentCount: rawNumber(row.attachmentCount),
            overdue: isTaskOverdue({ status, dueAt }, now),
            timer: { runningForMe: Boolean(mine), myStartedAt: mine?.startedAt ?? null },
        };
        const counted = actor.isManager ? running : running.filter((session) => session.employeeId === actor.employeeId);
        // KEINE laufende Zeit (14.09.2026, Samet: «kronometre olmayacak, arka planda süre hesaplamasın»):
        // die Zahl ist die Summe der ABGESCHLOSSENEN Messungen; eine laufende zählt erst beim Pausieren.
        dto.work = { dayMs: Math.max(0, dayClosedMs), liveCount: counted.length };
        return dto;
    });
    return { rows, total: raw.length ? rawNumber(raw[0]?.totalRows) : 0, personIds: [...personIds].filter(Boolean) };
};
