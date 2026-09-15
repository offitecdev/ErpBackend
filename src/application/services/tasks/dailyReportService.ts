import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import type { TasksActor } from './taskActor';
import { taskBadRequest, taskForbidden } from './taskErrors';
import { rawDate, rawJson, rawNumber } from './taskRows';

const HOUR_MS = 3_600_000;

/**
 * ── GÜN SONU RAPORU (14.09.2026, Vorgabe Samet) ─────────────────────────────
 *
 * «Hafta içi her gün 16:00'da bir pop-up çıkacak … madde madde birer cümle ile
 * neler yaptığınızı yazın. En altta hangi görevde kaç saat kaç dk yer aldığı
 * yazacak; bu rapor olarak kaydedilecek, günlük rapor oluşacak, haftalık
 * raporda bunların toplamı olacak.»
 *
 *   GET /tasks/daily-reports/me   heutiger Stand: gespeicherter Rapport (oder
 *                                 null), Aufgabenzeiten des Tages aus den
 *                                 Messungen, und die Woche (welche Tage fertig)
 *   PUT /tasks/daily-reports/me   speichern/überschreiben — die Aufgabenzeiten
 *                                 werden dabei aus den Messungen KOPIERT
 *
 * Tagesgrenzen kennt nur der Browser: er schickt `date` (YYYY-MM-DD) und
 * `from`/`to` (ISO). Jede Person schreibt nur ihren eigenen Rapport; die
 * Leitung liest ihn im Arbeitsrapport (workReportService).
 */

export const DAILY_REPORT_LIMITS = {
    itemsMax: 30,
    itemChars: 500,
} as const;

/** Ein Tag darf mit Zeitumstellung 25 h lang sein — etwas Luft dazu. */
const MAX_DAY_SPAN_MS = 26 * HOUR_MS;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export interface DailyTaskTimeDto {
    taskId: string;
    title: string;
    ms: number;
}

export interface DailyReportDto {
    date: string;
    items: string[];
    taskTimes: DailyTaskTimeDto[];
    totalMs: number;
    submittedAt: Date;
}

export interface MyDailyReportDto {
    date: string;
    report: DailyReportDto | null;
    /** Live aus den Messungen des Tages (Stand jetzt). */
    taskTimes: DailyTaskTimeDto[];
    totalMs: number;
    /** Montag–Sonntag der Woche von `weekStart`: je Tag, ob ein Rapport vorliegt. */
    week: Array<{ date: string; submitted: boolean; totalMs: number; itemCount: number }>;
    serverNow: Date;
}

const dateKeyParts = (value: string): [number, number, number] => {
    const [y = 0, m = 1, d = 1] = value.split('-').map(Number);
    return [y, m, d];
};

export const isDateKey = (value: unknown): value is string => {
    if (typeof value !== 'string' || !DATE_KEY.test(value)) return false;
    const [y, m, d] = dateKeyParts(value);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

const addDays = (dateKey: string, days: number): string => {
    const [y, m, d] = dateKeyParts(dateKey);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const parseDay = (input: { date?: unknown; from?: unknown; to?: unknown }): { date: string; from: Date; to: Date } => {
    if (!isDateKey(input.date)) throw taskBadRequest('DAILY_REPORT_DATE_INVALID', 'Datum ungültig (YYYY-MM-DD).');
    const from = typeof input.from === 'string' ? new Date(input.from) : null;
    const to = typeof input.to === 'string' ? new Date(input.to) : null;
    if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())
        || from >= to || to.getTime() - from.getTime() > MAX_DAY_SPAN_MS) {
        throw taskBadRequest('DAILY_REPORT_RANGE_INVALID', 'Tagesgrenzen ungültig (from/to).');
    }
    return { date: input.date, from, to };
};

/** Zeit je Aufgabe im Tagesfenster — laufende Messungen zählen bis jetzt. */
const loadTaskTimes = async (tenantId: string, employeeId: string, from: Date, to: Date): Promise<DailyTaskTimeDto[]> => {
    const now = new Date();
    const rows = await prisma.$queryRaw<Array<{ taskId: string; title: unknown; startedAt: unknown; endedAt: unknown }>>(Prisma.sql`
        SELECT s.taskId, t.title, s.startedAt, s.endedAt
        FROM TaskTimeSession s
        JOIN Task t ON t.id = s.taskId
        WHERE s.tenantId = ${tenantId} AND s.employeeId = ${employeeId}
          AND s.startedAt <= ${to} AND (s.endedAt IS NULL OR s.endedAt >= ${from})
    `);
    const byTask = new Map<string, DailyTaskTimeDto>();
    for (const row of rows) {
        const startedAt = rawDate(row.startedAt);
        if (!startedAt) continue;
        const end = rawDate(row.endedAt) ?? now;
        const clippedStart = Math.max(startedAt.getTime(), from.getTime());
        const clippedEnd = Math.min(end.getTime(), to.getTime());
        if (clippedEnd <= clippedStart) continue;
        const entry = byTask.get(row.taskId) ?? { taskId: row.taskId, title: String(row.title ?? ''), ms: 0 };
        entry.ms += clippedEnd - clippedStart;
        byTask.set(row.taskId, entry);
    }
    return [...byTask.values()].sort((a, b) => b.ms - a.ms || a.title.localeCompare(b.title));
};

