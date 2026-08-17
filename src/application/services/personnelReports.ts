/**
 * ── PERSONALBERICHTE: DATENZUSAMMENBAU ───────────────────────────────────────
 *
 * Der Detail- und der Buchhaltungsbericht lesen dieselben Zeilen, fassen sie nur
 * anders zusammen. Damit die beiden Seiten nie auseinanderlaufen, holt diese
 * Datei die Zeilen EINMAL und liefert beide Sichten daraus.
 *
 * Warum $queryRaw und nicht findMany+include: die Datenbank liegt entfernt, jede
 * Anweisung kostet einen Netzwerkweg. Ein `include: { employee: true }` löst je
 * Beziehung eine EIGENE Folgeanweisung aus — bei einem Monatsbericht über 30
 * Personen war das der Unterschied zwischen einem und dutzenden Wegen.
 *
 * DAUERHAFTES HOMEOFFICE: Personen mit `workLocation = 'REMOTE'` und bewilligte
 * Homeoffice-Anträge stempeln nicht. Ihre Tage entstehen deshalb hier ABGELEITET
 * (`source: 'REMOTE'`, `synthetic: true`) — ein volles Tagessoll je geplantem
 * Arbeitstag ohne eigene Stempelung. So steht im Bericht dasselbe, was ein
 * nächtlicher Job hineingeschrieben hätte, ohne einen Job zu brauchen.
 */
import { Prisma } from '@prisma/client';
import prisma from '../../infrastructure/database/prisma.client';
import {
    addDays,
    buildAccountingBalance,
    buildAccountingBasis,
    countWorkdaysInRange,
    isoWeekday,
    minutesOfDay,
    netShiftMinutes,
    startOfDay,
    summariseDay,
    toDateKey,
    type AccountingBasis,
    type ShiftPlan,
} from '../../shared/personnel';

export interface ReportFilters {
    start: Date;
    end: Date;
    firstName?: string | undefined;
    lastName?: string | undefined;
    employeeId?: string | undefined;
}

export interface StaffRow {
    id: string;
    staffNumber: number | null;
    firstName: string;
    lastName: string;
    createdAt: Date;
    workLocation: string;
}

export interface ReportEntry {
    /** Abgeleitete Homeoffice-Tage haben keine Zeile und damit keine id. */
    id: string | null;
    employeeId: string;
    staffNumber: number | null;
    firstName: string;
    lastName: string;
    /** OFFICE | REMOTE — der Detailbericht markiert dauerhaftes Homeoffice. */
    workLocation: string;
    employeeCreatedAt: Date;
    workDate: Date;
    startedAt: Date | null;
    endedAt: Date | null;
    durationSeconds: number;
    source: string;
    note: string | null;
    synthetic: boolean;
}

export interface LeaveFlag {
    id: string;
    employeeId: string;
    kind: string;
    leaveType: string;
    /** Freitext zu leaveType 'OTHER' — die selbst benannte Art. */
    leaveTypeLabel: string | null;
    status: string;
    startDate: Date;
    endDate: Date;
    totalDays: number;
    note: string | null;
}

const likeOrNull = (value?: string) => {
    const text = (value ?? '').trim();
    return text ? `%${text}%` : null;
};

