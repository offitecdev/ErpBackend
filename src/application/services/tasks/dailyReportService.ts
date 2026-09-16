import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import type { TasksActor } from './taskActor';
import { taskBadRequest, taskForbidden } from './taskErrors';
import {
    prepareTaskFiles,
    removeStoredFiles,
    storeTaskFiles,
    toAttachmentDto,
    type AttachmentDto,
    type IncomingTaskFile,
} from './taskFiles';
import { rawDate, rawJson, rawNumber, rawString } from './taskRows';

const HOUR_MS = 3_600_000;

/**
 * ── GÜN SONU RAPORU ─────────────────────────────────────────────────────────
 *
 * 16.09.2026 (Samet): «Gün sonu raporları artık madde madde olmayacak — direkt
 * beyaz bir sayfa, orada istediğini yazacak, markdown olacak, görsel
 * ekleyebilecek; görseller ve pdf'ler de eklenti olarak tıklanabilir url olarak
 * yer alacak.» Der Rapport ist also EIN freies Blatt:
 *
 *   body        Markdown-Text des Tages (alte Rapporte: ihre Punkte werden beim
 *               Lesen zu «- …»-Zeilen — die Spalte `items` bleibt unberührt)
 *   files       Bilder/PDF/Dateien des Tages: TaskAttachment mit kind 'DAILY',
 *               ohne Aufgabe, nur `dailyDate` + `uploadedById`. Der Rapport und
 *               das PDF zeigen sie als anklickbare Adresse (`url`/`contentPath`)
 *
 *   GET  /tasks/daily-reports/me    heutiger Stand + die Woche (welche Tage fertig)
 *   PUT  /tasks/daily-reports/me    speichern/überschreiben
 *   POST /tasks/daily-reports/me/files   Datei hochladen (multipart `files`)
 *
 * Tagesgrenzen kennt nur der Browser: er schickt `date` (YYYY-MM-DD) und
 * `from`/`to` (ISO). Jede Person schreibt nur ihren eigenen Rapport; die
 * Leitung liest ihn im Arbeitsrapport (workReportService).
 */

export const DAILY_REPORT_LIMITS = {
    /** Das Blatt: so viele Zeichen Markdown. */
    bodyChars: 20_000,
    filesPerUpload: 10,
    /** So viele Dateien darf ein Tag tragen. */
    filesMax: 40,
    /** Alte Rapporte (vor dem 16.09.2026) hatten Punkte. */
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
    /** Das Blatt in Markdown. */
    body: string;
    /** Bilder, PDF und Dateien des Tages — im Rapport anklickbare Adressen. */
    files: AttachmentDto[];
    taskTimes: DailyTaskTimeDto[];
    totalMs: number;
    submittedAt: Date;
}

