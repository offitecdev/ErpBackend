import { DAY_MS, endOfLocalDay, startOfLocalDay } from './taskTime';

/**
 * ── BITIŞ TAHMINI (Görevly reports.js `forecast`) ───────────────────────────
 *
 * Wann wird die Aufgabe bei diesem Tempo fertig? Gerechnet aus der
 * Checkliste: gemessene Zeit je erledigtem Punkt × offene Punkte, verteilt
 * auf die Tagesleistung der bisherigen Arbeitstage und gestreckt um den
 * Rhythmus (wie oft überhaupt an ihr gearbeitet wird, 1…5).
 *
 * Ausgegeben wird nur das Ergebnis — keine Millisekunden: auch ein
 * Teammitglied sieht die Prognose, aber keine Zeiten.
 */

export type ForecastReason = 'NEEDS_CHECKLIST' | 'NOT_ENOUGH_DATA' | 'ALL_DONE';

export interface ForecastInput {
    status: string;
    completedAt: Date | null;
    dueAt: Date | null;
    checkTotal: number;
    checkDone: number;
    /** Abgeschlossene UND laufende Messungen mit ihrer Dauer bis jetzt. */
    sessions: ReadonlyArray<{ startedAt: Date; ms: number }>;
    now?: Date;
}

export interface TaskForecast {
    ok: boolean;
    completed: boolean;
    predictedAt: Date | null;
    calendarDays: number | null;
    delayDays: number | null;
    late: boolean;
    total: number;
    done: number;
    remaining: number;
    reasonCode: ForecastReason | null;
}

const MIN_TRACKED_MS = 5 * 60_000;
const MIN_DAILY_MS = 15 * 60_000;

export const computeTaskForecast = (input: ForecastInput): TaskForecast => {
    const now = input.now ?? new Date();
    const total = Math.max(0, input.checkTotal);
    const done = Math.max(0, Math.min(total, input.checkDone));
    const remaining = total - done;
    const base: TaskForecast = {
        ok: false,
        completed: false,
        predictedAt: null,
        calendarDays: null,
        delayDays: null,
        late: false,
        total,
        done,
        remaining,
        reasonCode: null,
    };

    if (input.status === 'COMPLETED') {
        return { ...base, ok: true, completed: true, predictedAt: input.completedAt };
    }
    if (!total) return { ...base, reasonCode: 'NEEDS_CHECKLIST' };
    if (!remaining) return { ...base, ok: true, predictedAt: now, reasonCode: 'ALL_DONE' };

    const totalMs = input.sessions.reduce((sum, session) => sum + Math.max(0, session.ms), 0);
    if (!done || totalMs < MIN_TRACKED_MS) return { ...base, reasonCode: 'NOT_ENOUGH_DATA' };

    const msPerItem = totalMs / done;
    const remainingEffortMs = msPerItem * remaining;

    const activeDayStarts = new Set(input.sessions.map((session) => startOfLocalDay(session.startedAt).getTime()));
    const activeDays = activeDayStarts.size || 1;
    const dailyMs = totalMs / activeDays;
    const firstDay = activeDayStarts.size ? Math.min(...activeDayStarts) : startOfLocalDay(now).getTime();
    const spanDays = Math.max(1, Math.round((startOfLocalDay(now).getTime() - firstDay) / DAY_MS) + 1);
    const cadence = Math.min(5, Math.max(1, spanDays / activeDays));

    const calendarDays = Math.max(1, Math.ceil((remainingEffortMs / Math.max(dailyMs, MIN_DAILY_MS)) * cadence));
    const predictedAt = endOfLocalDay(new Date(now.getTime() + (calendarDays - 1) * DAY_MS));
    const delayDays = input.dueAt ? Math.ceil((predictedAt.getTime() - input.dueAt.getTime()) / DAY_MS) : null;

    return {
        ...base,
        ok: true,
        predictedAt,
        calendarDays,
        delayDays,
        late: delayDays !== null && delayDays > 0,
    };
};
