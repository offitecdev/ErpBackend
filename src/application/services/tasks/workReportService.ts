import { Prisma } from '@prisma/client';

import prisma from '../../../infrastructure/database/prisma.client';
import { isDateKey, listDailyReports, type DailyReportDto } from './dailyReportService';
import type { TasksActor } from './taskActor';
import { taskBadRequest, taskForbidden, taskNotFound } from './taskErrors';
import { getTasksPeople, loadPersonRefs, type PersonRef } from './taskPeople';
import { rawBool, rawDate } from './taskRows';
import { DAY_MS } from './taskTime';

/**
 * ── ARBEITSRAPPORT EINER PERSON: TAG ODER WOCHE ─────────────────────────────
 *
 * 16.09.2026 (Samet): «Raporlamada gün gün yazsın; grafik falan, görev bazlı
 * bakış, QR — hepsi kalksın. Sadece gün gün, gün sonunda neler yaptı.» … und
 * am selben Tag: «çalıştığı görevler ve kaç saat çalıştığı da yazsın, gün gün,
 * gün raporunun altında, ince gri kenarlı bir tabloda.»
 * Der Rapport ist damit je Kalendertag: das freie Blatt der Person samt ihren
 * Dateien UND die Zeit, die sie an diesem Tag je Aufgabe gemessen hat.
 * Checklistenpunkte, Kommentare und Termine stehen nicht mehr darin.
 *
 *   sessions  Messungen, die den Zeitraum ÜBERLAPPEN — auf ihn geklemmt, damit
 *             eine Schicht über Mitternacht nicht verschwindet; der Browser
 *             teilt sie auf seine Kalendertage auf (er kennt die Tagesgrenzen)
 *   tasks     die Titel zu diesen Messungen
 *
 * Tagesgrenzen kennt nur der Browser der Leserin: er schickt `from`/`to` (ISO)
 * und `fromDate`/`toDate` (YYYY-MM-DD), die Kalendertage seiner Uhr.
 *
 * Wer: `person` = eine Kennung. Die Leitung wählt jede Person der Firma,
 * ein Teammitglied bekommt immer sich selbst (eine fremde Kennung = 403).
 */

const MAX_RANGE_DAYS = 8;
const MAX_SESSION_ROWS = 400;

export interface WorkReportSessionDto {
    taskId: string;
    startedAt: Date;
    /** null = läuft noch. */
    endedAt: Date | null;
    ms: number;
}

export interface WorkReportDto {
    from: Date;
    to: Date;
    generatedAt: Date;
    employee: PersonRef;
    /** Die Gün sonu raporları des Zeitraums (Kalendertage des Browsers). */
    dailyReports: DailyReportDto[];
    /** Messungen im Zeitraum, auf ihn geklemmt — der Browser gruppiert nach Tagen. */
    sessions: WorkReportSessionDto[];
    /** Titel der Aufgaben, die in `sessions` vorkommen. */
    tasks: Record<string, { id: string; title: string }>;
}

const parseDate = (value: unknown): Date | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const date = new Date(value.trim());
    return Number.isNaN(date.getTime()) ? null : date;
};

/** Wessen Rapport — geprüft gegen die Firma. */
const resolvePerson = async (actor: TasksActor, requested: string): Promise<string> => {
    if (!requested || requested === actor.employeeId) return actor.employeeId;
    if (!actor.seesAll) {
        throw taskForbidden('REPORT_FORBIDDEN', 'Teammitglieder sehen nur ihren eigenen Rapport.');
    }
    if ((await getTasksPeople(actor.tenantId)).has(requested)) return requested;
    // Ehemalige ohne Zugang behalten ihren Rapport, solange sie Spuren in der Firma haben.
    const rows = await prisma.$queryRaw<Array<{ known: unknown }>>(Prisma.sql`
        SELECT (
            EXISTS(SELECT 1 FROM TaskAssignee WHERE tenantId = ${actor.tenantId} AND employeeId = ${requested})
            OR EXISTS(SELECT 1 FROM TaskTimeSession WHERE tenantId = ${actor.tenantId} AND employeeId = ${requested})
        ) AS known
    `);
    if (!rawBool(rows[0]?.known)) {
        throw taskNotFound('PERSON_NOT_FOUND', 'Diese Person gehört nicht zur ausgewählten Firma.');
    }
    return requested;
};

export const getWorkReport = async (actor: TasksActor, query: Record<string, unknown>): Promise<WorkReportDto> => {
    const now = new Date();
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (!from || !to || from.getTime() > to.getTime()) {
        throw taskBadRequest('REPORT_RANGE_INVALID', 'Zeitraum ungültig (from/to).');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        throw taskBadRequest('REPORT_RANGE_TOO_LONG', `Höchstens ${MAX_RANGE_DAYS} Tage.`);
    }

    const employeeId = await resolvePerson(actor, typeof query.person === 'string' ? query.person.trim() : '');
    const fromDate = isDateKey(query.fromDate) ? query.fromDate : null;
    const toDate = isDateKey(query.toDate) ? query.toDate : null;

    const sessionFilter = Prisma.sql`
        s.tenantId = ${actor.tenantId} AND s.employeeId = ${employeeId}
        AND s.startedAt <= ${to} AND (s.endedAt IS NULL OR s.endedAt >= ${from})`;

    const [refs, dailyReports, sessionRows, taskRows] = await Promise.all([
        loadPersonRefs([employeeId]),
        fromDate && toDate && fromDate <= toDate
            ? listDailyReports(actor.tenantId, employeeId, fromDate, toDate)
            : Promise.resolve([] as DailyReportDto[]),
        prisma.$queryRaw<Array<{ taskId: string; startedAt: unknown; endedAt: unknown }>>(Prisma.sql`
            SELECT s.taskId, s.startedAt, s.endedAt
            FROM TaskTimeSession s
            WHERE ${sessionFilter}
            ORDER BY s.startedAt ASC, s.id ASC
            LIMIT ${MAX_SESSION_ROWS}
        `),
        prisma.$queryRaw<Array<{ id: string; title: unknown }>>(Prisma.sql`
            SELECT t.id, t.title FROM Task t
            WHERE t.tenantId = ${actor.tenantId}
              AND t.id IN (SELECT s.taskId FROM TaskTimeSession s WHERE ${sessionFilter})
        `),
    ]);

    const sessions: WorkReportSessionDto[] = [];
    for (const row of sessionRows) {
        const startedAt = rawDate(row.startedAt);
        if (!startedAt) continue;
        const endedAt = rawDate(row.endedAt);
        const naturalEnd = endedAt ?? now;
        const clippedStart = startedAt < from ? from : startedAt;
        const clippedEnd = naturalEnd > to ? to : naturalEnd;
        if (clippedEnd <= clippedStart) continue;
        sessions.push({
            taskId: row.taskId,
            startedAt: clippedStart,
            endedAt: endedAt === null && naturalEnd <= to ? null : clippedEnd,
            ms: clippedEnd.getTime() - clippedStart.getTime(),
        });
    }

    const tasks: Record<string, { id: string; title: string }> = {};
    for (const row of taskRows) tasks[String(row.id)] = { id: String(row.id), title: String(row.title ?? '') };

    return {
        from,
        to,
        generatedAt: now,
        employee: refs[employeeId] ?? { id: employeeId, firstName: '', lastName: '', name: '', title: null, active: false },
        dailyReports,
        sessions,
        tasks,
    };
};
