/**
 * ── PERSONALAKTE: FEIERTAGE, ABWESENHEITEN, URLAUBSKONTO (26.08.2026) ────────
 *
 * Der Rapportbau (`personnelReports.ts`) beantwortet «wie lange war jemand
 * da». Diese Datei beantwortet die drei Fragen daneben:
 *
 *   FEIERTAGE       Welche Tage im Zeitraum sind arbeitsfrei? Sie zählen weder
 *                   gegen das Sollpensum noch als Fehltag, und ein Urlaubs-
 *                   antrag verbraucht sie nicht.
 *
 *   ABWESENHEITEN   «Abwesenheiten werden automatisch als Tage erfasst, an
 *                   denen die Person nicht zur Arbeit erschienen ist oder an
 *                   denen sie Urlaub genommen hat» (Vorgabe). Sie werden
 *                   deshalb ABGELEITET und nirgends gespeichert: ein
 *                   geplanter Arbeitstag ohne Stempelung ist eine Abwesenheit,
 *                   und wofür sie steht, sagt der bewilligte Antrag, der auf
 *                   denselben Tag fällt.
 *
 *   URLAUBSKONTO    Erworbener Anspruch (anteilig nach geleisteten
 *                   Arbeitstagen), verbrauchter und offener Jahresurlaub.
 *
 * Alles davon ist RECHNUNG, keine Buchung. Es gibt keinen nächtlichen Lauf,
 * der Abwesenheiten schreibt — er würde nur veralten, sobald jemand eine
 * Stempelung nachträgt oder ein Antrag rückwirkend bewilligt wird.
 */
import { Prisma } from '@prisma/client';
import prisma from '../../infrastructure/database/prisma.client';
import { employeeScopeSql } from '../../presentation/controllers/serviceTenantScope';
import {
    addDays,
    buildLeaveEntitlement,
    consumesEntitlement,
    countWorkdaysInRange,
    isoWeekday,
    requestTypeOf,
    roundHalf,
    startOfDay,
    endOfDay,
    toDateKey,
    type LeaveEntitlement,
    type LeavePolicy,
    type ShiftPlan,
} from '../../shared/personnel';
import { loadLeaveFlags, loadStaffForReport, loadTimeEntries, buildRemoteEntries, type LeaveFlag, type StaffRow } from './personnelReports';

// ── Feiertage ────────────────────────────────────────────────────────────────

export interface HolidayRow {
    id: string;
    date: Date;
    name: string;
    catalogKey: string | null;
    countryCode: string;
    religious: boolean;
    halfDay: boolean;
}

/**
 * Die geführten Feiertage eines Zeitraums. Sie hängen am STAMM des
 * Firmenbaums — dieselbe Regel wie Schichtplan und Urlaubsregel: Personal ist
 * baumweit geteilt, also müssen es auch seine arbeitsfreien Tage sein.
 */
export const loadHolidays = async (
    tenantId: string,
    start: Date,
    end: Date,
): Promise<HolidayRow[]> => {
    const rows = await prisma.publicHoliday.findMany({
        where: { tenantId, date: { gte: startOfDay(start), lte: endOfDay(end) } },
        orderBy: { date: 'asc' },
    });
    return rows.map((row) => ({
        id: row.id,
        date: new Date(row.date),
        name: row.name,
        catalogKey: row.catalogKey,
        countryCode: row.countryCode,
        religious: row.religious,
        halfDay: row.halfDay,
    }));
};

/** Tagesschlüssel → Feiertag. Fallen zwei auf denselben Tag, gewinnt der ganze. */
export const holidayIndex = (holidays: HolidayRow[]): Map<string, HolidayRow> => {
    const map = new Map<string, HolidayRow>();
    for (const holiday of holidays) {
        const key = toDateKey(holiday.date);
        const existing = map.get(key);
        if (!existing || (existing.halfDay && !holiday.halfDay)) map.set(key, holiday);
    }
    return map;
};

/**
 * Arbeitstage im Zeitraum OHNE die Feiertage, die auf einen Arbeitstag fallen.
 * Ein halber Feiertag (Arife) zieht einen halben Tag ab.
 */
