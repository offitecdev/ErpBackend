"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTaskReport = exports.getPersonReport = exports.getMyReport = exports.getTeamReport = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const peopleService_1 = require("./peopleService");
const taskAccess_1 = require("./taskAccess");
const taskActor_1 = require("./taskActor");
const taskConstants_1 = require("./taskConstants");
const taskErrors_1 = require("./taskErrors");
const taskForecast_1 = require("./taskForecast");
const taskParts_1 = require("./taskParts");
const taskPeople_1 = require("./taskPeople");
const taskRows_1 = require("./taskRows");
const taskTime_1 = require("./taskTime");
/**
 * ── BERICHTE («Rapor») — Görevly services/reports.js ────────────────────────
 *
 * Vorgabe Samet: Berichte nur als PDF — die Oberfläche setzt es, der Server
 * liefert Zahlen und Tabellen. Keine Grafiken, keine fertigen Sätze; Zeiten
 * in ms, alles andere als Anzahl.
 *
 *   Team      Leitung   Kennzahlen je Person (wie Kişiler) + ALLE Aufgaben
 *   Person    Leitung — ein Teammitglied nur den eigenen («Raporum»)
 *   Aufgabe   Leitung   Beiträge, Checkliste, jede Messung, Prognose
 *
 * Zeitraum wie Görevly: `range` = 7 | 30 | 90 | all (Standard 30) oder
 * `from`/`to` aus dem Browser. Eine Messung zählt in dem Zeitraum, in dem sie
 * begann; die laufende zählt mit ihrer Dauer bis jetzt und gilt als Messung
 * wie jede andere (Anzahl, erster/letzter Zeitpunkt, aktiver Tag).
 * Zugewiesen, offen und überfällig sind der heutige Stand, ohne Zeitraum.
 */
const unknownPerson = (id) => ({ id, firstName: '', lastName: '', name: '', title: null, active: false });
const getTeamReport = async (actor, rangeQuery) => {
    (0, taskActor_1.assertSeesAll)(actor);
    const now = new Date();
    const range = (0, taskTime_1.resolveReportRange)(rangeQuery, now);
    const [staff, facts, cores] = await Promise.all([
        (0, taskPeople_1.getTasksPeople)(actor.tenantId),
        (0, peopleService_1.loadPersonStatsFacts)(actor.tenantId, range, now),
        (0, taskRows_1.fetchTaskCores)(prisma_client_1.default, {
            where: client_1.Prisma.sql `t.tenantId = ${actor.tenantId}`,
            orderBy: client_1.Prisma.sql `t.dueAt IS NULL, t.dueAt ASC, t.createdAt DESC, t.id ASC`,
        }),
    ]);
    const people = (0, peopleService_1.buildPersonStats)(staff.values(), facts, range, now);
    // Die laufenden Messungen der Firma liegen schon in den Kennzahlen.
    const liveMsByTask = new Map();
    for (const session of facts.running) {
        liveMsByTask.set(session.taskId, (liveMsByTask.get(session.taskId) ?? 0) + (0, taskTime_1.liveDurationMs)(session.startedAt, now));
    }
    const tasks = cores.map((core) => ({
        id: core.id,
        title: core.title,
        status: core.status,
        effectiveStatus: (0, taskAccess_1.effectiveTaskStatus)({ status: core.status, startAt: core.startAt, hasSessions: core.sessionCount > 0 }, now),
        assigneeIds: core.assigneeIds,
        dueAt: core.dueAt,
        totalMs: core.closedMs + (liveMsByTask.get(core.id) ?? 0),
        checklist: { done: core.checkDone, total: core.checkTotal },
    }));
    const totals = { people: people.length, ms: 0, openCount: 0, completedCount: 0, overdueCount: 0 };
    for (const person of people) {
        totals.ms += person.ms;
        totals.openCount += person.openCount;
        totals.completedCount += person.completedCount;
        totals.overdueCount += person.overdueCount;
    }
    const peopleMap = await (0, taskPeople_1.loadPersonRefs)([
        ...people.map((person) => person.employeeId),
        ...tasks.flatMap((task) => task.assigneeIds),
    ]);
    return { range, generatedAt: now, totals, people, tasks, peopleMap };
};
exports.getTeamReport = getTeamReport;
/**
 * Jede Aufgabe, bei der die Person verantwortlich ist ODER je gemessen hat
 * (Görevly geht alle Aufgaben durch — hier nur die, die sie betreffen).
 * Neueste zuerst wie Görevlys Speicher; die Liste «Kayıp süre» behält das.
 */
