"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getActiveTimer = exports.pauseTaskTimer = exports.startTaskTimer = exports.closeRunningSessionsOnTask = void 0;
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskAccess_1 = require("./taskAccess");
const taskActivity_1 = require("./taskActivity");
const taskConstants_1 = require("./taskConstants");
const taskDb_1 = require("./taskDb");
const taskErrors_1 = require("./taskErrors");
const taskRows_1 = require("./taskRows");
const taskTime_1 = require("./taskTime");
/* Der Browser schickt den Klickzeitpunkt mit. Er darf eine langsame Anfrage
   ausgleichen, aber keine frei erfundene Arbeitszeit erzeugen: höchstens fünf
   Minuten vor Empfang und niemals nach Empfang werden akzeptiert. Alte Clients
   ohne `actionAt` verwenden weiterhin unmittelbar die Empfangszeit. */
const mapRunning = (row) => {
    const startedAt = (0, taskRows_1.rawDate)(row.startedAt);
    return startedAt ? { id: row.id, tenantId: row.tenantId, taskId: row.taskId, employeeId: row.employeeId, startedAt } : null;
};
const readRunningOfEmployee = async (db, employeeId, forUpdate) => {
    const lock = forUpdate ? client_1.Prisma.sql `FOR UPDATE` : client_1.Prisma.empty;
    const rows = await db.$queryRaw(client_1.Prisma.sql `
        SELECT id, tenantId, taskId, employeeId, startedAt
        FROM TaskTimeSession
        WHERE runningKey = ${employeeId}
        ${lock}
    `);
    return rows[0] ? mapRunning(rows[0]) : null;
};
/** Sperrt Aufgabenzeilen in fester Reihenfolge (ohne Firmenfilter — die Kennungen stammen aus geprüften Zeilen). */
const lockTaskRowsById = async (tx, taskIds) => {
    const ids = [...new Set(taskIds)].sort();
    if (!ids.length)
        return;
    await tx.$queryRaw(client_1.Prisma.sql `SELECT id FROM Task WHERE id IN (${client_1.Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
};
/** Beendet EINE laufende Messung (Aufrufer hält die Sperren). */
const closeSessionRow = async (tx, row, now, actorId, note) => {
    const durationMs = (0, taskTime_1.liveDurationMs)(row.startedAt, now);
    const discarded = durationMs <= taskConstants_1.TASK_LIMITS.sessionMinMs;
    if (discarded) {
        await tx.taskTimeSession.deleteMany({ where: { id: row.id } });
    }
    else {
        await tx.taskTimeSession.updateMany({
            where: { id: row.id },
            data: { endedAt: now, durationMs, runningKey: null, note },
        });
        await (0, taskActivity_1.logTaskActivity)(tx, row.tenantId, actorId, {
            taskId: row.taskId,
            type: taskConstants_1.ACTIVITY.TIMER_PAUSE,
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
const closeRunningSessionsOnTask = async (tx, tenantId, taskId, actorId, note, employeeIds) => {
    if (employeeIds && !employeeIds.length)
        return [];
    const onlyThese = employeeIds ? client_1.Prisma.sql `AND employeeId IN (${client_1.Prisma.join([...employeeIds])})` : client_1.Prisma.empty;
    const rows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT id, tenantId, taskId, employeeId, startedAt
        FROM TaskTimeSession
        WHERE tenantId = ${tenantId} AND taskId = ${taskId} AND endedAt IS NULL ${onlyThese}
        FOR UPDATE
    `);
    const now = new Date();
    const closed = [];
    for (const raw of rows) {
        const row = mapRunning(raw);
        if (row)
            closed.push(await closeSessionRow(tx, row, now, actorId, note));
    }
    return closed;
};
exports.closeRunningSessionsOnTask = closeRunningSessionsOnTask;
/** Zwischen Vorablesung und Sperre hat die laufende Messung gewechselt. */
class RunningSessionMoved extends Error {
    constructor() {
        super('Laufende Messung hat gewechselt.');
        this.name = 'RunningSessionMoved';
    }
}
const isRetryableStartError = (error) => error instanceof RunningSessionMoved
    || (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
const startOnce = async (actor, taskId, operationAt) => {
    const me = actor.employeeId;
    // Vorab ohne Sperre: welche Messung läuft — damit beide Aufgaben in
    // fester Reihenfolge gesperrt werden können.
    const previous = await readRunningOfEmployee(prisma_client_1.default, me, false);
    return (0, taskDb_1.runTasksTransaction)(async (tx) => {
        await lockTaskRowsById(tx, previous && previous.taskId !== taskId ? [taskId, previous.taskId] : [taskId]);
        const core = await (0, taskRows_1.loadTaskCore)(tx, actor.tenantId, taskId);
        if (!core)
            throw (0, taskErrors_1.taskNotFound)();
        const permissions = (0, taskAccess_1.taskPermissions)(actor, core);
        if (!permissions.canSee)
            throw (0, taskErrors_1.taskForbidden)('TASK_FORBIDDEN', 'Diese Aufgabe ist für Sie nicht sichtbar.');
        if (!permissions.canTrack) {
            throw (0, taskErrors_1.taskForbidden)('TIMER_NOT_ALLOWED', 'Die Zeit messen nur Verantwortliche einer offenen Aufgabe.');
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
        if (running && running.taskId !== previous?.taskId)
            throw new RunningSessionMoved();
        // Bei zwei Geräten kann ein inzwischen gestarteter Lauf jünger als der
        // mitgeschickte Klick sein. Niemals vor dessen Beginn abschliessen.
        const now = running && operationAt < running.startedAt ? running.startedAt : operationAt;
        let switchedFrom = null;
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
            data: { id: (0, nanoid_1.nanoid)(12), tenantId: actor.tenantId, taskId, employeeId: me, startedAt: now, runningKey: me },
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
        await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, me, { taskId, type: taskConstants_1.ACTIVITY.TIMER_START });
        return { taskId, startedAt: now, alreadyRunning: false, status, statusChanged, switchedFrom };
    });
};
/** Messung an einer Aufgabe starten (beendet eine andere laufende). */
const startTaskTimer = async (actor, taskId) => {
    // Einmal festlegen: auch ein Wiederholungsversuch darf die Startzeit nicht
    // um die Dauer des ersten Datenbankversuchs verschieben.
    const operationAt = new Date();
    try {
        return await startOnce(actor, taskId, operationAt);
    }
    catch (error) {
        // Zwei gleichzeitige Starts derselben Person: der zweite trifft den
        // eindeutigen Index — ein zweiter Versuch sieht die Lage klar.
        if (!isRetryableStartError(error))
            throw error;
        return startOnce(actor, taskId, operationAt);
    }
};
exports.startTaskTimer = startTaskTimer;
/**
 * Die eigene laufende Messung beenden. Mit `taskId` nur, wenn sie auf GENAU
 * dieser Aufgabe läuft. null = es lief nichts (kein Fehler — Doppelklick).
 */
const pauseTaskTimer = async (actor, options = {}) => {
    const me = actor.employeeId;
    const operationAt = new Date();
    const previous = await readRunningOfEmployee(prisma_client_1.default, me, false);
    if (!previous || (options.taskId && previous.taskId !== options.taskId))
        return null;
    return (0, taskDb_1.runTasksTransaction)(async (tx) => {
        await lockTaskRowsById(tx, [previous.taskId]);
        const rows = await tx.$queryRaw(client_1.Prisma.sql `
            SELECT id, tenantId, taskId, employeeId, startedAt
            FROM TaskTimeSession
            WHERE id = ${previous.id} AND runningKey = ${me}
            FOR UPDATE
        `);
        const row = rows[0] ? mapRunning(rows[0]) : null;
        if (!row)
            return null;
        const endedAt = operationAt < row.startedAt ? row.startedAt : operationAt;
        return closeSessionRow(tx, row, endedAt, me, options.note ?? null);
    });
};
exports.pauseTaskTimer = pauseTaskTimer;
/** Die laufende Messung einer Person (für Seitenleiste/Banner). */
const getActiveTimer = async (employeeId) => {
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT s.taskId, s.tenantId, s.startedAt, t.title
        FROM TaskTimeSession s
        JOIN Task t ON t.id = s.taskId
        WHERE s.runningKey = ${employeeId}
        LIMIT 1
    `);
    const row = rows[0];
    const startedAt = row ? (0, taskRows_1.rawDate)(row.startedAt) : null;
    if (!row || !startedAt)
        return null;
    return { taskId: row.taskId, taskTitle: row.title ?? '', tenantId: row.tenantId, startedAt };
};
exports.getActiveTimer = getActiveTimer;
//# sourceMappingURL=taskTimer.js.map