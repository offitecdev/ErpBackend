"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.windowedMs = exports.resolveDayWindow = exports.resolveReportRange = exports.REPORT_RANGE_KEYS = exports.liveDurationMs = exports.clampDurationMs = exports.endOfLocalDay = exports.startOfLocalDay = exports.DAY_MS = void 0;
const taskConstants_1 = require("./taskConstants");
/**
 * Zeit-Hilfen des Görevler-Moduls. «Heute», «Tagesanfang» und «Tagesende»
 * sind — wie überall im Terminwesen des Hauses — Tage der SERVER-Uhr.
 * Berichte nehmen darum bevorzugt `from`/`to` aus dem Browser entgegen, der
 * die Tagesgrenzen der Leserin kennt; der Zeitraumschlüssel ist nur Rückfall.
 */
exports.DAY_MS = 86_400_000;
const startOfLocalDay = (date) => {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    return day;
};
exports.startOfLocalDay = startOfLocalDay;
const endOfLocalDay = (date) => {
    const day = new Date(date);
    day.setHours(23, 59, 59, 999);
    return day;
};
exports.endOfLocalDay = endOfLocalDay;
/** Dauer einer Messung in ms, geklemmt auf die INT-Spalte. */
const clampDurationMs = (ms) => Math.max(0, Math.min(taskConstants_1.TASK_LIMITS.sessionMaxMs, Math.round(Number.isFinite(ms) ? ms : 0)));
exports.clampDurationMs = clampDurationMs;
/** Laufzeit einer offenen Messung bis `now`. */
const liveDurationMs = (startedAt, now) => (0, exports.clampDurationMs)(now.getTime() - startedAt.getTime());
exports.liveDurationMs = liveDurationMs;
exports.REPORT_RANGE_KEYS = ['7', '30', '90', 'all'];
const parseDate = (value) => {
    if (typeof value !== 'string' || !value.trim())
        return null;
    const date = new Date(value.trim());
    return Number.isNaN(date.getTime()) ? null : date;
};
/**
 * Zeitraum eines Berichts aus der Abfragezeile:
 *   `from`/`to` (ISO) gewinnen — sonst `range` = 7 | 30 | 90 | all (Standard 30):
 *   from = Tagesanfang von (heute − (Tage − 1)), to = Tagesende heute.
 */
const resolveReportRange = (query, now = new Date()) => {
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (from || to) {
        const end = to ?? (0, exports.endOfLocalDay)(now);
        const start = from && from.getTime() <= end.getTime() ? from : from ? end : null;
        return { key: 'custom', from: start, to: end };
    }
    const raw = String(query.range ?? '30');
    const key = exports.REPORT_RANGE_KEYS.includes(raw) ? raw : '30';
    if (key === 'all')
        return { key, from: null, to: (0, exports.endOfLocalDay)(now) };
    const days = Number(key);
    return { key, from: (0, exports.startOfLocalDay)(new Date(now.getTime() - (days - 1) * exports.DAY_MS)), to: (0, exports.endOfLocalDay)(now) };
};
exports.resolveReportRange = resolveReportRange;
const parseIsoDate = (value) => {
    if (typeof value !== 'string' || !value.trim())
        return null;
    const date = new Date(value.trim().slice(0, 40));
    return Number.isNaN(date.getTime()) ? null : date;
};
const resolveDayWindow = (fromRaw, toRaw, now = new Date()) => {
    const from = parseIsoDate(fromRaw);
    const to = parseIsoDate(toRaw);
    if (from && to && to.getTime() > from.getTime() && to.getTime() - from.getTime() <= exports.DAY_MS * 1.5)
        return { from, to };
    return { from: (0, exports.startOfLocalDay)(now), to: (0, exports.endOfLocalDay)(now) };
};
exports.resolveDayWindow = resolveDayWindow;
/** Anteil einer Messung innerhalb des Fensters; eine laufende zählt bis `now`. */
const windowedMs = (startedAt, endedAt, day, now) => {
    const start = Math.max(startedAt.getTime(), day.from.getTime());
    const end = Math.min((endedAt ?? now).getTime(), day.to.getTime());
    return Math.max(0, end - start);
};
exports.windowedMs = windowedMs;
//# sourceMappingURL=taskTime.js.map