"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveTaskContent = exports.requireContentEditableTask = exports.writeTaskContent = exports.lockTaskContent = exports.readTaskContent = exports.removeChecklistBlocks = exports.insertChecklistBlock = exports.normalizeContentBlocks = exports.assertContentSize = void 0;
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskHttp_1 = require("../../../presentation/routes/tasks/taskHttp");
const inlineHtml_1 = require("../../../shared/inlineHtml");
const taskConstants_1 = require("./taskConstants");
const taskErrors_1 = require("./taskErrors");
const taskParts_1 = require("./taskParts");
const taskRows_1 = require("./taskRows");
const BLOCK_ID_RE = new RegExp(`^[A-Za-z0-9_-]{1,${taskConstants_1.TASK_LIMITS.blockIdMax}}$`);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isBlockType = (value) => typeof value === 'string' && taskConstants_1.BLOCK_TYPES.includes(value);
/** Neue Blockkennung (Alphabet von nanoid = erlaubte Zeichen), die noch frei ist. */
const freshBlockId = (used) => {
    let id = (0, nanoid_1.nanoid)(10);
    while (used.has(id))
        id = (0, nanoid_1.nanoid)(10);
    return id;
};
const contentTooLarge = () => new taskErrors_1.TaskError(413, 'CONTENT_TOO_LARGE', `Der Inhalt ist zu gross (höchstens ${taskConstants_1.TASK_LIMITS.blocksMax} Blöcke und ${taskConstants_1.TASK_LIMITS.blocksBytesMax / 1024} KB).`, { maxBlocks: taskConstants_1.TASK_LIMITS.blocksMax, maxBytes: taskConstants_1.TASK_LIMITS.blocksBytesMax });
/** Obergrenzen des Inhalts — gilt auch, wenn der Server selbst einen Block einfügt. */
const assertContentSize = (blocks) => {
    if (blocks.length > taskConstants_1.TASK_LIMITS.blocksMax
        || Buffer.byteLength(JSON.stringify(blocks), 'utf8') > taskConstants_1.TASK_LIMITS.blocksBytesMax) {
        throw contentTooLarge();
    }
};
exports.assertContentSize = assertContentSize;
/** Tabellenzelle = Klartext: Auszeichnung und Steuerzeichen weg, gekürzt. */
const tableCell = (value) => typeof value === 'string' || typeof value === 'number'
    ? (0, taskHttp_1.cleanText)((0, inlineHtml_1.inlineHtmlToText)(String(value)), taskConstants_1.TASK_LIMITS.tableCellMax)
    : '';
/** Rechteckige Tabelle: höchstens 50 × 12, kurze Zeilen aufgefüllt, mindestens 1 × 1. */
const tableRows = (value) => {
    const source = Array.isArray(value) ? value.slice(0, taskConstants_1.TASK_LIMITS.tableRowsMax) : [];
    const rows = source.map((row) => (Array.isArray(row) ? row.slice(0, taskConstants_1.TASK_LIMITS.tableColsMax) : []).map(tableCell));
    if (!rows.length)
        rows.push([]);
    const width = Math.max(1, ...rows.map((row) => row.length));
    return rows.map((row) => [...row, ...new Array(width - row.length).fill('')]);
};
const TABLE_CELL_COLOR_RE = /^#[0-9a-f]{6}$/i;
const TABLE_VALIGNS = ['top', 'middle', 'bottom'];
/** Zellraster passend zu `rows` (Farbe, senkrechte Ausrichtung); nichts gesetzt = weg. */
const tableCellGrid = (value, rows, accept) => {
    if (!Array.isArray(value))
        return undefined;
    const grid = rows.map((row, rowIndex) => {
        const source = Array.isArray(value[rowIndex]) ? value[rowIndex] : [];
        return row.map((_, columnIndex) => accept(source[columnIndex]));
    });
    return grid.some((row) => row.some(Boolean)) ? grid : undefined;
};
/**
 * Tabelle (14.09.2026): Zellen, Spaltenbreiten (px, beim Einpassen Gewichte),
 * Hintergrund und senkrechte Ausrichtung je Zelle, Breite «note»/«window».
 */
