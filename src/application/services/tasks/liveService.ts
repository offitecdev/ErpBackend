import { Prisma } from '@prisma/client';

import prisma from '../../../infrastructure/database/prisma.client';
import type { TasksActor } from './taskActor';
import { getTasksPeople, loadPersonRefs, personDisplayName } from './taskPeople';
import { rawDate, rawNumber } from './taskRows';
import { DAY_MS, endOfLocalDay, startOfLocalDay } from './taskTime';

/**
 * ── CANLI: WER ARBEITET HEUTE WORAN (13.09.2026, Vorgabe Samet) ─────────────
 *
 * «panoda sürükleme olmayacak, sadece günlük kim ne yapıyor canlı izleme
 * olacak». Die Pano ist keine Kanban-Tafel mehr, sondern eine Übersicht des
 * Tages: je Person die laufende Messung, die Messungen des Tages und die heute
 * erledigten Aufgaben. Projekte kennt das Modul nicht — die Etiketten der
 * Aufgabe sind der Zusammenhang, in dem gearbeitet wird.
 *
 * Sicht: die Leitung sieht alle Personen des Moduls, ein Teammitglied nur sich
 * selbst (fremde Messungen hängen an Aufgaben, die es nicht sehen darf).
 *
 * «Heute» = `from`/`to` aus dem Browser (dessen Tagesgrenzen), sonst der Tag
 * der Server-Uhr. Drei parallele Abfragen, keine Transaktion.
 */

export interface LiveLabelDto {
    id: string;
    name: string;
    color: string;
}

export interface LiveSessionDto {
    id: string;
    taskId: string;
    taskTitle: string;
    startedAt: Date;
    /** null = läuft. */
    endedAt: Date | null;
    /** Anteil innerhalb des Tages (bis jetzt, wenn sie läuft). */
    durationMs: number;
}

export interface LivePersonDto {
    employeeId: string;
    name: string;
    title: string | null;
    isManager: boolean;
    running: { sessionId: string; taskId: string; taskTitle: string; taskStatus: string; startedAt: Date } | null;
    todayMs: number;
    sessions: LiveSessionDto[];
    completedToday: Array<{ taskId: string; title: string; completedAt: Date }>;
    /** Zuletzt aktiv heute (Ende der letzten Messung), null = heute nichts. */
    lastActiveAt: Date | null;
}

export interface LiveOverviewDto {
    day: { from: Date; to: Date };
    serverNow: Date;
    /** Etiketten je Aufgabe, die in `people` vorkommt. */
    taskLabels: Record<string, LiveLabelDto[]>;
    people: LivePersonDto[];
}

const parseDate = (value: unknown): Date | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const date = new Date(value.trim());
    return Number.isNaN(date.getTime()) ? null : date;
};

/** Tagesgrenzen: die des Browsers, wenn plausibel (≤ 36 h), sonst die des Servers. */
const resolveDay = (query: Record<string, unknown>, now: Date): { from: Date; to: Date } => {
    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (from && to && to.getTime() > from.getTime() && to.getTime() - from.getTime() <= DAY_MS * 1.5) {
        return { from, to };
    }
    return { from: startOfLocalDay(now), to: endOfLocalDay(now) };
};

