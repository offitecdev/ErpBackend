"use strict";
// Payment schedule (Zahlungsplan) helpers. A schedule is an array of
// instalments, each carrying a percentage of the gross total and — ON THE ORDER
// — the day it falls due (e.g. 30% on 2026-09-01, 70% on 2026-11-15), persisted
// as a JSON string on Tender.paymentStages / SalesOrder.paymentStages. Stages
// carry no identity: billing progress is derived by comparing the summed
// billedPercent against the cumulative stage percents, so custom-percent
// deviations self-heal instead of desyncing a stage↔invoice link.
//
// DUE DATES BELONG TO THE ORDER, NOT THE OFFER (Vorgabe 15.08.2026). The offer
// fixes only the percentages, so its write path validates with
// `requireDates: false` and stores the dates as null (`stripStageDates`); the
// order's own endpoint keeps demanding a date per instalment.
//
// Legacy rows hold a bare percent array (`[30,20,10,40]`) from before dates
// existed. They still parse — the dates come back null.
//
// Frontend mirror: offitec-frontend/src/lib/paymentSchedule.ts — keep in sync.
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextStageInfo = exports.serializePaymentStages = exports.validatePaymentStages = exports.stripStageDates = exports.parsePaymentStages = exports.normalizePaymentStages = exports.isValidStageDate = exports.MAX_PAYMENT_STAGES = void 0;
const EPSILON = 0.005;
exports.MAX_PAYMENT_STAGES = 12;
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** True for a complete ISO day that is also a real calendar date. */
const isValidStageDate = (date) => typeof date === 'string' && ISO_DAY.test(date) && !Number.isNaN(new Date(`${date}T00:00:00`).getTime());
exports.isValidStageDate = isValidStageDate;
/** One stored entry — a bare percent (legacy) or a `{ percent, date }` object. */
const toStage = (entry) => {
    if (typeof entry === 'number' || typeof entry === 'string') {
        const percent = Number(entry);
        return Number.isFinite(percent) ? { percent, date: null } : null;
    }
    if (entry && typeof entry === 'object') {
        const record = entry;
        const percent = Number(record.percent);
        if (!Number.isFinite(percent))
            return null;
        const date = typeof record.date === 'string' ? record.date : null;
        return { percent, date: (0, exports.isValidStageDate)(date) ? date : null };
    }
    return null;
};
/** Normalises whatever the client sent — a JSON string or an already-parsed array. */
const normalizePaymentStages = (raw) => {
    if (raw === null || raw === undefined || raw === '')
        return null;
    const source = Array.isArray(raw) ? raw : parseJsonArray(raw);
    if (!source || source.length === 0)
        return null;
    const stages = source.map(toStage);
    if (stages.some((stage) => stage === null))
        return null;
    return stages;
};
exports.normalizePaymentStages = normalizePaymentStages;
const parseJsonArray = (raw) => {
    try {
        const parsed = JSON.parse(String(raw));
        return Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
};
const parsePaymentStages = (raw) => (0, exports.normalizePaymentStages)(raw);
exports.parsePaymentStages = parsePaymentStages;
/** Drops the due dates — the offer stores percentages only. */
const stripStageDates = (stages) => stages.map((stage) => ({ ...stage, date: null }));
exports.stripStageDates = stripStageDates;
const validatePaymentStages = (stages, { requireDates = true } = {}) => {
    if (stages.length === 0 || stages.length > exports.MAX_PAYMENT_STAGES) {
        return `Ödeme planı 1 ile ${exports.MAX_PAYMENT_STAGES} taksit arasında olmalıdır.`;
    }
    for (const stage of stages) {
        if (!Number.isFinite(stage.percent) || round2(stage.percent) <= 0 || round2(stage.percent) > 100) {
            return "Her taksit %0'dan büyük ve en fazla %100 olmalıdır.";
        }
        if (requireDates && !(0, exports.isValidStageDate)(stage.date)) {
            return 'Her taksit için bir ödeme tarihi seçilmelidir.';
        }
    }
    const sum = round2(stages.reduce((total, stage) => total + round2(stage.percent), 0));
    if (Math.abs(sum - 100) > 0.01) {
        return `Taksitler %100'e tamamlanmalıdır (şu an %${sum}).`;
    }
    return null;
};
exports.validatePaymentStages = validatePaymentStages;
const serializePaymentStages = (stages) => JSON.stringify(stages.map((stage) => ({ percent: round2(stage.percent), date: stage.date ?? null })));
exports.serializePaymentStages = serializePaymentStages;
const nextStageInfo = (stages, billedPercent, remainingPercent) => {
    let cumulative = 0;
    for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index];
        const percent = round2(stage?.percent ?? 0);
        cumulative = round2(cumulative + percent);
        if (cumulative > billedPercent + EPSILON) {
            const suggested = round2(Math.min(remainingPercent, cumulative - billedPercent));
            if (suggested <= EPSILON)
                return null;
            return { index, percent, date: stage?.date ?? null, suggestedPercent: suggested };
        }
    }
    return null;
};
exports.nextStageInfo = nextStageInfo;
//# sourceMappingURL=paymentSchedule.js.map