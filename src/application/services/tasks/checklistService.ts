import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import {
    assertContentSize,
    insertChecklistBlock,
    lockTaskContent,
    removeChecklistBlocks,
    requireContentEditableTask,
    writeTaskContent,
} from './contentService';
import type { TasksActor } from './taskActor';
import { taskPermissions } from './taskAccess';
import { logTaskActivities, logTaskActivity } from './taskActivity';
import { ACTIVITY, NOTIFY, taskLinkUrl } from './taskConstants';
import { runTasksTransaction, type TasksDb } from './taskDb';
import { taskBadRequest, taskForbidden, taskNotFound, type TaskError } from './taskErrors';
import { queueTaskNotification } from './taskNotify';
import {
    CHECKLIST_ITEM_SELECT,
    loadTaskProgress,
    toChecklistItemDto,
    type ChecklistDto,
    type ChecklistItemDto,
    type ChecklistItemRow,
    type ChecklistProgress,
    type ContentDto,
} from './taskParts';
import { assertAssignablePeople, loadPersonName } from './taskPeople';
import { fetchTaskCores, lockTaskRow, rawNumber, type TaskCore } from './taskRows';

/**
 * ── CHECKLISTEN (Görevly services/checklist.js, ui/components/checklist.js) ─
 *
 * Eine Aufgabe hat beliebig viele Checklisten mit Punkten. Punkte haben KEINE
 * Zeitmessung — die Zeit gehört der Aufgabe; sie zählen für den Fortschritt
 * («5/8 madde») und die Bitiş-Prognose. Jede Handlung verlangt, dass die Person
 * den Inhalt der Aufgabe bearbeiten darf (canEditContent).
 *
 * Reihenfolge: `position` aufsteigend, bei Gleichstand `createdAt`. Einfügen
 * und Verschieben sperren die Aufgabenzeile, zwei gleichzeitige Griffe in
 * dieselbe Liste laufen also nacheinander. Teilen sich Punkte trotzdem eine
 * Position, nummeriert das nächste Verschieben die Liste 0…n−1 durch.
 *
 * Person eines Punkts: Personal der Firma mit Modulzugang. Steht sie nicht auf
 * der Aufgabe, nimmt die Leitung sie dazu (Verlauf ASSIGNED + Meldung); ein
 * Teammitglied darf nur Verantwortliche der Aufgabe wählen.
 */

/** Titel einer neuen Checkliste — wortgleich zu Görevly. */

const CHECKLIST_SELECT = {
    id: true,
    taskId: true,
    title: true,
    position: true,
    createdById: true,
    createdAt: true,
} satisfies Prisma.TaskChecklistSelect;

type ChecklistRow = Prisma.TaskChecklistGetPayload<{ select: typeof CHECKLIST_SELECT }>;

/** Ein Punkt samt der Aufgabe, zu der er gehört. */
const OWNED_ITEM_SELECT = { ...CHECKLIST_ITEM_SELECT, taskId: true } satisfies Prisma.TaskChecklistItemSelect;

type OwnedItemRow = Prisma.TaskChecklistItemGetPayload<{ select: typeof OWNED_ITEM_SELECT }>;

/** Anzeigereihenfolge wie loadTaskChecklists; die Kennung entscheidet den letzten Gleichstand. */
const ITEM_ORDER: Prisma.TaskChecklistItemOrderByWithRelationInput[] = [
    { position: 'asc' },
    { createdAt: 'asc' },
    { id: 'asc' },
];

export type ItemMoveDirection = 'up' | 'down';

export interface NewChecklistInput {
    title?: string | undefined;
    /** Zugleich einen Checklistenblock in den Inhalt setzen. */
    appendBlock?: boolean | undefined;
    /** Block, hinter den er kommt (sonst ans Ende). */
    afterBlockId?: string | null | undefined;
}

export interface NewChecklistResult {
    checklist: ChecklistDto;
    /** Nur mit `appendBlock`: der Inhalt samt neuem Block. */
    content?: ContentDto;
}

