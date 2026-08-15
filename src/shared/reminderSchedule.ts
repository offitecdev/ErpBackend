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

export const MAX_LEAD_DAYS = 30;
export const MAX_INTERVAL_DAYS = 30;
export const REMINDER_ENTITY_TYPES = ['QUOTE', 'ORDER'] as const;
export type ReminderEntityType = (typeof REMINDER_ENTITY_TYPES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

export const clampReminderSetting = (input: { leadDays: unknown; intervalDays: unknown }) => {
    const lead = Math.trunc(Number(input.leadDays));
    const interval = Math.trunc(Number(input.intervalDays));
    return {
        leadDays: Number.isFinite(lead) ? Math.min(MAX_LEAD_DAYS, Math.max(0, lead)) : 0,
        intervalDays: Number.isFinite(interval) ? Math.min(MAX_INTERVAL_DAYS, Math.max(1, interval)) : 1,
    };
};

/** Alle Schritte des Fahrplans als "Tage vor dem Bezug", absteigend — endet mit 0. */
export const reminderStepsBefore = (leadDays: number, intervalDays: number): number[] => {
    const { leadDays: lead, intervalDays: interval } = clampReminderSetting({ leadDays, intervalDays });
    const steps: number[] = [];
    for (let before = lead; before > 0; before -= interval) steps.push(before);
    steps.push(0);
    return steps;
};

/**
 * Der jüngste fällige Schritt für einen Beleg — oder null, wenn der Fahrplan
 * noch nicht begonnen hat. Liegt `now` hinter dem Bezug, ist es der Bezugstag.
 */
export const latestDueStep = (reference: Date, leadDays: number, intervalDays: number, now: Date): Date | null => {
    const { leadDays: lead, intervalDays: interval } = clampReminderSetting({ leadDays, intervalDays });
    const start = reference.getTime() - lead * DAY_MS;
    if (now.getTime() < start) return null;
    if (now.getTime() >= reference.getTime()) return new Date(reference.getTime());
    const stepIndex = Math.floor((now.getTime() - start) / (interval * DAY_MS));
    return new Date(start + stepIndex * interval * DAY_MS);
};

/** Ganze Tage zwischen Termin und Bezug (0 = am Bezugstag). */
export const daysBetween = (dueAt: Date, reference: Date): number =>
    Math.max(0, Math.round((reference.getTime() - dueAt.getTime()) / DAY_MS));