/** Die Personen des Firmenbaums, auf die die Namensfilter des Berichts passen. */
export const loadStaffForReport = async (
    tenantIds: string[],
    filters: ReportFilters,
): Promise<StaffRow[]> => {
    if (tenantIds.length === 0) return [];

    const conditions: Prisma.Sql[] = [
        Prisma.sql`e.tenantId IN (${Prisma.join(tenantIds)})`,
        Prisma.sql`e.deletedAt IS NULL`,
    ];
    const firstName = likeOrNull(filters.firstName);
    if (firstName) conditions.push(Prisma.sql`e.firstName LIKE ${firstName}`);
    const lastName = likeOrNull(filters.lastName);
    if (lastName) conditions.push(Prisma.sql`e.lastName LIKE ${lastName}`);
    if (filters.employeeId) conditions.push(Prisma.sql`e.id = ${filters.employeeId}`);

    const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT e.id, e.staffNumber, e.firstName, e.lastName, e.createdAt, e.workLocation
        FROM Employee e
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY e.staffNumber IS NULL, e.staffNumber ASC, e.lastName ASC, e.firstName ASC
    `);

    return rows.map((row) => ({
        id: String(row.id),
        staffNumber: row.staffNumber == null ? null : Number(row.staffNumber),
        firstName: String(row.firstName ?? ''),
        lastName: String(row.lastName ?? ''),
        createdAt: new Date(row.createdAt),
        workLocation: String(row.workLocation ?? 'OFFICE'),
    }));
};

/** Bewilligte Abwesenheiten, die den Zeitraum berühren (Ausrufezeichen-Marker). */
export const loadLeaveFlags = async (
    employeeIds: string[],
    start: Date,
    end: Date,
): Promise<LeaveFlag[]> => {
    if (employeeIds.length === 0) return [];
    const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT l.id, l.employeeId, l.kind, l.leaveType, l.leaveTypeLabel, l.status,
               l.startDate, l.endDate, l.totalDays, l.note
        FROM StaffLeaveRequest l
        WHERE l.employeeId IN (${Prisma.join(employeeIds)})
          AND l.status <> 'REJECTED'
          AND l.startDate <= ${end}
          AND l.endDate >= ${start}
        ORDER BY l.startDate ASC
    `);
    return rows.map((row) => ({
        id: String(row.id),
        employeeId: String(row.employeeId),
        kind: String(row.kind ?? 'LEAVE'),
        leaveType: String(row.leaveType ?? ''),
        leaveTypeLabel: row.leaveTypeLabel == null ? null : String(row.leaveTypeLabel),
        status: String(row.status ?? ''),
        startDate: new Date(row.startDate),
        endDate: new Date(row.endDate),
        totalDays: Number(row.totalDays ?? 0),
        note: row.note == null ? null : String(row.note),
    }));
};

/** Ein Tagesschlüssel-Set aller Tage, die eine Abwesenheit abdeckt. */
const remoteDayKeys = (flags: LeaveFlag[], plan: ShiftPlan): Map<string, Set<string>> => {
    const byEmployee = new Map<string, Set<string>>();
    const workdays = new Set(plan.workdays);
    for (const flag of flags) {
        // Nur BEWILLIGTES Homeoffice erzeugt einen Arbeitstag; Urlaub erzeugt
        // keinen (er ist Abwesenheit, keine Leistung).
        if (flag.kind !== 'REMOTE' || flag.status !== 'APPROVED') continue;
        let bucket = byEmployee.get(flag.employeeId);
        if (!bucket) {
            bucket = new Set<string>();
            byEmployee.set(flag.employeeId, bucket);
        }
        for (let cursor = startOfDay(flag.startDate); cursor <= flag.endDate; cursor = addDays(cursor, 1)) {
            if (workdays.has(isoWeekday(cursor))) bucket.add(toDateKey(cursor));
        }
    }
    return byEmployee;
};

/**
 * Die gestempelten Zeilen des Zeitraums. Nur ABGESCHLOSSENE Fenster zählen als
 * Arbeitszeit; eine noch offene Zeile (jemand ist gerade eingestempelt) kommt
 * mit `durationSeconds: 0` mit, damit sie im Detailbericht sichtbar ist, ohne
 * die Summen zu verfälschen.
 */
