"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWorkReport = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskAccess_1 = require("./taskAccess");
const taskErrors_1 = require("./taskErrors");
const taskPeople_1 = require("./taskPeople");
const taskRows_1 = require("./taskRows");
const taskTime_1 = require("./taskTime");
/**
 * ── ARBEITSRAPPORT EINER PERSON: TAG ODER WOCHE (13.09.2026, Vorgabe Samet) ──
 *
 * «Rapor tek kişi için — günlük veya haftalık.» EINE Anfrage liefert, was
 * Vorschau und PDF brauchen, mit vier parallelen Abfragen (die Datenbank
 * steht ~45 ms entfernt):
 *
 *   sessions      Messungen, die den Zeitraum ÜBERLAPPEN — auf ihn geklemmt,
 *                 damit eine Schicht über Mitternacht nicht verschwindet
 *   checkedItems  Checklistenpunkte, die die Person im Zeitraum abgehakt hat
 *   comments      Kommentare der Person im Zeitraum
 *   tasks         die Aufgaben zu allem oben (Titel, Etiketten, Status, Stand)
 *                 UND die Termine der Person (14.09.2026, Samet: «bittiğinde süre
 *                 devam etsin ama gecikme göstersin — onaylanana kadar»): ihr
 *                 zugewiesen und im Zeitraum fällig, im Zeitraum erledigt oder
 *                 noch offen und schon überfällig — mit Termin, Abschluss und
 *                 offener Abschlussanfrage, damit der Rapport den Verzug zeigt
 *
 * Tagesgrenzen kennt nur der Browser der Leserin: er schickt `from`/`to`
 * und gruppiert selbst nach Tagen.
 *
 * Wer: `person` = eine Kennung. Die Leitung wählt jede Person der Firma,
 * ein Teammitglied bekommt immer sich selbst (eine fremde Kennung = 403).
 */
