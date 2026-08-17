/**
 * ── PERSONALMODUL: GETEILTE RECHENREGELN ─────────────────────────────────────
 *
 * Schichtplan-Mathematik, Urlaubsarten und die Soll-/Ist-Rechnung der Berichte.
 * Reine Funktionen ohne Prisma und ohne Express — dieselbe Datei liegt WORTGLEICH
 * im Frontend unter `src/pages/personnel/utils/personnel.ts`.
 *
 * WICHTIG: Beide Kopien müssen im Gleichschritt bleiben. Der Buchhaltungsbericht
 * zeigt die Zahlen im Browser und druckt sie im PDF; rechnen die zwei Seiten
 * unterschiedlich, stehen im selben Dokument zwei verschiedene Sollstunden.
 */

// ── Schichtplan ──────────────────────────────────────────────────────────────

export interface ShiftPlan {
    /** ISO-Wochentage, die als Arbeitstage zählen (Mo=1 … So=7). */
    workdays: number[];
    /** "HH:MM" */
    startTime: string;
    /** "HH:MM" */
    endTime: string;
    /** Pause in Minuten (die Oberfläche erfasst Stunden + Minuten getrennt). */
    breakMinutes: number;
}

/** Mo–Fr, 08:00–17:00, 45 min Pause — bis jemand einen Plan speichert. */
export const DEFAULT_SHIFT_PLAN: ShiftPlan = {
    workdays: [1, 2, 3, 4, 5],
    startTime: '08:00',
    endTime: '17:00',
    breakMinutes: 45,
};

export const WEEKDAY_KEYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** Sa + So — der „Wochenende"-Schnellschalter der Planungsseite. */
export const WEEKEND_DAYS = [6, 7];

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

/** "HH:MM" prüfen und normalisieren; unlesbares fällt auf `fallback` zurück. */
export const normalizeTime = (value: unknown, fallback: string): string => {
    const text = String(value ?? '').trim();
    const match = /^(\d{1,2}):(\d{1,2})$/.exec(text);
    if (!match) return fallback;
    const hours = clampInt(match[1], 0, 23, 0);
    const minutes = clampInt(match[2], 0, 59, 0);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

/** Minuten seit Mitternacht. */
export const minutesOfDay = (time: string): number => {
    const [hours, minutes] = normalizeTime(time, '00:00').split(':');
    return Number(hours) * 60 + Number(minutes);
};

export const parseShiftPlan = (raw: unknown): ShiftPlan => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const rawDays = Array.isArray(input.workdays) ? input.workdays : DEFAULT_SHIFT_PLAN.workdays;
    const workdays = [...new Set(
        rawDays
            .map((day) => Math.trunc(Number(day)))
            .filter((day) => day >= 1 && day <= 7),
    )].sort((a, b) => a - b);
    return {
        workdays: workdays.length ? workdays : [...DEFAULT_SHIFT_PLAN.workdays],
        startTime: normalizeTime(input.startTime, DEFAULT_SHIFT_PLAN.startTime),
        endTime: normalizeTime(input.endTime, DEFAULT_SHIFT_PLAN.endTime),
        breakMinutes: clampInt(input.breakMinutes, 0, 12 * 60, DEFAULT_SHIFT_PLAN.breakMinutes),
    };
};

/**
 * Bruttodauer der Schicht in Minuten. Endet die Schicht rechnerisch vor ihrem
 * Beginn, läuft sie über Mitternacht (Nachtschicht) und bekommt einen Tag dazu.
 */
export const grossShiftMinutes = (plan: ShiftPlan): number => {
    const start = minutesOfDay(plan.startTime);
    const end = minutesOfDay(plan.endTime);
    return end > start ? end - start : end + 24 * 60 - start;
};

/** Tagesnetto = brutto minus Pause, nie negativ. */
export const netShiftMinutes = (plan: ShiftPlan): number =>
    Math.max(0, grossShiftMinutes(plan) - plan.breakMinutes);

/** Wochennetto = Tagesnetto × Anzahl geplanter Arbeitstage. */
export const weeklyNetMinutes = (plan: ShiftPlan): number =>
    netShiftMinutes(plan) * plan.workdays.length;