export interface NewChecklistItemInput {
    /** Kennung aus dem Browser (optimistisch angezeigter Punkt); sonst vergibt der Server eine. */
    id?: string | undefined;
    text: string;
    afterItemId?: string | null | undefined;
    assigneeId?: string | null | undefined;
    dueAt?: Date | null | undefined;
    reminderAt?: Date | null | undefined;
    flagged?: boolean | undefined;
}

export interface ChecklistItemPatch {
    text?: string | undefined;
    assigneeId?: string | null | undefined;
    dueAt?: Date | null | undefined;
    reminderAt?: Date | null | undefined;
    flagged?: boolean | undefined;
}

export interface ChecklistItemResult {
    item: ChecklistItemDto;
    progress: ChecklistProgress;
    /** Nur, wenn die Person des Punkts dabei neu auf die Aufgabe kam. */
    task?: { assigneeIds: string[] };
}

export interface ChecklistWithProgress {
    checklist: ChecklistDto;
    progress: ChecklistProgress;
}

const checklistNotFound = (): TaskError => taskNotFound('CHECKLIST_NOT_FOUND', 'Checkliste nicht gefunden.');

const itemNotFound = (): TaskError => taskNotFound('CHECKLIST_ITEM_NOT_FOUND', 'Checklistenpunkt nicht gefunden.');

/* ── Laden und Ausgeben ─────────────────────────────────────────────────── */

const toChecklistDto = (list: ChecklistRow, items: readonly ChecklistItemRow[]): ChecklistDto => {
    const dtos = items.map(toChecklistItemDto);
    return {
        id: list.id,
        title: list.title,
        position: list.position,
        createdById: list.createdById,
        createdAt: list.createdAt,
        progress: { done: dtos.filter((item) => item.done).length, total: dtos.length },
        items: dtos,
    };
};

const loadChecklistItems = (db: TasksDb, tenantId: string, checklistId: string): Promise<ChecklistItemRow[]> =>
    db.taskChecklistItem.findMany({ where: { tenantId, checklistId }, select: CHECKLIST_ITEM_SELECT, orderBy: ITEM_ORDER });

const loadChecklistWithProgress = async (tenantId: string, list: ChecklistRow): Promise<ChecklistWithProgress> => {
    const [items, progress] = await Promise.all([
        loadChecklistItems(prisma, tenantId, list.id),
        loadTaskProgress(prisma, tenantId, list.taskId),
    ]);
    return { checklist: toChecklistDto(list, items), progress };
};

/** Checkliste der Firma, deren Aufgabe die Person inhaltlich bearbeiten darf. */
const requireEditableChecklist = async (
    actor: TasksActor,
    checklistId: string,
): Promise<{ list: ChecklistRow; core: TaskCore }> => {
    const list = await prisma.taskChecklist.findFirst({
        where: { id: checklistId, tenantId: actor.tenantId },
        select: CHECKLIST_SELECT,
    });
    if (!list) throw checklistNotFound();
    const { core } = await requireContentEditableTask(actor, list.taskId);
    return { list, core };
};

/** Checklistenpunkt der Firma, dessen Aufgabe die Person inhaltlich bearbeiten darf. */
const requireEditableItem = async (
    actor: TasksActor,
    itemId: string,
): Promise<{ item: OwnedItemRow; core: TaskCore }> => {
    const item = await prisma.taskChecklistItem.findFirst({
        where: { id: itemId, tenantId: actor.tenantId },
        select: OWNED_ITEM_SELECT,
    });
    if (!item) throw itemNotFound();
    const { core } = await requireContentEditableTask(actor, item.taskId);
    return { item, core };
};

/* ── Person eines Punkts ────────────────────────────────────────────────── */

/**
 * Prüft die Person eines Punkts (Firma + Modulzugang). Zurück kommt sie nur,
 * wenn sie erst auf die Aufgabe genommen werden muss — das darf die Leitung.
 */
