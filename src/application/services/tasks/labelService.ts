import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import { assertManager, type TasksActor } from './taskActor';
import { labelColorFor, type LabelColor } from './taskConstants';
import { taskConflict, taskNotFound } from './taskErrors';

/**
 * ── ETIKETTEN DER FIRMA (Görevly `tasks.createLabel` …, Ekip → «Etiketler») ─
 *
 *   lesen    jede Person mit Modulzugang — ohne Katalog keine farbige Karte
 *   ändern   nur die Leitung: anlegen, umbenennen, umfärben, löschen
 *
 * Einen Namen gibt es je Firma nur einmal. Das prüft der eindeutige Index
 * (tenantId, name) selbst — seine Sortierung utf8mb4_unicode_ci vergleicht
 * ohne Gross/Klein, «Dringend» und «dringend» sind also dasselbe Etikett.
 * Kein Vorablesen: zwei gleichzeitig Anlegende können so nicht beide durch.
 * Löschen nimmt die Verknüpfungen per Kaskade mit, die Aufgaben bleiben.
 * `usageCount` (an wie vielen Aufgaben es hängt) sieht nur die Leitung.
 */

export interface LabelDto {
    id: string;
    name: string;
    color: string;
    /** Nur für die Leitung. */
    usageCount?: number;
}

export interface NewLabelInput {
    /** Bereits bereinigter, nicht leerer Name. */
    name: string;
    color?: LabelColor | undefined;
}

export interface LabelPatch {
    name?: string | undefined;
    color?: LabelColor | undefined;
}

const LABEL_SELECT = { id: true, name: true, color: true } satisfies Prisma.TaskLabelSelect;

const labelNotFound = () => taskNotFound('LABEL_NOT_FOUND', 'Etikett nicht gefunden.');

/** Schreiben mit Namensprüfung durch den eindeutigen Index: doppelt → 409 LABEL_EXISTS. */
const withUniqueName = async <T>(write: () => Promise<T>): Promise<T> => {
    try {
        return await write();
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw taskConflict('LABEL_EXISTS', 'Ein Etikett mit diesem Namen gibt es bereits.');
        }
        throw error;
    }
};

/** Alle Etiketten der Firma nach Namen; die Nutzung zählt EIN GROUP BY. */
export const listTaskLabels = async (actor: TasksActor): Promise<LabelDto[]> => {
    const [labels, usage] = await Promise.all([
        prisma.taskLabel.findMany({
            where: { tenantId: actor.tenantId },
            select: LABEL_SELECT,
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
        }),
        actor.isManager
            ? prisma.taskLabelLink.groupBy({ by: ['labelId'], where: { tenantId: actor.tenantId }, _count: { _all: true } })
            : null,
    ]);
    if (!usage) return labels;
    const counts = new Map(usage.map((row) => [row.labelId, row._count._all]));
    return labels.map((label) => ({ ...label, usageCount: counts.get(label.id) ?? 0 }));
};

export const createTaskLabel = async (actor: TasksActor, input: NewLabelInput): Promise<LabelDto> => {
    assertManager(actor);
    // Ohne Farbe wie Görevly `U.colorFor`: dieselbe Farbe für denselben Namen.
    const label = { id: nanoid(12), name: input.name, color: input.color ?? labelColorFor(input.name) };
    await withUniqueName(() => prisma.taskLabel.createMany({
        data: [{ ...label, tenantId: actor.tenantId, createdById: actor.employeeId }],
    }));
    return { ...label, usageCount: 0 };
};

export const updateTaskLabel = async (actor: TasksActor, labelId: string, patch: LabelPatch): Promise<LabelDto> => {
    assertManager(actor);
    const where = { id: labelId, tenantId: actor.tenantId };
    const [current, usageCount] = await Promise.all([
        prisma.taskLabel.findFirst({ where, select: LABEL_SELECT }),
        prisma.taskLabelLink.count({ where: { tenantId: actor.tenantId, labelId } }),
    ]);
    if (!current) throw labelNotFound();

    const next = { name: patch.name ?? current.name, color: patch.color ?? current.color };
    if (next.name !== current.name || next.color !== current.color) {
        const { count } = await withUniqueName(() => prisma.taskLabel.updateMany({ where, data: next }));
        // Zwischen Lesen und Schreiben gelöscht.
        if (!count) throw labelNotFound();
    }
    return { id: current.id, ...next, usageCount };
};

export const deleteTaskLabel = async (actor: TasksActor, labelId: string): Promise<void> => {
    assertManager(actor);
    const { count } = await prisma.taskLabel.deleteMany({ where: { id: labelId, tenantId: actor.tenantId } });
    if (!count) throw labelNotFound();
};