// ── Datumshilfen (kalendarisch, ohne Zeitzonen-Verschiebung) ─────────────────

/** "YYYY-MM-DD" → lokale Mitternacht. Ungültiges ergibt null. */
export const parseDateOnly = (value: unknown): Date | null => {
    const text = String(value ?? '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (!match) {
        const parsed = new Date(text);
        return Number.isNaN(parsed.getTime()) ? null : startOfDay(parsed);
    }
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
};

export const startOfDay = (date: Date): Date =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

export const endOfDay = (date: Date): Date =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

export const toDateKey = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** ISO-Wochentag: Mo=1 … So=7 (JavaScript liefert So=0). */
export const isoWeekday = (date: Date): number => date.getDay() === 0 ? 7 : date.getDay();

export const addDays = (date: Date, days: number): Date => {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
};

/** Montag der Woche, in der `date` liegt. */
export const startOfIsoWeek = (date: Date): Date =>
    startOfDay(addDays(date, -(isoWeekday(date) - 1)));

/** Kalendertage im Zeitraum, beide Enden eingeschlossen. */
export const countDaysInRange = (start: Date, end: Date): number => {
    if (end < start) return 0;
    const from = startOfDay(start).getTime();
    const to = startOfDay(end).getTime();
    return Math.round((to - from) / 86_400_000) + 1;
};

/** Arbeitstage im Zeitraum nach Schichtplan (Feiertage NICHT abgezogen). */
export const countWorkdaysInRange = (start: Date, end: Date, workdays: number[]): number => {
    if (end < start) return 0;
    const days = new Set(workdays);
    let count = 0;
    for (let cursor = startOfDay(start); cursor <= end; cursor = addDays(cursor, 1)) {
        if (days.has(isoWeekday(cursor))) count += 1;
    }
    return count;
};

// ── Stempeluhr: was ein Scan bedeutet ───────────────────────────────────────

/**
 * Die vier Ereignisse eines Arbeitstages:
 *
 *   IN          Arbeitsbeginn — der erste Scan des Tages.
 *   BREAK_START Pausenbeginn — ein Scan, der vor dem geplanten Schichtende ein
 *               laufendes Fenster schliesst.
 *   BREAK_END   Pausenende — ein Scan, der vor dem Schichtende ein neues
 *               Fenster öffnet, nachdem heute schon gearbeitet wurde.
 *   OUT         Feierabend — der Scan, der ab dem geplanten Schichtende ein
 *               laufendes Fenster schliesst.
 *
 * Pausenbeginn und Pausenende waren bis zum 16.08.2026 EIN Kennzeichen
 * („BREAK"); die Tagesübersicht am Tablet soll aber sagen können, ob jemand
 * gerade geht oder zurückkommt.
 */
export const SCAN_TAGS = ['IN', 'BREAK_START', 'BREAK_END', 'OUT'] as const;
export type ScanTag = (typeof SCAN_TAGS)[number];

export interface ScanContext {
    /** Läuft gerade ein offenes Arbeitsfenster? */
    hasOpenEntry: boolean;
    /** Wurde heute schon einmal gestempelt (offen oder geschlossen)? */
    hasEntriesToday: boolean;
    /** Minuten seit Mitternacht zum Zeitpunkt des Scans. */
    nowMinutes: number;
}

/**
 * Ist die geplante Schicht zu diesem Zeitpunkt vorbei?
 *
 * Läuft die Schicht über Mitternacht, liegt das Ende rechnerisch VOR dem
 * Beginn; dann gibt es vor Mitternacht kein „ab Schichtende" und die Frage
 * wird verneint — sonst wäre auf einer Nachtschicht JEDER Scan ein Feierabend.
 */
export const shiftEndReached = (plan: ShiftPlan, minutes: number): boolean => {
    const startMinutes = minutesOfDay(plan.startTime);
    const endMinutes = minutesOfDay(plan.endTime);
    if (endMinutes <= startMinutes) return false;
    return minutes >= endMinutes;
};

