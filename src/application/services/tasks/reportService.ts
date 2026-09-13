import { Prisma } from '@prisma/client';

import prisma from '../../../infrastructure/database/prisma.client';
import {
    buildPersonStats,
    isWithinRange,
    loadPersonStatsFacts,
    rangeDateFilter,
    sessionCountsInRange,
    type PersonStatsDto,
} from './peopleService';
import { effectiveTaskStatus, isTaskOverdue } from './taskAccess';
import { assertManager, assertSeesAll, type TasksActor } from './taskActor';
import { isOpenTaskStatus } from './taskConstants';
import { taskForbidden, taskNotFound } from './taskErrors';
import { computeTaskForecast, type TaskForecast } from './taskForecast';
import { loadTaskChecklists } from './taskParts';
import { getTasksPeople, loadPersonRefs, type PersonRef } from './taskPeople';
import {
    fetchTaskCores,
    rawBool,
    rawDate,
    rawNumber,
    rawString,
    requireVisibleTask,
    taskPeopleIds,
    toTaskDetailDto,
    type RunningSessionRef,
    type TaskDetailDto,
} from './taskRows';
import { liveDurationMs, resolveReportRange, startOfLocalDay, type ReportRange } from './taskTime';

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

const unknownPerson = (id: string): PersonRef => ({ id, firstName: '', lastName: '', name: '', title: null, active: false });

/* ── Teambericht («Ekip özeti») ─────────────────────────────────────────── */

export interface TeamTaskRowDto {
    id: string;
    title: string;
    status: string;
    effectiveStatus: string;
    assigneeIds: string[];
    dueAt: Date | null;
    /** Seit Anbeginn, laufende Messungen bis jetzt. */
    totalMs: number;
    checklist: { done: number; total: number };
}

export interface TeamReportDto {
    range: ReportRange;
    generatedAt: Date;
    /** Summen über die Personenzeilen (Görevly `teamDoc`). */
    totals: { people: number; ms: number; openCount: number; completedCount: number; overdueCount: number };
    people: PersonStatsDto[];
    tasks: TeamTaskRowDto[];
    peopleMap: Record<string, PersonRef>;
}

