"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseBreakPeriods = parseBreakPeriods;
exports.hasOpenBreak = hasOpenBreak;
exports.computeNetWorkSeconds = computeNetWorkSeconds;
function parseBreakPeriods(raw) {
    if (!raw || !Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (item && typeof item === "object" && typeof item.start === "string") {
            const end = item.end;
            out.push({
                start: item.start,
                end: typeof end === "string" ? end : null,
            });
        }
    }
    return out;
}
function hasOpenBreak(periods) {
    return periods.some((p) => p.end === null);
}
function computeNetWorkSeconds(checkIn, checkOut, periods) {
    let breakMs = 0;
    for (const p of periods) {
        const s = new Date(p.start).getTime();
        const e = p.end ? new Date(p.end).getTime() : checkOut.getTime();
        if (e > s)
            breakMs += e - s;
    }
    const total = checkOut.getTime() - checkIn.getTime();
    return Math.max(0, Math.floor((total - breakMs) / 1000));
}
//# sourceMappingURL=attendanceBreaks.js.map