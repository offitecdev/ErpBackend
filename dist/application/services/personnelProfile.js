"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadStaffForSearch = exports.staffSearchCondition = exports.buildLeaveYear = exports.buildAbsences = exports.ABSENCE_KINDS = exports.workdaysWithoutHolidays = exports.holidayIndex = exports.loadHolidays = void 0;
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
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const serviceTenantScope_1 = require("../../presentation/controllers/serviceTenantScope");
const personnel_1 = require("../../shared/personnel");
const personnelReports_1 = require("./personnelReports");
/**
 * Die geführten Feiertage eines Zeitraums. Sie hängen am STAMM des
 * Firmenbaums — dieselbe Regel wie Schichtplan und Urlaubsregel: Personal ist
 * baumweit geteilt, also müssen es auch seine arbeitsfreien Tage sein.
 */
const loadHolidays = async (tenantId, start, end) => {
    const rows = await prisma_client_1.default.publicHoliday.findMany({
        where: { tenantId, date: { gte: (0, personnel_1.startOfDay)(start), lte: (0, personnel_1.endOfDay)(end) } },
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
exports.loadHolidays = loadHolidays;
/** Tagesschlüssel → Feiertag. Fallen zwei auf denselben Tag, gewinnt der ganze. */
const holidayIndex = (holidays) => {
    const map = new Map();
    for (const holiday of holidays) {
        const key = (0, personnel_1.toDateKey)(holiday.date);
        const existing = map.get(key);
        if (!existing || (existing.halfDay && !holiday.halfDay))
            map.set(key, holiday);
    }
    return map;
};
exports.holidayIndex = holidayIndex;
/**
 * Arbeitstage im Zeitraum OHNE die Feiertage, die auf einen Arbeitstag fallen.
 * Ein halber Feiertag (Arife) zieht einen halben Tag ab.
 */
const workdaysWithoutHolidays = (start, end, plan, holidays) => {
    const workdays = new Set(plan.workdays);
    let count = 0;
    for (let cursor = (0, personnel_1.startOfDay)(start); cursor <= end; cursor = (0, personnel_1.addDays)(cursor, 1)) {
        if (!workdays.has((0, personnel_1.isoWeekday)(cursor)))
            continue;
        const holiday = holidays.get((0, personnel_1.toDateKey)(cursor));
        count += holiday ? (holiday.halfDay ? 0.5 : 0) : 1;
    }
    return (0, personnel_1.roundHalf)(count);
};
exports.workdaysWithoutHolidays = workdaysWithoutHolidays;
// ── Abwesenheiten ────────────────────────────────────────────────────────────
/**
 * Wofür ein fehlender Tag steht. `ABSENT` ist der Rest: erschienen ist niemand,
 * und ein Antrag, der es erklärte, gibt es nicht.
 */
exports.ABSENCE_KINDS = ['ABSENT', 'VACATION', 'SICK', 'REMOTE', 'OTHER'];
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
const buildAbsences = (input) => {
    const workdays = new Set(input.plan.workdays);
    const since = (0, personnel_1.startOfDay)(input.since);
    const until = (0, personnel_1.startOfDay)(input.until);
    /* Ein Tagesschlüssel → der Antrag, der ihn abdeckt. Der zuletzt
       eingetragene gewinnt nicht: ein BEWILLIGTER Antrag schlägt einen offenen,
       weil er die stärkere Aussage über den Tag ist. */
    const byDay = new Map();
    for (const flag of input.flags) {
        for (let cursor = (0, personnel_1.startOfDay)(flag.startDate); cursor <= flag.endDate; cursor = (0, personnel_1.addDays)(cursor, 1)) {
            if (!workdays.has((0, personnel_1.isoWeekday)(cursor)))
                continue;
            const key = (0, personnel_1.toDateKey)(cursor);
            const existing = byDay.get(key);
            if (!existing || (existing.status !== 'APPROVED' && flag.status === 'APPROVED')) {
                byDay.set(key, flag);
            }
        }
    }
    const rows = [];
    for (let cursor = (0, personnel_1.startOfDay)(input.start); cursor <= input.end; cursor = (0, personnel_1.addDays)(cursor, 1)) {
        if (!workdays.has((0, personnel_1.isoWeekday)(cursor)))
            continue;
        if (cursor < since)
            continue;
        const key = (0, personnel_1.toDateKey)(cursor);
        if (input.holidays.has(key))
            continue;
        if (input.workedDayKeys.has(key))
            continue;
        const flag = byDay.get(key) ?? null;
        // Zukunft ohne Antrag ist keine Abwesenheit, sondern schlicht: noch nicht da.
        if (cursor > until && !flag)
            continue;
        if (!flag) {
            rows.push({ date: key, kind: 'ABSENT', requestId: null, label: null, pending: false });
            continue;
        }
        const requestType = (0, personnel_1.requestTypeOf)(flag.kind, flag.leaveType);
        const kind = requestType === 'VACATION'
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
exports.buildAbsences = buildAbsences;
/**
 * Das Urlaubsjahr EINER Person: Anspruch, Feiertage und Abwesenheiten in einem
 * Zug. Der Nenner des Anspruchs sind die Arbeitstage BIS HEUTE (nicht des
 * ganzen Jahres) — sonst hätte jemand im Januar rechnerisch fast keinen
 * Anspruch, obwohl er jeden Tag gearbeitet hat.
 */
const buildLeaveYear = async (input) => {
    const yearStart = new Date(input.year, 0, 1, 0, 0, 0, 0);
    const yearEnd = new Date(input.year, 11, 31, 23, 59, 59, 999);
    const today = new Date();
    // Ein vergangenes Jahr ist ganz vorbei; das laufende endet heute.
    const asOf = today < yearEnd ? today : yearEnd;
    const staff = await (0, personnelReports_1.loadStaffForReport)(input.tenantIds, {
        start: yearStart,
        end: yearEnd,
        employeeId: input.employeeId,
    });
    const person = staff[0];
    if (!person) {
        const empty = (0, personnel_1.buildLeaveEntitlement)({
            year: input.year, policy: input.policy, workedDays: 0,
            referenceWorkdays: 1, usedDays: 0, pendingDays: 0,
        });
        return {
            year: input.year, policy: input.policy, entitlement: empty,
            holidays: [], absences: [], workedDays: 0, referenceWorkdays: 0,
        };
    }
    const [stamped, flags, holidayRows] = await Promise.all([
        (0, personnelReports_1.loadTimeEntries)([person], yearStart, yearEnd),
        (0, personnelReports_1.loadLeaveFlags)([person.id], yearStart, yearEnd),
        (0, exports.loadHolidays)(input.shiftPlanTenantId, yearStart, yearEnd),
    ]);
    const derived = (0, personnelReports_1.buildRemoteEntries)([person], stamped, flags, input.plan, yearStart, yearEnd);
    const workedDayKeys = new Set();
    for (const entry of [...stamped, ...derived])
        workedDayKeys.add((0, personnel_1.toDateKey)(entry.workDate));
    const holidays = (0, exports.holidayIndex)(holidayRows);
    const since = input.since > yearStart ? input.since : yearStart;
    /* Der Nenner: Arbeitstage seit dem Eintritt bis heute, ohne Feiertage.
       Wer im September eingetreten ist, wird nicht an einem ganzen Jahr
       gemessen — sonst wäre sein Anspruch dauerhaft ein Bruchteil dessen, was
       er tatsächlich erarbeitet hat. */
    const referenceWorkdays = asOf >= since
        ? (0, exports.workdaysWithoutHolidays)(since, asOf, input.plan, holidays)
        : 0;
    /* Verbrauch: NUR Jahresurlaub zehrt am Konto. Bewilligtes zählt als
       verbraucht, Offenes als reserviert — beides muss vom Rest abgehen,
       sonst verspricht das Konto Tage, die schon vergeben sind. */
    let usedDays = 0;
    let pendingDays = 0;
    for (const flag of flags) {
        if (!(0, personnel_1.consumesEntitlement)(flag.kind, flag.leaveType))
            continue;
        // Nur die Tage, die IN DIESES Jahr fallen (ein Antrag darf über den
        // Jahreswechsel laufen).
        const from = flag.startDate > yearStart ? flag.startDate : yearStart;
        const to = flag.endDate < yearEnd ? flag.endDate : yearEnd;
        const days = (0, exports.workdaysWithoutHolidays)(from, to, input.plan, holidays);
        if (flag.status === 'APPROVED')
            usedDays += days;
        else
            pendingDays += days;
    }
    const absences = (0, exports.buildAbsences)({
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
        entitlement: (0, personnel_1.buildLeaveEntitlement)({
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
exports.buildLeaveYear = buildLeaveYear;
/** Die Personen, auf die die Suche der Arbeitszeiterfassung passt. */
const staffSearchCondition = (search) => {
    const text = search.trim();
    if (!text)
        return null;
    const like = `%${text}%`;
    return client_1.Prisma.sql `(e.firstName LIKE ${like} OR e.lastName LIKE ${like} OR e.email LIKE ${like}
        OR CONCAT(e.firstName, ' ', e.lastName) LIKE ${like})`;
};
exports.staffSearchCondition = staffSearchCondition;
/**
 * Die Personen einer Freitextsuche — ein Feld statt Vor- und Nachname
 * getrennt (Vorgabe 26.08.2026: «erweiterte Suche über alle Mitarbeitenden»).
 * `employeeIds` schränkt zusätzlich auf eine Auswahl ein.
 */
const loadStaffForSearch = async (tenantIds, options) => {
    if (tenantIds.length === 0)
        return [];
    const conditions = [
        (0, serviceTenantScope_1.employeeScopeSql)(tenantIds),
        client_1.Prisma.sql `e.deletedAt IS NULL`,
    ];
    const search = (0, exports.staffSearchCondition)(options.search ?? '');
    if (search)
        conditions.push(search);
    if (options.employeeIds?.length) {
        conditions.push(client_1.Prisma.sql `e.id IN (${client_1.Prisma.join(options.employeeIds)})`);
    }
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT e.id, e.staffNumber, e.firstName, e.lastName, e.email, e.createdAt, e.workLocation
        FROM Employee e
        WHERE ${client_1.Prisma.join(conditions, ' AND ')}
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
exports.loadStaffForSearch = loadStaffForSearch;
//# sourceMappingURL=personnelProfile.js.map