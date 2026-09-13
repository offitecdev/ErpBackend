import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import type { TasksActor } from './taskActor';
import { taskPermissions } from './taskAccess';
import { logTaskActivity } from './taskActivity';
import { ACTIVITY, TASK_LIMITS } from './taskConstants';
import { runTasksTransaction, type TasksDb } from './taskDb';
import { taskForbidden, taskNotFound } from './taskErrors';
import { loadTaskCore, rawDate } from './taskRows';
import { liveDurationMs } from './taskTime';

/**
 * ── ZEITMESSUNG: START / PAUSE ───────────────────────────────────────────────
 *
 * Vorgabe: «elle süre ekleme olmayacak» — Zeit entsteht NUR hier. Regeln aus
 * Görevly (timer.js):
 *   • Eine Person misst immer nur EINE Aufgabe. Startet sie eine andere, wird
 *     die laufende Messung automatisch beendet (Notiz SWITCHED).
 *     Durchgesetzt vom eindeutigen Index auf `runningKey`, auch über Firmen.
 *   • Messungen unter 2 s werden verworfen.
 *   • Start auf einer NOT_STARTED- oder BLOCKED-Aufgabe setzt sie auf
 *     IN_PROGRESS und löscht den Blockadegrund.
 *   • Nur Verantwortliche einer offenen, nicht abgelehnten Aufgabe messen.
 *
 * `note` einer beendeten Messung ist ein CODE, kein Satz (die Oberfläche
 * übersetzt): SWITCHED · COMPLETION_REQUESTED · TASK_COMPLETED ·
 * REVIEW_REJECTED · UNASSIGNED · null (Pause von Hand).
 *
 * SPERRREIHENFOLGE: erst die Aufgabenzeile(n) nach Kennung, dann die
 * Messzeile. Zustandswechsel (Abschluss, Ablehnung) sperren in derselben
 * Reihenfolge — so kann keine Verklemmung zwischen beiden entstehen.
 */

export type SessionCloseNote = 'SWITCHED' | 'COMPLETION_REQUESTED' | 'TASK_COMPLETED' | 'REVIEW_REJECTED' | 'UNASSIGNED';

interface RunningRow {
    id: string;
    tenantId: string;
    taskId: string;
    employeeId: string;
    startedAt: Date;
}

const mapRunning = (row: { id: string; tenantId: string; taskId: string; employeeId: string; startedAt: unknown }): RunningRow | null => {
    const startedAt = rawDate(row.startedAt);
    return startedAt ? { id: row.id, tenantId: row.tenantId, taskId: row.taskId, employeeId: row.employeeId, startedAt } : null;
};

const readRunningOfEmployee = async (db: TasksDb, employeeId: string, forUpdate: boolean): Promise<RunningRow | null> => {
    const lock = forUpdate ? Prisma.sql`FOR UPDATE` : Prisma.empty;
    const rows = await db.$queryRaw<Array<{ id: string; tenantId: string; taskId: string; employeeId: string; startedAt: unknown }>>(Prisma.sql`
        SELECT id, tenantId, taskId, employeeId, startedAt
        FROM TaskTimeSession
        WHERE runningKey = ${employeeId}
        ${lock}
    `);
    return rows[0] ? mapRunning(rows[0]) : null;
};

