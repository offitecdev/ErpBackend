// Payment schedule (Zahlungsplan) helpers. A schedule is an array of
// instalments, each carrying a percentage of the gross total and the day it
// falls due (e.g. 30% on 2026-09-01, 70% on 2026-11-15), persisted as a JSON
// string on Tender.paymentStages / SalesOrder.paymentStages. Stages carry no
// identity: billing progress is derived by comparing the summed billedPercent
// against the cumulative stage percents, so custom-percent deviations self-heal
// instead of desyncing a stage↔invoice link.
//
// Legacy rows hold a bare percent array (`[30,20,10,40]`) from before dates
// existed. They still parse — the dates come back null — but validation now
// demands a date per stage, so the next write fills them in.
//
// Frontend mirror: offitec-frontend/src/lib/paymentSchedule.ts — keep in sync.

const EPSILON = 0.005;
export const MAX_PAYMENT_STAGES = 12;

export interface PaymentStage {
    /** Share of the gross total billed at this stage, in percent. */
    percent: number;
    /** Due date as an ISO day (`YYYY-MM-DD`); null on legacy percent-only rows. */
    date: string | null;
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a complete ISO day that is also a real calendar date. */
export const isValidStageDate = (date: string | null | undefined): date is string =>
    typeof date === 'string' && ISO_DAY.test(date) && !Number.isNaN(new Date(`${date}T00:00:00`).getTime());

/** One stored entry — a bare percent (legacy) or a `{ percent, date }` object. */
const toStage = (entry: unknown): PaymentStage | null => {
    if (typeof entry === 'number' || typeof entry === 'string') {
        const percent = Number(entry);
        return Number.isFinite(percent) ? { percent, date: null } : null;
    }
    if (entry && typeof entry === 'object') {
        const record = entry as { percent?: unknown; date?: unknown };
        const percent = Number(record.percent);
        if (!Number.isFinite(percent)) return null;
        const date = typeof record.date === 'string' ? record.date : null;
        return { percent, date: isValidStageDate(date) ? date : null };
    }
    return null;
};

/** Normalises whatever the client sent — a JSON string or an already-parsed array. */
export const normalizePaymentStages = (raw: unknown): PaymentStage[] | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    const source = Array.isArray(raw) ? raw : parseJsonArray(raw);
    if (!source || source.length === 0) return null;
    const stages = source.map(toStage);
    if (stages.some((stage) => stage === null)) return null;
    return stages as PaymentStage[];
};

const parseJsonArray = (raw: unknown): unknown[] | null => {
    try {
        const parsed = JSON.parse(String(raw));
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

export const parsePaymentStages = (raw: string | null | undefined): PaymentStage[] | null =>
    normalizePaymentStages(raw);

export const validatePaymentStages = (stages: PaymentStage[]): string | null => {
    if (stages.length === 0 || stages.length > MAX_PAYMENT_STAGES) {
        return `Ödeme planı 1 ile ${MAX_PAYMENT_STAGES} taksit arasında olmalıdır.`;
    }
    for (const stage of stages) {
        if (!Number.isFinite(stage.percent) || round2(stage.percent) <= 0 || round2(stage.percent) > 100) {
            return "Her taksit %0'dan büyük ve en fazla %100 olmalıdır.";
        }
        if (!isValidStageDate(stage.date)) {
            return 'Her taksit için bir ödeme tarihi seçilmelidir.';
        }
    }
    const sum = round2(stages.reduce((total, stage) => total + round2(stage.percent), 0));
    if (Math.abs(sum - 100) > 0.01) {
        return `Taksitler %100'e tamamlanmalıdır (şu an %${sum}).`;
    }
    return null;
};

export const serializePaymentStages = (stages: PaymentStage[]): string =>
    JSON.stringify(stages.map((stage) => ({ percent: round2(stage.percent), date: stage.date ?? null })));

export interface NextStageInfo {
    // Zero-based stage index.
    index: number;
    // The stage's own percent as defined in the schedule.
    percent: number;
    // Due date of that stage, or null on a legacy schedule without dates.
    date: string | null;
    // What to actually bill to land on the stage's cumulative boundary —
    // differs from `percent` after off-schedule invoices.
    suggestedPercent: number;
}

export const nextStageInfo = (
    stages: PaymentStage[],
    billedPercent: number,
    remainingPercent: number,
): NextStageInfo | null => {
    let cumulative = 0;
    for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index];
        const percent = round2(stage?.percent ?? 0);
        cumulative = round2(cumulative + percent);
        if (cumulative > billedPercent + EPSILON) {
            const suggested = round2(Math.min(remainingPercent, cumulative - billedPercent));
            if (suggested <= EPSILON) return null;
            return { index, percent, date: stage?.date ?? null, suggestedPercent: suggested };
        }
    }
    return null;
};
