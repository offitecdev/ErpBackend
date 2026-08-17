"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAccountingBalance = exports.buildAccountingBasis = exports.round2 = exports.nextStatusAfterManagerApproval = exports.isWorkLocation = exports.isStaffRole = exports.isKnownLeaveType = exports.isLeaveType = exports.WORK_LOCATIONS = exports.STAFF_ROLES = exports.LEAVE_STATUSES = exports.LEAVE_KINDS = exports.REMOTE_LEAVE_TYPE = exports.displayLeaveType = exports.requiresLeaveTypeLabel = exports.LEAVE_TYPE_LABEL_MAX = exports.LEAVE_TYPE_WITH_LABEL = exports.LEGACY_LEAVE_TYPES = exports.LEAVE_TYPES = exports.summariseDay = exports.deriveDayActivity = exports.scanTagFor = exports.shiftEndReached = exports.SCAN_TAGS = exports.countWorkdaysInRange = exports.countDaysInRange = exports.startOfIsoWeek = exports.addDays = exports.isoWeekday = exports.toDateKey = exports.endOfDay = exports.startOfDay = exports.parseDateOnly = exports.weeklyNetMinutes = exports.netShiftMinutes = exports.grossShiftMinutes = exports.parseShiftPlan = exports.minutesOfDay = exports.normalizeTime = exports.WEEKEND_DAYS = exports.WEEKDAY_KEYS = exports.DEFAULT_SHIFT_PLAN = void 0;
/** Mo–Fr, 08:00–17:00, 45 min Pause — bis jemand einen Plan speichert. */
exports.DEFAULT_SHIFT_PLAN = {
    workdays: [1, 2, 3, 4, 5],
    startTime: '08:00',
    endTime: '17:00',
    breakMinutes: 45,
};
exports.WEEKDAY_KEYS = [1, 2, 3, 4, 5, 6, 7];
/** Sa + So — der „Wochenende"-Schnellschalter der Planungsseite. */
exports.WEEKEND_DAYS = [6, 7];
const clampInt = (value, min, max, fallback) => {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
};
/** "HH:MM" prüfen und normalisieren; unlesbares fällt auf `fallback` zurück. */
const normalizeTime = (value, fallback) => {
    const text = String(value ?? '').trim();
    const match = /^(\d{1,2}):(\d{1,2})$/.exec(text);
    if (!match)
        return fallback;
    const hours = clampInt(match[1], 0, 23, 0);
    const minutes = clampInt(match[2], 0, 59, 0);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};
exports.normalizeTime = normalizeTime;
/** Minuten seit Mitternacht. */
const minutesOfDay = (time) => {
    const [hours, minutes] = (0, exports.normalizeTime)(time, '00:00').split(':');
    return Number(hours) * 60 + Number(minutes);
};
exports.minutesOfDay = minutesOfDay;
const parseShiftPlan = (raw) => {
    const input = (raw && typeof raw === 'object' ? raw : {});
    const rawDays = Array.isArray(input.workdays) ? input.workdays : exports.DEFAULT_SHIFT_PLAN.workdays;
    const workdays = [...new Set(rawDays
            .map((day) => Math.trunc(Number(day)))
            .filter((day) => day >= 1 && day <= 7))].sort((a, b) => a - b);
    return {
        workdays: workdays.length ? workdays : [...exports.DEFAULT_SHIFT_PLAN.workdays],
        startTime: (0, exports.normalizeTime)(input.startTime, exports.DEFAULT_SHIFT_PLAN.startTime),
        endTime: (0, exports.normalizeTime)(input.endTime, exports.DEFAULT_SHIFT_PLAN.endTime),
        breakMinutes: clampInt(input.breakMinutes, 0, 12 * 60, exports.DEFAULT_SHIFT_PLAN.breakMinutes),
    };
};
exports.parseShiftPlan = parseShiftPlan;
/**
 * Bruttodauer der Schicht in Minuten. Endet die Schicht rechnerisch vor ihrem
 * Beginn, läuft sie über Mitternacht (Nachtschicht) und bekommt einen Tag dazu.
 */