export const workdaysWithoutHolidays = (
    start: Date,
    end: Date,
    plan: ShiftPlan,
    holidays: Map<string, HolidayRow>,
): number => {
    const workdays = new Set(plan.workdays);
    let count = 0;
    for (let cursor = startOfDay(start); cursor <= end; cursor = addDays(cursor, 1)) {
        if (!workdays.has(isoWeekday(cursor))) continue;
        const holiday = holidays.get(toDateKey(cursor));
        count += holiday ? (holiday.halfDay ? 0.5 : 0) : 1;
    }
    return roundHalf(count);
};

// ── Abwesenheiten ────────────────────────────────────────────────────────────

/**
 * Wofür ein fehlender Tag steht. `ABSENT` ist der Rest: erschienen ist niemand,
 * und ein Antrag, der es erklärte, gibt es nicht.
 */
export const ABSENCE_KINDS = ['ABSENT', 'VACATION', 'SICK', 'REMOTE', 'OTHER'] as const;
export type AbsenceKind = (typeof ABSENCE_KINDS)[number];

export interface AbsenceDay {
    /** YYYY-MM-DD */
    date: string;
    kind: AbsenceKind;
    /** Der Antrag, der den Tag erklärt — null bei einer unerklärten Abwesenheit. */
    requestId: string | null;
    /** Der Freitext der Antragsart, falls einer erfasst wurde. */
    label: string | null;
    /** true = der Antrag ist noch nicht endgültig bewilligt. */
    pending: boolean;
}

/**
 * Die Abwesenheiten EINER Person im Zeitraum.
 *
 * Ein Tag ist abwesend, wenn er
 *   • ein geplanter Arbeitstag ist,
 *   • kein Feiertag ist,
 *   • nicht vor dem Eintritt der Person liegt,
 *   • nicht in der Zukunft liegt (was noch kommt, ist keine Abwesenheit —
 *     ausser ein bewilligter Antrag deckt ihn bereits ab), und
 *   • keine Arbeitszeit trägt (weder gestempelt noch aus dem Homeoffice
 *     abgeleitet).
 *
 * Bewilligtes HOMEOFFICE ist deshalb KEINE Abwesenheit: der Rapportbau leitet
 * dafür ein volles Tagessoll ab, der Tag trägt also Arbeitszeit. Ein noch
 * offener Homeoffice-Antrag hingegen trägt keine — er erscheint als geplante
 * Abwesenheit mit `pending`.
 */
export const buildAbsences = (input: {
    start: Date;
    end: Date;
    plan: ShiftPlan;
    holidays: Map<string, HolidayRow>;
    /** Tagesschlüssel mit Arbeitszeit (gestempelt oder abgeleitet). */
    workedDayKeys: Set<string>;
    /** Die Anträge, die den Zeitraum berühren (ohne abgelehnte). */
    flags: LeaveFlag[];
    /** Eintritt bzw. Anlage der Person — davor gibt es keine Abwesenheit. */
    since: Date;
    /** Bis wohin überhaupt geurteilt wird (in der Regel: heute). */
    until: Date;
}): AbsenceDay[] => {
    const workdays = new Set(input.plan.workdays);
    const since = startOfDay(input.since);
    const until = startOfDay(input.until);

    /* Ein Tagesschlüssel → der Antrag, der ihn abdeckt. Der zuletzt
       eingetragene gewinnt nicht: ein BEWILLIGTER Antrag schlägt einen offenen,
       weil er die stärkere Aussage über den Tag ist. */
    const byDay = new Map<string, LeaveFlag>();
    for (const flag of input.flags) {
        for (let cursor = startOfDay(flag.startDate); cursor <= flag.endDate; cursor = addDays(cursor, 1)) {
            if (!workdays.has(isoWeekday(cursor))) continue;
            const key = toDateKey(cursor);
            const existing = byDay.get(key);
            if (!existing || (existing.status !== 'APPROVED' && flag.status === 'APPROVED')) {
                byDay.set(key, flag);
            }
        }
    }

    const rows: AbsenceDay[] = [];
    for (let cursor = startOfDay(input.start); cursor <= input.end; cursor = addDays(cursor, 1)) {
        if (!workdays.has(isoWeekday(cursor))) continue;
        if (cursor < since) continue;
        const key = toDateKey(cursor);
        if (input.holidays.has(key)) continue;
        if (input.workedDayKeys.has(key)) continue;

        const flag = byDay.get(key) ?? null;
        // Zukunft ohne Antrag ist keine Abwesenheit, sondern schlicht: noch nicht da.
        if (cursor > until && !flag) continue;

        if (!flag) {
            rows.push({ date: key, kind: 'ABSENT', requestId: null, label: null, pending: false });
            continue;
        }

        const requestType = requestTypeOf(flag.kind, flag.leaveType);
        const kind: AbsenceKind = requestType === 'VACATION'
            ? 'VACATION'
            : requestType === 'SICK'
                ? 'SICK'
                : requestType === 'REMOTE'
                    ? 'REMOTE'
                    : 'OTHER';
        rows.push({
            date: key,
            kind,
            requestId: flag.id,
            label: flag.leaveTypeLabel,
            pending: flag.status !== 'APPROVED',
        });
    }
    return rows;
};