export const getTeamReport = async (actor: TasksActor, rangeQuery: Record<string, unknown>): Promise<TeamReportDto> => {
    assertSeesAll(actor);
    const now = new Date();
    const range = resolveReportRange(rangeQuery, now);
    const [staff, facts, cores] = await Promise.all([
        getTasksPeople(actor.tenantId),
        loadPersonStatsFacts(actor.tenantId, range, now),
        fetchTaskCores(prisma, {
            where: Prisma.sql`t.tenantId = ${actor.tenantId}`,
            orderBy: Prisma.sql`t.dueAt IS NULL, t.dueAt ASC, t.createdAt DESC, t.id ASC`,
        }),
    ]);
    const people = buildPersonStats(staff.values(), facts, range, now);

    // Die laufenden Messungen der Firma liegen schon in den Kennzahlen.
    const liveMsByTask = new Map<string, number>();
    for (const session of facts.running) {
        liveMsByTask.set(session.taskId, (liveMsByTask.get(session.taskId) ?? 0) + liveDurationMs(session.startedAt, now));
    }
    const tasks = cores.map((core): TeamTaskRowDto => ({
        id: core.id,
        title: core.title,
        status: core.status,
        effectiveStatus: effectiveTaskStatus({ status: core.status, startAt: core.startAt, hasSessions: core.sessionCount > 0 }, now),
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

    const peopleMap = await loadPersonRefs([
        ...people.map((person) => person.employeeId),
        ...tasks.flatMap((task) => task.assigneeIds),
    ]);
    return { range, generatedAt: now, totals, people, tasks, peopleMap };
};

/* ── Personenbericht («Kişi raporu» / «Raporum») ────────────────────────── */

export interface PerTaskWorkDto {
    taskId: string;
    title: string;
    status: string;
    effectiveStatus: string;
    ms: number;
    sessions: number;
    first: Date;
    last: Date;
    /** Punkte dieser Aufgabe, die die Person je abgehakt hat. */
    checkDone: number;
    progress: { done: number; total: number };
}

export interface WastedTaskDto {
    taskId: string;
    title: string;
    ms: number;
    /** Begründung der Ablehnung. */
    note: string | null;
}

export interface UserReportDto {
    range: ReportRange;
    generatedAt: Date;
    employee: PersonRef;
    totalMs: number;
    sessions: number;
    activeDays: number;
    assignedCount: number;
    openCount: number;
    completedCount: number;
    overdueCount: number;
    checkDone: number;
    wastedMs: number;
    perTask: PerTaskWorkDto[];
    wastedTasks: WastedTaskDto[];
    peopleMap: Record<string, PersonRef>;
}

interface PersonTask {
    id: string;
    title: string;
    status: string;
    startAt: Date | null;
    dueAt: Date | null;
    completedAt: Date | null;
    reviewState: string;
    reviewNote: string | null;
    isAssignee: boolean;
    hasSessions: boolean;
    checkTotal: number;
    checkDone: number;
    /** Punkte, die die Person abgehakt hat — seit Anbeginn. */
    myCheckDone: number;
    /** Abgeschlossene Messungen der Person — seit Anbeginn. */
    myClosedMs: number;
}

/**
 * Jede Aufgabe, bei der die Person verantwortlich ist ODER je gemessen hat
 * (Görevly geht alle Aufgaben durch — hier nur die, die sie betreffen).
 * Neueste zuerst wie Görevlys Speicher; die Liste «Kayıp süre» behält das.
 */
const loadPersonTasks = async (tenantId: string, employeeId: string): Promise<PersonTask[]> => {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
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
        startAt: rawDate(row.startAt),
        dueAt: rawDate(row.dueAt),
        completedAt: rawDate(row.completedAt),
        reviewState: String(row.reviewState ?? 'APPROVED'),
        reviewNote: rawString(row.reviewNote),
        isAssignee: rawBool(row.isAssignee),
        hasSessions: rawBool(row.hasSessions),
        checkTotal: rawNumber(row.checkTotal),
        checkDone: rawNumber(row.checkDone),
        myCheckDone: rawNumber(row.myCheckDone),
        myClosedMs: rawNumber(row.myClosedMs),
    }));
};

interface PersonSession {
    taskId: string;
    startedAt: Date;
    live: boolean;
    /** Ende bzw. jetzt bei der laufenden. */
    end: Date;
    ms: number;
}

/** Die Messungen der Person, die zum Zeitraum gehören — die laufende eingeschlossen. */
const loadPersonSessions = async (
    tenantId: string,
    employeeId: string,
    range: ReportRange,
    now: Date,
): Promise<PersonSession[]> => {
    const rows = await prisma.taskTimeSession.findMany({
        where: { tenantId, employeeId, OR: [{ endedAt: null }, { startedAt: rangeDateFilter(range) }] },
        select: { taskId: true, startedAt: true, endedAt: true, durationMs: true },
    });
    return rows
        .map((row): PersonSession => {
            const live = row.endedAt === null;
            return {
                taskId: row.taskId,
                startedAt: row.startedAt,
                live,
                end: row.endedAt ?? now,
                ms: live ? liveDurationMs(row.startedAt, now) : row.durationMs ?? 0,
            };
        })
        .filter((session) => sessionCountsInRange(session, range));
};

/** Eine Person aus einer anderen Firma bleibt unsichtbar — auch ihr Name (loadPersonRefs filtert nicht). */
const assertReportablePerson = async (tenantId: string, employeeId: string): Promise<void> => {
    if ((await getTasksPeople(tenantId)).has(employeeId)) return;
    // Ehemalige ohne Zugang behalten ihren Bericht, solange sie Spuren in der Firma haben.
    const rows = await prisma.$queryRaw<Array<{ known: unknown }>>(Prisma.sql`
        SELECT (
            EXISTS(SELECT 1 FROM TaskAssignee WHERE tenantId = ${tenantId} AND employeeId = ${employeeId})
            OR EXISTS(SELECT 1 FROM TaskTimeSession WHERE tenantId = ${tenantId} AND employeeId = ${employeeId})
            OR EXISTS(SELECT 1 FROM Task WHERE tenantId = ${tenantId} AND createdById = ${employeeId})
        ) AS known
    `);
    if (!rawBool(rows[0]?.known)) {
        throw taskNotFound('PERSON_NOT_FOUND', 'Diese Person gehört nicht zur ausgewählten Firma.');
    }
};

