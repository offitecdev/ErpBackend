import { Prisma } from '@prisma/client';

import prisma from '../../../infrastructure/database/prisma.client';
import { assertManager, type TasksActor } from './taskActor';
import { CLOSED_TASK_STATUSES } from './taskConstants';
import { getTasksPeople, personDisplayName, type TasksPerson } from './taskPeople';
import { rawDate, rawNumber } from './taskRows';
import { liveDurationMs, resolveReportRange, type ReportRange } from './taskTime';

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
 *   activeTask  woran sie gerade misst — nur Aufgaben DIESER Firma
 * `loadPersonStatsFacts` holt die Zahlen mit vier parallelen Abfragen,
 * `buildPersonStats` rechnet daraus ohne Datenbank; der Teambericht
 * (reportService) nimmt beide unverändert.
 */

/* ── Zeitraum eines Berichts (auch für reportService) ───────────────────── */

/** Prisma-Filter «Zeitpunkt liegt im Zeitraum»; ohne Anfang = seit Anbeginn. */
export const rangeDateFilter = (range: ReportRange): { gte?: Date; lte: Date } =>
    range.from ? { gte: range.from, lte: range.to } : { lte: range.to };

export const isWithinRange = (date: Date | null, range: ReportRange): boolean =>
    date !== null
    && date.getTime() <= range.to.getTime()
    && (!range.from || date.getTime() >= range.from.getTime());

/**
 * Gehört eine Messung zum Zeitraum? Eine abgeschlossene, wenn sie darin
 * BEGANN (Görevly). Die laufende zählt Görevly immer mit, weil dort jeder
 * Zeitraum heute endet — hier, sobald sie vor dem Ende des Zeitraums begann:
 * ein eigener Zeitraum (`from`/`to`) kann in der Vergangenheit enden.
 */
export const sessionCountsInRange = (session: { startedAt: Date; live: boolean }, range: ReportRange): boolean =>
    session.live ? session.startedAt.getTime() <= range.to.getTime() : isWithinRange(session.startedAt, range);

/* ── Verzeichnis ─────────────────────────────────────────────────────────── */

export interface DirectoryPersonDto {
    id: string;
    firstName: string;
    lastName: string;
    name: string;
    title: string | null;
    roleName: string | null;
    isManager: boolean;
}

const compareByName = (a: TasksPerson, b: TasksPerson): number =>
    a.firstName.localeCompare(b.firstName, 'de', { sensitivity: 'base' })
    || a.lastName.localeCompare(b.lastName, 'de', { sensitivity: 'base' })
    || a.id.localeCompare(b.id);

export const listTasksDirectory = async (actor: TasksActor): Promise<DirectoryPersonDto[]> =>
    [...(await getTasksPeople(actor.tenantId)).values()].sort(compareByName).map((person) => ({
        id: person.id,
        firstName: person.firstName,
        lastName: person.lastName,
        name: personDisplayName(person),
        title: person.title,
        roleName: person.roleName,
        isManager: person.isManager,
    }));

/* ── Kennzahlen je Person ────────────────────────────────────────────────── */

export interface PersonStatsDto {
    employeeId: string;
    name: string;
    title: string | null;
    roleName: string | null;
    isManager: boolean;
    openCount: number;
    completedCount: number;
    overdueCount: number;
    ms: number;
    checkDone: number;
    activeTask: { taskId: string; title: string; startedAt: Date } | null;
}

export interface RunningTaskSession {
    employeeId: string;
    taskId: string;
    title: string;
    startedAt: Date;
}

export interface PersonStatsFacts {
    taskCounts: Map<string, { openCount: number; completedCount: number; overdueCount: number }>;
    /** Abgeschlossene Messungen mit Beginn im Zeitraum, je Person. */
    closedMsInRange: Map<string, number>;
    checkDoneInRange: Map<string, number>;
    /** Laufende Messungen an Aufgaben der Firma — je Person höchstens eine. */
    running: RunningTaskSession[];
}

const OPEN_TASK_SQL = Prisma.sql`t.status NOT IN (${Prisma.join([...CLOSED_TASK_STATUSES])})`;