export const getLiveOverview = async (actor: TasksActor, query: Record<string, unknown>): Promise<LiveOverviewDto> => {
    const now = new Date();
    const day = resolveDay(query, now);
    const tenantId = actor.tenantId;
    // Nur Admins sehen alle; alle anderen (auch die Leitung) nur sich selbst.
    const onlyMe = actor.seesAll ? Prisma.empty : Prisma.sql`AND s.employeeId = ${actor.employeeId}`;
    const onlyMeAssignee = actor.seesAll ? Prisma.empty : Prisma.sql`AND a.employeeId = ${actor.employeeId}`;

    const sessionWindow = Prisma.sql`
        s.tenantId = ${tenantId}
        AND s.startedAt <= ${day.to}
        AND (s.endedAt IS NULL OR s.endedAt >= ${day.from})
    `;
    const completedWindow = Prisma.sql`
        t.tenantId = ${tenantId}
        AND t.status = 'COMPLETED'
        AND t.completedAt >= ${day.from}
        AND t.completedAt <= ${day.to}
    `;

    const [people, sessionRows, completedRows, labelRows] = await Promise.all([
        getTasksPeople(tenantId),
        prisma.$queryRaw<Array<{
            id: string; taskId: string; employeeId: string; startedAt: unknown; endedAt: unknown;
            title: string | null; status: string; runningKey: string | null;
        }>>(Prisma.sql`
            SELECT s.id, s.taskId, s.employeeId, s.startedAt, s.endedAt, s.runningKey, t.title, t.status
            FROM TaskTimeSession s
            JOIN Task t ON t.id = s.taskId
            WHERE ${sessionWindow} ${onlyMe}
            ORDER BY s.startedAt ASC
        `),
        prisma.$queryRaw<Array<{ id: string; title: string | null; completedAt: unknown; employeeId: string }>>(Prisma.sql`
            SELECT t.id, t.title, t.completedAt, a.employeeId
            FROM Task t
            JOIN TaskAssignee a ON a.taskId = t.id
            WHERE ${completedWindow} ${onlyMeAssignee}
            ORDER BY t.completedAt ASC
        `),
        prisma.$queryRaw<Array<{ taskId: string; id: string; name: string; color: string; createdAt: unknown }>>(Prisma.sql`
            SELECT ll.taskId, lb.id, lb.name, lb.color, ll.createdAt
            FROM TaskLabelLink ll
            JOIN TaskLabel lb ON lb.id = ll.labelId
            WHERE ll.tenantId = ${tenantId}
              AND ll.taskId IN (
                  SELECT s.taskId FROM TaskTimeSession s WHERE ${sessionWindow} ${onlyMe}
                  UNION
                  SELECT t.id FROM Task t JOIN TaskAssignee a ON a.taskId = t.id WHERE ${completedWindow} ${onlyMeAssignee}
              )
            ORDER BY ll.createdAt ASC
        `),
    ]);

    const byPerson = new Map<string, LivePersonDto>();
    const ensurePerson = (employeeId: string): LivePersonDto => {
        let entry = byPerson.get(employeeId);
        if (!entry) {
            const person = people.get(employeeId);
            entry = {
                employeeId,
                name: person ? personDisplayName(person) : '',
                title: person?.title ?? null,
                isManager: person?.isManager ?? false,
                running: null,
                todayMs: 0,
                sessions: [],
                completedToday: [],
                lastActiveAt: null,
            };
            byPerson.set(employeeId, entry);
        }
        return entry;
    };

    // Alle Personen des Moduls (Leitung) bzw. nur sich selbst.
    if (actor.seesAll) for (const id of people.keys()) ensurePerson(id);
    else ensurePerson(actor.employeeId);

    for (const row of sessionRows) {
        const startedAt = rawDate(row.startedAt);
        if (!startedAt) continue;
        const endedAt = rawDate(row.endedAt);
        const live = !endedAt;
        const clipStart = Math.max(startedAt.getTime(), day.from.getTime());
        // KEINE laufende Zeit (14.09.2026, Samet): eine laufende Messung zählt erst beim Pausieren.
        const durationMs = live ? 0 : Math.max(0, Math.min(endedAt.getTime(), day.to.getTime()) - clipStart);
        const entry = ensurePerson(row.employeeId);
        entry.sessions.push({ id: row.id, taskId: row.taskId, taskTitle: row.title ?? '', startedAt, endedAt, durationMs });
        entry.todayMs += durationMs;
        if (live && row.runningKey) {
            entry.running = { sessionId: row.id, taskId: row.taskId, taskTitle: row.title ?? '', taskStatus: row.status, startedAt };
            entry.lastActiveAt = now;
        } else if (endedAt && (!entry.lastActiveAt || endedAt.getTime() > entry.lastActiveAt.getTime())) {
            entry.lastActiveAt = endedAt;
        }
    }

    for (const row of completedRows) {
        const completedAt = rawDate(row.completedAt);
        if (!completedAt) continue;
        const entry = byPerson.get(row.employeeId) ?? (actor.seesAll ? ensurePerson(row.employeeId) : null);
        entry?.completedToday.push({ taskId: row.id, title: row.title ?? '', completedAt });
    }

    // Namen für Personen, die heute gemessen haben, aber nicht (mehr) im Modul stehen.
    const unnamed = [...byPerson.values()].filter((entry) => !entry.name).map((entry) => entry.employeeId);
    if (unnamed.length) {
        const refs = await loadPersonRefs(unnamed);
        for (const id of unnamed) {
            const entry = byPerson.get(id);
            if (entry) {
                entry.name = refs[id]?.name ?? '';
                entry.title = refs[id]?.title ?? null;
            }
        }
    }

    const taskLabels: Record<string, LiveLabelDto[]> = {};
    for (const row of labelRows) {
        (taskLabels[row.taskId] ??= []).push({ id: row.id, name: row.name, color: row.color });
    }

    const rank = (entry: LivePersonDto): number => (entry.running ? 0 : entry.sessions.length ? 1 : 2);
    const list = [...byPerson.values()].sort((a, b) =>
        rank(a) - rank(b)
        || (rank(a) === 1 ? rawNumber(b.lastActiveAt?.getTime()) - rawNumber(a.lastActiveAt?.getTime()) : 0)
        || a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })
        || a.employeeId.localeCompare(b.employeeId));

    return { day, serverNow: now, taskLabels, people: list };
};
