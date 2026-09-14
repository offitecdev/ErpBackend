import { Prisma } from '@prisma/client';

import prisma from '../../../infrastructure/database/prisma.client';
import { effectiveTaskStatus } from './taskAccess';
import type { TasksActor } from './taskActor';
import { taskBadRequest, taskForbidden, taskNotFound } from './taskErrors';
import { getTasksPeople, loadPersonRefs, type PersonRef } from './taskPeople';
import { rawBool, rawDate, rawNumber, rawString } from './taskRows';
import { DAY_MS } from './taskTime';

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

export interface WorkReportSessionDto {
    taskId: string;
    startedAt: Date;
    /** null = läuft noch. */
    endedAt: Date | null;
    ms: number;
    live: boolean;
}

export interface WorkReportTaskDto {
    id: string;
    title: string;
    status: string;
    effectiveStatus: string;
    labels: string[];
    checkTotal: number;
    checkDone: number;
    priority: string;
    startAt: Date | null;
    dueAt: Date | null;
    /** Beim Abschluss mit Freigabe = Zeitpunkt der Freigabe. */
    completedAt: Date | null;
    /** NONE | PENDING | APPROVED | REJECTED — PENDING: der Verzug läuft weiter. */
    approvalState: string;
    approvalRequestedAt: Date | null;
}

export interface WorkReportDto {
    from: Date;
    to: Date;
    generatedAt: Date;
    employee: PersonRef;
    sessions: WorkReportSessionDto[];
    checkedItems: Array<{ taskId: string; text: string; doneAt: Date }>;
    comments: Array<{ taskId: string; text: string; createdAt: Date }>;
    tasks: Record<string, WorkReportTaskDto>;
}

const parseDate = (value: unknown): Date | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const date = new Date(value.trim());
    return Number.isNaN(date.getTime()) ? null : date;
};

/** Wessen Rapport — geprüft gegen die Firma. */
const resolvePerson = async (actor: TasksActor, requested: string): Promise<string> => {
    if (!requested || requested === actor.employeeId) return actor.employeeId;
    if (!actor.seesAll) {
        throw taskForbidden('REPORT_FORBIDDEN', 'Teammitglieder sehen nur ihren eigenen Rapport.');
    }
    if ((await getTasksPeople(actor.tenantId)).has(requested)) return requested;
    // Ehemalige ohne Zugang behalten ihren Rapport, solange sie Spuren in der Firma haben.
    const rows = await prisma.$queryRaw<Array<{ known: unknown }>>(Prisma.sql`
        SELECT (
            EXISTS(SELECT 1 FROM TaskAssignee WHERE tenantId = ${actor.tenantId} AND employeeId = ${requested})
            OR EXISTS(SELECT 1 FROM TaskTimeSession WHERE tenantId = ${actor.tenantId} AND employeeId = ${requested})
        ) AS known
    `);
    if (!rawBool(rows[0]?.known)) {
        throw taskNotFound('PERSON_NOT_FOUND', 'Diese Person gehört nicht zur ausgewählten Firma.');
    }
    return requested;
};

