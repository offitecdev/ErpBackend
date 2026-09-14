"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyTimerAction = exports.listTimers = exports.readTimer = exports.toTimerDto = void 0;
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const timerErrors_1 = require("./timerErrors");
const timerMachine_1 = require("./timerMachine");
/* ── Zeile ⇄ Stand ────────────────────────────────────────────────────────── */
const asStatus = (raw) => timerMachine_1.TIMER_STATUSES.includes(raw) ? raw : 'IDLE';
const rowToState = (row) => ({
    status: asStatus(row.status),
    startedAtMs: row.startedAt ? row.startedAt.getTime() : null,
    accumulatedMs: Number(row.accumulatedMs),
    completedAtMs: row.completedAt ? row.completedAt.getTime() : null,
    lastTransitionAtMs: row.lastTransitionAt.getTime(),
});
const stateToColumns = (state) => ({
    status: state.status,
    startedAt: state.startedAtMs === null ? null : new Date(state.startedAtMs),
    accumulatedMs: BigInt(Math.round(state.accumulatedMs)),
    completedAt: state.completedAtMs === null ? null : new Date(state.completedAtMs),
    lastTransitionAt: new Date(state.lastTransitionAtMs),
});
const toIso = (ms) => (ms === null ? null : new Date(ms).toISOString());
const toTimerDto = (subject, state, version, now) => ({
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    status: state.status,
    startedAt: toIso(state.startedAtMs),
    accumulatedMs: state.accumulatedMs,
    elapsedMs: (0, timerMachine_1.elapsedMsAt)(state, now.getTime()),
    completedAt: toIso(state.completedAtMs),
    version,
});
exports.toTimerDto = toTimerDto;
const uniqueWhere = (scope, subject) => ({
    tenantId_ownerId_subjectType_subjectId: {
        tenantId: scope.tenantId,
        ownerId: scope.ownerId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
    },
});
const isUniqueViolation = (error) => error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
/* ── Lesen ────────────────────────────────────────────────────────────────── */
/** Der Stand eines Gegenstands — ohne Zeile ein virtueller IDLE-Stand (die Oberfläche braucht keinen 404-Fall). */
const readTimer = async (scope, subject) => {
    const row = await prisma_client_1.default.serverTimer.findUnique({ where: uniqueWhere(scope, subject) });
    return (0, exports.toTimerDto)(subject, row ? rowToState(row) : timerMachine_1.IDLE_STATE, row?.version ?? 0, new Date());
};
exports.readTimer = readTimer;
const LIST_LIMIT = 200;
/** Die eigenen Zähler der ausgewählten Firma, jüngste zuerst; `status` grenzt ein (z. B. nur RUNNING). */
const listTimers = async (scope, status) => {
    const rows = await prisma_client_1.default.serverTimer.findMany({
        where: { tenantId: scope.tenantId, ownerId: scope.ownerId, ...(status ? { status } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: LIST_LIMIT,
    });
    const now = new Date();
    return rows.map((row) => (0, exports.toTimerDto)({ subjectType: row.subjectType, subjectId: row.subjectId }, rowToState(row), row.version, now));
};
exports.listTimers = listTimers;
/* ── Schreiben ────────────────────────────────────────────────────────────── */
const WRITE_ATTEMPTS = 3;
/**
 * start | pause | resume | stop | reset auf den Zähler anwenden. Der Zeitpunkt
 * wird EINMAL von der Serveruhr festgelegt — ein Wiederholungsversuch darf ihn
 * nicht um die Dauer des ersten Datenbankgangs verschieben.
 */
const applyTimerAction = async (scope, subject, action) => {
    const operationMs = Date.now();
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const row = await prisma_client_1.default.serverTimer.findUnique({ where: uniqueWhere(scope, subject) });
        const current = row ? rowToState(row) : timerMachine_1.IDLE_STATE;
        // Bei einer konkurrierenden Aktion nie vor den letzten Wechsel gehen.
        const atMs = Math.max(operationMs, current.lastTransitionAtMs);
        const result = (0, timerMachine_1.transition)(current, action, atMs);
        if (!result.ok)
            throw (0, timerErrors_1.timerRejected)(result.reason, action, current.status);
        if (!result.changed)
            return (0, exports.toTimerDto)(subject, current, row?.version ?? 0, new Date());
        if (!row) {
            try {
                await prisma_client_1.default.serverTimer.create({
                    data: {
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId: scope.tenantId,
                        ownerId: scope.ownerId,
                        subjectType: subject.subjectType,
                        subjectId: subject.subjectId,
                        ...stateToColumns(result.state),
                        version: 1,
                    },
                });
                return (0, exports.toTimerDto)(subject, result.state, 1, new Date());
            }
            catch (error) {
                // Zwei erste Starts zugleich: der zweite trifft den eindeutigen Index und liest neu.
                if (!isUniqueViolation(error))
                    throw error;
                continue;
            }
        }
        const written = await prisma_client_1.default.serverTimer.updateMany({
            where: { id: row.id, version: row.version },
            data: { ...stateToColumns(result.state), version: row.version + 1 },
        });
        if (written.count === 1)
            return (0, exports.toTimerDto)(subject, result.state, row.version + 1, new Date());
        // Ein anderes Gerät war schneller — mit dem neuen Stand noch einmal.
    }
    throw (0, timerErrors_1.timerConflict)();
};
exports.applyTimerAction = applyTimerAction;
//# sourceMappingURL=serverTimerService.js.map