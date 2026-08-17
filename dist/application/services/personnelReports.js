"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.leaveWorkdays = exports.buildAccountingDetail = exports.buildAccountingReport = exports.buildDetailedReport = exports.buildRemoteEntries = exports.loadTimeEntries = exports.loadLeaveFlags = exports.loadStaffForReport = void 0;
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
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const personnel_1 = require("../../shared/personnel");
const likeOrNull = (value) => {
    const text = (value ?? '').trim();
    return text ? `%${text}%` : null;
};
/** Die Personen des Firmenbaums, auf die die Namensfilter des Berichts passen. */
const loadStaffForReport = async (tenantIds, filters) => {
    if (tenantIds.length === 0)
        return [];
    const conditions = [
        client_1.Prisma.sql `e.tenantId IN (${client_1.Prisma.join(tenantIds)})`,
        client_1.Prisma.sql `e.deletedAt IS NULL`,
    ];
    const firstName = likeOrNull(filters.firstName);
    if (firstName)
        conditions.push(client_1.Prisma.sql `e.firstName LIKE ${firstName}`);
    const lastName = likeOrNull(filters.lastName);
    if (lastName)
        conditions.push(client_1.Prisma.sql `e.lastName LIKE ${lastName}`);
    if (filters.employeeId)
        conditions.push(client_1.Prisma.sql `e.id = ${filters.employeeId}`);
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT e.id, e.staffNumber, e.firstName, e.lastName, e.createdAt, e.workLocation
        FROM Employee e
        WHERE ${client_1.Prisma.join(conditions, ' AND ')}
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
exports.loadStaffForReport = loadStaffForReport;
/** Bewilligte Abwesenheiten, die den Zeitraum berühren (Ausrufezeichen-Marker). */
const loadLeaveFlags = async (employeeIds, start, end) => {
    if (employeeIds.length === 0)
        return [];
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT l.id, l.employeeId, l.kind, l.leaveType, l.leaveTypeLabel, l.status,
               l.startDate, l.endDate, l.totalDays, l.note
        FROM StaffLeaveRequest l
        WHERE l.employeeId IN (${client_1.Prisma.join(employeeIds)})
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
exports.loadLeaveFlags = loadLeaveFlags;
/** Ein Tagesschlüssel-Set aller Tage, die eine Abwesenheit abdeckt. */
const remoteDayKeys = (flags, plan) => {
    const byEmployee = new Map();
    const workdays = new Set(plan.workdays);
    for (const flag of flags) {
        // Nur BEWILLIGTES Homeoffice erzeugt einen Arbeitstag; Urlaub erzeugt
        // keinen (er ist Abwesenheit, keine Leistung).
        if (flag.kind !== 'REMOTE' || flag.status !== 'APPROVED')
            continue;
        let bucket = byEmployee.get(flag.employeeId);
        if (!bucket) {
            bucket = new Set();
            byEmployee.set(flag.employeeId, bucket);
        }
        for (let cursor = (0, personnel_1.startOfDay)(flag.startDate); cursor <= flag.endDate; cursor = (0, personnel_1.addDays)(cursor, 1)) {
            if (workdays.has((0, personnel_1.isoWeekday)(cursor)))
                bucket.add((0, personnel_1.toDateKey)(cursor));
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
const loadTimeEntries = async (staff, start, end) => {
    if (staff.length === 0)
        return [];
    const byId = new Map(staff.map((person) => [person.id, person]));
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT t.id, t.employeeId, t.workDate, t.startedAt, t.endedAt,
               t.durationSeconds, t.source, t.note
        FROM StaffTimeEntry t
        WHERE t.employeeId IN (${client_1.Prisma.join([...byId.keys()])})
          AND t.workDate >= ${start}
          AND t.workDate <= ${end}
        ORDER BY t.workDate ASC, t.startedAt ASC
    `);
    const entries = [];
    for (const row of rows) {
        const person = byId.get(String(row.employeeId));
        if (!person)
            continue;
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
exports.loadTimeEntries = loadTimeEntries;
/**
 * Die abgeleiteten Homeoffice-Tage: je geplanter Arbeitstag ohne eigene
 * Stempelung ein volles Tagessoll. Erfasst wird
 *   • dauerhaftes Homeoffice (`workLocation = 'REMOTE'`) und
 *   • bewilligte einzelne Homeoffice-Anträge.
 * Der HEUTIGE Tag zählt erst, wenn die Schicht vorbei ist ("am Ende des Tages").
 */
const buildRemoteEntries = (staff, entries, flags, plan, start, end) => {
    const workdays = new Set(plan.workdays);
    const netSeconds = (0, personnel_1.netShiftMinutes)(plan) * 60;
    if (netSeconds <= 0)
        return [];
    const stamped = new Set(entries.map((entry) => `${entry.employeeId}|${(0, personnel_1.toDateKey)(entry.workDate)}`));
    const remoteByEmployee = remoteDayKeys(flags, plan);
    // Der laufende Tag ist erst nach Schichtende "fertig"; alles davor bleibt
    // offen, damit ein Bericht am Vormittag keine Stunden erfindet.
    const now = new Date();
    const todayKey = (0, personnel_1.toDateKey)(now);
    const planStartMinutes = (0, personnel_1.minutesOfDay)(plan.startTime);
    const shiftEndReached = now.getHours() * 60 + now.getMinutes() >= (0, personnel_1.minutesOfDay)(plan.endTime);
    const derived = [];
    for (const person of staff) {
        const permanent = person.workLocation === 'REMOTE';
        const approvedDays = remoteByEmployee.get(person.id);
        if (!permanent && !approvedDays?.size)
            continue;
        for (let cursor = (0, personnel_1.startOfDay)(start); cursor <= end; cursor = (0, personnel_1.addDays)(cursor, 1)) {
            if (!workdays.has((0, personnel_1.isoWeekday)(cursor)))
                continue;
            const key = (0, personnel_1.toDateKey)(cursor);
            if (!permanent && !approvedDays?.has(key))
                continue;
            if (stamped.has(`${person.id}|${key}`))
                continue;
            if (cursor > now)
                continue;
            if (key === todayKey && !shiftEndReached)
                continue;
            // Vor dem Eintritt der Person gibt es keinen Arbeitstag.
            if (cursor < (0, personnel_1.startOfDay)(person.createdAt))
                continue;
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
exports.buildRemoteEntries = buildRemoteEntries;
const buildDetailedReport = async (tenantIds, filters, plan) => {
    const staff = await (0, exports.loadStaffForReport)(tenantIds, filters);
    if (staff.length === 0)
        return { days: [], flags: [], plan };
    const [stamped, flags] = await Promise.all([
        (0, exports.loadTimeEntries)(staff, filters.start, filters.end),
        (0, exports.loadLeaveFlags)(staff.map((person) => person.id), filters.start, filters.end),
    ]);
    const derived = (0, exports.buildRemoteEntries)(staff, stamped, flags, plan, filters.start, filters.end);
    const entries = [...stamped, ...derived];
    // Fenster nach Person UND Tag bündeln.
    const buckets = new Map();
    for (const entry of entries) {
        const key = `${entry.employeeId}|${(0, personnel_1.toDateKey)(entry.workDate)}`;
        const bucket = buckets.get(key);
        if (bucket)
            bucket.push(entry);
        else
            buckets.set(key, [entry]);
    }
    const days = [];
    for (const [key, bucket] of buckets) {
        const ordered = [...bucket].sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
        const head = ordered[0];
        const summary = (0, personnel_1.summariseDay)(ordered.map((entry) => ({
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
        if (byDate !== 0)
            return byDate;
        const byName = a.lastName.localeCompare(b.lastName);
        if (byName !== 0)
            return byName;
        return a.firstName.localeCompare(b.firstName);
    });
    return { days, flags, plan };
};
exports.buildDetailedReport = buildDetailedReport;
const buildAccountingReport = async (tenantIds, filters, plan, publicHolidays) => {
    const basis = (0, personnel_1.buildAccountingBasis)(filters.start, filters.end, plan, publicHolidays);
    const staff = await (0, exports.loadStaffForReport)(tenantIds, filters);
    if (staff.length === 0)
        return { basis, plan, rows: [] };
    const [stamped, flags] = await Promise.all([
        (0, exports.loadTimeEntries)(staff, filters.start, filters.end),
        (0, exports.loadLeaveFlags)(staff.map((person) => person.id), filters.start, filters.end),
    ]);
    const derived = (0, exports.buildRemoteEntries)(staff, stamped, flags, plan, filters.start, filters.end);
    const entries = [...stamped, ...derived];
    const rows = staff.map((person) => {
        const own = entries.filter((entry) => entry.employeeId === person.id);
        const totalSeconds = own.reduce((sum, entry) => sum + entry.durationSeconds, 0);
        const presentDays = new Set(own.filter((entry) => entry.durationSeconds > 0).map((entry) => (0, personnel_1.toDateKey)(entry.workDate))).size;
        const balance = (0, personnel_1.buildAccountingBalance)(totalSeconds, basis);
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
exports.buildAccountingReport = buildAccountingReport;
const buildAccountingDetail = async (tenantIds, employeeId, filters, plan, publicHolidays) => {
    const basis = (0, personnel_1.buildAccountingBasis)(filters.start, filters.end, plan, publicHolidays);
    const staff = await (0, exports.loadStaffForReport)(tenantIds, { ...filters, employeeId });
    const person = staff[0] ?? null;
    if (!person)
        return { person: null, basis, days: [], totalSeconds: 0 };
    const [stamped, flags] = await Promise.all([
        (0, exports.loadTimeEntries)([person], filters.start, filters.end),
        (0, exports.loadLeaveFlags)([person.id], filters.start, filters.end),
    ]);
    const derived = (0, exports.buildRemoteEntries)([person], stamped, flags, plan, filters.start, filters.end);
    const entries = [...stamped, ...derived];
    const workdays = new Set(plan.workdays);
    const targetSeconds = (0, personnel_1.netShiftMinutes)(plan) * 60;
    const days = [];
    let totalSeconds = 0;
    for (let cursor = (0, personnel_1.startOfDay)(filters.start); cursor <= filters.end; cursor = (0, personnel_1.addDays)(cursor, 1)) {
        const key = (0, personnel_1.toDateKey)(cursor);
        const isWorkday = workdays.has((0, personnel_1.isoWeekday)(cursor));
        const dayEntries = entries.filter((entry) => (0, personnel_1.toDateKey)(entry.workDate) === key);
        const seconds = dayEntries.reduce((sum, entry) => sum + entry.durationSeconds, 0);
        totalSeconds += seconds;
        const leave = flags.find((flag) => (0, personnel_1.startOfDay)(flag.startDate) <= cursor && cursor <= flag.endDate) ?? null;
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
exports.buildAccountingDetail = buildAccountingDetail;
/** Arbeitstage eines Antragszeitraums — die `totalDays`-Spalte der Anträge. */
const leaveWorkdays = (start, end, plan) => (0, personnel_1.countWorkdaysInRange)(start, end, plan.workdays);
exports.leaveWorkdays = leaveWorkdays;
//# sourceMappingURL=personnelReports.js.map