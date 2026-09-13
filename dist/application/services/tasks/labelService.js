"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteTaskLabel = exports.updateTaskLabel = exports.createTaskLabel = exports.listTaskLabels = void 0;
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskActor_1 = require("./taskActor");
const taskConstants_1 = require("./taskConstants");
const taskErrors_1 = require("./taskErrors");
const LABEL_SELECT = { id: true, name: true, color: true };
const labelNotFound = () => (0, taskErrors_1.taskNotFound)('LABEL_NOT_FOUND', 'Etikett nicht gefunden.');
/** Schreiben mit Namensprüfung durch den eindeutigen Index: doppelt → 409 LABEL_EXISTS. */
const withUniqueName = async (write) => {
    try {
        return await write();
    }
    catch (error) {
        if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw (0, taskErrors_1.taskConflict)('LABEL_EXISTS', 'Ein Etikett mit diesem Namen gibt es bereits.');
        }
        throw error;
    }
};
/** Alle Etiketten der Firma nach Namen; die Nutzung zählt EIN GROUP BY. */
const listTaskLabels = async (actor) => {
    const [labels, usage] = await Promise.all([
        prisma_client_1.default.taskLabel.findMany({
            where: { tenantId: actor.tenantId },
            select: LABEL_SELECT,
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
        actor.isManager
            ? prisma_client_1.default.taskLabelLink.groupBy({ by: ['labelId'], where: { tenantId: actor.tenantId }, _count: { _all: true } })
            : null,
    ]);
    if (!usage)
        return labels;
    const counts = new Map(usage.map((row) => [row.labelId, row._count._all]));
    return labels.map((label) => ({ ...label, usageCount: counts.get(label.id) ?? 0 }));
};
exports.listTaskLabels = listTaskLabels;
const createTaskLabel = async (actor, input) => {
    (0, taskActor_1.assertManager)(actor);
    // Ohne Farbe wie Görevly `U.colorFor`: dieselbe Farbe für denselben Namen.
    const label = { id: (0, nanoid_1.nanoid)(12), name: input.name, color: input.color ?? (0, taskConstants_1.labelColorFor)(input.name) };
    await withUniqueName(() => prisma_client_1.default.taskLabel.createMany({
        data: [{ ...label, tenantId: actor.tenantId, createdById: actor.employeeId }],
    }));
    return { ...label, usageCount: 0 };
};
exports.createTaskLabel = createTaskLabel;
const updateTaskLabel = async (actor, labelId, patch) => {
    (0, taskActor_1.assertManager)(actor);
    const where = { id: labelId, tenantId: actor.tenantId };
    const [current, usageCount] = await Promise.all([
        prisma_client_1.default.taskLabel.findFirst({ where, select: LABEL_SELECT }),
        prisma_client_1.default.taskLabelLink.count({ where: { tenantId: actor.tenantId, labelId } }),
    ]);
    if (!current)
        throw labelNotFound();
    const next = { name: patch.name ?? current.name, color: patch.color ?? current.color };
    if (next.name !== current.name || next.color !== current.color) {
        const { count } = await withUniqueName(() => prisma_client_1.default.taskLabel.updateMany({ where, data: next }));
        // Zwischen Lesen und Schreiben gelöscht.
        if (!count)
            throw labelNotFound();
    }
    return { id: current.id, ...next, usageCount };
};
exports.updateTaskLabel = updateTaskLabel;
const deleteTaskLabel = async (actor, labelId) => {
    (0, taskActor_1.assertManager)(actor);
    const { count } = await prisma_client_1.default.taskLabel.deleteMany({ where: { id: labelId, tenantId: actor.tenantId } });
    if (!count)
        throw labelNotFound();
};
exports.deleteTaskLabel = deleteTaskLabel;
//# sourceMappingURL=labelService.js.map