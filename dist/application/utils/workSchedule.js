"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWorkSchedule = parseWorkSchedule;
/** Çizelge artık zorunlu mesai saati kuralı taşımaz; isteğe bağlı kayıtlı veriler. */
function parseWorkSchedule(raw) {
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    const o = raw;
    const workStart = typeof o.workStart === 'string' ? o.workStart : undefined;
    const workEnd = typeof o.workEnd === 'string' ? o.workEnd : undefined;
    let breaks;
    if (Array.isArray(o.breaks)) {
        breaks = o.breaks
            .filter((b) => !!b &&
            typeof b === 'object' &&
            typeof b.label === 'string' &&
            typeof b.start === 'string' &&
            typeof b.end === 'string')
            .map((b) => ({
            label: b.label,
            start: b.start,
            end: b.end,
        }));
    }
    if (!breaks?.length)
        breaks = undefined;
    const out = {};
    if (workStart !== undefined)
        out.workStart = workStart;
    if (workEnd !== undefined)
        out.workEnd = workEnd;
    if (breaks !== undefined)
        out.breaks = breaks;
    return out;
}
//# sourceMappingURL=workSchedule.js.map