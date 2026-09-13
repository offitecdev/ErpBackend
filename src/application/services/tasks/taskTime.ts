import { TASK_LIMITS } from './taskConstants';

/**
 * Zeit-Hilfen des Görevler-Moduls. «Heute», «Tagesanfang» und «Tagesende»
 * sind — wie überall im Terminwesen des Hauses — Tage der SERVER-Uhr.
 * Berichte nehmen darum bevorzugt `from`/`to` aus dem Browser entgegen, der
 * die Tagesgrenzen der Leserin kennt; der Zeitraumschlüssel ist nur Rückfall.
 */

export const DAY_MS = 86_400_000;

export const startOfLocalDay = (date: Date): Date => {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    return day;
};

export const endOfLocalDay = (date: Date): Date => {
    const day = new Date(date);
    day.setHours(23, 59, 59, 999);
    return day;
};

/** Dauer einer Messung in ms, geklemmt auf die INT-Spalte. */
export const clampDurationMs = (ms: number): number =>
    Math.max(0, Math.min(TASK_LIMITS.sessionMaxMs, Math.round(Number.isFinite(ms) ? ms : 0)));

/** Laufzeit einer offenen Messung bis `now`. */
export const liveDurationMs = (startedAt: Date, now: Date): number => clampDurationMs(now.getTime() - startedAt.getTime());

export const REPORT_RANGE_KEYS = ['7', '30', '90', 'all'] as const;
export type ReportRangeKey = typeof REPORT_RANGE_KEYS[number];

export interface ReportRange {
    key: ReportRangeKey | 'custom';
    /** null = seit Anbeginn («Tüm zamanlar»). */
    from: Date | null;
    to: Date;
}

const parseDate = (value: unknown): Date | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const date = new Date(value.trim());
    return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Zeitraum eines Berichts aus der Abfragezeile:
 *   `from`/`to` (ISO) gewinnen — sonst `range` = 7 | 30 | 90 | all (Standard 30):
 *   from = Tagesanfang von (heute − (Tage − 1)), to = Tagesende heute.
 */
export const resolveReportRange = (query: Record<string, unknown>, now: Date = new Date()): ReportRange => {
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (from || to) {
        const end = to ?? endOfLocalDay(now);
        const start = from && from.getTime() <= end.getTime() ? from : from ? end : null;
        return { key: 'custom', from: start, to: end };
    }
    const raw = String(query.range ?? '30');
    const key: ReportRangeKey = (REPORT_RANGE_KEYS as readonly string[]).includes(raw) ? (raw as ReportRangeKey) : '30';
    if (key === 'all') return { key, from: null, to: endOfLocalDay(now) };
    const days = Number(key);
    return { key, from: startOfLocalDay(new Date(now.getTime() - (days - 1) * DAY_MS)), to: endOfLocalDay(now) };
};