/**
 * Die Bedeutung eines Scans — die einzige Stelle, an der diese Regel steht.
 *
 * Ein Scan SCHLIESST ein offenes Fenster oder ÖFFNET ein neues; was er heisst,
 * hängt daran, wo im Tag er liegt (Vorgabe 16.08.2026):
 *
 *   erster Scan des Tages                    → IN
 *   schliesst ein Fenster vor Schichtende    → BREAK_START
 *   öffnet ein Fenster vor Schichtende       → BREAK_END
 *   schliesst ein Fenster ab Schichtende     → OUT
 *   öffnet ein Fenster ab Schichtende        → IN   (Nacharbeit nach Feierabend)
 *
 * PAUSEN ZÄHLEN NICHT ALS ARBEITSZEIT: sie sind die LÜCKE zwischen zwei
 * Fenstern und werden nirgends addiert — deshalb entspricht die Summe der
 * Fenster genau der geleisteten Zeit.
 */
export const scanTagFor = (plan: ShiftPlan, context: ScanContext): ScanTag => {
    const ended = shiftEndReached(plan, context.nowMinutes);
    if (context.hasOpenEntry) return ended ? 'OUT' : 'BREAK_START';
    if (!context.hasEntriesToday) return 'IN';
    return ended ? 'IN' : 'BREAK_END';
};

/** Ein gespeichertes Arbeitsfenster, so weit die Ableitungen es brauchen. */
export interface DaySpan {
    startedAt: Date;
    endedAt: Date | null;
    durationSeconds: number | null;
}

export interface DayActivityEvent {
    at: Date;
    tag: ScanTag;
}

const minutesOfDate = (date: Date): number => date.getHours() * 60 + date.getMinutes();

/**
 * Die Ereignisliste eines Tages aus seinen Fenstern — für die Tagesübersicht
 * am Tablet.
 *
 * Gespeichert werden FENSTER, nicht Ereignisse: ein Fenster hat einen Anfang
 * und ein Ende, und genau die sind die Scans. Die Kennzeichen werden hier nach
 * DERSELBEN Regel wie in `scanTagFor` vergeben, damit die Übersicht später
 * nichts anderes behauptet als die Begrüssung im Augenblick des Scans.
 */
export const deriveDayActivity = (spans: DaySpan[], plan: ShiftPlan): DayActivityEvent[] => {
    const ordered = [...spans].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const events: DayActivityEvent[] = [];

    ordered.forEach((span, index) => {
        const previous = index > 0 ? ordered[index - 1] : undefined;
        // Nach einem Feierabend ist der nächste Beginn kein Pausenende mehr,
        // sondern ein neuer Arbeitsbeginn.
        const afterClockOut = Boolean(previous?.endedAt && shiftEndReached(plan, minutesOfDate(previous.endedAt)));
        events.push({
            at: span.startedAt,
            tag: index === 0 || afterClockOut ? 'IN' : 'BREAK_END',
        });
        if (span.endedAt) {
            events.push({
                at: span.endedAt,
                tag: shiftEndReached(plan, minutesOfDate(span.endedAt)) ? 'OUT' : 'BREAK_START',
            });
        }
    });

    return events;
};

/**
 * Die DREI Zahlen eines Arbeitstages (Vorgabe 16.08.2026). Sie werden getrennt
 * ausgewiesen und NICHT gegeneinander verrechnet oder an den Plan angeglichen:
 *
 *   grossSeconds      Schichtdauer   — vom ersten Kommen bis zum letzten Gehen
 *   actualWorkSeconds Arbeitszeit    — die Summe der Fenster
 *   breakSeconds      Pausenzeit     — die Lücken dazwischen
 *
 * Es gilt immer `gross = actual + break`. Die Pausenvorgabe des Schichtplans
 * spielt hier bewusst KEINE Rolle: der Bericht zeigt, was tatsächlich gestempelt
 * wurde, nicht was hätte sein sollen.
 */
export interface DaySummary {
    firstStart: Date | null;
    lastEnd: Date | null;
    /** Erstes Kommen bis letztes Gehen. */
    grossSeconds: number;
    /** Summe der Fenster — die tatsächliche Arbeitszeit. */
    actualWorkSeconds: number;
    /** Die Lücken zwischen den Fenstern. */
    breakSeconds: number;
    /** Läuft gerade ein Fenster? */
    open: boolean;
}