const loadUserReport = async (
    tenantId: string,
    employeeId: string,
    rangeQuery: Record<string, unknown>,
): Promise<UserReportDto> => {
    const now = new Date();
    const range = resolveReportRange(rangeQuery, now);
    const [tasks, sessions, checkDone, peopleMap] = await Promise.all([
        loadPersonTasks(tenantId, employeeId),
        loadPersonSessions(tenantId, employeeId, range, now),
        prisma.taskChecklistItem.count({
            where: { tenantId, doneById: employeeId, done: true, doneAt: rangeDateFilter(range) },
        }),
        loadPersonRefs([employeeId]),
    ]);

    const workByTask = new Map<string, { ms: number; sessions: number; first: Date; last: Date }>();
    const activeDays = new Set<number>();
    for (const session of sessions) {
        const work = workByTask.get(session.taskId);
        if (work) {
            work.ms += session.ms;
            work.sessions += 1;
            if (session.startedAt < work.first) work.first = session.startedAt;
            if (session.end > work.last) work.last = session.end;
        } else {
            workByTask.set(session.taskId, { ms: session.ms, sessions: 1, first: session.startedAt, last: session.end });
        }
        // Eine laufende Messung von vor dem Zeitraum macht dessen ersten Tag aktiv, keinen früheren.
        const day = range.from && session.startedAt < range.from ? range.from : session.startedAt;
        activeDays.add(startOfLocalDay(day).getTime());
    }

    const perTask: PerTaskWorkDto[] = [];
    for (const task of tasks) {
        const work = workByTask.get(task.id);
        if (!work || work.ms <= 0) continue;
        perTask.push({
            taskId: task.id,
            title: task.title,
            status: task.status,
            effectiveStatus: effectiveTaskStatus({ status: task.status, startAt: task.startAt, hasSessions: task.hasSessions }, now),
            ms: work.ms,
            sessions: work.sessions,
            first: work.first,
            last: work.last,
            checkDone: task.myCheckDone,
            progress: { done: task.checkDone, total: task.checkTotal },
        });
    }
    perTask.sort((a, b) => b.ms - a.ms);

    const wastedTasks = tasks
        .filter((task) => (task.status === 'REJECTED' || task.reviewState === 'REJECTED') && task.myClosedMs > 0)
        .map((task): WastedTaskDto => ({ taskId: task.id, title: task.title, ms: task.myClosedMs, note: task.reviewNote }));
    const assigned = tasks.filter((task) => task.isAssignee);

    return {
        range,
        generatedAt: now,
        employee: peopleMap[employeeId] ?? unknownPerson(employeeId),
        totalMs: perTask.reduce((sum, entry) => sum + entry.ms, 0),
        sessions: perTask.reduce((sum, entry) => sum + entry.sessions, 0),
        activeDays: activeDays.size,
        assignedCount: assigned.length,
        openCount: assigned.filter((task) => isOpenTaskStatus(task.status)).length,
        completedCount: assigned.filter((task) => task.status === 'COMPLETED' && isWithinRange(task.completedAt, range)).length,
        overdueCount: assigned.filter((task) => isTaskOverdue(task, now)).length,
        checkDone,
        wastedMs: wastedTasks.reduce((sum, entry) => sum + entry.ms, 0),
        perTask,
        wastedTasks,
        peopleMap,
    };
};

/** «Raporum»: der eigene Bericht — auch für Teammitglieder mit ihren eigenen Zeiten (Görevly). */
export const getMyReport = (actor: TasksActor, rangeQuery: Record<string, unknown>): Promise<UserReportDto> =>
    loadUserReport(actor.tenantId, actor.employeeId, rangeQuery);

export const getPersonReport = async (
    actor: TasksActor,
    employeeId: string,
    rangeQuery: Record<string, unknown>,
): Promise<UserReportDto> => {
    if (employeeId !== actor.employeeId) {
        if (!actor.seesAll) {
            throw taskForbidden('REPORT_FORBIDDEN', 'Teammitglieder sehen nur ihren eigenen Bericht.');
        }
        await assertReportablePerson(actor.tenantId, employeeId);
    }
    return loadUserReport(actor.tenantId, employeeId, rangeQuery);
};