export interface MyDailyReportDto {
    date: string;
    report: DailyReportDto | null;
    /** Dateien des Tages, auch wenn der Rapport noch nicht gespeichert ist. */
    files: AttachmentDto[];
    /** Live aus den Messungen des Tages (Stand jetzt). */
    taskTimes: DailyTaskTimeDto[];
    totalMs: number;
    /** Montag–Sonntag der Woche von `weekStart`: je Tag, ob ein Rapport vorliegt. */
    week: Array<{ date: string; submitted: boolean; totalMs: number }>;
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

/** Das Blatt eines Rapports: der Markdown-Text, bei alten Rapporten ihre Punkte. */
const bodyOf = (body: unknown, items: unknown): string => {
    const text = rawString(body) ?? '';
    if (text.trim()) return text;
    return toItems(rawJson(items)).map((item) => item.trim()).filter(Boolean).map((item) => `- ${item}`).join('\n');
};

/* ── Dateien des Tages (kind 'DAILY') ───────────────────────────────────── */

/** Die Dateien einer Person zwischen zwei Kalendertagen, nach Tag geordnet. */
export const listDailyFiles = async (
    tenantId: string,
    employeeId: string,
    fromDate: string,
    toDate: string,
): Promise<Map<string, AttachmentDto[]>> => {
    const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT id, kind, dailyDate, fileName, contentType, sizeBytes, fileRef, uploadedById, createdAt
        FROM TaskAttachment
        WHERE tenantId = ${tenantId} AND kind = 'DAILY' AND uploadedById = ${employeeId}
          AND dailyDate >= ${fromDate} AND dailyDate <= ${toDate}
        ORDER BY createdAt ASC, id ASC
    `);
    const byDate = new Map<string, AttachmentDto[]>();
    for (const row of rows) {
        const date = String(row.dailyDate ?? '');
        const dto = toAttachmentDto({
            id: String(row.id),
            kind: 'DAILY',
            fileName: String(row.fileName ?? ''),
            contentType: String(row.contentType ?? ''),
            sizeBytes: rawNumber(row.sizeBytes),
            uploadedById: rawString(row.uploadedById),
            createdAt: rawDate(row.createdAt) ?? new Date(0),
            fileRef: rawString(row.fileRef),
        });
        byDate.set(date, [...(byDate.get(date) ?? []), dto]);
    }
    return byDate;
};

/** Gespeicherte Rapporte einer Person zwischen zwei Kalendertagen (beide inklusive). */
export const listDailyReports = async (
    tenantId: string,
    employeeId: string,
    fromDate: string,
    toDate: string,
): Promise<DailyReportDto[]> => {
    const [rows, filesByDate] = await Promise.all([
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
            SELECT reportDate, body, items, taskTimes, totalMs, submittedAt
            FROM TaskDailyReport
            WHERE tenantId = ${tenantId} AND employeeId = ${employeeId}
              AND reportDate >= ${fromDate} AND reportDate <= ${toDate}
            ORDER BY reportDate ASC
        `),
        listDailyFiles(tenantId, employeeId, fromDate, toDate),
    ]);
    return rows.map((row) => {
        const date = String(row.reportDate);
        return {
            date,
            body: bodyOf(row.body, rawJson(row.items)),
            files: filesByDate.get(date) ?? [],
            taskTimes: toTaskTimes(rawJson(row.taskTimes)),
            totalMs: rawNumber(row.totalMs),
            submittedAt: rawDate(row.submittedAt) ?? new Date(0),
        };
    });
};