const tableMeta = (meta) => {
    const rows = tableRows(meta.rows);
    const out = { rows };
    const width = rows[0]?.length ?? 1;
    if (Array.isArray(meta.colWidths) && meta.colWidths.length === width
        && meta.colWidths.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
        out.colWidths = meta.colWidths.map((entry) => Math.round(Math.min(4000, Math.max(24, entry))));
    }
    if (meta.fit === 'note' || meta.fit === 'window')
        out.fit = meta.fit;
    const bg = tableCellGrid(meta.cellBg, rows, (cell) => (typeof cell === 'string' && TABLE_CELL_COLOR_RE.test(cell) ? cell.toLowerCase() : ''));
    if (bg)
        out.cellBg = bg;
    const valign = tableCellGrid(meta.cellVAlign, rows, (cell) => (TABLE_VALIGNS.includes(cell) ? String(cell) : ''));
    if (valign)
        out.cellVAlign = valign;
    return out;
};
/** Text und `meta` eines Blocks nach seiner Art; null = der Block fällt weg. */
const blockBody = (type, raw, rules) => {
    const meta = isRecord(raw.meta) ? raw.meta : {};
    if (taskConstants_1.TEXT_BLOCK_TYPES.has(type)) {
        const align = taskConstants_1.BLOCK_ALIGNMENTS.find((value) => value === meta.align);
        return {
            text: (0, inlineHtml_1.sanitizeInlineHtml)(typeof raw.text === 'string' ? raw.text : '', taskConstants_1.TASK_LIMITS.blockTextMax),
            meta: align ? { align } : {},
        };
    }
    switch (type) {
        case 'divider':
            return { text: '', meta: {} };
        case 'table':
            return { text: '', meta: tableMeta(meta) };
        case 'checklist': {
            const groupId = meta.groupId;
            return typeof groupId === 'string' && rules.checklistIds.has(groupId) ? { text: '', meta: { groupId } } : null;
        }
        case 'image':
        case 'file': {
            const attId = meta.attId;
            return typeof attId === 'string' && rules.attachmentIds.has(attId) ? { text: '', meta: { attId } } : null;
        }
        default:
            // Eine Blockart ohne eigene Regel wird nicht ungeprüft gespeichert.
            return null;
    }
};
/**
 * Bereinigt die Blockliste eines Speicherns. Rein: was die Aufgabe besitzt,
 * steht in `rules`. Unbekannte Arten und Verweise ins Leere fallen weg,
 * fehlende oder doppelte Kennungen werden neu vergeben.
 * Wirft 403 CONTENT_BLOCK_FORBIDDEN und 413 CONTENT_TOO_LARGE.
 */