const MAX_RANGE_DAYS = 8;
const MAX_LIST_ROWS = 300;
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
/** Kommentartext für eine Tabellenzelle: Klartext, eine Zeile, gekürzt. */
const plainLine = (value, max = 300) => {
    const text = String(value ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
    const tenantId = actor.tenantId;
    const employeeId = await resolvePerson(actor, typeof query.person === 'string' ? query.person.trim() : '');
    const sessionFilter = client_1.Prisma.sql `
        s.tenantId = ${tenantId} AND s.employeeId = ${employeeId}
        AND s.startedAt <= ${to} AND (s.endedAt IS NULL OR s.endedAt >= ${from})`;
    const checkFilter = client_1.Prisma.sql `
        ci.tenantId = ${tenantId} AND ci.done = 1 AND ci.doneById = ${employeeId}
        AND ci.doneAt >= ${from} AND ci.doneAt <= ${to}`;
    const commentFilter = client_1.Prisma.sql `
        c.tenantId = ${tenantId} AND c.authorId = ${employeeId}
        AND c.createdAt >= ${from} AND c.createdAt <= ${to}`;
    // Termine der Person: im Zeitraum fällig, im Zeitraum erledigt oder offen und überfällig.
    const deadlineFilter = client_1.Prisma.sql `
        a.tenantId = ${tenantId} AND a.employeeId = ${employeeId} AND d.dueAt IS NOT NULL AND (
            (d.dueAt >= ${from} AND d.dueAt <= ${to})
            OR (d.completedAt >= ${from} AND d.completedAt <= ${to})
            OR (d.status NOT IN ('COMPLETED', 'REJECTED') AND d.dueAt < ${to})
        )`;
    const [sessionRows, itemRows, commentRows, taskRows, refs] = await Promise.all([
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT s.taskId, s.startedAt, s.endedAt
            FROM TaskTimeSession s
            WHERE ${sessionFilter}
            ORDER BY s.startedAt ASC, s.id ASC
            LIMIT ${MAX_LIST_ROWS}
        `),
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT ci.taskId, ci.text, ci.doneAt
            FROM TaskChecklistItem ci
            WHERE ${checkFilter}
            ORDER BY ci.doneAt ASC, ci.id ASC
            LIMIT ${MAX_LIST_ROWS}
        `),
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT c.taskId, c.text, c.createdAt
            FROM TaskComment c
            WHERE ${commentFilter}
            ORDER BY c.createdAt ASC, c.id ASC
            LIMIT ${MAX_LIST_ROWS}
        `),
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT t.id, t.title, t.status, t.priority, t.startAt, t.dueAt, t.completedAt,
                   t.approvalState, t.approvalRequestedAt,
                   EXISTS(SELECT 1 FROM TaskTimeSession x WHERE x.taskId = t.id) AS hasSessions,
                   (SELECT COUNT(*) FROM TaskChecklistItem k WHERE k.taskId = t.id) AS checkTotal,
                   (SELECT COUNT(*) FROM TaskChecklistItem k WHERE k.taskId = t.id AND k.done = 1) AS checkDone,
                   (SELECT GROUP_CONCAT(l.name ORDER BY l.name SEPARATOR '\n')
                      FROM TaskLabelLink ll JOIN TaskLabel l ON l.id = ll.labelId
                     WHERE ll.taskId = t.id) AS labels
            FROM Task t
            WHERE t.tenantId = ${tenantId} AND t.id IN (
                SELECT s.taskId FROM TaskTimeSession s WHERE ${sessionFilter}
                UNION
                SELECT ci.taskId FROM TaskChecklistItem ci WHERE ${checkFilter}
                UNION
                SELECT c.taskId FROM TaskComment c WHERE ${commentFilter}
                UNION
                SELECT a.taskId FROM TaskAssignee a JOIN Task d ON d.id = a.taskId WHERE ${deadlineFilter}
            )
        `),
        (0, taskPeople_1.loadPersonRefs)([employeeId]),
    ]);
    const tasks = {};
    for (const row of taskRows) {
        const id = String(row.id);
        const status = String(row.status ?? 'NOT_STARTED');
        tasks[id] = {
            id,
            title: String(row.title ?? ''),
            status,
            effectiveStatus: (0, taskAccess_1.effectiveTaskStatus)({ status, startAt: (0, taskRows_1.rawDate)(row.startAt), hasSessions: (0, taskRows_1.rawBool)(row.hasSessions) }, now),
            labels: ((0, taskRows_1.rawString)(row.labels) ?? '').split('\n').filter(Boolean),
            checkTotal: (0, taskRows_1.rawNumber)(row.checkTotal),
            checkDone: (0, taskRows_1.rawNumber)(row.checkDone),
            priority: String(row.priority ?? 'MEDIUM'),
            startAt: (0, taskRows_1.rawDate)(row.startAt),
            dueAt: (0, taskRows_1.rawDate)(row.dueAt),
            completedAt: (0, taskRows_1.rawDate)(row.completedAt),
            approvalState: String(row.approvalState ?? 'NONE'),
            approvalRequestedAt: (0, taskRows_1.rawDate)(row.approvalRequestedAt),
        };
    }
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
        const live = endedAt === null && naturalEnd <= to;
        sessions.push({
            taskId: row.taskId,
            startedAt: clippedStart,
            endedAt: live ? null : clippedEnd,
            ms: clippedEnd.getTime() - clippedStart.getTime(),
            live,
        });
    }
    return {
        from,
        to,
        generatedAt: now,
        employee: refs[employeeId] ?? { id: employeeId, firstName: '', lastName: '', name: '', title: null, active: false },
        sessions,
        checkedItems: itemRows.flatMap((row) => {
            const doneAt = (0, taskRows_1.rawDate)(row.doneAt);
            return doneAt ? [{ taskId: row.taskId, text: plainLine(row.text), doneAt }] : [];
        }),
        comments: commentRows.flatMap((row) => {
            const createdAt = (0, taskRows_1.rawDate)(row.createdAt);
            return createdAt ? [{ taskId: row.taskId, text: plainLine(row.text), createdAt }] : [];
        }),
        tasks,
    };
};
exports.getWorkReport = getWorkReport;
//# sourceMappingURL=workReportService.js.map