export const loadTimeEntries = async (
    staff: StaffRow[],
    start: Date,
    end: Date,
): Promise<ReportEntry[]> => {
    if (staff.length === 0) return [];
    const byId = new Map(staff.map((person) => [person.id, person]));

    const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT t.id, t.employeeId, t.workDate, t.startedAt, t.endedAt,
               t.durationSeconds, t.source, t.note
        FROM StaffTimeEntry t
        WHERE t.employeeId IN (${Prisma.join([...byId.keys()])})
          AND t.workDate >= ${start}
          AND t.workDate <= ${end}
        ORDER BY t.workDate ASC, t.startedAt ASC
    `);

    const entries: ReportEntry[] = [];
    for (const row of rows) {
        const person = byId.get(String(row.employeeId));
        if (!person) continue;
        entries.push({
            id: String(row.id),
            employeeId: person.id,
            staffNumber: person.staffNumber,
            firstName: person.firstName,
            lastName: person.lastName,
            workLocation: person.workLocation,
            employeeCreatedAt: person.createdAt,
            workDate: new Date(row.workDate),
            startedAt: row.startedAt ? new Date(row.startedAt) : null,
            endedAt: row.endedAt ? new Date(row.endedAt) : null,
            durationSeconds: row.durationSeconds == null ? 0 : Number(row.durationSeconds),
            source: String(row.source ?? 'QR'),
            note: row.note == null ? null : String(row.note),
            synthetic: false,
        });
    }
    return entries;
};

/**
 * Die abgeleiteten Homeoffice-Tage: je geplanter Arbeitstag ohne eigene
 * Stempelung ein volles Tagessoll. Erfasst wird
 *   • dauerhaftes Homeoffice (`workLocation = 'REMOTE'`) und
 *   • bewilligte einzelne Homeoffice-Anträge.
 * Der HEUTIGE Tag zählt erst, wenn die Schicht vorbei ist ("am Ende des Tages").
 */
export const buildRemoteEntries = (
    staff: StaffRow[],
    entries: ReportEntry[],
    flags: LeaveFlag[],
    plan: ShiftPlan,
    start: Date,
    end: Date,
): ReportEntry[] => {
    const workdays = new Set(plan.workdays);
    const netSeconds = netShiftMinutes(plan) * 60;
    if (netSeconds <= 0) return [];

    const stamped = new Set(entries.map((entry) => `${entry.employeeId}|${toDateKey(entry.workDate)}`));
    const remoteByEmployee = remoteDayKeys(flags, plan);
    // Der laufende Tag ist erst nach Schichtende "fertig"; alles davor bleibt
    // offen, damit ein Bericht am Vormittag keine Stunden erfindet.
    const now = new Date();
    const todayKey = toDateKey(now);
    const planStartMinutes = minutesOfDay(plan.startTime);
    const shiftEndReached = now.getHours() * 60 + now.getMinutes() >= minutesOfDay(plan.endTime);

    const derived: ReportEntry[] = [];
    for (const person of staff) {
        const permanent = person.workLocation === 'REMOTE';
        const approvedDays = remoteByEmployee.get(person.id);
        if (!permanent && !approvedDays?.size) continue;

        for (let cursor = startOfDay(start); cursor <= end; cursor = addDays(cursor, 1)) {
            if (!workdays.has(isoWeekday(cursor))) continue;
            const key = toDateKey(cursor);
            if (!permanent && !approvedDays?.has(key)) continue;
            if (stamped.has(`${person.id}|${key}`)) continue;
            if (cursor > now) continue;
            if (key === todayKey && !shiftEndReached) continue;
            // Vor dem Eintritt der Person gibt es keinen Arbeitstag.
            if (cursor < startOfDay(person.createdAt)) continue;

            const startedAt = new Date(cursor.getTime());
            startedAt.setHours(Math.floor(planStartMinutes / 60), planStartMinutes % 60, 0, 0);
            derived.push({
                id: null,
                employeeId: person.id,
                staffNumber: person.staffNumber,
                firstName: person.firstName,
                lastName: person.lastName,
                workLocation: person.workLocation,
                employeeCreatedAt: person.createdAt,
                workDate: new Date(cursor.getTime()),
                startedAt,
                endedAt: new Date(startedAt.getTime() + netSeconds * 1000),
                durationSeconds: netSeconds,
                source: 'REMOTE',
                note: null,
                synthetic: true,
            });
        }
    }
    return derived;
};

/** Ein einzelnes Arbeitsfenster innerhalb eines Tages (zum Korrigieren). */
export interface ReportSegment {
    /** Abgeleitete Homeoffice-Fenster haben keine Zeile und damit keine id. */
    id: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    durationSeconds: number;
    source: string;
    note: string | null;
    synthetic: boolean;
}

/**
 * EINE Zeile je Person und Tag (Vorgabe 16.08.2026). Vorher stand hier ein
 * Fenster je Zeile, und eine Person mit zwei Pausen belegte drei Zeilen — der
 * Bericht las sich wie ein Fehler. Jetzt trägt die Zeile Kommen, Gehen, die
 * geleistete Zeit UND die Pausendauer; die einzelnen Fenster hängen als
 * `segments` daran, damit sich einzelne Stempelungen weiterhin korrigieren
 * lassen.
 */
export interface ReportDay {
    /** `${employeeId}|${YYYY-MM-DD}` — stabiler Schlüssel für die Oberfläche. */
    key: string;
    employeeId: string;
    staffNumber: number | null;
    firstName: string;
    lastName: string;
    workLocation: string;
    employeeCreatedAt: Date;
    workDate: Date;
    /** Erster Beginn des Tages. */
    startedAt: Date | null;
    /** Letztes Ende des Tages; null, solange ein Fenster offen ist. */
    endedAt: Date | null;
    /** Schichtdauer: erstes Kommen bis letztes Gehen (= Arbeitszeit + Pause). */
    grossSeconds: number;
    /** Tatsächliche Arbeitszeit: die Summe der Fenster. */
    actualWorkSeconds: number;
    /** Pausenzeit: die Lücken dazwischen. Erst nach dem Feierabend belastbar. */
    breakSeconds: number;
    /** Läuft gerade ein Fenster? */
    open: boolean;
    /** Enthält der Tag ausschliesslich abgeleitete Homeoffice-Zeit? */
    synthetic: boolean;
    segments: ReportSegment[];
}

export interface DetailedReport {
    days: ReportDay[];
    flags: LeaveFlag[];
    plan: ShiftPlan;
}

export const buildDetailedReport = async (
    tenantIds: string[],
    filters: ReportFilters,
    plan: ShiftPlan,
): Promise<DetailedReport> => {
    const staff = await loadStaffForReport(tenantIds, filters);
    if (staff.length === 0) return { days: [], flags: [], plan };

    const [stamped, flags] = await Promise.all([
        loadTimeEntries(staff, filters.start, filters.end),
        loadLeaveFlags(staff.map((person) => person.id), filters.start, filters.end),
    ]);

    const derived = buildRemoteEntries(staff, stamped, flags, plan, filters.start, filters.end);
    const entries = [...stamped, ...derived];

    // Fenster nach Person UND Tag bündeln.
    const buckets = new Map<string, ReportEntry[]>();
    for (const entry of entries) {
        const key = `${entry.employeeId}|${toDateKey(entry.workDate)}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(entry);
        else buckets.set(key, [entry]);
    }

    const days: ReportDay[] = [];
    for (const [key, bucket] of buckets) {
        const ordered = [...bucket].sort(
            (a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0),
        );
        const head = ordered[0]!;
        const summary = summariseDay(ordered.map((entry) => ({
            startedAt: entry.startedAt ?? entry.workDate,
            endedAt: entry.endedAt,
            durationSeconds: entry.durationSeconds,
        })));

        days.push({
            key,
            employeeId: head.employeeId,
            staffNumber: head.staffNumber,
            firstName: head.firstName,
            lastName: head.lastName,
            workLocation: head.workLocation,
            employeeCreatedAt: head.employeeCreatedAt,
            workDate: head.workDate,
            startedAt: summary.firstStart,
            endedAt: summary.lastEnd,
            grossSeconds: summary.grossSeconds,
            actualWorkSeconds: summary.actualWorkSeconds,
            breakSeconds: summary.breakSeconds,
            open: summary.open,
            synthetic: ordered.every((entry) => entry.synthetic),
            segments: ordered.map((entry) => ({
                id: entry.id,
                startedAt: entry.startedAt,
                endedAt: entry.endedAt,
                durationSeconds: entry.durationSeconds,
                source: entry.source,
                note: entry.note,
                synthetic: entry.synthetic,
            })),
        });
    }

    days.sort((a, b) => {
        const byDate = a.workDate.getTime() - b.workDate.getTime();
        if (byDate !== 0) return byDate;
        const byName = a.lastName.localeCompare(b.lastName);
        if (byName !== 0) return byName;
        return a.firstName.localeCompare(b.firstName);
    });

    return { days, flags, plan };
};