const normalizeContentBlocks = (input, rules) => {
    if (input.length > taskConstants_1.TASK_LIMITS.blocksMax)
        throw contentTooLarge();
    const blocks = [];
    const usedIds = new Set();
    for (const raw of input) {
        if (!isRecord(raw))
            continue;
        const type = raw.type;
        if (!isBlockType(type))
            continue;
        const body = blockBody(type, raw, rules);
        if (!body)
            continue;
        const id = typeof raw.id === 'string' && BLOCK_ID_RE.test(raw.id) && !usedIds.has(raw.id)
            ? raw.id
            : freshBlockId(usedIds);
        usedIds.add(id);
        // Ein Teammitglied behält Tabellen und Trenner nur, wenn genau dieser Block
        // schon so gespeichert ist — eine neue Kennung oder eine umgewandelte Art
        // wäre ein neu eingefügter Block.
        if (!rules.isManager && taskConstants_1.MANAGER_ONLY_BLOCK_TYPES.has(type) && rules.storedBlockTypes.get(id) !== type) {
            throw (0, taskErrors_1.taskForbidden)('CONTENT_BLOCK_FORBIDDEN', 'Tabellen und Trennlinien fügt nur die Leitung ein.', { blockType: type });
        }
        blocks.push({ id, type, ...body });
    }
    (0, exports.assertContentSize)(blocks);
    return blocks;
};
exports.normalizeContentBlocks = normalizeContentBlocks;
/** Fügt einen Checklistenblock für die Gruppe hinter `afterBlockId` ein (sonst am Ende). */
const insertChecklistBlock = (blocks, groupId, afterBlockId) => {
    const block = {
        id: freshBlockId(new Set(blocks.map((entry) => entry.id))),
        type: 'checklist',
        text: '',
        meta: { groupId },
    };
    const index = afterBlockId ? blocks.findIndex((entry) => entry.id === afterBlockId) : -1;
    return index < 0 ? [...blocks, block] : [...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)];
};
exports.insertChecklistBlock = insertChecklistBlock;
/** Die Blöcke ohne die Checklistenblöcke dieser Gruppe. */
const removeChecklistBlocks = (blocks, groupId) => blocks.filter((block) => !(block.type === 'checklist' && block.meta.groupId === groupId));
exports.removeChecklistBlocks = removeChecklistBlocks;
/* ── Lesen und Schreiben ────────────────────────────────────────────────── */
/** Gespeicherte Blöcke lesen — sie sind beim Schreiben schon bereinigt worden. */
const parseStoredBlocks = (value) => {
    const parsed = (0, taskRows_1.rawJson)(value);
    if (!Array.isArray(parsed))
        return [];
    return parsed
        .filter(isRecord)
        .map((block) => ({
        id: String(block.id ?? ''),
        type: String(block.type ?? 'p'),
        text: typeof block.text === 'string' ? block.text : '',
        meta: isRecord(block.meta) ? block.meta : {},
    }))
        .filter((block) => block.id.length > 0);
};
const selectContent = async (db, tenantId, taskId, lock) => {
    const rows = await db.$queryRaw(client_1.Prisma.sql `
        SELECT blocks, version, updatedAt, updatedById
        FROM TaskContent
        WHERE taskId = ${taskId} AND tenantId = ${tenantId}
        ${lock}
    `);
    const row = rows[0];
    if (!row)
        return { ...taskParts_1.EMPTY_CONTENT, blocks: [] };
    return {
        blocks: parseStoredBlocks(row.blocks),
        version: (0, taskRows_1.rawNumber)(row.version),
        updatedAt: (0, taskRows_1.rawDate)(row.updatedAt),
        updatedById: (0, taskRows_1.rawString)(row.updatedById),
    };
};
/** Gespeicherter Inhalt einer Aufgabe der Firma (Version 0 = noch nie gespeichert). */
const readTaskContent = (db, tenantId, taskId) => selectContent(db, tenantId, taskId, client_1.Prisma.empty);
exports.readTaskContent = readTaskContent;
/**
 * Wie readTaskContent, sperrt aber die Zeile — oder, solange es keine gibt,
 * ihre Lücke — bis zum Ende der Transaktion. Liest den neuesten Stand, auch
 * wenn die Transaktion schon anderes gelesen hat: ein serverseitiges Einfügen
 * oder Entfernen von Blöcken überholt so kein gleichzeitiges Speichern.
 */
const lockTaskContent = (tx, tenantId, taskId) => selectContent(tx, tenantId, taskId, client_1.Prisma.sql `FOR UPDATE`);
exports.lockTaskContent = lockTaskContent;
const contentConflict = (content) => (0, taskErrors_1.taskConflict)('CONTENT_CONFLICT', 'Der Inhalt wurde inzwischen anderswo gespeichert. Bitte neu laden.', { content });
const isUniqueViolation = (error) => error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
/**
 * Schreibt `blocks` auf den Stand `base`: eine vorhandene Zeile nur, solange sie
 * noch dieselbe Version trägt (dann Version + 1); ohne Zeile wird sie mit
 * Version 1 angelegt. Hat inzwischen jemand anders gespeichert, kommt 409
 * CONTENT_CONFLICT mit dem aktuellen Inhalt.
 */
