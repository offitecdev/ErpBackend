import { Prisma, type ServerTimer } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import { timerConflict, timerRejected } from './timerErrors';
import {
    elapsedMsAt,
    IDLE_STATE,
    TIMER_STATUSES,
    transition,
    type TimerAction,
    type TimerState,
    type TimerStatus,
} from './timerMachine';

/**
 * ── ZEITMESSUNG NACH ZEITSTEMPELN: DER DIENST ────────────────────────────────
 *
 * EINE QUELLE DER WAHRHEIT (14.09.2026, Samet): der Server nimmt vom Browser
 * nie eine Dauer entgegen. Er hält je Firma, Person und Gegenstand einen Stand
 * (timerMachine.ts) und rechnet jeden Wechsel mit SEINER Uhr. Jede Antwort
 * trägt `serverTime`, damit der Browser seinen Uhrversatz bestimmen kann.
 *
 * Weder Dauer noch Client-Zeitstempel werden akzeptiert. Der Zeitpunkt jeder
 * Aktion wird genau einmal mit der Serveruhr erfasst und bei einem
 * Konkurrenz-Retry unverändert weiterverwendet.
 *
 * Schreiben ohne Zeilensperre: Lesen → Regeln anwenden → Vergleich-und-Tausch
 * über `version`. Zwei Geräte gleichzeitig: der zweite Versuch liest neu und
 * scheitert nur, wenn der Wechsel nach dem neuen Stand unzulässig ist.
 * Zwei Rundgänge zur fernen Datenbank je Handlung — keine Transaktion.
 */

export interface TimerScope {
    tenantId: string;
    /** Personal-id — jeder Mensch hat je Gegenstand seinen eigenen Zähler. */
    ownerId: string;
}

export interface TimerSubject {
    /** Grossbuchstaben-Kennung des Bereichs, z. B. TASK, PROJECT, GENERIC. */
    subjectType: string;
    subjectId: string;
}

export interface ServerTimerDto {
    subjectType: string;
    subjectId: string;
    status: TimerStatus;
    /** UTC-ISO — Beginn des laufenden Abschnitts, sonst null. */
    startedAt: string | null;
    /** Summe der abgeschlossenen Abschnitte in ms. */
    accumulatedMs: number;
    /** Verstrichene Zeit zum `serverTime` der Antwort — für Anzeigen OHNE Uhr (Listen, Berichte). Eine tickende Uhr rechnet aus startedAt + accumulatedMs. */
    elapsedMs: number;
    completedAt: string | null;
    /** Zählstand der Zeile; 0 = noch keine Zeile (virtueller IDLE-Stand). */
    version: number;
}

/* ── Zeile ⇄ Stand ────────────────────────────────────────────────────────── */

const asStatus = (raw: string): TimerStatus =>
    (TIMER_STATUSES as readonly string[]).includes(raw) ? (raw as TimerStatus) : 'IDLE';

const rowToState = (row: ServerTimer): TimerState => ({
    status: asStatus(row.status),
    startedAtMs: row.startedAt ? row.startedAt.getTime() : null,
    accumulatedMs: Number(row.accumulatedMs),
    completedAtMs: row.completedAt ? row.completedAt.getTime() : null,
    lastTransitionAtMs: row.lastTransitionAt.getTime(),
});

const stateToColumns = (state: TimerState) => ({
    status: state.status,
    startedAt: state.startedAtMs === null ? null : new Date(state.startedAtMs),
    accumulatedMs: BigInt(Math.round(state.accumulatedMs)),
    completedAt: state.completedAtMs === null ? null : new Date(state.completedAtMs),
    lastTransitionAt: new Date(state.lastTransitionAtMs),
});

const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export const toTimerDto = (subject: TimerSubject, state: TimerState, version: number, now: Date): ServerTimerDto => ({
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    status: state.status,
    startedAt: toIso(state.startedAtMs),
    accumulatedMs: state.accumulatedMs,
    elapsedMs: elapsedMsAt(state, now.getTime()),
    completedAt: toIso(state.completedAtMs),
    version,
});

const uniqueWhere = (scope: TimerScope, subject: TimerSubject) => ({
    tenantId_ownerId_subjectType_subjectId: {
        tenantId: scope.tenantId,
        ownerId: scope.ownerId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
    },
});

const isUniqueViolation = (error: unknown): boolean =>
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/* ── Lesen ────────────────────────────────────────────────────────────────── */

/** Der Stand eines Gegenstands — ohne Zeile ein virtueller IDLE-Stand (die Oberfläche braucht keinen 404-Fall). */
export const readTimer = async (scope: TimerScope, subject: TimerSubject): Promise<ServerTimerDto> => {
    const row = await prisma.serverTimer.findUnique({ where: uniqueWhere(scope, subject) });
    return toTimerDto(subject, row ? rowToState(row) : IDLE_STATE, row?.version ?? 0, new Date());
};

const LIST_LIMIT = 200;

/** Die eigenen Zähler der ausgewählten Firma, jüngste zuerst; `status` grenzt ein (z. B. nur RUNNING). */
export const listTimers = async (scope: TimerScope, status?: TimerStatus): Promise<ServerTimerDto[]> => {
    const rows = await prisma.serverTimer.findMany({
        where: { tenantId: scope.tenantId, ownerId: scope.ownerId, ...(status ? { status } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: LIST_LIMIT,
    });
    const now = new Date();
    return rows.map((row) => toTimerDto({ subjectType: row.subjectType, subjectId: row.subjectId }, rowToState(row), row.version, now));
};

/* ── Schreiben ────────────────────────────────────────────────────────────── */

const WRITE_ATTEMPTS = 3;

/**
 * start | pause | resume | stop | reset auf den Zähler anwenden. Der Zeitpunkt
 * wird EINMAL von der Serveruhr festgelegt — ein Wiederholungsversuch darf ihn
 * nicht um die Dauer des ersten Datenbankgangs verschieben.
 */
export const applyTimerAction = async (
    scope: TimerScope,
    subject: TimerSubject,
    action: TimerAction,
): Promise<ServerTimerDto> => {
    const operationMs = Date.now();

    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const row = await prisma.serverTimer.findUnique({ where: uniqueWhere(scope, subject) });
        const current = row ? rowToState(row) : IDLE_STATE;
        // Bei einer konkurrierenden Aktion nie vor den letzten Wechsel gehen.
        const atMs = Math.max(operationMs, current.lastTransitionAtMs);
        const result = transition(current, action, atMs);
        if (!result.ok) throw timerRejected(result.reason, action, current.status);
        if (!result.changed) return toTimerDto(subject, current, row?.version ?? 0, new Date());

        if (!row) {
            try {
                await prisma.serverTimer.create({
                    data: {
                        id: nanoid(12),
                        tenantId: scope.tenantId,
                        ownerId: scope.ownerId,
                        subjectType: subject.subjectType,
                        subjectId: subject.subjectId,
                        ...stateToColumns(result.state),
                        version: 1,
                    },
                });
                return toTimerDto(subject, result.state, 1, new Date());
            } catch (error) {
                // Zwei erste Starts zugleich: der zweite trifft den eindeutigen Index und liest neu.
                if (!isUniqueViolation(error)) throw error;
                continue;
            }
        }

        const written = await prisma.serverTimer.updateMany({
            where: { id: row.id, version: row.version },
            data: { ...stateToColumns(result.state), version: row.version + 1 },
        });
        if (written.count === 1) return toTimerDto(subject, result.state, row.version + 1, new Date());
        // Ein anderes Gerät war schneller — mit dem neuen Stand noch einmal.
    }

    throw timerConflict();
};
