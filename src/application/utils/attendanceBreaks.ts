export type BreakPeriod = { start: string; end: string | null };

export function parseBreakPeriods(raw: unknown): BreakPeriod[] {
    if (!raw || !Array.isArray(raw)) return [];
    const out: BreakPeriod[] = [];
    for (const item of raw) {
        if (item && typeof item === "object" && typeof (item as BreakPeriod).start === "string") {
            const end = (item as BreakPeriod).end;
            out.push({
                start: (item as BreakPeriod).start,
                end: typeof end === "string" ? end : null,
            });
        }
    }
    return out;
}

export function hasOpenBreak(periods: BreakPeriod[]): boolean {
    return periods.some((p) => p.end === null);
}

export function computeNetWorkSeconds(checkIn: Date, checkOut: Date, periods: BreakPeriod[]): number {
    let breakMs = 0;
    for (const p of periods) {
        const s = new Date(p.start).getTime();
        const e = p.end ? new Date(p.end).getTime() : checkOut.getTime();
        if (e > s) breakMs += e - s;
    }
    const total = checkOut.getTime() - checkIn.getTime();
    return Math.max(0, Math.floor((total - breakMs) / 1000));
}