export const loadPersonStatsFacts = async (tenantId: string, range: ReportRange, now: Date): Promise<PersonStatsFacts> => {
    const [countRows, closedRows, checkRows, runningRows] = await Promise.all([
        prisma.$queryRaw<Array<{ employeeId: string; openCount: unknown; completedCount: unknown; overdueCount: unknown }>>(Prisma.sql`
            SELECT a.employeeId,
                   SUM(CASE WHEN ${OPEN_TASK_SQL} THEN 1 ELSE 0 END) AS openCount,
                   SUM(CASE WHEN t.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completedCount,
                   SUM(CASE WHEN ${OPEN_TASK_SQL} AND t.dueAt < ${now} THEN 1 ELSE 0 END) AS overdueCount
            FROM TaskAssignee a
            JOIN Task t ON t.id = a.taskId AND t.tenantId = a.tenantId
            WHERE a.tenantId = ${tenantId}
            GROUP BY a.employeeId
        `),
        prisma.taskTimeSession.groupBy({
            by: ['employeeId'],
            where: { tenantId, endedAt: { not: null }, startedAt: rangeDateFilter(range) },
            _sum: { durationMs: true },
        }),
        prisma.taskChecklistItem.groupBy({
            by: ['doneById'],
            where: { tenantId, done: true, doneById: { not: null }, doneAt: rangeDateFilter(range) },
            _count: { _all: true },
        }),
        // runningKey ist nur während der Messung gesetzt — der eindeutige Index hält die Suche klein.
        prisma.$queryRaw<Array<{ employeeId: string; taskId: string; title: string | null; startedAt: unknown }>>(Prisma.sql`
            SELECT s.employeeId, s.taskId, s.startedAt, t.title
            FROM TaskTimeSession s
            JOIN Task t ON t.id = s.taskId
            WHERE s.runningKey IS NOT NULL AND s.endedAt IS NULL AND s.tenantId = ${tenantId}
        `),
    ]);

    const checkDoneInRange = new Map<string, number>();
    for (const row of checkRows) {
        if (row.doneById) checkDoneInRange.set(row.doneById, row._count._all);
    }
    const running: RunningTaskSession[] = [];
    for (const row of runningRows) {
        const startedAt = rawDate(row.startedAt);
        if (startedAt) running.push({ employeeId: row.employeeId, taskId: row.taskId, title: row.title ?? '', startedAt });
    }
    return {
        taskCounts: new Map(countRows.map((row) => [row.employeeId, {
            openCount: rawNumber(row.openCount),
            completedCount: rawNumber(row.completedCount),
            overdueCount: rawNumber(row.overdueCount),
        }])),
        closedMsInRange: new Map(closedRows.map((row) => [row.employeeId, row._sum.durationMs ?? 0])),
        checkDoneInRange,
        running,
    };
};

/** Die Zeilen je Person, nach Namen — rein gerechnet, ohne Datenbank. */
export const buildPersonStats = (
    people: Iterable<TasksPerson>,
    facts: PersonStatsFacts,
    range: ReportRange,
    now: Date,
): PersonStatsDto[] => {
    const runningByPerson = new Map(facts.running.map((session) => [session.employeeId, session]));
    return [...people].sort(compareByName).map((person) => {
        const counts = facts.taskCounts.get(person.id);
        const live = runningByPerson.get(person.id) ?? null;
        const liveMs = live && sessionCountsInRange({ startedAt: live.startedAt, live: true }, range)
            ? liveDurationMs(live.startedAt, now)
            : 0;
        return {
            employeeId: person.id,
            name: personDisplayName(person),
            title: person.title,
            roleName: person.roleName,
            isManager: person.isManager,
            openCount: counts?.openCount ?? 0,
            completedCount: counts?.completedCount ?? 0,
            overdueCount: counts?.overdueCount ?? 0,
            ms: (facts.closedMsInRange.get(person.id) ?? 0) + liveMs,
            checkDone: facts.checkDoneInRange.get(person.id) ?? 0,
            activeTask: live ? { taskId: live.taskId, title: live.title, startedAt: live.startedAt } : null,
        };
    });
};

export const getPeopleStats = async (
    actor: TasksActor,
    rangeQuery: Record<string, unknown>,
): Promise<{ data: PersonStatsDto[]; range: ReportRange; serverNow: Date }> => {
    assertManager(actor);
    const now = new Date();
    const range = resolveReportRange(rangeQuery, now);
    const [people, facts] = await Promise.all([
        getTasksPeople(actor.tenantId),
        loadPersonStatsFacts(actor.tenantId, range, now),
    ]);
    // Nicht-Admins sehen in «Kişiler» nur sich selbst.
    const visible = actor.seesAll ? [...people.values()] : [...people.values()].filter((person) => person.id === actor.employeeId);
    return { data: buildPersonStats(visible, facts, range, now), range, serverNow: now };
};