const assigneeJoiningTask = async (
    actor: TasksActor,
    core: TaskCore,
    assigneeId: string | null,
): Promise<string | null> => {
    if (!assigneeId) return null;
    await assertAssignablePeople(actor.tenantId, [assigneeId]);
    if (core.assigneeIds.includes(assigneeId)) return null;
    if (!actor.isManager) {
        throw taskBadRequest(
            'ITEM_ASSIGNEE_NOT_ON_TASK',
            'Einen Punkt können Sie nur Verantwortlichen dieser Aufgabe zuteilen.',
            { employeeId: assigneeId },
        );
    }
    return assigneeId;
};

/**
 * Nimmt eine Person als Verantwortliche auf; der Aufrufer hält die Sperre der
 * Aufgabenzeile. Zurück kommt die neue Liste — null, wenn die Person
 * inzwischen schon darauf stand (dann weder Verlauf noch Meldung).
 */
const joinTaskAssignees = async (
    tx: TasksDb,
    actor: TasksActor,
    taskId: string,
    employeeId: string,
): Promise<string[] | null> => {
    const { count } = await tx.taskAssignee.createMany({
        data: [{ id: nanoid(12), tenantId: actor.tenantId, taskId, employeeId }],
        skipDuplicates: true,
    });
    if (!count) return null;
    await logTaskActivity(tx, actor.tenantId, actor.employeeId, { taskId, type: ACTIVITY.ASSIGNED, meta: { employeeId } });
    const rows = await tx.taskAssignee.findMany({
        where: { tenantId: actor.tenantId, taskId },
        select: { employeeId: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => row.employeeId);
};

/** TASKS_ASSIGNED an die Person, die über einen Punkt auf die Aufgabe kam — die Antwort wartet nicht darauf. */
const queueAssignedNotification = (actor: TasksActor, core: TaskCore, employeeId: string, itemId: string): void => {
    void loadPersonName(actor.employeeId)
        .catch((error: unknown) => {
            console.warn('[tasks.checklist] Name für die Zuweisungsmeldung nicht lesbar', error);
            return '';
        })
        .then((actorName) => queueTaskNotification({
            tenantId: actor.tenantId,
            type: NOTIFY.ASSIGNED,
            recipientIds: [employeeId],
            actorId: actor.employeeId,
            title: 'Neue Aufgabe',
            message: `${actorName} hat Ihnen «${core.title}» zugewiesen.`,
            linkUrl: taskLinkUrl(core.id),
            params: { actor: actorName, title: core.title },
            meta: { taskId: core.id, itemId },
        }));
};

/* ── Positionen ─────────────────────────────────────────────────────────── */

interface ItemSlot {
    maxPosition: number | null;
    afterPosition: number | null;
}

const rawPosition = (value: unknown): number | null =>
    value === null || value === undefined ? null : rawNumber(value);

/**
 * Wohin ein neuer Punkt kommt — unter der Sperre in EINER Anweisung: die
 * höchste Position der Liste und die des Vorgängers. Steht der Vorgänger nicht
 * in dieser Liste, hängt der Punkt wie in Görevly hinten an.
 * null = die Checkliste ist inzwischen gelöscht.
 */
const readItemSlot = async (
    tx: TasksDb,
    tenantId: string,
    checklistId: string,
    afterItemId: string | null,
): Promise<ItemSlot | null> => {
    const afterPosition = afterItemId
        ? Prisma.sql`(SELECT i.position FROM TaskChecklistItem i WHERE i.checklistId = c.id AND i.id = ${afterItemId})`
        : Prisma.sql`NULL`;
    const rows = await tx.$queryRaw<Array<{ maxPosition: unknown; afterPosition: unknown }>>(Prisma.sql`
        SELECT (SELECT MAX(i.position) FROM TaskChecklistItem i WHERE i.checklistId = c.id) AS maxPosition,
               ${afterPosition} AS afterPosition
        FROM TaskChecklist c
        WHERE c.id = ${checklistId} AND c.tenantId = ${tenantId}
    `);
    const row = rows[0];
    return row ? { maxPosition: rawPosition(row.maxPosition), afterPosition: rawPosition(row.afterPosition) } : null;
};

/**
 * Reihenfolge nach einem Schritt nach oben oder unten (Görevly moveItem). Ohne
 * Gleichstand tauschen genau zwei Punkte ihre Positionen; teilen sich Punkte
 * eine Position, wird die Liste 0…n−1 durchnummeriert. Am Rand bleibt alles.
 */
const reorderItems = (
    rows: readonly ChecklistItemRow[],
    itemId: string,
    direction: ItemMoveDirection,
): ChecklistItemRow[] => {
    const from = rows.findIndex((row) => row.id === itemId);
    const to = direction === 'up' ? from - 1 : from + 1;
    const moving = rows[from];
    const neighbour = rows[to];
    if (!moving || !neighbour) return [...rows];

    const ordered = [...rows];
    ordered[from] = neighbour;
    ordered[to] = moving;
    const collided = rows.some((row, index) => index > 0 && row.position === rows[index - 1]?.position);
    if (collided) return ordered.map((row, index) => ({ ...row, position: index }));
    return ordered.map((row) => {
        if (row.id === moving.id) return { ...row, position: neighbour.position };
        if (row.id === neighbour.id) return { ...row, position: moving.position };
        return row;
    });
};

/** Neue Positionen mehrerer Punkte in EINER Anweisung. */
const writeItemPositions = async (
    tx: TasksDb,
    tenantId: string,
    rows: ReadonlyArray<{ id: string; position: number }>,
): Promise<void> => {
    if (!rows.length) return;
    const cases = Prisma.join(rows.map((row) => Prisma.sql`WHEN ${row.id} THEN ${row.position}`), ' ');
    await tx.$executeRaw(Prisma.sql`
        UPDATE TaskChecklistItem
        SET position = CASE id ${cases} END, updatedAt = NOW(3)
        WHERE tenantId = ${tenantId} AND id IN (${Prisma.join(rows.map((row) => row.id))})
    `);
};

/* ── Checklisten ────────────────────────────────────────────────────────── */

/** POST /:taskId/checklists — neue Checkliste, auf Wunsch gleich mit ihrem Block im Inhalt. */
export const addChecklist = async (
    actor: TasksActor,
    taskId: string,
    input: NewChecklistInput,
): Promise<NewChecklistResult> => {
    await requireContentEditableTask(actor, taskId);
    // Kein Vorgabetitel: leer bleibt leer, die Oberfläche zeigt einen Platzhalter.
    const title = input.title ?? '';

    return runTasksTransaction(async (tx): Promise<NewChecklistResult> => {
        if (!(await lockTaskRow(tx, actor.tenantId, taskId))) throw taskNotFound();
        const { _max: highest } = await tx.taskChecklist.aggregate({
            where: { tenantId: actor.tenantId, taskId },
            _max: { position: true },
        });
        const list: ChecklistRow = {
            id: nanoid(12),
            taskId,
            title,
            position: (highest.position ?? -1) + 1,
            createdById: actor.employeeId,
            createdAt: new Date(),
        };
        // createMany: MySQL kennt kein RETURNING — create läse die bekannte Zeile ein zweites Mal.
        await tx.taskChecklist.createMany({ data: [{ ...list, tenantId: actor.tenantId }] });
        await logTaskActivity(tx, actor.tenantId, actor.employeeId, { taskId, type: ACTIVITY.CHECKLIST_ADD, meta: { title } });

        const checklist = toChecklistDto(list, []);
        if (!input.appendBlock) return { checklist };
        const base = await lockTaskContent(tx, actor.tenantId, taskId);
        const blocks = insertChecklistBlock(base.blocks, list.id, input.afterBlockId);
        assertContentSize(blocks);
        return { checklist, content: await writeTaskContent(tx, actor, taskId, base, blocks) };
    });
};

/** PATCH /checklists/:checklistId — Titel ändern (ohne Verlauf, wie Görevly). */
export const renameChecklist = async (
    actor: TasksActor,
    checklistId: string,
    title: string,
): Promise<{ checklist: ChecklistDto }> => {
    const { list } = await requireEditableChecklist(actor, checklistId);
    const [{ count }, items] = await Promise.all([
        prisma.taskChecklist.updateMany({ where: { id: list.id, tenantId: actor.tenantId }, data: { title } }),
        loadChecklistItems(prisma, actor.tenantId, list.id),
    ]);
    if (!count) throw checklistNotFound();
    return { checklist: toChecklistDto({ ...list, title }, items) };
};

/**
 * DELETE /checklists/:checklistId — die Liste (ihre Punkte per Kaskade) und
 * ihre Blöcke im Inhalt verschwinden in EINER Transaktion.
 */
export const deleteChecklist = async (
    actor: TasksActor,
    checklistId: string,
): Promise<{ content: ContentDto; progress: ChecklistProgress }> => {
    const { list } = await requireEditableChecklist(actor, checklistId);
    const content = await runTasksTransaction(async (tx) => {
        if (!(await lockTaskRow(tx, actor.tenantId, list.taskId))) throw taskNotFound();
        await tx.taskChecklist.deleteMany({ where: { id: list.id, tenantId: actor.tenantId } });
        const base = await lockTaskContent(tx, actor.tenantId, list.taskId);
        const blocks = removeChecklistBlocks(base.blocks, list.id);
        // Die Version steigt nur, wenn wirklich ein Block wegfiel — sonst müsste jede offene Bearbeitung neu laden.
        return blocks.length === base.blocks.length ? base : writeTaskContent(tx, actor, list.taskId, base, blocks);
    });
    return { content, progress: await loadTaskProgress(prisma, actor.tenantId, list.taskId) };
};

/** POST /checklists/:checklistId/check-all — alle offenen Punkte abhaken, je Punkt ein Verlaufseintrag. */
export const checkAllItems = async (actor: TasksActor, checklistId: string): Promise<ChecklistWithProgress> => {
    const { list } = await requireEditableChecklist(actor, checklistId);
    await runTasksTransaction(async (tx) => {
        // Gesperrt gelesen: ein gleichzeitiges Abhaken wartet, und der Verlauf nennt nur, was HIER wechselte.
        const open = await tx.$queryRaw<Array<{ id: string; text: string }>>(Prisma.sql`
            SELECT id, text
            FROM TaskChecklistItem
            WHERE checklistId = ${list.id} AND tenantId = ${actor.tenantId} AND done = 0
            ORDER BY position, createdAt, id
            FOR UPDATE
        `);
        if (!open.length) return;
        await tx.taskChecklistItem.updateMany({
            where: { tenantId: actor.tenantId, id: { in: open.map((row) => row.id) } },
            data: { done: true, doneAt: new Date(), doneById: actor.employeeId },
        });
        await logTaskActivities(tx, actor.tenantId, actor.employeeId, open.map((row) => ({
            taskId: list.taskId,
            type: ACTIVITY.CHECK_DONE,
            meta: { text: row.text },
        })));
    });
    return loadChecklistWithProgress(actor.tenantId, list);
};

/** POST /checklists/:checklistId/clear-done — erledigte Punkte entfernen (ohne Verlauf, wie Görevly). */
export const clearDoneItems = async (actor: TasksActor, checklistId: string): Promise<ChecklistWithProgress> => {
    const { list } = await requireEditableChecklist(actor, checklistId);
    await prisma.taskChecklistItem.deleteMany({ where: { tenantId: actor.tenantId, checklistId: list.id, done: true } });
    return loadChecklistWithProgress(actor.tenantId, list);
};

/* ── Punkte ─────────────────────────────────────────────────────────────── */

/** POST /checklists/:checklistId/items — neuer Punkt hinter `afterItemId` oder am Ende. */
/**
 * SCHNELLWEG «Madde ekle» am Listenende (13.09.2026, Samet: «maddeler çok yavaş
 * ekleniyor»). Vorher 8 Rundreisen zur entfernten DB (Liste, Aufgabe, BEGIN,
 * Sperre, Platz, INSERT, COMMIT, Fortschritt) ≈ 250–380 ms. Jetzt zwei:
 *   1. parallel: Liste · Aufgabe (über die Liste) · Fortschritt vorher
 *   2. EIN INSERT … SELECT, das die nächste Position selbst berechnet
 * Ohne Transaktion: die Anweisung ist atomar; eine seltene doppelte Position
 * bei gleichzeitigem Anfügen heilt reorderItems (nummeriert bei Gleichstand neu).
 * Einfügen MITTEN in der Liste oder mit Person geht weiter den gesperrten Weg.
 */
const appendChecklistItemFast = async (
    actor: TasksActor,
    checklistId: string,
    input: NewChecklistItemInput,
): Promise<ChecklistItemResult> => {
    const [list, core, before] = await Promise.all([
        prisma.taskChecklist.findFirst({ where: { id: checklistId, tenantId: actor.tenantId }, select: CHECKLIST_SELECT }),
        fetchTaskCores(prisma, {
            where: Prisma.sql`t.tenantId = ${actor.tenantId} AND t.id = (SELECT c.taskId FROM TaskChecklist c WHERE c.id = ${checklistId} AND c.tenantId = ${actor.tenantId})`,
            limit: 1,
        }).then((rows) => rows[0] ?? null),
        prisma.$queryRaw<Array<{ total: unknown; doneCount: unknown; maxPosition: unknown }>>(Prisma.sql`
            SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN i.done = 1 THEN 1 ELSE 0 END), 0) AS doneCount,
                   (SELECT MAX(m.position) FROM TaskChecklistItem m WHERE m.checklistId = ${checklistId}) AS maxPosition
            FROM TaskChecklistItem i
            WHERE i.tenantId = ${actor.tenantId}
              AND i.taskId = (SELECT c.taskId FROM TaskChecklist c WHERE c.id = ${checklistId} AND c.tenantId = ${actor.tenantId})
        `),
    ]);
    if (!list || !core) throw checklistNotFound();
    const permissions = taskPermissions(actor, core);
    if (!permissions.canSee) throw taskForbidden('TASK_FORBIDDEN', 'Diese Aufgabe ist für Sie nicht sichtbar.');
    if (!permissions.canEditContent) {
        throw taskForbidden('CONTENT_EDIT_FORBIDDEN', 'Den Inhalt dieser Aufgabe dürfen Sie nicht bearbeiten.');
    }

    const id = input.id ?? nanoid(12);
    const now = new Date();
    const dueAt = input.dueAt ?? null;
    const reminderAt = input.reminderAt ?? null;
    const flagged = input.flagged ?? false;
    const inserted = await prisma.$executeRaw(Prisma.sql`
        INSERT INTO TaskChecklistItem
            (id, tenantId, taskId, checklistId, text, position, done, assigneeId, dueAt, reminderAt, flagged, createdById, createdAt, updatedAt)
        SELECT ${id}, c.tenantId, c.taskId, c.id, ${input.text},
               COALESCE((SELECT MAX(i.position) FROM TaskChecklistItem i WHERE i.checklistId = c.id), -1) + 1,
               0, NULL, ${dueAt}, ${reminderAt}, ${flagged}, ${actor.employeeId}, ${now}, ${now}
        FROM TaskChecklist c
        WHERE c.id = ${list.id} AND c.tenantId = ${actor.tenantId}
    `);
    if (!inserted) throw checklistNotFound();

    const row: ChecklistItemRow = {
        id,
        checklistId: list.id,
        text: input.text,
        // Stand vor dem INSERT + 1 — die DB rechnet dieselbe Zahl im INSERT selbst.
        position: before[0]?.maxPosition == null ? 0 : rawNumber(before[0].maxPosition) + 1,
        done: false,
        doneAt: null,
        doneById: null,
        assigneeId: null,
        dueAt,
        reminderAt,
        flagged,
        createdById: actor.employeeId,
        createdAt: now,
    };
    const progressRow = before[0];
    return {
        item: toChecklistItemDto(row),
        progress: { done: Number(progressRow?.doneCount ?? 0), total: Number(progressRow?.total ?? 0) + 1 },
    };
};

export const addChecklistItem = async (
    actor: TasksActor,
    checklistId: string,
    input: NewChecklistItemInput,
): Promise<ChecklistItemResult> => {
    const assigneeId = input.assigneeId ?? null;
    if (!assigneeId && !input.afterItemId) return appendChecklistItemFast(actor, checklistId, input);

    const { list, core } = await requireEditableChecklist(actor, checklistId);
    const joiningId = await assigneeJoiningTask(actor, core, assigneeId);

    const { row, assigneeIds } = await runTasksTransaction(async (tx) => {
        if (!(await lockTaskRow(tx, actor.tenantId, core.id))) throw taskNotFound();
        const slot = await readItemSlot(tx, actor.tenantId, list.id, input.afterItemId ?? null);
        if (!slot) throw checklistNotFound();
        if (slot.afterPosition !== null) {
            await tx.taskChecklistItem.updateMany({
                where: { tenantId: actor.tenantId, checklistId: list.id, position: { gt: slot.afterPosition } },
                data: { position: { increment: 1 } },
            });
        }
        const created: ChecklistItemRow = {
            id: input.id ?? nanoid(12),
            checklistId: list.id,
            text: input.text,
            position: slot.afterPosition !== null ? slot.afterPosition + 1 : (slot.maxPosition ?? -1) + 1,
            done: false,
            doneAt: null,
            doneById: null,
            assigneeId,
            dueAt: input.dueAt ?? null,
            reminderAt: input.reminderAt ?? null,
            flagged: input.flagged ?? false,
            createdById: actor.employeeId,
            createdAt: new Date(),
        };
        await tx.taskChecklistItem.createMany({ data: [{ ...created, tenantId: actor.tenantId, taskId: core.id }] });
        return { row: created, assigneeIds: joiningId ? await joinTaskAssignees(tx, actor, core.id, joiningId) : null };
    });

    if (assigneeIds && joiningId) queueAssignedNotification(actor, core, joiningId, row.id);
    return {
        item: toChecklistItemDto(row),
        progress: await loadTaskProgress(prisma, actor.tenantId, core.id),
        ...(assigneeIds ? { task: { assigneeIds } } : {}),
    };
};

/** PATCH /checklist-items/:itemId — Text, Person, Termine, Fähnchen (ohne Verlauf, wie Görevly). */
export const updateChecklistItem = async (
    actor: TasksActor,
    itemId: string,
    patch: ChecklistItemPatch,
): Promise<ChecklistItemResult> => {
    const { item, core } = await requireEditableItem(actor, itemId);
    // Geprüft wird nur eine GEÄNDERTE Person; wer schon auf dem Punkt steht, bleibt es.
    const assigneeChanged = patch.assigneeId !== undefined && patch.assigneeId !== item.assigneeId;
    const joiningId = assigneeChanged ? await assigneeJoiningTask(actor, core, patch.assigneeId ?? null) : null;
    const changes = {
        ...(patch.text !== undefined ? { text: patch.text } : {}),
        ...(assigneeChanged ? { assigneeId: patch.assigneeId ?? null } : {}),
        ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
        ...(patch.reminderAt !== undefined ? { reminderAt: patch.reminderAt } : {}),
        ...(patch.flagged !== undefined ? { flagged: patch.flagged } : {}),
    };
    const where = { id: item.id, tenantId: actor.tenantId };

    let assigneeIds: string[] | null = null;
    if (joiningId) {
        assigneeIds = await runTasksTransaction(async (tx) => {
            if (!(await lockTaskRow(tx, actor.tenantId, core.id))) throw taskNotFound();
            const { count } = await tx.taskChecklistItem.updateMany({ where, data: changes });
            if (!count) throw itemNotFound();
            return joinTaskAssignees(tx, actor, core.id, joiningId);
        });
        if (assigneeIds) queueAssignedNotification(actor, core, joiningId, item.id);
    } else if (Object.keys(changes).length) {
        const { count } = await prisma.taskChecklistItem.updateMany({ where, data: changes });
        if (!count) throw itemNotFound();
    }

    return {
        item: toChecklistItemDto({ ...item, ...changes }),
        // Text, Person und Termine ändern den Fortschritt nicht: die Zählung von eben gilt.
        progress: { done: core.checkDone, total: core.checkTotal },
        ...(assigneeIds ? { task: { assigneeIds } } : {}),
    };
};

/** POST /checklist-items/:itemId/toggle — abhaken oder zurücknehmen; ohne `done` umschalten. */
export const toggleChecklistItem = async (
    actor: TasksActor,
    itemId: string,
    done: boolean | undefined,
): Promise<{ item: ChecklistItemDto; progress: ChecklistProgress }> => {
    const { item, core } = await requireEditableItem(actor, itemId);
    const target = done ?? !item.done;

    await runTasksTransaction(async (tx) => {
        // Nur ein echter Wechsel schreibt — und nur er kommt in den Verlauf.
        const { count } = await tx.taskChecklistItem.updateMany({
            where: { id: item.id, tenantId: actor.tenantId, done: !target },
            data: target
                ? { done: true, doneAt: new Date(), doneById: actor.employeeId }
                : { done: false, doneAt: null, doneById: null },
        });
        if (!count) return;
        await logTaskActivity(tx, actor.tenantId, actor.employeeId, {
            taskId: core.id,
            type: target ? ACTIVITY.CHECK_DONE : ACTIVITY.CHECK_UNDONE,
            meta: { text: item.text },
        });
    });

    const [fresh, progress] = await Promise.all([
        prisma.taskChecklistItem.findFirst({ where: { id: item.id, tenantId: actor.tenantId }, select: CHECKLIST_ITEM_SELECT }),
        loadTaskProgress(prisma, actor.tenantId, core.id),
    ]);
    if (!fresh) throw itemNotFound();
    return { item: toChecklistItemDto(fresh), progress };
};

/** POST /checklist-items/:itemId/move — einen Platz nach oben oder unten. */
export const moveChecklistItem = async (
    actor: TasksActor,
    itemId: string,
    direction: ItemMoveDirection,
): Promise<{ checklist: ChecklistDto }> => {
    const { item, core } = await requireEditableItem(actor, itemId);
    const [items, list] = await Promise.all([
        runTasksTransaction(async (tx) => {
            if (!(await lockTaskRow(tx, actor.tenantId, core.id))) throw taskNotFound();
            const rows = await loadChecklistItems(tx, actor.tenantId, item.checklistId);
            if (!rows.some((row) => row.id === item.id)) throw itemNotFound();
            const next = reorderItems(rows, item.id, direction);
            const before = new Map(rows.map((row) => [row.id, row.position]));
            await writeItemPositions(tx, actor.tenantId, next.filter((row) => before.get(row.id) !== row.position));
            return next;
        }),
        prisma.taskChecklist.findFirst({ where: { id: item.checklistId, tenantId: actor.tenantId }, select: CHECKLIST_SELECT }),
    ]);
    if (!list) throw checklistNotFound();
    return { checklist: toChecklistDto(list, items) };
};

/** DELETE /checklist-items/:itemId */
export const deleteChecklistItem = async (actor: TasksActor, itemId: string): Promise<{ progress: ChecklistProgress }> => {
    const { item } = await requireEditableItem(actor, itemId);
    await prisma.taskChecklistItem.deleteMany({ where: { id: item.id, tenantId: actor.tenantId } });
    return { progress: await loadTaskProgress(prisma, actor.tenantId, item.taskId) };
};