const loadPersonTasks = async (tenantId, employeeId) => {
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT t.id, t.title, t.status, t.startAt, t.dueAt, t.completedAt, t.reviewState, t.reviewNote,
               EXISTS(SELECT 1 FROM TaskAssignee a WHERE a.taskId = t.id AND a.employeeId = ${employeeId}) AS isAssignee,
               EXISTS(SELECT 1 FROM TaskTimeSession ts WHERE ts.taskId = t.id) AS hasSessions,
               (SELECT COUNT(*) FROM TaskChecklistItem ci WHERE ci.taskId = t.id) AS checkTotal,
               (SELECT COUNT(*) FROM TaskChecklistItem ci WHERE ci.taskId = t.id AND ci.done = 1) AS checkDone,
               (SELECT COUNT(*) FROM TaskChecklistItem ci
                 WHERE ci.taskId = t.id AND ci.done = 1 AND ci.doneById = ${employeeId}) AS myCheckDone,
               (SELECT COALESCE(SUM(ts.durationMs), 0) FROM TaskTimeSession ts
                 WHERE ts.taskId = t.id AND ts.employeeId = ${employeeId} AND ts.endedAt IS NOT NULL) AS myClosedMs
        FROM Task t
        JOIN (
            SELECT a.taskId FROM TaskAssignee a WHERE a.tenantId = ${tenantId} AND a.employeeId = ${employeeId}
            UNION
            SELECT s.taskId FROM TaskTimeSession s WHERE s.tenantId = ${tenantId} AND s.employeeId = ${employeeId}
        ) mine ON mine.taskId = t.id
        WHERE t.tenantId = ${tenantId}
        ORDER BY t.createdAt DESC, t.id ASC
    `);
    return rows.map((row) => ({
        id: String(row.id),
        title: String(row.title ?? ''),
        status: String(row.status ?? 'NOT_STARTED'),
        startAt: (0, taskRows_1.rawDate)(row.startAt),
        dueAt: (0, taskRows_1.rawDate)(row.dueAt),
        completedAt: (0, taskRows_1.rawDate)(row.completedAt),
        reviewState: String(row.reviewState ?? 'APPROVED'),
        reviewNote: (0, taskRows_1.rawString)(row.reviewNote),
        isAssignee: (0, taskRows_1.rawBool)(row.isAssignee),
        hasSessions: (0, taskRows_1.rawBool)(row.hasSessions),
        checkTotal: (0, taskRows_1.rawNumber)(row.checkTotal),
        checkDone: (0, taskRows_1.rawNumber)(row.checkDone),
        myCheckDone: (0, taskRows_1.rawNumber)(row.myCheckDone),
        myClosedMs: (0, taskRows_1.rawNumber)(row.myClosedMs),
    }));
};
/** Die Messungen der Person, die zum Zeitraum gehören — die laufende eingeschlossen. */
const loadPersonSessions = async (tenantId, employeeId, range, now) => {
    const rows = await prisma_client_1.default.taskTimeSession.findMany({
        where: { tenantId, employeeId, OR: [{ endedAt: null }, { startedAt: (0, peopleService_1.rangeDateFilter)(range) }] },
        select: { taskId: true, startedAt: true, endedAt: true, durationMs: true },
    });
    return rows
        .map((row) => {
        const live = row.endedAt === null;
        return {
            taskId: row.taskId,
            startedAt: row.startedAt,
            live,
            end: row.endedAt ?? now,
            ms: live ? (0, taskTime_1.liveDurationMs)(row.startedAt, now) : row.durationMs ?? 0,
        };
    })
        .filter((session) => (0, peopleService_1.sessionCountsInRange)(session, range));
};
/** Eine Person aus einer anderen Firma bleibt unsichtbar — auch ihr Name (loadPersonRefs filtert nicht). */
const assertReportablePerson = async (tenantId, employeeId) => {
    if ((await (0, taskPeople_1.getTasksPeople)(tenantId)).has(employeeId))
        return;
    // Ehemalige ohne Zugang behalten ihren Bericht, solange sie Spuren in der Firma haben.
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT (
            EXISTS(SELECT 1 FROM TaskAssignee WHERE tenantId = ${tenantId} AND employeeId = ${employeeId})
            OR EXISTS(SELECT 1 FROM TaskTimeSession WHERE tenantId = ${tenantId} AND employeeId = ${employeeId})
            OR EXISTS(SELECT 1 FROM Task WHERE tenantId = ${tenantId} AND createdById = ${employeeId})
        ) AS known
    `);
    if (!(0, taskRows_1.rawBool)(rows[0]?.known)) {
        throw (0, taskErrors_1.taskNotFound)('PERSON_NOT_FOUND', 'Diese Person gehört nicht zur ausgewählten Firma.');
    }
};
const loadUserReport = async (tenantId, employeeId, rangeQuery) => {
    const now = new Date();
    const range = (0, taskTime_1.resolveReportRange)(rangeQuery, now);
    const [tasks, sessions, checkDone, peopleMap] = await Promise.all([
        loadPersonTasks(tenantId, employeeId),
        loadPersonSessions(tenantId, employeeId, range, now),
        prisma_client_1.default.taskChecklistItem.count({
            where: { tenantId, doneById: employeeId, done: true, doneAt: (0, peopleService_1.rangeDateFilter)(range) },
        }),
        (0, taskPeople_1.loadPersonRefs)([employeeId]),
    ]);
    const workByTask = new Map();
    const activeDays = new Set();
    for (const session of sessions) {
        const work = workByTask.get(session.taskId);
        if (work) {
            work.ms += session.ms;
            work.sessions += 1;
            if (session.startedAt < work.first)
                work.first = session.startedAt;
            if (session.end > work.last)
                work.last = session.end;
        }
        else {
            workByTask.set(session.taskId, { ms: session.ms, sessions: 1, first: session.startedAt, last: session.end });
        }
        // Eine laufende Messung von vor dem Zeitraum macht dessen ersten Tag aktiv, keinen früheren.
        const day = range.from && session.startedAt < range.from ? range.from : session.startedAt;
        activeDays.add((0, taskTime_1.startOfLocalDay)(day).getTime());
    }
    const perTask = [];
    for (const task of tasks) {
        const work = workByTask.get(task.id);
        if (!work || work.ms <= 0)
            continue;
        perTask.push({
            taskId: task.id,
            title: task.title,
            status: task.status,
            effectiveStatus: (0, taskAccess_1.effectiveTaskStatus)({ status: task.status, startAt: task.startAt, hasSessions: task.hasSessions }, now),
            ms: work.ms,
            sessions: work.sessions,
            first: work.first,
            last: work.last,
            checkDone: task.myCheckDone,
            progress: { done: task.checkDone, total: task.checkTotal },
        });
    }
    perTask.sort((a, b) => b.ms - a.ms);
    const assigned = tasks.filter((task) => task.isAssignee);
    return {
        range,
        generatedAt: now,
        employee: peopleMap[employeeId] ?? unknownPerson(employeeId),
        totalMs: perTask.reduce((sum, entry) => sum + entry.ms, 0),
        sessions: perTask.reduce((sum, entry) => sum + entry.sessions, 0),
        activeDays: activeDays.size,
        assignedCount: assigned.length,
        openCount: assigned.filter((task) => (0, taskConstants_1.isOpenTaskStatus)(task.status)).length,
        completedCount: assigned.filter((task) => task.status === 'COMPLETED' && (0, peopleService_1.isWithinRange)(task.completedAt, range)).length,
        overdueCount: assigned.filter((task) => (0, taskAccess_1.isTaskOverdue)(task, now)).length,
        checkDone,
        perTask,
        peopleMap,
    };
};
/** «Raporum»: der eigene Bericht — auch für Teammitglieder mit ihren eigenen Zeiten (Görevly). */
const getMyReport = (actor, rangeQuery) => loadUserReport(actor.tenantId, actor.employeeId, rangeQuery);
exports.getMyReport = getMyReport;
const getPersonReport = async (actor, employeeId, rangeQuery) => {
    if (employeeId !== actor.employeeId) {
        if (!actor.seesAll) {
            throw (0, taskErrors_1.taskForbidden)('REPORT_FORBIDDEN', 'Teammitglieder sehen nur ihren eigenen Bericht.');
        }
        await assertReportablePerson(actor.tenantId, employeeId);
    }
    return loadUserReport(actor.tenantId, employeeId, rangeQuery);
};
exports.getPersonReport = getPersonReport;
const getTaskReport = async (actor, taskId) => {
    (0, taskActor_1.assertManager)(actor);
    const now = new Date();
    const where = { tenantId: actor.tenantId, taskId };
    // Alle Teile sind firmengefiltert — sie laufen darum schon neben der Prüfung, ob es die Aufgabe gibt.
    const [{ core }, sessionRows, checklists, commentCounts] = await Promise.all([
        (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId),
        prisma_client_1.default.taskTimeSession.findMany({
            where,
            select: { employeeId: true, startedAt: true, endedAt: true, durationMs: true },
            orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        }),
        (0, taskParts_1.loadTaskChecklists)(prisma_client_1.default, actor.tenantId, taskId),
        prisma_client_1.default.taskComment.groupBy({ by: ['authorId'], where, _count: { _all: true } }),
    ]);
    const sessions = sessionRows.map((row) => {
        const live = row.endedAt === null;
        return {
            employeeId: row.employeeId,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            durationMs: live ? (0, taskTime_1.liveDurationMs)(row.startedAt, now) : row.durationMs ?? 0,
            live,
        };
    });
    const running = sessions
        .filter((session) => session.live)
        .map((session) => ({ employeeId: session.employeeId, startedAt: session.startedAt }));
    const checklistItems = checklists.flatMap((checklist) => checklist.items.map((item) => ({ checklist, item })));
    const items = checklistItems.map(({ checklist, item }) => ({
        checklistTitle: checklist.title,
        text: item.text,
        done: item.done,
        doneById: item.doneById,
        doneAt: item.doneAt,
    }));
    const progress = { done: items.filter((item) => item.done).length, total: items.length };
    // Görevly: Verantwortliche und die Anlegende, auch wenn sie nichts beigetragen haben.
    const msByPerson = new Map();
    for (const session of sessions) {
        msByPerson.set(session.employeeId, (msByPerson.get(session.employeeId) ?? 0) + session.durationMs);
    }
    const commentsByPerson = new Map(commentCounts.map((row) => [row.authorId, row._count._all]));
    const contribution = [...new Set([...core.assigneeIds, core.createdById])]
        .map((employeeId) => ({
        employeeId,
        ms: msByPerson.get(employeeId) ?? 0,
        done: checklistItems.filter(({ item }) => item.done && item.doneById === employeeId).length,
        created: checklistItems.filter(({ item }) => item.createdById === employeeId).length,
        comments: commentsByPerson.get(employeeId) ?? 0,
    }))
        .sort((a, b) => b.ms - a.ms);
    const peopleMap = await (0, taskPeople_1.loadPersonRefs)([
        ...(0, taskRows_1.taskPeopleIds)(core, running),
        ...sessions.map((session) => session.employeeId),
        ...items.map((item) => item.doneById),
    ]);
    return {
        generatedAt: now,
        task: (0, taskRows_1.toTaskDetailDto)(core, actor, running, now),
        totalMs: sessions.reduce((sum, session) => sum + session.durationMs, 0),
        progress,
        forecast: (0, taskForecast_1.computeTaskForecast)({
            status: core.status,
            completedAt: core.completedAt,
            dueAt: core.dueAt,
            checkTotal: progress.total,
            checkDone: progress.done,
            sessions: sessions.map((session) => ({ startedAt: session.startedAt, ms: session.durationMs })),
            now,
        }),
        contribution,
        items,
        sessions,
        peopleMap,
    };
};
exports.getTaskReport = getTaskReport;
//# sourceMappingURL=reportService.js.map