export interface AccountingPersonRow {
    employeeId: string;
    staffNumber: number | null;
    firstName: string;
    lastName: string;
    workLocation: string;
    totalSeconds: number;
    totalHours: number;
    daysShort: number;
    extraDays: number;
    /** Tage mit mindestens einer Stempelung — für die Kurzkarten. */
    presentDays: number;
    /** Bewilligte/laufende Abwesenheiten, die den Zeitraum berühren. */
    flags: LeaveFlag[];
}

export interface AccountingReport {
    basis: AccountingBasis;
    plan: ShiftPlan;
    rows: AccountingPersonRow[];
}

export const buildAccountingReport = async (
    tenantIds: string[],
    filters: ReportFilters,
    plan: ShiftPlan,
    publicHolidays: number,
): Promise<AccountingReport> => {
    const basis = buildAccountingBasis(filters.start, filters.end, plan, publicHolidays);
    const staff = await loadStaffForReport(tenantIds, filters);
    if (staff.length === 0) return { basis, plan, rows: [] };

    const [stamped, flags] = await Promise.all([
        loadTimeEntries(staff, filters.start, filters.end),
        loadLeaveFlags(staff.map((person) => person.id), filters.start, filters.end),
    ]);
    const derived = buildRemoteEntries(staff, stamped, flags, plan, filters.start, filters.end);
    const entries = [...stamped, ...derived];

    const rows = staff.map((person) => {
        const own = entries.filter((entry) => entry.employeeId === person.id);
        const totalSeconds = own.reduce((sum, entry) => sum + entry.durationSeconds, 0);
        const presentDays = new Set(own.filter((entry) => entry.durationSeconds > 0).map((entry) => toDateKey(entry.workDate))).size;
        const balance = buildAccountingBalance(totalSeconds, basis);
        return {
            employeeId: person.id,
            staffNumber: person.staffNumber,
            firstName: person.firstName,
            lastName: person.lastName,
            workLocation: person.workLocation,
            totalSeconds,
            totalHours: balance.totalHours,
            daysShort: balance.daysShort,
            extraDays: balance.extraDays,
            presentDays,
            flags: flags.filter((flag) => flag.employeeId === person.id),
        };
    });

    return { basis, plan, rows };
};

