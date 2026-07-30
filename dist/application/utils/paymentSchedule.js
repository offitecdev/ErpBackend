"use strict";
// Percentage-based payment schedule (Zahlungsplan) helpers. A schedule is a
// plain array of stage percents (e.g. [30, 20, 10, 40]) persisted as a JSON
// string on Tender.paymentStages / SalesOrder.paymentStages. Stages carry no
// identity: billing progress is derived by comparing the summed billedPercent
// against the cumulative stage percents, so custom-percent deviations
// self-heal instead of desyncing a stage↔invoice link.
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextStageInfo = exports.serializePaymentStages = exports.validatePaymentStages = exports.parsePaymentStages = exports.MAX_PAYMENT_STAGES = void 0;
const EPSILON = 0.005;
exports.MAX_PAYMENT_STAGES = 12;
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const parsePaymentStages = (raw) => {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0)
            return null;
        const stages = parsed.map(Number);
        if (stages.some((value) => !Number.isFinite(value)))
            return null;
        return stages;
    }
    catch {
        return null;
    }
};
exports.parsePaymentStages = parsePaymentStages;
const validatePaymentStages = (stages) => {
    if (stages.length === 0 || stages.length > exports.MAX_PAYMENT_STAGES) {
        return `Ödeme planı 1 ile ${exports.MAX_PAYMENT_STAGES} taksit arasında olmalıdır.`;
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
exports.validatePaymentStages = validatePaymentStages;
const serializePaymentStages = (stages) => JSON.stringify(stages.map(round2));
exports.serializePaymentStages = serializePaymentStages;
const nextStageInfo = (stages, billedPercent, remainingPercent) => {
    let cumulative = 0;
    for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index] ?? 0;
        cumulative = round2(cumulative + round2(stage));
        if (cumulative > billedPercent + EPSILON) {
            const suggested = round2(Math.min(remainingPercent, cumulative - billedPercent));
            if (suggested <= EPSILON)
                return null;
            return { index, percent: round2(stage), suggestedPercent: suggested };
        }
    }
    return null;
};
exports.nextStageInfo = nextStageInfo;
//# sourceMappingURL=paymentSchedule.js.map