const grossShiftMinutes = (plan) => {
    const start = (0, exports.minutesOfDay)(plan.startTime);
    const end = (0, exports.minutesOfDay)(plan.endTime);
    return end > start ? end - start : end + 24 * 60 - start;
};
exports.grossShiftMinutes = grossShiftMinutes;
/** Tagesnetto = brutto minus Pause, nie negativ. */
const netShiftMinutes = (plan) => Math.max(0, (0, exports.grossShiftMinutes)(plan) - plan.breakMinutes);
exports.netShiftMinutes = netShiftMinutes;
/** Wochennetto = Tagesnetto × Anzahl geplanter Arbeitstage. */
const weeklyNetMinutes = (plan) => (0, exports.netShiftMinutes)(plan) * plan.workdays.length;
exports.weeklyNetMinutes = weeklyNetMinutes;
// ── Datumshilfen (kalendarisch, ohne Zeitzonen-Verschiebung) ─────────────────
/** "YYYY-MM-DD" → lokale Mitternacht. Ungültiges ergibt null. */
const parseDateOnly = (value) => {
    const text = String(value ?? '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (!match) {
        const parsed = new Date(text);
        return Number.isNaN(parsed.getTime()) ? null : (0, exports.startOfDay)(parsed);
    }
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
};
exports.parseDateOnly = parseDateOnly;
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
exports.startOfDay = startOfDay;
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
exports.endOfDay = endOfDay;
const toDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
exports.toDateKey = toDateKey;
/** ISO-Wochentag: Mo=1 … So=7 (JavaScript liefert So=0). */
const isoWeekday = (date) => date.getDay() === 0 ? 7 : date.getDay();
exports.isoWeekday = isoWeekday;
const addDays = (date, days) => {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
};
exports.addDays = addDays;
/** Montag der Woche, in der `date` liegt. */
const startOfIsoWeek = (date) => (0, exports.startOfDay)((0, exports.addDays)(date, -((0, exports.isoWeekday)(date) - 1)));
exports.startOfIsoWeek = startOfIsoWeek;
/** Kalendertage im Zeitraum, beide Enden eingeschlossen. */
const countDaysInRange = (start, end) => {
    if (end < start)
        return 0;
    const from = (0, exports.startOfDay)(start).getTime();
    const to = (0, exports.startOfDay)(end).getTime();
    return Math.round((to - from) / 86_400_000) + 1;
};
exports.countDaysInRange = countDaysInRange;
/** Arbeitstage im Zeitraum nach Schichtplan (Feiertage NICHT abgezogen). */
const countWorkdaysInRange = (start, end, workdays) => {
    if (end < start)
        return 0;
    const days = new Set(workdays);
    let count = 0;
    for (let cursor = (0, exports.startOfDay)(start); cursor <= end; cursor = (0, exports.addDays)(cursor, 1)) {
        if (days.has((0, exports.isoWeekday)(cursor)))
            count += 1;
    }
    return count;
};
exports.countWorkdaysInRange = countWorkdaysInRange;
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
exports.SCAN_TAGS = ['IN', 'BREAK_START', 'BREAK_END', 'OUT'];
/**
 * Ist die geplante Schicht zu diesem Zeitpunkt vorbei?
 *
 * Läuft die Schicht über Mitternacht, liegt das Ende rechnerisch VOR dem
 * Beginn; dann gibt es vor Mitternacht kein „ab Schichtende" und die Frage
 * wird verneint — sonst wäre auf einer Nachtschicht JEDER Scan ein Feierabend.
 */
const shiftEndReached = (plan, minutes) => {
    const startMinutes = (0, exports.minutesOfDay)(plan.startTime);
    const endMinutes = (0, exports.minutesOfDay)(plan.endTime);
    if (endMinutes <= startMinutes)
        return false;
    return minutes >= endMinutes;
};
exports.shiftEndReached = shiftEndReached;
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
const scanTagFor = (plan, context) => {
    const ended = (0, exports.shiftEndReached)(plan, context.nowMinutes);
    if (context.hasOpenEntry)
        return ended ? 'OUT' : 'BREAK_START';
    if (!context.hasEntriesToday)
        return 'IN';
    return ended ? 'IN' : 'BREAK_END';
};
exports.scanTagFor = scanTagFor;
const minutesOfDate = (date) => date.getHours() * 60 + date.getMinutes();
/**
 * Die Ereignisliste eines Tages aus seinen Fenstern — für die Tagesübersicht
 * am Tablet.
 *
 * Gespeichert werden FENSTER, nicht Ereignisse: ein Fenster hat einen Anfang
 * und ein Ende, und genau die sind die Scans. Die Kennzeichen werden hier nach
 * DERSELBEN Regel wie in `scanTagFor` vergeben, damit die Übersicht später
 * nichts anderes behauptet als die Begrüssung im Augenblick des Scans.
 */