/**
 * Ein Tag einer Person auf EINE Zeile gebracht: Kommen, Gehen, Schichtdauer,
 * Arbeitszeit und Pausenzeit nebeneinander statt einer Zeile je Fenster.
 *
 * Solange ein Fenster offen ist, stehen Schichtdauer und Pausenzeit noch nicht
 * fest und bleiben 0 — eine laufende Schicht hat noch keine Bilanz, und eine
 * gegen „jetzt" gerechnete Zahl wäre in der nächsten Minute eine andere.
 */
export const summariseDay = (spans: DaySpan[]): DaySummary => {
    if (spans.length === 0) {
        return { firstStart: null, lastEnd: null, grossSeconds: 0, actualWorkSeconds: 0, breakSeconds: 0, open: false };
    }
    const ordered = [...spans].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const firstStart = ordered[0]!.startedAt;
    const open = ordered.some((span) => span.endedAt === null);
    const lastEnd = open ? null : ordered[ordered.length - 1]!.endedAt;
    const actualWorkSeconds = ordered.reduce((sum, span) => sum + (span.durationSeconds ?? 0), 0);
    const grossSeconds = lastEnd ? Math.max(0, Math.round((lastEnd.getTime() - firstStart.getTime()) / 1000)) : 0;
    return {
        firstStart,
        lastEnd,
        grossSeconds,
        actualWorkSeconds,
        breakSeconds: lastEnd ? Math.max(0, grossSeconds - actualWorkSeconds) : 0,
        open,
    };
};

// ── Urlaubsarten ─────────────────────────────────────────────────────────────

/**
 * Wählbare Urlaubsarten. „Sonstiger Urlaub" (OTHER) ist die offene Art: sie
 * verlangt einen FREITEXT, in dem die antragstellende Person die Art selbst
 * benennt — der Jahresurlaub läuft seit dem 16.08.2026 darüber (Vorgabe) und
 * ist deshalb keine eigene Auswahl mehr.
 *
 * OTHER steht ABSICHTLICH vorn: es ist der häufigste Fall und damit die
 * Vorauswahl des Formulars.
 */