const writeTaskContent = async (db, actor, taskId, base, blocks) => {
    const now = new Date();
    const json = blocks;
    let written;
    if (base.version > 0) {
        const { count } = await db.taskContent.updateMany({
            where: { taskId, tenantId: actor.tenantId, version: base.version },
            data: { blocks: json, version: { increment: 1 }, updatedById: actor.employeeId, updatedAt: now },
        });
        written = count > 0;
    }
    else {
        try {
            // createMany statt create: MySQL kennt kein RETURNING, create läse die Zeile ein zweites Mal.
            await db.taskContent.createMany({
                data: [{
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId: actor.tenantId,
                        taskId,
                        blocks: json,
                        version: 1,
                        updatedById: actor.employeeId,
                        createdAt: now,
                        updatedAt: now,
                    }],
            });
            written = true;
        }
        catch (error) {
            if (!isUniqueViolation(error))
                throw error;
            written = false;
        }
    }
    // Den Konflikt frisch über den gemeinsamen Client lesen — nicht aus einer Transaktion.
    if (!written)
        throw contentConflict(await (0, exports.readTaskContent)(prisma_client_1.default, actor.tenantId, taskId));
    return { blocks, version: base.version + 1, updatedAt: now, updatedById: actor.employeeId };
};
exports.writeTaskContent = writeTaskContent;
/* ── Zugriff und Speichern ──────────────────────────────────────────────── */
/** Aufgabe, deren Inhalt (Blöcke, Checklisten, Punkte) die handelnde Person bearbeiten darf. */
const requireContentEditableTask = async (actor, taskId) => {
    const visible = await (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId);
    if (!visible.permissions.canEditContent) {
        throw (0, taskErrors_1.taskForbidden)('CONTENT_EDIT_FORBIDDEN', 'Den Inhalt dieser Aufgabe dürfen Sie nicht bearbeiten.');
    }
    return visible;
};
exports.requireContentEditableTask = requireContentEditableTask;
const NO_IDS = new Set();
const loadChecklistIds = async (tenantId, taskId) => new Set((await prisma_client_1.default.taskChecklist.findMany({ where: { tenantId, taskId }, select: { id: true } })).map((row) => row.id));
const loadTaskAttachmentIds = async (tenantId, taskId) => new Set((await prisma_client_1.default.taskAttachment.findMany({
    where: { tenantId, taskId, kind: 'TASK' },
    select: { id: true },
})).map((row) => row.id));
/** PUT /:taskId/content — die ganze Blockliste auf dem Stand `baseVersion` speichern. */
const saveTaskContent = async (actor, taskId, input) => {
    // Gespeichert wird beim Tippen: Checklisten und Dateien nur laden, wenn Blöcke darauf verweisen.
    const types = new Set(input.blocks.map((block) => (isRecord(block) ? block.type : undefined)));
    const [, current, checklistIds, attachmentIds] = await Promise.all([
        (0, exports.requireContentEditableTask)(actor, taskId),
        (0, exports.readTaskContent)(prisma_client_1.default, actor.tenantId, taskId),
        types.has('checklist') ? loadChecklistIds(actor.tenantId, taskId) : NO_IDS,
        types.has('image') || types.has('file') ? loadTaskAttachmentIds(actor.tenantId, taskId) : NO_IDS,
    ]);
    // Vor den Blockregeln: ob ein Block «neu» ist, lässt sich nur am eigenen Stand entscheiden.
    if (current.version !== input.baseVersion)
        throw contentConflict(current);
    const blocks = (0, exports.normalizeContentBlocks)(input.blocks, {
        checklistIds,
        attachmentIds,
        storedBlockTypes: new Map(current.blocks.map((block) => [block.id, block.type])),
        isManager: actor.isManager,
    });
    return { content: await (0, exports.writeTaskContent)(prisma_client_1.default, actor, taskId, current, blocks) };
};
exports.saveTaskContent = saveTaskContent;
//# sourceMappingURL=contentService.js.map