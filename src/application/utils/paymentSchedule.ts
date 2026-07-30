// Percentage-based payment schedule (Zahlungsplan) helpers. A schedule is a
// plain array of stage percents (e.g. [30, 20, 10, 40]) persisted as a JSON
// string on Tender.paymentStages / SalesOrder.paymentStages. Stages carry no
// identity: billing progress is derived by comparing the summed billedPercent
// against the cumulative stage percents, so custom-percent deviations
// self-heal instead of desyncing a stage↔invoice link.

const EPSILON = 0.005;
export const MAX_PAYMENT_STAGES = 12;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export const parsePaymentStages = (raw: string | null | undefined): number[] | null => {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) return null;
        const stages = parsed.map(Number);
        if (stages.some((value) => !Number.isFinite(value))) return null;
        return stages;
    } catch {
        return null;
    }
};

export const validatePaymentStages = (stages: number[]): string | null => {
    if (stages.length === 0 || stages.length > MAX_PAYMENT_STAGES) {
        return `Ödeme planı 1 ile ${MAX_PAYMENT_STAGES} taksit arasında olmalıdır.`;
    }
    for (const stage of stages) {
        if (!Number.isFinite(stage) || round2(stage) <= 0 || round2(stage) > 100) {
            return "Her taksit %0'dan büyük ve en fazla %100 olmalıdır.";
        }
    }
    const sum = round2(stages.reduce((total, stage) => total + round2(stage), 0));
    if (Math.abs(sum - 100) > 0.01) {
        return `Taksitler %100'e tamamlanmalıdır (şu an %${sum}).`;
    }
    return null;
};

export const serializePaymentStages = (stages: number[]): string =>
    JSON.stringify(stages.map(round2));

export interface NextStageInfo {
    // Zero-based stage index.
    index: number;
    // The stage's own percent as defined in the schedule.
    percent: number;
    // What to actually bill to land on the stage's cumulative boundary —
    // differs from `percent` after off-schedule invoices.
    suggestedPercent: number;
}

export const nextStageInfo = (
    stages: number[],
    billedPercent: number,
    remainingPercent: number,
): NextStageInfo | null => {
    let cumulative = 0;
    for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index] ?? 0;
        cumulative = round2(cumulative + round2(stage));
        if (cumulative > billedPercent + EPSILON) {
            const suggested = round2(Math.min(remainingPercent, cumulative - billedPercent));
            if (suggested <= EPSILON) return null;
            return { index, percent: round2(stage), suggestedPercent: suggested };
        }
    }
    return null;
};