/** Sperrt Aufgabenzeilen in fester Reihenfolge (ohne Firmenfilter — die Kennungen stammen aus geprüften Zeilen). */
const lockTaskRowsById = async (tx: TasksDb, taskIds: string[]): Promise<void> => {
    const ids = [...new Set(taskIds)].sort();
    if (!ids.length) return;
    await tx.$queryRaw(Prisma.sql`SELECT id FROM Task WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
};

export interface ClosedSession {
    taskId: string;
    tenantId: string;
    employeeId: string;
    durationMs: number;
    discarded: boolean;
}

/** Beendet EINE laufende Messung (Aufrufer hält die Sperren). */
const closeSessionRow = async (
    tx: TasksDb,
    row: RunningRow,
    now: Date,
    actorId: string,
    note: SessionCloseNote | null,
): Promise<ClosedSession> => {
    const durationMs = liveDurationMs(row.startedAt, now);
    const discarded = durationMs <= TASK_LIMITS.sessionMinMs;
    if (discarded) {
        await tx.taskTimeSession.deleteMany({ where: { id: row.id } });
    } else {
        await tx.taskTimeSession.updateMany({
            where: { id: row.id },
            data: { endedAt: now, durationMs, runningKey: null, note },
        });
        await logTaskActivity(tx, row.tenantId, actorId, {
            taskId: row.taskId,
            type: ACTIVITY.TIMER_PAUSE,
            meta: {
                ms: durationMs,
                ...(row.employeeId !== actorId ? { employeeId: row.employeeId } : {}),
                ...(note ? { note } : {}),
            },
        });
    }
    return { taskId: row.taskId, tenantId: row.tenantId, employeeId: row.employeeId, durationMs, discarded };
};

/**
 * Beendet ALLE laufenden Messungen an einer Aufgabe (Abschluss, Ablehnung,
 * Zuweisung entfernt). Der Aufrufer hält die Sperre der Aufgabenzeile.
 * `employeeIds` grenzt auf bestimmte Personen ein.
 */
export const closeRunningSessionsOnTask = async (
    tx: TasksDb,
    tenantId: string,
    taskId: string,
    actorId: string,
    note: SessionCloseNote,
    employeeIds?: readonly string[],
): Promise<ClosedSession[]> => {
    if (employeeIds && !employeeIds.length) return [];
    const onlyThese = employeeIds ? Prisma.sql`AND employeeId IN (${Prisma.join([...employeeIds])})` : Prisma.empty;
    const rows = await tx.$queryRaw<Array<{ id: string; tenantId: string; taskId: string; employeeId: string; startedAt: unknown }>>(Prisma.sql`
        SELECT id, tenantId, taskId, employeeId, startedAt
        FROM TaskTimeSession
        WHERE tenantId = ${tenantId} AND taskId = ${taskId} AND endedAt IS NULL ${onlyThese}
        FOR UPDATE
    `);
    const now = new Date();
    const closed: ClosedSession[] = [];
    for (const raw of rows) {
        const row = mapRunning(raw);
        if (row) closed.push(await closeSessionRow(tx, row, now, actorId, note));
    }
    return closed;
};

export interface StartTimerResult {
    taskId: string;
    startedAt: Date;
    alreadyRunning: boolean;
    status: string;
    statusChanged: boolean;
    switchedFrom: { taskId: string; title: string; tenantId: string; durationMs: number; discarded: boolean } | null;
}

/** Zwischen Vorablesung und Sperre hat die laufende Messung gewechselt. */
class RunningSessionMoved extends Error {
    constructor() {
        super('Laufende Messung hat gewechselt.');
        this.name = 'RunningSessionMoved';
    }
}

const isRetryableStartError = (error: unknown): boolean =>
    error instanceof RunningSessionMoved
    || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');

const startOnce = async (actor: TasksActor, taskId: string): Promise<StartTimerResult> => {
    const me = actor.employeeId;
    // Vorab ohne Sperre: welche Messung läuft — damit beide Aufgaben in
    // fester Reihenfolge gesperrt werden können.
    const previous = await readRunningOfEmployee(prisma, me, false);

    return runTasksTransaction(async (tx) => {
        await lockTaskRowsById(tx, previous && previous.taskId !== taskId ? [taskId, previous.taskId] : [taskId]);

        const core = await loadTaskCore(tx, actor.tenantId, taskId);
        if (!core) throw taskNotFound();
        const permissions = taskPermissions(actor, core);
        if (!permissions.canSee) throw taskForbidden('TASK_FORBIDDEN', 'Diese Aufgabe ist für Sie nicht sichtbar.');
        if (!permissions.canTrack) {
            throw taskForbidden('TIMER_NOT_ALLOWED', 'Die Zeit messen nur Verantwortliche einer offenen Aufgabe.');
        }

        const running = await readRunningOfEmployee(tx, me, true);
        if (running && running.taskId === taskId) {
            return {
                taskId,
                startedAt: running.startedAt,
                alreadyRunning: true,
                status: core.status,
                statusChanged: false,
                switchedFrom: null,
            };
        }
        // Lief inzwischen eine ANDERE Aufgabe als vorab gelesen, ist deren Zeile
        // nicht gesperrt — neu anfangen statt ungeordnet zu sperren.
        if (running && running.taskId !== previous?.taskId) throw new RunningSessionMoved();

        const now = new Date();
        let switchedFrom: StartTimerResult['switchedFrom'] = null;
        if (running) {
            const other = await tx.task.findFirst({ where: { id: running.taskId }, select: { title: true } });
            const closed = await closeSessionRow(tx, running, now, me, 'SWITCHED');
            switchedFrom = {
                taskId: running.taskId,
                title: other?.title ?? '',
                tenantId: running.tenantId,
                durationMs: closed.durationMs,
                discarded: closed.discarded,
            };
        }

        await tx.taskTimeSession.create({
            data: { id: nanoid(12), tenantId: actor.tenantId, taskId, employeeId: me, startedAt: now, runningKey: me },
        });

        let status = core.status;
        let statusChanged = false;
        if (core.status === 'NOT_STARTED' || core.status === 'BLOCKED') {
            await tx.task.updateMany({
                where: { id: taskId, tenantId: actor.tenantId },
                data: { status: 'IN_PROGRESS', blockReason: null },
            });
            status = 'IN_PROGRESS';
            statusChanged = true;
        }
        await logTaskActivity(tx, actor.tenantId, me, { taskId, type: ACTIVITY.TIMER_START });

        return { taskId, startedAt: now, alreadyRunning: false, status, statusChanged, switchedFrom };
    });
};

/** Messung an einer Aufgabe starten (beendet eine andere laufende). */
export const startTaskTimer = async (actor: TasksActor, taskId: string): Promise<StartTimerResult> => {
    try {
        return await startOnce(actor, taskId);
    } catch (error) {
        // Zwei gleichzeitige Starts derselben Person: der zweite trifft den
        // eindeutigen Index — ein zweiter Versuch sieht die Lage klar.
        if (!isRetryableStartError(error)) throw error;
        return startOnce(actor, taskId);
    }
};

/**
 * Die eigene laufende Messung beenden. Mit `taskId` nur, wenn sie auf GENAU
 * dieser Aufgabe läuft. null = es lief nichts (kein Fehler — Doppelklick).
 */
export const pauseTaskTimer = async (
    actor: TasksActor,
    options: { taskId?: string; note?: SessionCloseNote | null } = {},
): Promise<ClosedSession | null> => {
    const me = actor.employeeId;
    const previous = await readRunningOfEmployee(prisma, me, false);
    if (!previous || (options.taskId && previous.taskId !== options.taskId)) return null;

    return runTasksTransaction(async (tx) => {
        await lockTaskRowsById(tx, [previous.taskId]);
        const rows = await tx.$queryRaw<Array<{ id: string; tenantId: string; taskId: string; employeeId: string; startedAt: unknown }>>(Prisma.sql`
            SELECT id, tenantId, taskId, employeeId, startedAt
            FROM TaskTimeSession
            WHERE id = ${previous.id} AND runningKey = ${me}
            FOR UPDATE
        `);
        const row = rows[0] ? mapRunning(rows[0]) : null;
        if (!row) return null;
        return closeSessionRow(tx, row, new Date(), me, options.note ?? null);
    });
};

export interface ActiveTimerInfo {
    taskId: string;
    taskTitle: string;
    /** Firma der Aufgabe — kann eine andere als die ausgewählte sein. */
    tenantId: string;
    startedAt: Date;
}

/** Die laufende Messung einer Person (für Seitenleiste/Banner). */
export const getActiveTimer = async (employeeId: string): Promise<ActiveTimerInfo | null> => {
    const rows = await prisma.$queryRaw<Array<{ taskId: string; tenantId: string; startedAt: unknown; title: string | null }>>(Prisma.sql`
        SELECT s.taskId, s.tenantId, s.startedAt, t.title
        FROM TaskTimeSession s
        JOIN Task t ON t.id = s.taskId
        WHERE s.runningKey = ${employeeId}
        LIMIT 1
    `);
    const row = rows[0];
    const startedAt = row ? rawDate(row.startedAt) : null;
    if (!row || !startedAt) return null;
    return { taskId: row.taskId, taskTitle: row.title ?? '', tenantId: row.tenantId, startedAt };
};
