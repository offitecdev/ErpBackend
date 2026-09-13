"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.taskPeopleIds = exports.toTaskDetailDto = exports.toTaskRowDto = exports.loadRunningSessionsByTask = exports.requireVisibleTask = exports.visibleTasksSql = exports.memberVisibilitySql = exports.lockTaskRow = exports.loadTaskCore = exports.fetchTaskCoresByIds = exports.fetchTaskCores = exports.mapTaskCore = exports.TASK_CORE_COLUMNS = exports.rawJson = exports.rawCsv = exports.rawString = exports.rawDate = exports.rawBool = exports.rawNumber = void 0;
const client_1 = require("@prisma/client");
const taskAccess_1 = require("./taskAccess");
const taskErrors_1 = require("./taskErrors");
const taskTime_1 = require("./taskTime");
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
const rawNumber = (value) => {
    if (value === null || value === undefined)
        return 0;
    if (typeof value === 'bigint')
        return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};
exports.rawNumber = rawNumber;
const rawBool = (value) => value === true || value === 1 || value === '1' || (typeof value === 'bigint' && value === 1n);
exports.rawBool = rawBool;
const rawDate = (value) => {
    if (value === null || value === undefined || value === '')
        return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
};
exports.rawDate = rawDate;
const rawString = (value) => value === null || value === undefined ? null : String(value);
exports.rawString = rawString;
const rawCsv = (value) => typeof value === 'string' && value.length ? value.split(',').filter(Boolean) : [];
exports.rawCsv = rawCsv;
const rawJson = (value) => {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
};
exports.rawJson = rawJson;
/** Spaltenliste über `Task t` — für jede Abfrage, die TaskCore-Zeilen liefert. */
exports.TASK_CORE_COLUMNS = client_1.Prisma.sql `
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
const mapTaskCore = (row) => ({
    id: String(row.id),
    tenantId: String(row.tenantId),
    title: String(row.title ?? ''),
    description: (0, exports.rawString)(row.description),
    status: String(row.status ?? 'NOT_STARTED'),
    priority: String(row.priority ?? 'MEDIUM'),
    origin: String(row.origin ?? 'MANAGER'),
    flagged: (0, exports.rawBool)(row.flagged),
    startAt: (0, exports.rawDate)(row.startAt),
    dueAt: (0, exports.rawDate)(row.dueAt),
    reminderAt: (0, exports.rawDate)(row.reminderAt),
    completedAt: (0, exports.rawDate)(row.completedAt),
    blockReason: (0, exports.rawString)(row.blockReason),
    approvalState: String(row.approvalState ?? 'NONE'),
    approvalRequestedById: (0, exports.rawString)(row.approvalRequestedById),
    approvalRequestedAt: (0, exports.rawDate)(row.approvalRequestedAt),
    approvalNote: (0, exports.rawString)(row.approvalNote),
    approvalDecidedById: (0, exports.rawString)(row.approvalDecidedById),
    approvalDecidedAt: (0, exports.rawDate)(row.approvalDecidedAt),
    approvalDecisionNote: (0, exports.rawString)(row.approvalDecisionNote),
    reviewState: String(row.reviewState ?? 'APPROVED'),
    reviewRequestedById: (0, exports.rawString)(row.reviewRequestedById),
    reviewRequestedAt: (0, exports.rawDate)(row.reviewRequestedAt),
    reviewDecidedById: (0, exports.rawString)(row.reviewDecidedById),
    reviewDecidedAt: (0, exports.rawDate)(row.reviewDecidedAt),
    reviewNote: (0, exports.rawString)(row.reviewNote),
    deleteRequestedById: (0, exports.rawString)(row.deleteRequestedById),
    deleteRequestedAt: (0, exports.rawDate)(row.deleteRequestedAt),
    deleteRequestNote: (0, exports.rawString)(row.deleteRequestNote),
    boardPosition: (0, exports.rawNumber)(row.boardPosition),
    createdById: String(row.createdById ?? ''),
    createdAt: (0, exports.rawDate)(row.createdAt) ?? new Date(0),
    updatedAt: (0, exports.rawDate)(row.updatedAt) ?? new Date(0),
    assigneeIds: (0, exports.rawCsv)(row.assigneeCsv),
    labelIds: (0, exports.rawCsv)(row.labelCsv),
    checkTotal: (0, exports.rawNumber)(row.checkTotal),
    checkDone: (0, exports.rawNumber)(row.checkDone),
    commentCount: (0, exports.rawNumber)(row.commentCount),
    attachmentCount: (0, exports.rawNumber)(row.attachmentCount),
    closedMs: (0, exports.rawNumber)(row.closedMs),
    sessionCount: (0, exports.rawNumber)(row.sessionCount),
});
exports.mapTaskCore = mapTaskCore;
const fetchTaskCores = async (db, query) => {
    const order = query.orderBy ?? client_1.Prisma.sql `t.createdAt DESC, t.id ASC`;
    const limit = query.limit !== undefined ? client_1.Prisma.sql `LIMIT ${query.limit} OFFSET ${query.offset ?? 0}` : client_1.Prisma.empty;
    const rows = await db.$queryRaw(client_1.Prisma.sql `
        SELECT ${exports.TASK_CORE_COLUMNS}
        FROM Task t
        WHERE ${query.where}
        ORDER BY ${order}
        ${limit}
    `);
    return rows.map(exports.mapTaskCore);
};
exports.fetchTaskCores = fetchTaskCores;
const fetchTaskCoresByIds = async (db, tenantId, ids) => {
    if (!ids.length)
        return [];
    return (0, exports.fetchTaskCores)(db, { where: client_1.Prisma.sql `t.tenantId = ${tenantId} AND t.id IN (${client_1.Prisma.join([...ids])})` });
};
exports.fetchTaskCoresByIds = fetchTaskCoresByIds;
const loadTaskCore = async (db, tenantId, taskId) => {
    if (!taskId)
        return null;
    const [core] = await (0, exports.fetchTaskCores)(db, { where: client_1.Prisma.sql `t.tenantId = ${tenantId} AND t.id = ${taskId}`, limit: 1 });
    return core ?? null;
};
exports.loadTaskCore = loadTaskCore;
/** Sperrt die Aufgabenzeile in einer Transaktion (Zustandswechsel nacheinander). */
const lockTaskRow = async (tx, tenantId, taskId) => {
    const rows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT id FROM Task WHERE id = ${taskId} AND tenantId = ${tenantId} FOR UPDATE
    `);
    return rows.length > 0;
};
exports.lockTaskRow = lockTaskRow;
/** Sichtbarkeitsbedingung eines Teammitglieds über `t` (verantwortlich ODER angelegt). */
const memberVisibilitySql = (employeeId) => client_1.Prisma.sql `(
    t.createdById = ${employeeId}
    OR EXISTS (SELECT 1 FROM TaskAssignee va WHERE va.taskId = t.id AND va.employeeId = ${employeeId})
)`;
exports.memberVisibilitySql = memberVisibilitySql;
/** Firmen- und Sichtbarkeitsbedingung für die handelnde Person. */
const visibleTasksSql = (actor) => actor.seesAll
    ? client_1.Prisma.sql `t.tenantId = ${actor.tenantId}`
    : client_1.Prisma.sql `t.tenantId = ${actor.tenantId} AND ${(0, exports.memberVisibilitySql)(actor.employeeId)}`;