export const getMyDailyReport = async (actor: TasksActor, query: Record<string, unknown>): Promise<MyDailyReportDto> => {
    const day = parseDay(query);
    const weekStart = isDateKey(query.weekStart) ? query.weekStart : day.date;
    const weekEnd = addDays(weekStart, 6);
    const rangeFrom = day.date < weekStart ? day.date : weekStart;
    const rangeTo = day.date > weekEnd ? day.date : weekEnd;

    const [reports, taskTimes, filesByDate] = await Promise.all([
        listDailyReports(actor.tenantId, actor.employeeId, rangeFrom, rangeTo),
        loadTaskTimes(actor.tenantId, actor.employeeId, day.from, day.to),
        listDailyFiles(actor.tenantId, actor.employeeId, day.date, day.date),
    ]);
    const byDate = new Map(reports.map((report) => [report.date, report]));
    return {
        date: day.date,
        report: byDate.get(day.date) ?? null,
        files: filesByDate.get(day.date) ?? [],
        taskTimes,
        totalMs: taskTimes.reduce((sum, entry) => sum + entry.ms, 0),
        week: Array.from({ length: 7 }, (_, index) => {
            const date = addDays(weekStart, index);
            const report = byDate.get(date);
            return { date, submitted: Boolean(report), totalMs: report?.totalMs ?? 0 };
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

/**
 * Bilder/PDF/Dateien für das Blatt eines Tages. Sie hängen an KEINER Aufgabe:
 * kind 'DAILY' + `dailyDate` + `uploadedById`. Gelesen werden sie über
 * `/tasks/attachments/:id/content` (R2-Bilder und -PDF direkt bei Cloudflare).
 */
export const uploadDailyReportFiles = async (
    actor: TasksActor,
    input: { date: string; from: string; to: string },
    files: readonly IncomingTaskFile[],
): Promise<{ data: AttachmentDto[] }> => {
    const day = parseDay(input);
    await assertInReportWindow(actor.tenantId, day);
    const prepared = prepareTaskFiles(files, DAILY_REPORT_LIMITS.filesPerUpload);
    if (!prepared.length) throw taskBadRequest('NO_FILES', 'Es wurde keine Datei übergeben.');

    const counted = await prisma.$queryRaw<Array<{ total: unknown }>>(Prisma.sql`
        SELECT COUNT(*) AS total FROM TaskAttachment
        WHERE tenantId = ${actor.tenantId} AND kind = 'DAILY'
          AND uploadedById = ${actor.employeeId} AND dailyDate = ${day.date}
    `);
    if (rawNumber(counted[0]?.total) + prepared.length > DAILY_REPORT_LIMITS.filesMax) {
        throw taskBadRequest('DAILY_REPORT_FILES_LIMIT', `Höchstens ${DAILY_REPORT_LIMITS.filesMax} Dateien je Tag.`);
    }

    const refs = await storeTaskFiles(actor.tenantId, prepared);
    const createdMs = Date.now();
    const rows = prepared.map((file, index) => ({
        id: nanoid(12),
        kind: 'DAILY' as const,
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        fileRef: refs[index] as string,
        uploadedById: actor.employeeId,
        // Die Liste sortiert nach createdAt: +1 ms je Datei hält die Reihenfolge der Auswahl.
        createdAt: new Date(createdMs + index),
    }));
    try {
        for (const row of rows) {
            await prisma.$executeRaw(Prisma.sql`
                INSERT INTO TaskAttachment (id, tenantId, kind, dailyDate, fileName, contentType, sizeBytes, fileRef, uploadedById, createdAt)
                VALUES (${row.id}, ${actor.tenantId}, 'DAILY', ${day.date}, ${row.fileName}, ${row.contentType},
                        ${row.sizeBytes}, ${row.fileRef}, ${row.uploadedById}, ${row.createdAt})
            `);
        }
    } catch (error) {
        await removeStoredFiles(refs);
        throw error;
    }
    return { data: rows.map(toAttachmentDto) };
};

export const saveMyDailyReport = async (
    actor: TasksActor,
    input: { date: string; from: string; to: string; body: string },
): Promise<DailyReportDto> => {
    const day = parseDay(input);
    const body = input.body.slice(0, DAILY_REPORT_LIMITS.bodyChars).trim();
    await assertInReportWindow(actor.tenantId, day);
    const files = (await listDailyFiles(actor.tenantId, actor.employeeId, day.date, day.date)).get(day.date) ?? [];
    // Ein leeres Blatt ohne Datei ist kein Rapport.
    if (!body && !files.length) throw taskBadRequest('DAILY_REPORT_EMPTY', 'Das Blatt ist leer.');

    const taskTimes = await loadTaskTimes(actor.tenantId, actor.employeeId, day.from, day.to);
    const totalMs = taskTimes.reduce((sum, entry) => sum + entry.ms, 0);
    const now = new Date();
    const timesJson = JSON.stringify(taskTimes);
    // EINE Anweisung: zwei gleichzeitige Speicherungen treffen sich am eindeutigen Schlüssel.
    await prisma.$executeRaw(Prisma.sql`
        INSERT INTO TaskDailyReport (id, tenantId, employeeId, reportDate, body, items, taskTimes, totalMs, submittedAt, createdAt, updatedAt)
        VALUES (${nanoid(16)}, ${actor.tenantId}, ${actor.employeeId}, ${day.date}, ${body}, '[]', ${timesJson}, ${totalMs}, ${now}, ${now}, ${now})
        ON DUPLICATE KEY UPDATE body = ${body}, items = '[]', taskTimes = ${timesJson}, totalMs = ${totalMs}, submittedAt = ${now}, updatedAt = ${now}
    `);
    return { date: day.date, body, files, taskTimes, totalMs, submittedAt: now };
};