/* ── Aufgabenbericht («Görev raporu») ───────────────────────────────────── */

export interface TaskContributionDto {
    employeeId: string;
    ms: number;
    /** Abgehakte Checklistenpunkte. */
    done: number;
    /** Angelegte Checklistenpunkte. */
    created: number;
    comments: number;
}

export interface TaskReportItemDto {
    checklistTitle: string;
    text: string;
    done: boolean;
    doneById: string | null;
    doneAt: Date | null;
}

export interface TaskReportSessionDto {
    employeeId: string;
    startedAt: Date;
    /** null = läuft noch. */
    endedAt: Date | null;
    durationMs: number;
    live: boolean;
}

export interface TaskReportDto {
    generatedAt: Date;
    task: TaskDetailDto;
    totalMs: number;
    progress: { done: number; total: number };
    forecast: TaskForecast;
    contribution: TaskContributionDto[];
    items: TaskReportItemDto[];
    sessions: TaskReportSessionDto[];
    peopleMap: Record<string, PersonRef>;
}

export const getTaskReport = async (actor: TasksActor, taskId: string): Promise<TaskReportDto> => {
    assertManager(actor);
    const now = new Date();
    const where = { tenantId: actor.tenantId, taskId };
    // Alle Teile sind firmengefiltert — sie laufen darum schon neben der Prüfung, ob es die Aufgabe gibt.
    const [{ core }, sessionRows, checklists, commentCounts] = await Promise.all([
        requireVisibleTask(prisma, actor, taskId),
        prisma.taskTimeSession.findMany({
            where,
            select: { employeeId: true, startedAt: true, endedAt: true, durationMs: true },
            orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        }),
        loadTaskChecklists(prisma, actor.tenantId, taskId),
        prisma.taskComment.groupBy({ by: ['authorId'], where, _count: { _all: true } }),
    ]);

    const sessions = sessionRows.map((row): TaskReportSessionDto => {
        const live = row.endedAt === null;
        return {
            employeeId: row.employeeId,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            durationMs: live ? liveDurationMs(row.startedAt, now) : row.durationMs ?? 0,
            live,
        };
    });
    const running: RunningSessionRef[] = sessions
        .filter((session) => session.live)
        .map((session) => ({ employeeId: session.employeeId, startedAt: session.startedAt }));

    const checklistItems = checklists.flatMap((checklist) => checklist.items.map((item) => ({ checklist, item })));
    const items = checklistItems.map(({ checklist, item }): TaskReportItemDto => ({
        checklistTitle: checklist.title,
        text: item.text,
        done: item.done,
        doneById: item.doneById,
        doneAt: item.doneAt,
    }));
    const progress = { done: items.filter((item) => item.done).length, total: items.length };

    // Görevly: Verantwortliche und die Anlegende, auch wenn sie nichts beigetragen haben.
    const msByPerson = new Map<string, number>();
    for (const session of sessions) {
        msByPerson.set(session.employeeId, (msByPerson.get(session.employeeId) ?? 0) + session.durationMs);
    }
    const commentsByPerson = new Map(commentCounts.map((row) => [row.authorId, row._count._all]));
    const contribution = [...new Set([...core.assigneeIds, core.createdById])]
        .map((employeeId): TaskContributionDto => ({
            employeeId,
            ms: msByPerson.get(employeeId) ?? 0,
            done: checklistItems.filter(({ item }) => item.done && item.doneById === employeeId).length,
            created: checklistItems.filter(({ item }) => item.createdById === employeeId).length,
            comments: commentsByPerson.get(employeeId) ?? 0,
        }))
        .sort((a, b) => b.ms - a.ms);

    const peopleMap = await loadPersonRefs([
        ...taskPeopleIds(core, running),
        ...sessions.map((session) => session.employeeId),
        ...items.map((item) => item.doneById),
    ]);
    return {
        generatedAt: now,
        task: toTaskDetailDto(core, actor, running, now),
        totalMs: sessions.reduce((sum, session) => sum + session.durationMs, 0),
        progress,
        forecast: computeTaskForecast({
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
