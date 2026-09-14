"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPeopleStats = exports.buildPersonStats = exports.loadPersonStatsFacts = exports.listTasksDirectory = exports.sessionCountsInRange = exports.isWithinRange = exports.rangeDateFilter = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskActor_1 = require("./taskActor");
const taskConstants_1 = require("./taskConstants");
const taskPeople_1 = require("./taskPeople");
const taskRows_1 = require("./taskRows");
const taskTime_1 = require("./taskTime");
/**
 * ── KİŞİLER: VERZEICHNIS UND KENNZAHLEN JE PERSON ───────────────────────────
 *
 * Verzeichnis: wer im Modul vorkommen kann — Personal der ausgewählten Firma
 * mit Modulzugang. Jede Person mit Zugang darf es lesen; die Auswahllisten
 * (Verantwortliche, Chat-Mitglieder) brauchen es.
 *
 * Kennzahlen (nur Leitung) = Görevly `reports.team`; dieselbe Zeile zeigt der
 * Ekip-Bildschirm und die Tabelle «Kişi bazlı özet» des Teamberichts:
 *   offen · erledigt · überfällig   Aufgaben, bei denen die Person verantwortlich
 *                                   ist — heutiger Stand, ohne Zeitraum
 *   ms          Messungen, die im Zeitraum begannen, plus die laufende
 *   checkDone   Checklistenpunkte, die sie im Zeitraum abgehakt hat
 *   wastedMs    alle je gemessene Zeit an abgelehnten Aufgaben («Kayıp süre»)
 *   activeTask  woran sie gerade misst — nur Aufgaben DIESER Firma
 * `loadPersonStatsFacts` holt die Zahlen mit fünf parallelen Abfragen,
 * `buildPersonStats` rechnet daraus ohne Datenbank; der Teambericht
 * (reportService) nimmt beide unverändert.
 */
/* ── Zeitraum eines Berichts (auch für reportService) ───────────────────── */
/** Prisma-Filter «Zeitpunkt liegt im Zeitraum»; ohne Anfang = seit Anbeginn. */
const rangeDateFilter = (range) => range.from ? { gte: range.from, lte: range.to } : { lte: range.to };
exports.rangeDateFilter = rangeDateFilter;
const isWithinRange = (date, range) => date !== null
    && date.getTime() <= range.to.getTime()
    && (!range.from || date.getTime() >= range.from.getTime());
exports.isWithinRange = isWithinRange;
/**
 * Gehört eine Messung zum Zeitraum? Eine abgeschlossene, wenn sie darin
 * BEGANN (Görevly). Die laufende zählt Görevly immer mit, weil dort jeder
 * Zeitraum heute endet — hier, sobald sie vor dem Ende des Zeitraums begann:
 * ein eigener Zeitraum (`from`/`to`) kann in der Vergangenheit enden.
 */
const sessionCountsInRange = (session, range) => session.live ? session.startedAt.getTime() <= range.to.getTime() : (0, exports.isWithinRange)(session.startedAt, range);
exports.sessionCountsInRange = sessionCountsInRange;
const compareByName = (a, b) => a.firstName.localeCompare(b.firstName, 'de', { sensitivity: 'base' })
    || a.lastName.localeCompare(b.lastName, 'de', { sensitivity: 'base' })
    || a.id.localeCompare(b.id);