// ── Urlaubskonto ─────────────────────────────────────────────────────────────

export interface LeaveYear {
    year: number;
    policy: LeavePolicy;
    entitlement: LeaveEntitlement;
    holidays: HolidayRow[];
    absences: AbsenceDay[];
    /** Arbeitstage mit mindestens einer Stempelung (bzw. Homeoffice-Tag). */
    workedDays: number;
    /** Arbeitstage des Jahres bis heute, ohne Feiertage. */
    referenceWorkdays: number;
}

/**
 * Das Urlaubsjahr EINER Person: Anspruch, Feiertage und Abwesenheiten in einem
 * Zug. Der Nenner des Anspruchs sind die Arbeitstage BIS HEUTE (nicht des
 * ganzen Jahres) — sonst hätte jemand im Januar rechnerisch fast keinen
 * Anspruch, obwohl er jeden Tag gearbeitet hat.
 */
export const buildLeaveYear = async (input: {
    tenantIds: string[];
    shiftPlanTenantId: string;
    employeeId: string;
    year: number;
    plan: ShiftPlan;
    policy: LeavePolicy;
    /** Eintritt/Anlage der Person. */
    since: Date;
}): Promise<LeaveYear> => {
    const yearStart = new Date(input.year, 0, 1, 0, 0, 0, 0);
    const yearEnd = new Date(input.year, 11, 31, 23, 59, 59, 999);
    const today = new Date();
    // Ein vergangenes Jahr ist ganz vorbei; das laufende endet heute.
    const asOf = today < yearEnd ? today : yearEnd;

    const staff = await loadStaffForReport(input.tenantIds, {
        start: yearStart,
        end: yearEnd,
        employeeId: input.employeeId,
    });
    const person = staff[0];
    if (!person) {
        const empty = buildLeaveEntitlement({
            year: input.year, policy: input.policy, workedDays: 0,
            referenceWorkdays: 1, usedDays: 0, pendingDays: 0,
        });
        return {
            year: input.year, policy: input.policy, entitlement: empty,
            holidays: [], absences: [], workedDays: 0, referenceWorkdays: 0,
        };
    }

    const [stamped, flags, holidayRows] = await Promise.all([
        loadTimeEntries([person], yearStart, yearEnd),
        loadLeaveFlags([person.id], yearStart, yearEnd),
        loadHolidays(input.shiftPlanTenantId, yearStart, yearEnd),
    ]);

    const derived = buildRemoteEntries([person], stamped, flags, input.plan, yearStart, yearEnd);
    const workedDayKeys = new Set<string>();
    for (const entry of [...stamped, ...derived]) workedDayKeys.add(toDateKey(entry.workDate));

    const holidays = holidayIndex(holidayRows);
    const since = input.since > yearStart ? input.since : yearStart;

    /* Der Nenner: Arbeitstage seit dem Eintritt bis heute, ohne Feiertage.
       Wer im September eingetreten ist, wird nicht an einem ganzen Jahr
       gemessen — sonst wäre sein Anspruch dauerhaft ein Bruchteil dessen, was
       er tatsächlich erarbeitet hat. */
    const referenceWorkdays = asOf >= since
        ? workdaysWithoutHolidays(since, asOf, input.plan, holidays)
        : 0;

    /* Verbrauch: NUR Jahresurlaub zehrt am Konto. Bewilligtes zählt als
       verbraucht, Offenes als reserviert — beides muss vom Rest abgehen,
       sonst verspricht das Konto Tage, die schon vergeben sind. */
    let usedDays = 0;
    let pendingDays = 0;
    for (const flag of flags) {
        if (!consumesEntitlement(flag.kind, flag.leaveType)) continue;
        // Nur die Tage, die IN DIESES Jahr fallen (ein Antrag darf über den
        // Jahreswechsel laufen).
        const from = flag.startDate > yearStart ? flag.startDate : yearStart;
        const to = flag.endDate < yearEnd ? flag.endDate : yearEnd;
        const days = workdaysWithoutHolidays(from, to, input.plan, holidays);
        if (flag.status === 'APPROVED') usedDays += days;
        else pendingDays += days;
    }

    const absences = buildAbsences({
        start: yearStart,
        end: yearEnd,
        plan: input.plan,
        holidays,
        workedDayKeys,
        flags,
        since,
        until: today,
    });

    return {
        year: input.year,
        policy: input.policy,
        entitlement: buildLeaveEntitlement({
            year: input.year,
            policy: input.policy,
            workedDays: workedDayKeys.size,
            referenceWorkdays,
            usedDays,
            pendingDays,
        }),
        holidays: holidayRows,
        absences,
        workedDays: workedDayKeys.size,
        referenceWorkdays,
    };
};

