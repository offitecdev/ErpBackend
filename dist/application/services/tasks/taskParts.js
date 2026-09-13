"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadTaskAttachments = exports.loadTaskProgress = exports.loadTaskChecklists = exports.toChecklistItemDto = exports.CHECKLIST_ITEM_SELECT = exports.loadTaskContent = exports.EMPTY_CONTENT = void 0;
const client_1 = require("@prisma/client");
const taskFiles_1 = require("./taskFiles");
const taskRows_1 = require("./taskRows");
exports.EMPTY_CONTENT = { blocks: [], version: 0, updatedAt: null, updatedById: null };
const asBlocks = (value) => {
    const parsed = (0, taskRows_1.rawJson)(value);
    if (!Array.isArray(parsed))
        return [];
    return parsed
        .filter((block) => Boolean(block) && typeof block === 'object')
        .map((block) => ({
        id: String(block.id ?? ''),
        type: String(block.type ?? 'p'),
        text: typeof block.text === 'string' ? block.text : '',
        meta: block.meta && typeof block.meta === 'object' && !Array.isArray(block.meta)
            ? block.meta
            : {},
    }))
        .filter((block) => block.id.length > 0);
};
const loadTaskContent = async (db, tenantId, taskId) => {
    const row = await db.taskContent.findFirst({
        where: { tenantId, taskId },
        select: { blocks: true, version: true, updatedAt: true, updatedById: true },
    });
    if (!row)
        return { ...exports.EMPTY_CONTENT, blocks: [] };
    return { blocks: asBlocks(row.blocks), version: row.version, updatedAt: row.updatedAt, updatedById: row.updatedById };
};
exports.loadTaskContent = loadTaskContent;
/* ── Checklisten ────────────────────────────────────────────────────────── */
exports.CHECKLIST_ITEM_SELECT = {
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
};
const toChecklistItemDto = (row) => ({
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
exports.toChecklistItemDto = toChecklistItemDto;
/** Alle Checklisten einer Aufgabe mit ihren Punkten, sortiert. */
const loadTaskChecklists = async (db, tenantId, taskId) => {
    const [lists, items] = await Promise.all([
        db.taskChecklist.findMany({
            where: { tenantId, taskId },
            select: { id: true, title: true, position: true, createdById: true, createdAt: true },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        }),
        db.taskChecklistItem.findMany({
            where: { tenantId, taskId },
            select: exports.CHECKLIST_ITEM_SELECT,
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        }),
    ]);
    const itemsByList = new Map();
    for (const item of items) {
        const list = itemsByList.get(item.checklistId) ?? [];
        list.push((0, exports.toChecklistItemDto)(item));
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
exports.loadTaskChecklists = loadTaskChecklists;
/** Fortschritt ALLER Checklisten einer Aufgabe («5/8 madde»). */
const loadTaskProgress = async (db, tenantId, taskId) => {
    const rows = await db.$queryRaw(client_1.Prisma.sql `
        SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END), 0) AS doneCount
        FROM TaskChecklistItem WHERE tenantId = ${tenantId} AND taskId = ${taskId}
    `);
    const row = rows[0];
    return { done: Number(row?.doneCount ?? 0), total: Number(row?.total ?? 0) };
};
exports.loadTaskProgress = loadTaskProgress;
/* ── Dateien der Aufgabe (Reiter «Dosyalar») ────────────────────────────── */
const loadTaskAttachments = async (db, tenantId, taskId) => (await db.taskAttachment.findMany({
    where: { tenantId, taskId, kind: 'TASK' },
    select: taskFiles_1.ATTACHMENT_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
})).map(taskFiles_1.toAttachmentDto);
exports.loadTaskAttachments = loadTaskAttachments;
//# sourceMappingURL=taskParts.js.map