/** Tagesweise Aufschlüsselung einer Person (Buchhaltungs-Detailbericht). */
export interface AccountingDetailDay {
    date: string;
    isWorkday: boolean;
    seconds: number;
    /** Soll dieses Tages in Sekunden (0 an planfreien Tagen). */
    targetSeconds: number;
    entries: Array<{
        id: string | null;
        startedAt: Date | null;
        endedAt: Date | null;
        durationSeconds: number;
        source: string;
        synthetic: boolean;
    }>;
    leave: LeaveFlag | null;
}

export const buildAccountingDetail = async (
    tenantIds: string[],
    employeeId: string,
    filters: ReportFilters,
    plan: ShiftPlan,
    publicHolidays: number,
): Promise<{ person: StaffRow | null; basis: AccountingBasis; days: AccountingDetailDay[]; totalSeconds: number }> => {
    const basis = buildAccountingBasis(filters.start, filters.end, plan, publicHolidays);
    const staff = await loadStaffForReport(tenantIds, { ...filters, employeeId });
    const person = staff[0] ?? null;
    if (!person) return { person: null, basis, days: [], totalSeconds: 0 };

    const [stamped, flags] = await Promise.all([
        loadTimeEntries([person], filters.start, filters.end),
        loadLeaveFlags([person.id], filters.start, filters.end),
    ]);
    const derived = buildRemoteEntries([person], stamped, flags, plan, filters.start, filters.end);
    const entries = [...stamped, ...derived];

    const workdays = new Set(plan.workdays);
    const targetSeconds = netShiftMinutes(plan) * 60;
    const days: AccountingDetailDay[] = [];
    let totalSeconds = 0;

    for (let cursor = startOfDay(filters.start); cursor <= filters.end; cursor = addDays(cursor, 1)) {
        const key = toDateKey(cursor);
        const isWorkday = workdays.has(isoWeekday(cursor));
        const dayEntries = entries.filter((entry) => toDateKey(entry.workDate) === key);
        const seconds = dayEntries.reduce((sum, entry) => sum + entry.durationSeconds, 0);
        totalSeconds += seconds;
        const leave = flags.find((flag) => startOfDay(flag.startDate) <= cursor && cursor <= flag.endDate) ?? null;
        days.push({
            date: key,
            isWorkday,
            seconds,
            targetSeconds: isWorkday ? targetSeconds : 0,
            entries: dayEntries.map((entry) => ({
                id: entry.id,
                startedAt: entry.startedAt,
                endedAt: entry.endedAt,
                durationSeconds: entry.durationSeconds,
                source: entry.source,
                synthetic: Boolean(entry.synthetic),
            })),
            leave,
        });
    }

    return { person, basis, days, totalSeconds };
};

/** Arbeitstage eines Antragszeitraums — die `totalDays`-Spalte der Anträge. */
export const leaveWorkdays = (start: Date, end: Date, plan: ShiftPlan): number =>
    countWorkdaysInRange(start, end, plan.workdays);
