"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWorkReport = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const dailyReportService_1 = require("./dailyReportService");
const taskErrors_1 = require("./taskErrors");
const taskPeople_1 = require("./taskPeople");
const taskRows_1 = require("./taskRows");
const taskTime_1 = require("./taskTime");
/**
 * ── ARBEITSRAPPORT EINER PERSON: TAG ODER WOCHE ─────────────────────────────
 *
 * 16.09.2026 (Samet): «Raporlamada gün gün yazsın; grafik falan, görev bazlı
 * bakış, QR — hepsi kalksın. Sadece gün gün, gün sonunda neler yaptı.» … und
 * am selben Tag: «çalıştığı görevler ve kaç saat çalıştığı da yazsın, gün gün,
 * gün raporunun altında, ince gri kenarlı bir tabloda.»
 * Der Rapport ist damit je Kalendertag: das freie Blatt der Person samt ihren
 * Dateien UND die Zeit, die sie an diesem Tag je Aufgabe gemessen hat.
 * Checklistenpunkte, Kommentare und Termine stehen nicht mehr darin.
 *
 *   sessions  Messungen, die den Zeitraum ÜBERLAPPEN — auf ihn geklemmt, damit
 *             eine Schicht über Mitternacht nicht verschwindet; der Browser
 *             teilt sie auf seine Kalendertage auf (er kennt die Tagesgrenzen)
 *   tasks     die Titel zu diesen Messungen
 *
 * Tagesgrenzen kennt nur der Browser der Leserin: er schickt `from`/`to` (ISO)
 * und `fromDate`/`toDate` (YYYY-MM-DD), die Kalendertage seiner Uhr.
 *
 * Wer: `person` = eine Kennung. Die Leitung wählt jede Person der Firma,
 * ein Teammitglied bekommt immer sich selbst (eine fremde Kennung = 403).
 */
const MAX_RANGE_DAYS = 8;
const MAX_SESSION_ROWS = 400;
const parseDate = (value) => {
    if (typeof value !== 'string' || !value.trim())
        return null;
    const date = new Date(value.trim());
    return Number.isNaN(date.getTime()) ? null : date;
};
/** Wessen Rapport — geprüft gegen die Firma. */
const resolvePerson = async (actor, requested) => {
    if (!requested || requested === actor.employeeId)
        return actor.employeeId;
    if (!actor.seesAll) {
        throw (0, taskErrors_1.taskForbidden)('REPORT_FORBIDDEN', 'Teammitglieder sehen nur ihren eigenen Rapport.');
    }
    if ((await (0, taskPeople_1.getTasksPeople)(actor.tenantId)).has(requested))
        return requested;
    // Ehemalige ohne Zugang behalten ihren Rapport, solange sie Spuren in der Firma haben.
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT (
            EXISTS(SELECT 1 FROM TaskAssignee WHERE tenantId = ${actor.tenantId} AND employeeId = ${requested})
            OR EXISTS(SELECT 1 FROM TaskTimeSession WHERE tenantId = ${actor.tenantId} AND employeeId = ${requested})
        ) AS known
    `);
    if (!(0, taskRows_1.rawBool)(rows[0]?.known)) {
        throw (0, taskErrors_1.taskNotFound)('PERSON_NOT_FOUND', 'Diese Person gehört nicht zur ausgewählten Firma.');
    }
    return requested;
};
const getWorkReport = async (actor, query) => {
    const now = new Date();
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (!from || !to || from.getTime() > to.getTime()) {
        throw (0, taskErrors_1.taskBadRequest)('REPORT_RANGE_INVALID', 'Zeitraum ungültig (from/to).');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * taskTime_1.DAY_MS) {
        throw (0, taskErrors_1.taskBadRequest)('REPORT_RANGE_TOO_LONG', `Höchstens ${MAX_RANGE_DAYS} Tage.`);
    }
    const employeeId = await resolvePerson(actor, typeof query.person === 'string' ? query.person.trim() : '');
    const fromDate = (0, dailyReportService_1.isDateKey)(query.fromDate) ? query.fromDate : null;
    const toDate = (0, dailyReportService_1.isDateKey)(query.toDate) ? query.toDate : null;
    const sessionFilter = client_1.Prisma.sql `
        s.tenantId = ${actor.tenantId} AND s.employeeId = ${employeeId}
        AND s.startedAt <= ${to} AND (s.endedAt IS NULL OR s.endedAt >= ${from})`;
    const [refs, dailyReports, sessionRows, taskRows] = await Promise.all([
        (0, taskPeople_1.loadPersonRefs)([employeeId]),
        fromDate && toDate && fromDate <= toDate
            ? (0, dailyReportService_1.listDailyReports)(actor.tenantId, employeeId, fromDate, toDate)
            : Promise.resolve([]),
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT s.taskId, s.startedAt, s.endedAt
            FROM TaskTimeSession s
            WHERE ${sessionFilter}
            ORDER BY s.startedAt ASC, s.id ASC
            LIMIT ${MAX_SESSION_ROWS}
        `),
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT t.id, t.title FROM Task t
            WHERE t.tenantId = ${actor.tenantId}
              AND t.id IN (SELECT s.taskId FROM TaskTimeSession s WHERE ${sessionFilter})
        `),
    ]);
    const sessions = [];
    for (const row of sessionRows) {
        const startedAt = (0, taskRows_1.rawDate)(row.startedAt);
        if (!startedAt)
            continue;
        const endedAt = (0, taskRows_1.rawDate)(row.endedAt);
        const naturalEnd = endedAt ?? now;
        const clippedStart = startedAt < from ? from : startedAt;
        const clippedEnd = naturalEnd > to ? to : naturalEnd;
        if (clippedEnd <= clippedStart)
            continue;
        sessions.push({
            taskId: row.taskId,
            startedAt: clippedStart,
            endedAt: endedAt === null && naturalEnd <= to ? null : clippedEnd,
            ms: clippedEnd.getTime() - clippedStart.getTime(),
        });
    }
    const tasks = {};
    for (const row of taskRows)
        tasks[String(row.id)] = { id: String(row.id), title: String(row.title ?? '') };
    return {
        from,
        to,
        generatedAt: now,
        employee: refs[employeeId] ?? { id: employeeId, firstName: '', lastName: '', name: '', title: null, active: false },
        dailyReports,
        sessions,
        tasks,
    };
};
exports.getWorkReport = getWorkReport;
//# sourceMappingURL=workReportService.js.map