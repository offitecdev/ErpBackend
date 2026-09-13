"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeTaskForecast = void 0;
const taskTime_1 = require("./taskTime");
const MIN_TRACKED_MS = 5 * 60_000;
const MIN_DAILY_MS = 15 * 60_000;
const computeTaskForecast = (input) => {
    const now = input.now ?? new Date();
    const total = Math.max(0, input.checkTotal);
    const done = Math.max(0, Math.min(total, input.checkDone));
    const remaining = total - done;
    const base = {
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
    if (!total)
        return { ...base, reasonCode: 'NEEDS_CHECKLIST' };
    if (!remaining)
        return { ...base, ok: true, predictedAt: now, reasonCode: 'ALL_DONE' };
    const totalMs = input.sessions.reduce((sum, session) => sum + Math.max(0, session.ms), 0);
    if (!done || totalMs < MIN_TRACKED_MS)
        return { ...base, reasonCode: 'NOT_ENOUGH_DATA' };
    const msPerItem = totalMs / done;
    const remainingEffortMs = msPerItem * remaining;
    const activeDayStarts = new Set(input.sessions.map((session) => (0, taskTime_1.startOfLocalDay)(session.startedAt).getTime()));
    const activeDays = activeDayStarts.size || 1;
    const dailyMs = totalMs / activeDays;
    const firstDay = activeDayStarts.size ? Math.min(...activeDayStarts) : (0, taskTime_1.startOfLocalDay)(now).getTime();
    const spanDays = Math.max(1, Math.round(((0, taskTime_1.startOfLocalDay)(now).getTime() - firstDay) / taskTime_1.DAY_MS) + 1);
    const cadence = Math.min(5, Math.max(1, spanDays / activeDays));
    const calendarDays = Math.max(1, Math.ceil((remainingEffortMs / Math.max(dailyMs, MIN_DAILY_MS)) * cadence));
    const predictedAt = (0, taskTime_1.endOfLocalDay)(new Date(now.getTime() + (calendarDays - 1) * taskTime_1.DAY_MS));
    const delayDays = input.dueAt ? Math.ceil((predictedAt.getTime() - input.dueAt.getTime()) / taskTime_1.DAY_MS) : null;
    return {
        ...base,
        ok: true,
        predictedAt,
        calendarDays,
        delayDays,
        late: delayDays !== null && delayDays > 0,
    };
};
exports.computeTaskForecast = computeTaskForecast;
//# sourceMappingURL=taskForecast.js.map