const deriveDayActivity = (spans, plan) => {
    const ordered = [...spans].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const events = [];
    ordered.forEach((span, index) => {
        const previous = index > 0 ? ordered[index - 1] : undefined;
        // Nach einem Feierabend ist der nächste Beginn kein Pausenende mehr,
        // sondern ein neuer Arbeitsbeginn.
        const afterClockOut = Boolean(previous?.endedAt && (0, exports.shiftEndReached)(plan, minutesOfDate(previous.endedAt)));
        events.push({
            at: span.startedAt,
            tag: index === 0 || afterClockOut ? 'IN' : 'BREAK_END',
        });
        if (span.endedAt) {
            events.push({
                at: span.endedAt,
                tag: (0, exports.shiftEndReached)(plan, minutesOfDate(span.endedAt)) ? 'OUT' : 'BREAK_START',
            });
        }
    });
    return events;
};
exports.deriveDayActivity = deriveDayActivity;
/**
 * Ein Tag einer Person auf EINE Zeile gebracht: Kommen, Gehen, Schichtdauer,
 * Arbeitszeit und Pausenzeit nebeneinander statt einer Zeile je Fenster.
 *
 * Solange ein Fenster offen ist, stehen Schichtdauer und Pausenzeit noch nicht
 * fest und bleiben 0 — eine laufende Schicht hat noch keine Bilanz, und eine
 * gegen „jetzt" gerechnete Zahl wäre in der nächsten Minute eine andere.
 */