export const LEAVE_TYPES = ['OTHER', 'EXCUSE', 'SICK_SHORT', 'SICK_LONG'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

/**
 * Arten, die nicht mehr gewählt werden können, aber in Altanträgen stehen.
 * Sie müssen weiterhin eine Beschriftung finden, sonst zeigte ein Rapport über
 * einen vergangenen Zeitraum plötzlich einen rohen Schlüssel.
 */
export const LEGACY_LEAVE_TYPES = ['ANNUAL_PAID'] as const;

/** Die Art, die einen Freitext verlangt. */
export const LEAVE_TYPE_WITH_LABEL = 'OTHER';

/** Höchstlänge des Freitexts — passt in die Spalte und in die PDF-Zelle. */
export const LEAVE_TYPE_LABEL_MAX = 120;

export const requiresLeaveTypeLabel = (leaveType: unknown): boolean =>
    String(leaveType) === LEAVE_TYPE_WITH_LABEL;

/**
 * Was auf dem Bildschirm und im PDF als Urlaubsart steht: bei „Sonstiger
 * Urlaub" der eingetippte Text, sonst die Beschriftung der festen Art. Der
 * Aufrufer reicht die übersetzte Beschriftung herein, damit diese Datei ohne
 * i18n-Abhängigkeit auskommt und im Backend wie im Browser gleich rechnet.
 */
export const displayLeaveType = (
    leaveType: unknown,
    customLabel: string | null | undefined,
    translated: string,
): string => {
    const custom = String(customLabel ?? '').trim();
    return requiresLeaveTypeLabel(leaveType) && custom ? custom : translated;
};

/** Homeoffice läuft über dasselbe Antragsmodell, aber ohne Buchhaltungsstufe. */
export const REMOTE_LEAVE_TYPE = 'REMOTE_WORK';

export const LEAVE_KINDS = ['LEAVE', 'REMOTE'] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_STATUSES = ['PENDING_MANAGER', 'PENDING_ACCOUNTING', 'APPROVED', 'REJECTED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const STAFF_ROLES = ['STAFF', 'ADMIN', 'ACCOUNTANT'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const WORK_LOCATIONS = ['OFFICE', 'REMOTE'] as const;
export type WorkLocation = (typeof WORK_LOCATIONS)[number];

/** Nur WÄHLBARE Arten — die Prüfung beim Anlegen eines Antrags. */
export const isLeaveType = (value: unknown): value is LeaveType =>
    LEAVE_TYPES.includes(String(value) as LeaveType);

/** Wählbar ODER Altbestand — für Anzeige und Auswertung bestehender Anträge. */
export const isKnownLeaveType = (value: unknown): boolean =>
    isLeaveType(value) || (LEGACY_LEAVE_TYPES as readonly string[]).includes(String(value));

export const isStaffRole = (value: unknown): value is StaffRole =>
    STAFF_ROLES.includes(String(value) as StaffRole);

export const isWorkLocation = (value: unknown): value is WorkLocation =>
    WORK_LOCATIONS.includes(String(value) as WorkLocation);

/**
 * Der nächste Status nach einer Freigabe.
 * Urlaub geht nach der Freigabe des Vorgesetzten IN DIE BUCHHALTUNG und erst
 * deren Ja schliesst den Antrag ab. Homeoffice ist mit dem Ja des Vorgesetzten
 * fertig — die Buchhaltung sieht es gar nicht (Vorgabe).
 */
export const nextStatusAfterManagerApproval = (kind: LeaveKind): LeaveStatus =>
    kind === 'REMOTE' ? 'APPROVED' : 'PENDING_ACCOUNTING';

// ── Buchhaltungsbericht: Soll- und Ist-Rechnung ──────────────────────────────

export interface AccountingBasis {
    /** Kalendertage im Zeitraum. */
    totalDays: number;
    /** Arbeitstage nach Schichtplan. */
    workdays: number;
    /** Feiertage, die auf einen Arbeitstag fallen (Eingabe des Berichts). */
    publicHolidays: number;
    /** Arbeitstage minus Feiertage, nie negativ. */
    actualWorkdays: number;
    /** Tagesnetto in Stunden (Pause abgezogen). */
    dailyNetHours: number;
    /** Sollstunden = tatsächliche Arbeitstage × Tagesnetto. */
    targetHours: number;
}

/** Auf zwei Nachkommastellen runden — Stundenwerte werden so angezeigt. */
export const round2 = (value: number): number => Math.round(value * 100) / 100;

export const buildAccountingBasis = (
    start: Date,
    end: Date,
    plan: ShiftPlan,
    publicHolidays: number,
): AccountingBasis => {
    const totalDays = countDaysInRange(start, end);
    const workdays = countWorkdaysInRange(start, end, plan.workdays);
    const holidays = Math.min(Math.max(0, Math.trunc(publicHolidays) || 0), workdays);
    const actualWorkdays = Math.max(0, workdays - holidays);
    const dailyNetHours = round2(netShiftMinutes(plan) / 60);
    return {
        totalDays,
        workdays,
        publicHolidays: holidays,
        actualWorkdays,
        dailyNetHours,
        targetHours: round2(actualWorkdays * dailyNetHours),
    };
};

export interface AccountingBalance {
    /** Tatsächlich gestempelte Stunden. */
    totalHours: number;
    /** Fehltage: (Soll − Ist) / Tagesnetto, auf zwei Stellen. */
    daysShort: number;
    /** Mehrtage: (Ist − Soll) / Tagesnetto, auf zwei Stellen. */
    extraDays: number;
}

/**
 * Fehl- und Mehrtage einer Person. Bewusst in TAGEN, nicht in Stunden: der
 * Bericht führt die Spalten „Fehltage" und „Mehrtage", und ein Tag ist genau
 * ein Tagesnetto.
 */
export const buildAccountingBalance = (totalSeconds: number, basis: AccountingBasis): AccountingBalance => {
    const totalHours = round2(totalSeconds / 3600);
    const difference = round2(totalHours - basis.targetHours);
    const perDay = basis.dailyNetHours || 0;
    if (perDay <= 0) {
        return { totalHours, daysShort: 0, extraDays: 0 };
    }
    return {
        totalHours,
        daysShort: difference < 0 ? round2(Math.abs(difference) / perDay) : 0,
        extraDays: difference > 0 ? round2(difference / perDay) : 0,
    };
};

