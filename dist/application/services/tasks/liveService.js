"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLiveOverview = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskPeople_1 = require("./taskPeople");
const taskRows_1 = require("./taskRows");
const taskTime_1 = require("./taskTime");
const parseDate = (value) => {
    if (typeof value !== 'string' || !value.trim())
        return null;
    const date = new Date(value.trim());
    return Number.isNaN(date.getTime()) ? null : date;
};
/** Tagesgrenzen: die des Browsers, wenn plausibel (≤ 36 h), sonst die des Servers. */
const resolveDay = (query, now) => {
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (from && to && to.getTime() > from.getTime() && to.getTime() - from.getTime() <= taskTime_1.DAY_MS * 1.5) {
        return { from, to };
    }
    return { from: (0, taskTime_1.startOfLocalDay)(now), to: (0, taskTime_1.endOfLocalDay)(now) };
};
const getLiveOverview = async (actor, query) => {
    const now = new Date();
    const day = resolveDay(query, now);
    const tenantId = actor.tenantId;
    // Nur Admins sehen alle; alle anderen (auch die Leitung) nur sich selbst.
    const onlyMe = actor.seesAll ? client_1.Prisma.empty : client_1.Prisma.sql `AND s.employeeId = ${actor.employeeId}`;
    const onlyMeAssignee = actor.seesAll ? client_1.Prisma.empty : client_1.Prisma.sql `AND a.employeeId = ${actor.employeeId}`;
    const sessionWindow = client_1.Prisma.sql `
        s.tenantId = ${tenantId}
        AND s.startedAt <= ${day.to}
        AND (s.endedAt IS NULL OR s.endedAt >= ${day.from})
    `;
    const completedWindow = client_1.Prisma.sql `
        t.tenantId = ${tenantId}
        AND t.status = 'COMPLETED'
        AND t.completedAt >= ${day.from}
        AND t.completedAt <= ${day.to}
    `;
    const [people, sessionRows, completedRows, labelRows] = await Promise.all([
        (0, taskPeople_1.getTasksPeople)(tenantId),
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT s.id, s.taskId, s.employeeId, s.startedAt, s.endedAt, s.runningKey, t.title, t.status
            FROM TaskTimeSession s
            JOIN Task t ON t.id = s.taskId
            WHERE ${sessionWindow} ${onlyMe}
            ORDER BY s.startedAt ASC
        `),
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT t.id, t.title, t.completedAt, a.employeeId
            FROM Task t
            JOIN TaskAssignee a ON a.taskId = t.id
            WHERE ${completedWindow} ${onlyMeAssignee}
            ORDER BY t.completedAt ASC
        `),
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT ll.taskId, lb.id, lb.name, lb.color, ll.createdAt
            FROM TaskLabelLink ll
            JOIN TaskLabel lb ON lb.id = ll.labelId
            WHERE ll.tenantId = ${tenantId}
              AND ll.taskId IN (
                  SELECT s.taskId FROM TaskTimeSession s WHERE ${sessionWindow} ${onlyMe}
                  UNION
                  SELECT t.id FROM Task t JOIN TaskAssignee a ON a.taskId = t.id WHERE ${completedWindow} ${onlyMeAssignee}
              )
            ORDER BY ll.createdAt ASC
        `),
    ]);
    const byPerson = new Map();
    const ensurePerson = (employeeId) => {
        let entry = byPerson.get(employeeId);
        if (!entry) {
            const person = people.get(employeeId);
            entry = {
                employeeId,
                name: person ? (0, taskPeople_1.personDisplayName)(person) : '',
                title: person?.title ?? null,
                isManager: person?.isManager ?? false,
                running: null,
                todayMs: 0,
                sessions: [],
                completedToday: [],
                lastActiveAt: null,
            };
            byPerson.set(employeeId, entry);
        }
        return entry;
    };
    // Alle Personen des Moduls (Leitung) bzw. nur sich selbst.
    if (actor.seesAll)
        for (const id of people.keys())
            ensurePerson(id);
    else
        ensurePerson(actor.employeeId);
    for (const row of sessionRows) {
        const startedAt = (0, taskRows_1.rawDate)(row.startedAt);
        if (!startedAt)
            continue;
        const endedAt = (0, taskRows_1.rawDate)(row.endedAt);
        const live = !endedAt;
        const clipStart = Math.max(startedAt.getTime(), day.from.getTime());
        // KEINE laufende Zeit (14.09.2026, Samet): eine laufende Messung zählt erst beim Pausieren.
        const durationMs = live ? 0 : Math.max(0, Math.min(endedAt.getTime(), day.to.getTime()) - clipStart);
        const entry = ensurePerson(row.employeeId);
        entry.sessions.push({ id: row.id, taskId: row.taskId, taskTitle: row.title ?? '', startedAt, endedAt, durationMs });
        entry.todayMs += durationMs;
        if (live && row.runningKey) {
            entry.running = { sessionId: row.id, taskId: row.taskId, taskTitle: row.title ?? '', taskStatus: row.status, startedAt };
            entry.lastActiveAt = now;
        }
        else if (endedAt && (!entry.lastActiveAt || endedAt.getTime() > entry.lastActiveAt.getTime())) {
            entry.lastActiveAt = endedAt;
        }
    }
    for (const row of completedRows) {
        const completedAt = (0, taskRows_1.rawDate)(row.completedAt);
        if (!completedAt)
            continue;
        const entry = byPerson.get(row.employeeId) ?? (actor.seesAll ? ensurePerson(row.employeeId) : null);
        entry?.completedToday.push({ taskId: row.id, title: row.title ?? '', completedAt });
    }
    // Namen für Personen, die heute gemessen haben, aber nicht (mehr) im Modul stehen.
    const unnamed = [...byPerson.values()].filter((entry) => !entry.name).map((entry) => entry.employeeId);
    if (unnamed.length) {
        const refs = await (0, taskPeople_1.loadPersonRefs)(unnamed);
        for (const id of unnamed) {
            const entry = byPerson.get(id);
            if (entry) {
                entry.name = refs[id]?.name ?? '';
                entry.title = refs[id]?.title ?? null;
            }
        }
    }
    const taskLabels = {};
    for (const row of labelRows) {
        (taskLabels[row.taskId] ??= []).push({ id: row.id, name: row.name, color: row.color });
    }
    const rank = (entry) => (entry.running ? 0 : entry.sessions.length ? 1 : 2);
    const list = [...byPerson.values()].sort((a, b) => rank(a) - rank(b)
        || (rank(a) === 1 ? (0, taskRows_1.rawNumber)(b.lastActiveAt?.getTime()) - (0, taskRows_1.rawNumber)(a.lastActiveAt?.getTime()) : 0)
        || a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })
        || a.employeeId.localeCompare(b.employeeId));
    return { day, serverNow: now, taskLabels, people: list };
};
exports.getLiveOverview = getLiveOverview;
//# sourceMappingURL=liveService.js.map