exports.visibleTasksSql = visibleTasksSql;
/**
 * Die Aufgabe für eine Handlung laden: 404, wenn es sie in der ausgewählten
 * Firma nicht gibt; 403, wenn die Person sie nicht sehen darf.
 */
const requireVisibleTask = async (db, actor, taskId) => {
    const core = await (0, exports.loadTaskCore)(db, actor.tenantId, taskId);
    if (!core)
        throw (0, taskErrors_1.taskNotFound)();
    const permissions = (0, taskAccess_1.taskPermissions)(actor, core);
    if (!permissions.canSee)
        throw (0, taskErrors_1.taskForbidden)('TASK_FORBIDDEN', 'Diese Aufgabe ist für Sie nicht sichtbar.');
    return { core, permissions };
};
exports.requireVisibleTask = requireVisibleTask;
const loadRunningSessionsByTask = async (db, tenantId, taskIds) => {
    const byTask = new Map();
    if (!taskIds.length)
        return byTask;
    const rows = await db.$queryRaw(client_1.Prisma.sql `
        SELECT taskId, employeeId, startedAt
        FROM TaskTimeSession
        WHERE tenantId = ${tenantId} AND endedAt IS NULL AND taskId IN (${client_1.Prisma.join([...taskIds])})
    `);
    for (const row of rows) {
        const startedAt = (0, exports.rawDate)(row.startedAt);
        if (!startedAt)
            continue;
        const list = byTask.get(row.taskId) ?? [];
        list.push({ employeeId: row.employeeId, startedAt });
        byTask.set(row.taskId, list);
    }
    return byTask;
};
exports.loadRunningSessionsByTask = loadRunningSessionsByTask;
const toTaskRowDto = (core, actor, running, now = new Date()) => {
    const mine = running.find((session) => session.employeeId === actor.employeeId) ?? null;
    const row = {
        id: core.id,
        title: core.title,
        status: core.status,
        effectiveStatus: (0, taskAccess_1.effectiveTaskStatus)({ status: core.status, startAt: core.startAt, hasSessions: core.sessionCount > 0 }, now),
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
        overdue: (0, taskAccess_1.isTaskOverdue)(core, now),
        timer: { runningForMe: Boolean(mine), myStartedAt: mine?.startedAt ?? null },
    };
    if (actor.isManager) {
        const liveMs = running.reduce((sum, session) => sum + (0, taskTime_1.liveDurationMs)(session.startedAt, now), 0);
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
exports.toTaskRowDto = toTaskRowDto;
const toTaskDetailDto = (core, actor, running, now = new Date()) => ({
    ...(0, exports.toTaskRowDto)(core, actor, running, now),
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
exports.toTaskDetailDto = toTaskDetailDto;
/** Alle Personenkennungen, die eine Aufgabenausgabe nennt (für die `people`-Karte). */
const taskPeopleIds = (core, running = []) => [
    core.createdById,
    ...core.assigneeIds,
    ...(core.approvalRequestedById ? [core.approvalRequestedById] : []),
    ...(core.approvalDecidedById ? [core.approvalDecidedById] : []),
    ...(core.reviewRequestedById ? [core.reviewRequestedById] : []),
    ...(core.reviewDecidedById ? [core.reviewDecidedById] : []),
    ...(core.deleteRequestedById ? [core.deleteRequestedById] : []),
    ...running.map((session) => session.employeeId),
];
exports.taskPeopleIds = taskPeopleIds;
//# sourceMappingURL=taskRows.js.map