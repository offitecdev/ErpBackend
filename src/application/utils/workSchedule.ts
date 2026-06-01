export type WorkScheduleBreak = { label: string; start: string; end: string };

export type WorkSchedule = {
    workStart?: string;
    workEnd?: string;
    breaks?: WorkScheduleBreak[];
};

/** Çizelge artık zorunlu mesai saati kuralı taşımaz; isteğe bağlı kayıtlı veriler. */
export function parseWorkSchedule(raw: unknown): WorkSchedule {
    if (!raw || typeof raw !== 'object') {
        return {};
    }
    const o = raw as Record<string, unknown>;
    const workStart = typeof o.workStart === 'string' ? o.workStart : undefined;
    const workEnd = typeof o.workEnd === 'string' ? o.workEnd : undefined;
    let breaks: WorkScheduleBreak[] | undefined;
    if (Array.isArray(o.breaks)) {
        breaks = o.breaks
            .filter(
                (b): b is WorkScheduleBreak =>
                    !!b &&
                    typeof b === 'object' &&
                    typeof (b as WorkScheduleBreak).label === 'string' &&
                    typeof (b as WorkScheduleBreak).start === 'string' &&
                    typeof (b as WorkScheduleBreak).end === 'string'
            )
            .map((b) => ({
                label: b.label,
                start: b.start,
                end: b.end,
            }));
    }
    if (!breaks?.length) breaks = undefined;
    const out: WorkSchedule = {};
    if (workStart !== undefined) out.workStart = workStart;
    if (workEnd !== undefined) out.workEnd = workEnd;
    if (breaks !== undefined) out.breaks = breaks;
    return out;
}
