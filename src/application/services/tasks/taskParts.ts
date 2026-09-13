import { Prisma } from '@prisma/client';

import type { TasksDb } from './taskDb';
import { ATTACHMENT_SELECT, toAttachmentDto, type AttachmentDto } from './taskFiles';
import { rawJson } from './taskRows';

/**
 * ── TEILE EINER AUFGABE: Inhalt, Checklisten, Dateien ───────────────────────
 *
 * Gemeinsame Ausgabeformen für die Detailansicht und für die Antworten der
 * Inhalts-, Checklisten- und Dateiwege — damit die Oberfläche nach jedem
 * Schreiben dieselbe Form zurückbekommt, die sie beim Laden gesehen hat.
 */

/* ── Inhalt ─────────────────────────────────────────────────────────────── */

export interface ContentBlock {
    id: string;
    type: string;
    /** Bereinigtes Inline-HTML bei Textblöcken, sonst "". */
    text: string;
    meta: Record<string, unknown>;
}

export interface ContentDto {
    blocks: ContentBlock[];
    /** 0 = noch nie gespeichert. */
    version: number;
    updatedAt: Date | null;
    updatedById: string | null;
}

export const EMPTY_CONTENT: ContentDto = { blocks: [], version: 0, updatedAt: null, updatedById: null };

const asBlocks = (value: unknown): ContentBlock[] => {
    const parsed = rawJson(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
        .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object')
        .map((block) => ({
            id: String(block.id ?? ''),
            type: String(block.type ?? 'p'),
            text: typeof block.text === 'string' ? block.text : '',
            meta: block.meta && typeof block.meta === 'object' && !Array.isArray(block.meta)
                ? (block.meta as Record<string, unknown>)
                : {},
        }))
        .filter((block) => block.id.length > 0);
};

export const loadTaskContent = async (db: TasksDb, tenantId: string, taskId: string): Promise<ContentDto> => {
    const row = await db.taskContent.findFirst({
        where: { tenantId, taskId },
        select: { blocks: true, version: true, updatedAt: true, updatedById: true },
    });
    if (!row) return { ...EMPTY_CONTENT, blocks: [] };
    return { blocks: asBlocks(row.blocks), version: row.version, updatedAt: row.updatedAt, updatedById: row.updatedById };
};

/* ── Checklisten ────────────────────────────────────────────────────────── */

export const CHECKLIST_ITEM_SELECT = {
    id: true,
    checklistId: true,
    text: true,
    position: true,
    done: true,
    doneAt: true,
    doneById: true,
    assigneeId: true,
    dueAt: true,
    reminderAt: true,
    flagged: true,
    createdById: true,
    createdAt: true,
} satisfies Prisma.TaskChecklistItemSelect;

export type ChecklistItemRow = Prisma.TaskChecklistItemGetPayload<{ select: typeof CHECKLIST_ITEM_SELECT }>;

export interface ChecklistItemDto {
    id: string;
    checklistId: string;
    text: string;
    position: number;
    done: boolean;
    doneAt: Date | null;
    doneById: string | null;
    assigneeId: string | null;
    dueAt: Date | null;
    reminderAt: Date | null;
    flagged: boolean;
    createdById: string | null;
    createdAt: Date;
}

export const toChecklistItemDto = (row: ChecklistItemRow): ChecklistItemDto => ({
    id: row.id,
    checklistId: row.checklistId,
    text: row.text,
    position: row.position,
    done: row.done,
    doneAt: row.doneAt,
    doneById: row.doneById,
    assigneeId: row.assigneeId,
    dueAt: row.dueAt,
    reminderAt: row.reminderAt,
    flagged: row.flagged,
    createdById: row.createdById,
    createdAt: row.createdAt,
});

export interface ChecklistDto {
    id: string;
    title: string;
    position: number;
    createdById: string | null;
    createdAt: Date;
    progress: { done: number; total: number };
    items: ChecklistItemDto[];
}

export interface ChecklistProgress {
    done: number;
    total: number;
}

/** Alle Checklisten einer Aufgabe mit ihren Punkten, sortiert. */
export const loadTaskChecklists = async (db: TasksDb, tenantId: string, taskId: string): Promise<ChecklistDto[]> => {
    const [lists, items] = await Promise.all([
        db.taskChecklist.findMany({
            where: { tenantId, taskId },
            select: { id: true, title: true, position: true, createdById: true, createdAt: true },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        }),
        db.taskChecklistItem.findMany({
            where: { tenantId, taskId },
            select: CHECKLIST_ITEM_SELECT,
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        }),
    ]);
    const itemsByList = new Map<string, ChecklistItemDto[]>();
    for (const item of items) {
        const list = itemsByList.get(item.checklistId) ?? [];
        list.push(toChecklistItemDto(item));
        itemsByList.set(item.checklistId, list);
    }
    return lists.map((list) => {
        const listItems = itemsByList.get(list.id) ?? [];
        return {
            ...list,
            progress: { done: listItems.filter((item) => item.done).length, total: listItems.length },
            items: listItems,
        };
    });
};

/** Fortschritt ALLER Checklisten einer Aufgabe («5/8 madde»). */
export const loadTaskProgress = async (db: TasksDb, tenantId: string, taskId: string): Promise<ChecklistProgress> => {
    const rows = await db.$queryRaw<Array<{ total: unknown; doneCount: unknown }>>(Prisma.sql`
        SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END), 0) AS doneCount
        FROM TaskChecklistItem WHERE tenantId = ${tenantId} AND taskId = ${taskId}
    `);
    const row = rows[0];
    return { done: Number(row?.doneCount ?? 0), total: Number(row?.total ?? 0) };
};

/* ── Dateien der Aufgabe (Reiter «Dosyalar») ────────────────────────────── */

export const loadTaskAttachments = async (db: TasksDb, tenantId: string, taskId: string): Promise<AttachmentDto[]> =>
    (await db.taskAttachment.findMany({
        where: { tenantId, taskId, kind: 'TASK' },
        select: ATTACHMENT_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })).map(toAttachmentDto);