/** Kommentartext für eine Tabellenzelle: Klartext, eine Zeile, gekürzt. */
const plainLine = (value: unknown, max = 300): string => {
    const text = String(value ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export const getWorkReport = async (actor: TasksActor, query: Record<string, unknown>): Promise<WorkReportDto> => {
    const now = new Date();
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (!from || !to || from.getTime() > to.getTime()) {
        throw taskBadRequest('REPORT_RANGE_INVALID', 'Zeitraum ungültig (from/to).');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        throw taskBadRequest('REPORT_RANGE_TOO_LONG', `Höchstens ${MAX_RANGE_DAYS} Tage.`);
    }

    const tenantId = actor.tenantId;
    const employeeId = await resolvePerson(actor, typeof query.person === 'string' ? query.person.trim() : '');

    const sessionFilter = Prisma.sql`
        s.tenantId = ${tenantId} AND s.employeeId = ${employeeId}
        AND s.startedAt <= ${to} AND (s.endedAt IS NULL OR s.endedAt >= ${from})`;
    const checkFilter = Prisma.sql`
        ci.tenantId = ${tenantId} AND ci.done = 1 AND ci.doneById = ${employeeId}
        AND ci.doneAt >= ${from} AND ci.doneAt <= ${to}`;
    const commentFilter = Prisma.sql`
        c.tenantId = ${tenantId} AND c.authorId = ${employeeId}
        AND c.createdAt >= ${from} AND c.createdAt <= ${to}`;
    // Termine der Person: im Zeitraum fällig, im Zeitraum erledigt oder offen und überfällig.
    const deadlineFilter = Prisma.sql`
        a.tenantId = ${tenantId} AND a.employeeId = ${employeeId} AND d.dueAt IS NOT NULL AND (
            (d.dueAt >= ${from} AND d.dueAt <= ${to})
            OR (d.completedAt >= ${from} AND d.completedAt <= ${to})
            OR (d.status NOT IN ('COMPLETED', 'REJECTED') AND d.dueAt < ${to})
        )`;

    const [sessionRows, itemRows, commentRows, taskRows, refs] = await Promise.all([
        prisma.$queryRaw<Array<{ taskId: string; startedAt: unknown; endedAt: unknown }>>(Prisma.sql`
            SELECT s.taskId, s.startedAt, s.endedAt
            FROM TaskTimeSession s
            WHERE ${sessionFilter}
            ORDER BY s.startedAt ASC, s.id ASC
            LIMIT ${MAX_LIST_ROWS}
        `),
        prisma.$queryRaw<Array<{ taskId: string; text: string; doneAt: unknown }>>(Prisma.sql`
            SELECT ci.taskId, ci.text, ci.doneAt
            FROM TaskChecklistItem ci
            WHERE ${checkFilter}
            ORDER BY ci.doneAt ASC, ci.id ASC
            LIMIT ${MAX_LIST_ROWS}
        `),
        prisma.$queryRaw<Array<{ taskId: string; text: string; createdAt: unknown }>>(Prisma.sql`
            SELECT c.taskId, c.text, c.createdAt
            FROM TaskComment c
            WHERE ${commentFilter}
            ORDER BY c.createdAt ASC, c.id ASC
            LIMIT ${MAX_LIST_ROWS}
        `),
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
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
        loadPersonRefs([employeeId]),
    ]);

    const tasks: Record<string, WorkReportTaskDto> = {};
    for (const row of taskRows) {
        const id = String(row.id);
        const status = String(row.status ?? 'NOT_STARTED');
        tasks[id] = {
            id,
            title: String(row.title ?? ''),
            status,
            effectiveStatus: effectiveTaskStatus({ status, startAt: rawDate(row.startAt), hasSessions: rawBool(row.hasSessions) }, now),
            labels: (rawString(row.labels) ?? '').split('\n').filter(Boolean),
            checkTotal: rawNumber(row.checkTotal),
            checkDone: rawNumber(row.checkDone),
            priority: String(row.priority ?? 'MEDIUM'),
            startAt: rawDate(row.startAt),
            dueAt: rawDate(row.dueAt),
            completedAt: rawDate(row.completedAt),
            approvalState: String(row.approvalState ?? 'NONE'),
            approvalRequestedAt: rawDate(row.approvalRequestedAt),
        };
    }

    const sessions: WorkReportSessionDto[] = [];
    for (const row of sessionRows) {
        const startedAt = rawDate(row.startedAt);
        if (!startedAt) continue;
        const endedAt = rawDate(row.endedAt);
        const naturalEnd = endedAt ?? now;
        const clippedStart = startedAt < from ? from : startedAt;
        const clippedEnd = naturalEnd > to ? to : naturalEnd;
        if (clippedEnd <= clippedStart) continue;
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
            const doneAt = rawDate(row.doneAt);
            return doneAt ? [{ taskId: row.taskId, text: plainLine(row.text), doneAt }] : [];
        }),
        comments: commentRows.flatMap((row) => {
            const createdAt = rawDate(row.createdAt);
            return createdAt ? [{ taskId: row.taskId, text: plainLine(row.text), createdAt }] : [];
        }),
        tasks,
    };
};
