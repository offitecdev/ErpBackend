"use strict";
/**
 * Erinnerungs-Fahrplan — die reine Rechnung, ohne Datenbank (die Oberfläche
 * spiegelt sie in `lib/reminderSchedule.ts` für die Vorschau; beide müssen
 * gleich bleiben).
 *
 * Eine Einstellung ist ZWEI Zahlen: Vorlauf (`leadDays`, erste Erinnerung so
 * viele Tage vor dem Bezugsdatum) und Wiederholung (`intervalDays`, danach
 * alle N Tage). Erinnert wird an den Schritten
 *
 *     Bezug − Vorlauf, Bezug − Vorlauf + N, … (solange vor dem Bezug) und am
 *     Bezugsdatum selbst — danach nie mehr.
 *
 * Der Hintergrunddienst feuert je Beleg immer nur den JÜNGSTEN fälligen
 * Schritt (kein Nachholen verpasster Zwischenschritte, kein Fluten nach einer
 * Auszeit) und merkt sich (Belegart, Beleg, Termin) im Zünd-Verlauf.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.daysBetween = exports.latestDueStep = exports.reminderStepsBefore = exports.clampReminderSetting = exports.REMINDER_ENTITY_TYPES = exports.MAX_INTERVAL_DAYS = exports.MAX_LEAD_DAYS = void 0;
exports.MAX_LEAD_DAYS = 30;
exports.MAX_INTERVAL_DAYS = 30;
exports.REMINDER_ENTITY_TYPES = ['QUOTE', 'ORDER'];
const DAY_MS = 24 * 60 * 60 * 1000;
const clampReminderSetting = (input) => {
    const lead = Math.trunc(Number(input.leadDays));
    const interval = Math.trunc(Number(input.intervalDays));
    return {
        leadDays: Number.isFinite(lead) ? Math.min(exports.MAX_LEAD_DAYS, Math.max(0, lead)) : 0,
        intervalDays: Number.isFinite(interval) ? Math.min(exports.MAX_INTERVAL_DAYS, Math.max(1, interval)) : 1,
    };
};
exports.clampReminderSetting = clampReminderSetting;
/** Alle Schritte des Fahrplans als "Tage vor dem Bezug", absteigend — endet mit 0. */
const reminderStepsBefore = (leadDays, intervalDays) => {
    const { leadDays: lead, intervalDays: interval } = (0, exports.clampReminderSetting)({ leadDays, intervalDays });
    const steps = [];
    for (let before = lead; before > 0; before -= interval)
        steps.push(before);
    steps.push(0);
    return steps;
};
exports.reminderStepsBefore = reminderStepsBefore;
/**
 * Der jüngste fällige Schritt für einen Beleg — oder null, wenn der Fahrplan
 * noch nicht begonnen hat. Liegt `now` hinter dem Bezug, ist es der Bezugstag.
 */
const latestDueStep = (reference, leadDays, intervalDays, now) => {
    const { leadDays: lead, intervalDays: interval } = (0, exports.clampReminderSetting)({ leadDays, intervalDays });
    const start = reference.getTime() - lead * DAY_MS;
    if (now.getTime() < start)
        return null;
    if (now.getTime() >= reference.getTime())
        return new Date(reference.getTime());
    const stepIndex = Math.floor((now.getTime() - start) / (interval * DAY_MS));
    return new Date(start + stepIndex * interval * DAY_MS);
};
exports.latestDueStep = latestDueStep;
/** Ganze Tage zwischen Termin und Bezug (0 = am Bezugstag). */
const daysBetween = (dueAt, reference) => Math.max(0, Math.round((reference.getTime() - dueAt.getTime()) / DAY_MS));
exports.daysBetween = daysBetween;
//# sourceMappingURL=reminderSchedule.js.map