// ── Arbeitszeitrapport: die Zusammenfassung je Person ────────────────────────

export interface TimeRecordPerson {
    employeeId: string;
    staffNumber: number | null;
    firstName: string;
    lastName: string;
    email: string;
    workLocation: string;
    /** Tatsächlich geleistete Zeit (Summe der Fenster). */
    totalSeconds: number;
    totalHours: number;
    /** Schichtdauer und Pausen, getrennt geführt wie im Detailrapport. */
    grossSeconds: number;
    breakSeconds: number;
    /** Tage mit mindestens einer Stempelung. */
    presentDays: number;
    /** Geplante Arbeitstage ohne Leistung. */
    absentDays: number;
    /** Davon durch einen Antrag erklärt. */
    leaveDays: number;
    sickDays: number;
    /** Sollstunden im Zeitraum (Arbeitstage ohne Feiertage × Tagesnetto). */
    targetHours: number;
    /** Differenz in Tagen — wie im Buchhaltungsrapport. */
    daysShort: number;
    extraDays: number;
}

/** Die Personen, auf die die Suche der Arbeitszeiterfassung passt. */
export const staffSearchCondition = (search: string): Prisma.Sql | null => {
    const text = search.trim();
    if (!text) return null;
    const like = `%${text}%`;
    return Prisma.sql`(e.firstName LIKE ${like} OR e.lastName LIKE ${like} OR e.email LIKE ${like}
        OR CONCAT(e.firstName, ' ', e.lastName) LIKE ${like})`;
};

/** Wie `StaffRow`, aber mit der Adresse: die Arbeitszeiterfassung sucht danach. */
export interface StaffSearchRow extends StaffRow {
    email: string;
}

/**
 * Die Personen einer Freitextsuche — ein Feld statt Vor- und Nachname
 * getrennt (Vorgabe 26.08.2026: «erweiterte Suche über alle Mitarbeitenden»).
 * `employeeIds` schränkt zusätzlich auf eine Auswahl ein.
 */
export const loadStaffForSearch = async (
    tenantIds: string[],
    options: { search?: string; employeeIds?: string[] },
): Promise<StaffSearchRow[]> => {
    if (tenantIds.length === 0) return [];

    const conditions: Prisma.Sql[] = [
        employeeScopeSql(tenantIds),
        Prisma.sql`e.deletedAt IS NULL`,
    ];
    const search = staffSearchCondition(options.search ?? '');
    if (search) conditions.push(search);
    if (options.employeeIds?.length) {
        conditions.push(Prisma.sql`e.id IN (${Prisma.join(options.employeeIds)})`);
    }

    const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT e.id, e.staffNumber, e.firstName, e.lastName, e.email, e.createdAt, e.workLocation
        FROM Employee e
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY e.staffNumber IS NULL, e.staffNumber ASC, e.lastName ASC, e.firstName ASC
        LIMIT 400
    `);

    return rows.map((row) => ({
        id: String(row.id),
        staffNumber: row.staffNumber == null ? null : Number(row.staffNumber),
        firstName: String(row.firstName ?? ''),
        lastName: String(row.lastName ?? ''),
        email: String(row.email ?? ''),
        createdAt: new Date(row.createdAt),
        workLocation: String(row.workLocation ?? 'OFFICE'),
    }));
};
