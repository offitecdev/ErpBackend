"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getQuickMode = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskAccess_1 = require("./taskAccess");
const taskConstants_1 = require("./taskConstants");
const taskRows_1 = require("./taskRows");
const taskTime_1 = require("./taskTime");
const QUICK_CARD_LIMIT = 60;
const parseDate = (value) => {
    if (typeof value !== 'string' || !value.trim())
        return null;
    const date = new Date(value.trim().slice(0, 40));
    return Number.isNaN(date.getTime()) ? null : date;
};
const resolveDay = (query, now) => {
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (from && to && to.getTime() > from.getTime() && to.getTime() - from.getTime() <= taskTime_1.DAY_MS * 1.5)
        return { from, to };
    return { from: (0, taskTime_1.startOfLocalDay)(now), to: (0, taskTime_1.endOfLocalDay)(now) };
};
const getQuickMode = async (actor, query) => {
    const now = new Date();
    const day = resolveDay(query, now);
    const me = actor.employeeId;
    const closed = client_1.Prisma.join([...taskConstants_1.CLOSED_TASK_STATUSES]);
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT t.id, t.title, t.status, t.startAt, t.dueAt, t.reviewState, t.approvalState, t.createdById,
            (SELECT GROUP_CONCAT(ta.employeeId SEPARATOR ',') FROM TaskAssignee ta WHERE ta.taskId = t.id) AS assigneeCsv,
            (SELECT GROUP_CONCAT(tl.labelId ORDER BY tl.createdAt, tl.id SEPARATOR ',')
               FROM TaskLabelLink tl WHERE tl.taskId = t.id) AS labelCsv,
            (SELECT COUNT(*) FROM TaskTimeSession ts WHERE ts.taskId = t.id) AS sessionCount,
            (SELECT COALESCE(SUM(ts.durationMs), 0) FROM TaskTimeSession ts
              WHERE ts.taskId = t.id AND ts.employeeId = ${me} AND ts.endedAt IS NOT NULL) AS totalClosedMs,
            (SELECT COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(MICROSECOND, GREATEST(ts.startedAt, ${day.from}), LEAST(ts.endedAt, ${day.to})) DIV 1000)), 0)
               FROM TaskTimeSession ts
              WHERE ts.taskId = t.id AND ts.employeeId = ${me} AND ts.endedAt IS NOT NULL
                AND ts.startedAt <= ${day.to} AND ts.endedAt >= ${day.from}) AS todayClosedMs,
            (SELECT TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', ts.startedAt) DIV 1000
               FROM TaskTimeSession ts WHERE ts.taskId = t.id AND ts.runningKey = ${me} LIMIT 1) AS runningStartMs
        FROM Task t
        WHERE ${(0, taskRows_1.visibleTasksSql)(actor)}
          AND t.id NOT LIKE 'tasks-welcome-%'
          AND (
              (EXISTS (SELECT 1 FROM TaskAssignee qa WHERE qa.taskId = t.id AND qa.employeeId = ${me})
               AND t.status NOT IN (${closed})
               AND t.reviewState NOT IN ('REJECTED', 'PENDING')
               AND (t.startAt IS NULL OR t.startAt <= ${day.to}))
              OR EXISTS (SELECT 1 FROM TaskTimeSession qs
                  WHERE qs.taskId = t.id AND qs.employeeId = ${me}
                    AND qs.startedAt <= ${day.to} AND (qs.endedAt IS NULL OR qs.endedAt >= ${day.from}))
          )
        ORDER BY t.dueAt IS NULL ASC, t.dueAt ASC, t.createdAt DESC, t.id ASC
        LIMIT ${QUICK_CARD_LIMIT}
    `);
    const cards = rows.map((row) => {
        const status = String(row.status ?? 'NOT_STARTED');
        const startAt = (0, taskRows_1.rawDate)(row.startAt);
        const dueAt = (0, taskRows_1.rawDate)(row.dueAt);
        const runningStartMs = row.runningStartMs === null || row.runningStartMs === undefined ? null : (0, taskRows_1.rawNumber)(row.runningStartMs);
        const facts = {
            status,
            createdById: String(row.createdById ?? ''),
            reviewState: String(row.reviewState ?? 'APPROVED'),
            approvalState: String(row.approvalState ?? 'NONE'),
            approvalRequestedById: null,
            assigneeIds: (0, taskRows_1.rawCsv)(row.assigneeCsv),
        };
        return {
            id: String(row.id),
            title: (0, taskRows_1.rawString)(row.title) ?? '',
            status,
            effectiveStatus: (0, taskAccess_1.effectiveTaskStatus)({ status, startAt, hasSessions: (0, taskRows_1.rawNumber)(row.sessionCount) > 0 }, now),
            startAt,
            dueAt,
            overdue: (0, taskAccess_1.isTaskOverdue)({ status, dueAt }, now),
            labelIds: (0, taskRows_1.rawCsv)(row.labelCsv),
            canTrack: (0, taskAccess_1.canTrackTask)(actor, facts),
            todayClosedMs: (0, taskRows_1.rawNumber)(row.todayClosedMs),
            totalClosedMs: (0, taskRows_1.rawNumber)(row.totalClosedMs),
            runningStartedAt: runningStartMs === null ? null : new Date(runningStartMs),
        };
    });
    // Feste Reihenfolge nach Termin: ‹ › blättert, ein Start soll die Karten nicht umsortieren.
    return { day, cards, serverNow: now };
};
exports.getQuickMode = getQuickMode;
//# sourceMappingURL=quickModeService.js.map