const toItems = (value: unknown): string[] =>
    (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === 'string');

const toTaskTimes = (value: unknown): DailyTaskTimeDto[] =>
    (Array.isArray(value) ? value : []).flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const { taskId, title, ms } = entry as Record<string, unknown>;
        return typeof taskId === 'string' ? [{ taskId, title: String(title ?? ''), ms: rawNumber(ms) }] : [];
    });

/** Gespeicherte Rapporte einer Person zwischen zwei Kalendertagen (beide inklusive). */
export const listDailyReports = async (
    tenantId: string,
    employeeId: string,
    fromDate: string,
    toDate: string,
): Promise<DailyReportDto[]> => {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT reportDate, items, taskTimes, totalMs, submittedAt
        FROM TaskDailyReport
        WHERE tenantId = ${tenantId} AND employeeId = ${employeeId}
          AND reportDate >= ${fromDate} AND reportDate <= ${toDate}
        ORDER BY reportDate ASC
    `);
    return rows.map((row) => ({
        date: String(row.reportDate),
        items: toItems(rawJson(row.items)),
        taskTimes: toTaskTimes(rawJson(row.taskTimes)),
        totalMs: rawNumber(row.totalMs),
        submittedAt: rawDate(row.submittedAt) ?? new Date(0),
    }));
};

export const getMyDailyReport = async (actor: TasksActor, query: Record<string, unknown>): Promise<MyDailyReportDto> => {
    const day = parseDay(query);
    const weekStart = isDateKey(query.weekStart) ? query.weekStart : day.date;
    const weekEnd = addDays(weekStart, 6);
    const rangeFrom = day.date < weekStart ? day.date : weekStart;
    const rangeTo = day.date > weekEnd ? day.date : weekEnd;

    const [reports, taskTimes] = await Promise.all([
        listDailyReports(actor.tenantId, actor.employeeId, rangeFrom, rangeTo),
        loadTaskTimes(actor.tenantId, actor.employeeId, day.from, day.to),
    ]);
    const byDate = new Map(reports.map((report) => [report.date, report]));
    return {
        date: day.date,
        report: byDate.get(day.date) ?? null,
        taskTimes,
        totalMs: taskTimes.reduce((sum, entry) => sum + entry.ms, 0),
        week: Array.from({ length: 7 }, (_, index) => {
            const date = addDays(weekStart, index);
            const report = byDate.get(date);
            return { date, submitted: Boolean(report), totalMs: report?.totalMs ?? 0, itemCount: report?.items.length ?? 0 };
        }),
        serverNow: new Date(),
    };
};

/* ── Uhrzeit des Fensters (15.09.2026, Samet: «16'yı modül ayarlarından
   değiştirebilelim») — je Firma, «HH:MM» Browserzeit, Vorgabe 16:00. Lesen
   darf jede Person des Moduls (das Fenster braucht die Zeit), ändern nur die
   Leitung/Administratorrolle. */
export const DEFAULT_DAILY_REPORT_TIME = '16:00';
export const DEFAULT_DAILY_REPORT_END_TIME = '17:00';
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** Wer um 16:59 noch tippt, darf ein paar Minuten nach Fensterschluss speichern. */
const SAVE_GRACE_MINUTES = 10;

export interface DailyReportSettingDto {
    promptTime: string;
    /** Bis wann («HH:MM») der Rapport geschrieben werden kann (15.09.2026). */
    endTime: string;
}

const toMinutes = (value: string): number => {
    const [h = 0, m = 0] = value.split(':').map(Number);
    return h * 60 + m;
};

export const getDailyReportSetting = async (tenantId: string): Promise<DailyReportSettingDto> => {
    const rows = await prisma.$queryRaw<Array<{ promptTime: unknown; endTime: unknown }>>(Prisma.sql`
        SELECT promptTime, endTime FROM TaskDailyReportSetting WHERE tenantId = ${tenantId} LIMIT 1
    `);
    const start = String(rows[0]?.promptTime ?? '');
    const end = String(rows[0]?.endTime ?? '');
    const promptTime = TIME_OF_DAY.test(start) ? start : DEFAULT_DAILY_REPORT_TIME;
    // Altes Ende vor einem später gestellten Beginn: bis Tagesende offen.
    const fallbackEnd = toMinutes(DEFAULT_DAILY_REPORT_END_TIME) > toMinutes(promptTime) ? DEFAULT_DAILY_REPORT_END_TIME : '23:59';
    const endTime = TIME_OF_DAY.test(end) && toMinutes(end) > toMinutes(promptTime) ? end : fallbackEnd;
    return { promptTime, endTime };
};

export const saveDailyReportSetting = async (
    actor: TasksActor,
    input: { promptTime: string; endTime?: string | undefined },
): Promise<DailyReportSettingDto> => {
    // 15.09.2026 (Samet): Einstellungen nur für die Administratorrolle.
    if (!actor.isSystemAdmin) throw taskForbidden('ADMIN_ONLY', 'Das dürfen nur Admins.');
    const promptTime = input.promptTime.trim();
    const endTime = (input.endTime ?? DEFAULT_DAILY_REPORT_END_TIME).trim();
    if (!TIME_OF_DAY.test(promptTime) || !TIME_OF_DAY.test(endTime)) {
        throw taskBadRequest('DAILY_REPORT_TIME_INVALID', 'Uhrzeit ungültig (HH:MM).');
    }
    if (toMinutes(endTime) <= toMinutes(promptTime)) {
        throw taskBadRequest('DAILY_REPORT_WINDOW_INVALID', 'Das Ende muss nach dem Beginn liegen.');
    }
    const now = new Date();
    await prisma.$executeRaw(Prisma.sql`
        INSERT INTO TaskDailyReportSetting (id, tenantId, promptTime, endTime, createdAt, updatedAt)
        VALUES (${nanoid(16)}, ${actor.tenantId}, ${promptTime}, ${endTime}, ${now}, ${now})
        ON DUPLICATE KEY UPDATE promptTime = ${promptTime}, endTime = ${endTime}, updatedAt = ${now}
    `);
    return { promptTime, endTime };
};

/* Geschrieben wird nur im Fenster (Browserzeit): `from` ist die Mitternacht des
   Browsers, also sind (jetzt − from) die lokalen Minuten des Tages. */
const assertInReportWindow = async (tenantId: string, day: { from: Date; to: Date }): Promise<void> => {
    const setting = await getDailyReportSetting(tenantId);
    const now = Date.now();
    const localMinutes = (now - day.from.getTime()) / 60_000;
    if (now >= day.to.getTime()
        || localMinutes < toMinutes(setting.promptTime)
        || localMinutes > toMinutes(setting.endTime) + SAVE_GRACE_MINUTES) {
        throw taskBadRequest('DAILY_REPORT_WINDOW_CLOSED', 'Der Rapport kann nur im Zeitfenster geschrieben werden.', {
            promptTime: setting.promptTime,
            endTime: setting.endTime,
        });
    }
};

export const saveMyDailyReport = async (
    actor: TasksActor,
    input: { date: string; from: string; to: string; items: string[] },
): Promise<DailyReportDto> => {
    const day = parseDay(input);
    const items = input.items.map((item) => item.trim()).filter(Boolean);
    if (!items.length) throw taskBadRequest('DAILY_REPORT_EMPTY', 'Mindestens ein Punkt.');
    await assertInReportWindow(actor.tenantId, day);

    const taskTimes = await loadTaskTimes(actor.tenantId, actor.employeeId, day.from, day.to);
    const totalMs = taskTimes.reduce((sum, entry) => sum + entry.ms, 0);
    const now = new Date();
    const itemsJson = JSON.stringify(items);
    const timesJson = JSON.stringify(taskTimes);
    // EINE Anweisung: zwei gleichzeitige Speicherungen treffen sich am eindeutigen Schlüssel.
    await prisma.$executeRaw(Prisma.sql`
        INSERT INTO TaskDailyReport (id, tenantId, employeeId, reportDate, items, taskTimes, totalMs, submittedAt, createdAt, updatedAt)
        VALUES (${nanoid(16)}, ${actor.tenantId}, ${actor.employeeId}, ${day.date}, ${itemsJson}, ${timesJson}, ${totalMs}, ${now}, ${now}, ${now})
        ON DUPLICATE KEY UPDATE items = ${itemsJson}, taskTimes = ${timesJson}, totalMs = ${totalMs}, submittedAt = ${now}, updatedAt = ${now}
    `);
    return { date: day.date, items, taskTimes, totalMs, submittedAt: now };
};