const listTasksDirectory = async (actor) => [...(await (0, taskPeople_1.getTasksPeople)(actor.tenantId)).values()].sort(compareByName).map((person) => ({
    id: person.id,
    firstName: person.firstName,
    lastName: person.lastName,
    name: (0, taskPeople_1.personDisplayName)(person),
    title: person.title,
    roleName: person.roleName,
    isManager: person.isManager,
}));
exports.listTasksDirectory = listTasksDirectory;
const OPEN_TASK_SQL = client_1.Prisma.sql `t.status NOT IN (${client_1.Prisma.join([...taskConstants_1.CLOSED_TASK_STATUSES])})`;
const loadPersonStatsFacts = async (tenantId, range, now) => {
    const [countRows, closedRows, checkRows, wastedRows, runningRows] = await Promise.all([
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT a.employeeId,
                   SUM(CASE WHEN ${OPEN_TASK_SQL} THEN 1 ELSE 0 END) AS openCount,
                   SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completedCount,
                   SUM(CASE WHEN ${OPEN_TASK_SQL} AND t.dueAt < ${now} THEN 1 ELSE 0 END) AS overdueCount
            FROM TaskAssignee a
            JOIN Task t ON t.id = a.taskId AND t.tenantId = a.tenantId
            WHERE a.tenantId = ${tenantId}
            GROUP BY a.employeeId
        `),
        prisma_client_1.default.taskTimeSession.groupBy({
            by: ['employeeId'],
            where: { tenantId, endedAt: { not: null }, startedAt: (0, exports.rangeDateFilter)(range) },
            _sum: { durationMs: true },
        }),
        prisma_client_1.default.taskChecklistItem.groupBy({
            by: ['doneById'],
            where: { tenantId, done: true, doneById: { not: null }, doneAt: (0, exports.rangeDateFilter)(range) },
            _count: { _all: true },
        }),
        // Görevly zählt hier nur abgeschlossene Messungen; laufende kann es an
        // abgelehnten Aufgaben nicht geben (die Ablehnung beendet sie).
        prisma_client_1.default.taskTimeSession.groupBy({
            by: ['employeeId'],
            where: {
                tenantId,
                endedAt: { not: null },
                task: { OR: [{ status: 'REJECTED' }, { reviewState: 'REJECTED' }] },
            },
            _sum: { durationMs: true },
        }),
        // runningKey ist nur während der Messung gesetzt — der eindeutige Index hält die Suche klein.
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT s.employeeId, s.taskId, s.startedAt, t.title
            FROM TaskTimeSession s
            JOIN Task t ON t.id = s.taskId
            WHERE s.runningKey IS NOT NULL AND s.endedAt IS NULL AND s.tenantId = ${tenantId}
        `),
    ]);
    const checkDoneInRange = new Map();
    for (const row of checkRows) {
        if (row.doneById)
            checkDoneInRange.set(row.doneById, row._count._all);
    }
    const running = [];
    for (const row of runningRows) {
        const startedAt = (0, taskRows_1.rawDate)(row.startedAt);
        if (startedAt)
            running.push({ employeeId: row.employeeId, taskId: row.taskId, title: row.title ?? '', startedAt });
    }
    return {
        taskCounts: new Map(countRows.map((row) => [row.employeeId, {
                openCount: (0, taskRows_1.rawNumber)(row.openCount),
                completedCount: (0, taskRows_1.rawNumber)(row.completedCount),
                overdueCount: (0, taskRows_1.rawNumber)(row.overdueCount),
            }])),
        closedMsInRange: new Map(closedRows.map((row) => [row.employeeId, row._sum.durationMs ?? 0])),
        checkDoneInRange,
        wastedMs: new Map(wastedRows.map((row) => [row.employeeId, row._sum.durationMs ?? 0])),
        running,
    };
};
exports.loadPersonStatsFacts = loadPersonStatsFacts;
/** Die Zeilen je Person, nach Namen — rein gerechnet, ohne Datenbank. */
const buildPersonStats = (people, facts, range, now) => {
    const runningByPerson = new Map(facts.running.map((session) => [session.employeeId, session]));
    return [...people].sort(compareByName).map((person) => {
        const counts = facts.taskCounts.get(person.id);
        const live = runningByPerson.get(person.id) ?? null;
        const liveMs = live && (0, exports.sessionCountsInRange)({ startedAt: live.startedAt, live: true }, range)
            ? (0, taskTime_1.liveDurationMs)(live.startedAt, now)
            : 0;
        return {
            employeeId: person.id,
            name: (0, taskPeople_1.personDisplayName)(person),
            title: person.title,
            roleName: person.roleName,
            isManager: person.isManager,
            openCount: counts?.openCount ?? 0,
            completedCount: counts?.completedCount ?? 0,
            overdueCount: counts?.overdueCount ?? 0,
            ms: (facts.closedMsInRange.get(person.id) ?? 0) + liveMs,
            checkDone: facts.checkDoneInRange.get(person.id) ?? 0,
            wastedMs: facts.wastedMs.get(person.id) ?? 0,
            activeTask: live ? { taskId: live.taskId, title: live.title, startedAt: live.startedAt } : null,
        };
    });
};
exports.buildPersonStats = buildPersonStats;
const getPeopleStats = async (actor, rangeQuery) => {
    (0, taskActor_1.assertManager)(actor);
    const now = new Date();
    const range = (0, taskTime_1.resolveReportRange)(rangeQuery, now);
    const [people, facts] = await Promise.all([
        (0, taskPeople_1.getTasksPeople)(actor.tenantId),
        (0, exports.loadPersonStatsFacts)(actor.tenantId, range, now),
    ]);
    // Nicht-Admins sehen in «Kişiler» nur sich selbst.
    const visible = actor.seesAll ? [...people.values()] : [...people.values()].filter((person) => person.id === actor.employeeId);
    return { data: (0, exports.buildPersonStats)(visible, facts, range, now), range, serverNow: now };
};
exports.getPeopleStats = getPeopleStats;
//# sourceMappingURL=peopleService.js.map