const summariseDay = (spans) => {
    if (spans.length === 0) {
        return { firstStart: null, lastEnd: null, grossSeconds: 0, actualWorkSeconds: 0, breakSeconds: 0, open: false };
    }
    const ordered = [...spans].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const firstStart = ordered[0].startedAt;
    const open = ordered.some((span) => span.endedAt === null);
    const lastEnd = open ? null : ordered[ordered.length - 1].endedAt;
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
exports.summariseDay = summariseDay;
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
exports.LEAVE_TYPES = ['OTHER', 'EXCUSE', 'SICK_SHORT', 'SICK_LONG'];
/**
 * Arten, die nicht mehr gewählt werden können, aber in Altanträgen stehen.
 * Sie müssen weiterhin eine Beschriftung finden, sonst zeigte ein Rapport über
 * einen vergangenen Zeitraum plötzlich einen rohen Schlüssel.
 */
exports.LEGACY_LEAVE_TYPES = ['ANNUAL_PAID'];
/** Die Art, die einen Freitext verlangt. */
exports.LEAVE_TYPE_WITH_LABEL = 'OTHER';
/** Höchstlänge des Freitexts — passt in die Spalte und in die PDF-Zelle. */
exports.LEAVE_TYPE_LABEL_MAX = 120;
const requiresLeaveTypeLabel = (leaveType) => String(leaveType) === exports.LEAVE_TYPE_WITH_LABEL;
exports.requiresLeaveTypeLabel = requiresLeaveTypeLabel;
/**
 * Was auf dem Bildschirm und im PDF als Urlaubsart steht: bei „Sonstiger
 * Urlaub" der eingetippte Text, sonst die Beschriftung der festen Art. Der
 * Aufrufer reicht die übersetzte Beschriftung herein, damit diese Datei ohne
 * i18n-Abhängigkeit auskommt und im Backend wie im Browser gleich rechnet.
 */
const displayLeaveType = (leaveType, customLabel, translated) => {
    const custom = String(customLabel ?? '').trim();
    return (0, exports.requiresLeaveTypeLabel)(leaveType) && custom ? custom : translated;
};
exports.displayLeaveType = displayLeaveType;
/** Homeoffice läuft über dasselbe Antragsmodell, aber ohne Buchhaltungsstufe. */
exports.REMOTE_LEAVE_TYPE = 'REMOTE_WORK';
exports.LEAVE_KINDS = ['LEAVE', 'REMOTE'];
exports.LEAVE_STATUSES = ['PENDING_MANAGER', 'PENDING_ACCOUNTING', 'APPROVED', 'REJECTED'];
exports.STAFF_ROLES = ['STAFF', 'ADMIN', 'ACCOUNTANT'];
exports.WORK_LOCATIONS = ['OFFICE', 'REMOTE'];
/** Nur WÄHLBARE Arten — die Prüfung beim Anlegen eines Antrags. */
const isLeaveType = (value) => exports.LEAVE_TYPES.includes(String(value));
exports.isLeaveType = isLeaveType;
/** Wählbar ODER Altbestand — für Anzeige und Auswertung bestehender Anträge. */
const isKnownLeaveType = (value) => (0, exports.isLeaveType)(value) || exports.LEGACY_LEAVE_TYPES.includes(String(value));
exports.isKnownLeaveType = isKnownLeaveType;
const isStaffRole = (value) => exports.STAFF_ROLES.includes(String(value));
exports.isStaffRole = isStaffRole;
const isWorkLocation = (value) => exports.WORK_LOCATIONS.includes(String(value));
exports.isWorkLocation = isWorkLocation;
/**
 * Der nächste Status nach einer Freigabe.
 * Urlaub geht nach der Freigabe des Vorgesetzten IN DIE BUCHHALTUNG und erst
 * deren Ja schliesst den Antrag ab. Homeoffice ist mit dem Ja des Vorgesetzten
 * fertig — die Buchhaltung sieht es gar nicht (Vorgabe).
 */
const nextStatusAfterManagerApproval = (kind) => kind === 'REMOTE' ? 'APPROVED' : 'PENDING_ACCOUNTING';
exports.nextStatusAfterManagerApproval = nextStatusAfterManagerApproval;
/** Auf zwei Nachkommastellen runden — Stundenwerte werden so angezeigt. */
const round2 = (value) => Math.round(value * 100) / 100;
exports.round2 = round2;
const buildAccountingBasis = (start, end, plan, publicHolidays) => {
    const totalDays = (0, exports.countDaysInRange)(start, end);
    const workdays = (0, exports.countWorkdaysInRange)(start, end, plan.workdays);
    const holidays = Math.min(Math.max(0, Math.trunc(publicHolidays) || 0), workdays);
    const actualWorkdays = Math.max(0, workdays - holidays);
    const dailyNetHours = (0, exports.round2)((0, exports.netShiftMinutes)(plan) / 60);
    return {
        totalDays,
        workdays,
        publicHolidays: holidays,
        actualWorkdays,
        dailyNetHours,
        targetHours: (0, exports.round2)(actualWorkdays * dailyNetHours),
    };
};
exports.buildAccountingBasis = buildAccountingBasis;
/**
 * Fehl- und Mehrtage einer Person. Bewusst in TAGEN, nicht in Stunden: der
 * Bericht führt die Spalten „Fehltage" und „Mehrtage", und ein Tag ist genau
 * ein Tagesnetto.
 */
const buildAccountingBalance = (totalSeconds, basis) => {
    const totalHours = (0, exports.round2)(totalSeconds / 3600);
    const difference = (0, exports.round2)(totalHours - basis.targetHours);
    const perDay = basis.dailyNetHours || 0;
    if (perDay <= 0) {
        return { totalHours, daysShort: 0, extraDays: 0 };
    }
    return {
        totalHours,
        daysShort: difference < 0 ? (0, exports.round2)(Math.abs(difference) / perDay) : 0,
        extraDays: difference > 0 ? (0, exports.round2)(difference / perDay) : 0,
    };
};
exports.buildAccountingBalance = buildAccountingBalance;
//# sourceMappingURL=personnel.js.map