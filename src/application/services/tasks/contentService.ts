import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import { cleanText } from '../../../presentation/routes/tasks/taskHttp';
import { inlineHtmlToText, sanitizeInlineHtml } from '../../../shared/inlineHtml';
import type { TasksActor } from './taskActor';
import {
    BLOCK_ALIGNMENTS,
    BLOCK_TYPES,
    MANAGER_ONLY_BLOCK_TYPES,
    TASK_LIMITS,
    TEXT_BLOCK_TYPES,
    type BlockType,
} from './taskConstants';
import type { TasksDb } from './taskDb';
import { TaskError, taskConflict, taskForbidden } from './taskErrors';
import { EMPTY_CONTENT, type ContentBlock, type ContentDto } from './taskParts';
import { rawDate, rawJson, rawNumber, rawString, requireVisibleTask, type VisibleTask } from './taskRows';

/**
 * ── INHALT EINER AUFGABE (Blockeditor, Görevly ui/editor.js) ────────────────
 *
 * Der Browser schickt bei jedem Speichern die ganze Blockliste; der Server
 * behält nur, was das Modell kennt:
 *   • Textblöcke (p h2 h3 bullet number quote) tragen BEREINIGTES Inline-HTML
 *     (sanitizeInlineHtml) — nie maskiert. Vorgabe Samet: «<b>…&nbsp;</b>» darf
 *     nie als Quelltext auf dem Bildschirm stehen. `meta` höchstens die
 *     Ausrichtung; der Zähler der nummerierten Liste entsteht im Browser.
 *   • Tabellen tragen Klartextzellen, Trenner gar nichts.
 *   • Checklisten-, Bild- und Dateiblöcke verweisen auf Zeilen DIESER Aufgabe;
 *     ein Verweis ins Leere (Liste oder Datei gelöscht) fällt beim Speichern weg.
 * Tabelle und Trenner fügt nur die Leitung NEU ein (Görevly `editor.full`);
 * vorhandene darf auch ein Teammitglied füllen, verschieben und löschen.
 *
 * Zwei Schreibende: `version` ist eine optimistische Sperre. Wer auf einem
 * veralteten Stand speichert, bekommt 409 CONTENT_CONFLICT samt dem aktuellen
 * Inhalt und führt in der Oberfläche zusammen. Kein Verlaufseintrag — Görevly
 * speichert still.
 */

/* ── Regeln (rein, ohne Datenbank) ──────────────────────────────────────── */

/** Was die Regeln über die Aufgabe wissen müssen — der Aufrufer lädt es. */
export interface ContentRules {
    /** Checklisten DIESER Aufgabe. */
    checklistIds: ReadonlySet<string>;
    /** Dateien (Art TASK) DIESER Aufgabe. */
    attachmentIds: ReadonlySet<string>;
    /** Kennung → Art der gespeicherten Blöcke, also des Stands, auf dem gespeichert wird. */
    storedBlockTypes: ReadonlyMap<string, string>;
    isManager: boolean;
}

type RawRecord = Record<string, unknown>;
type BlockBody = Pick<ContentBlock, 'text' | 'meta'>;

const BLOCK_ID_RE = new RegExp(`^[A-Za-z0-9_-]{1,${TASK_LIMITS.blockIdMax}}$`);

const isRecord = (value: unknown): value is RawRecord =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isBlockType = (value: unknown): value is BlockType =>
    typeof value === 'string' && (BLOCK_TYPES as readonly string[]).includes(value);

/** Neue Blockkennung (Alphabet von nanoid = erlaubte Zeichen), die noch frei ist. */
const freshBlockId = (used: ReadonlySet<string>): string => {
    let id = nanoid(10);
    while (used.has(id)) id = nanoid(10);
    return id;
};

const contentTooLarge = (): TaskError => new TaskError(
    413,
    'CONTENT_TOO_LARGE',
    `Der Inhalt ist zu gross (höchstens ${TASK_LIMITS.blocksMax} Blöcke und ${TASK_LIMITS.blocksBytesMax / 1024} KB).`,
    { maxBlocks: TASK_LIMITS.blocksMax, maxBytes: TASK_LIMITS.blocksBytesMax },
);

/** Obergrenzen des Inhalts — gilt auch, wenn der Server selbst einen Block einfügt. */
export const assertContentSize = (blocks: readonly ContentBlock[]): void => {
    if (blocks.length > TASK_LIMITS.blocksMax
        || Buffer.byteLength(JSON.stringify(blocks), 'utf8') > TASK_LIMITS.blocksBytesMax) {
        throw contentTooLarge();
    }
};

/** Tabellenzelle = Klartext: Auszeichnung und Steuerzeichen weg, gekürzt. */
const tableCell = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number'
        ? cleanText(inlineHtmlToText(String(value)), TASK_LIMITS.tableCellMax)
        : '';

/** Rechteckige Tabelle: höchstens 50 × 12, kurze Zeilen aufgefüllt, mindestens 1 × 1. */
const tableRows = (value: unknown): string[][] => {
    const source = Array.isArray(value) ? value.slice(0, TASK_LIMITS.tableRowsMax) : [];
    const rows = source.map((row) => (Array.isArray(row) ? row.slice(0, TASK_LIMITS.tableColsMax) : []).map(tableCell));
    if (!rows.length) rows.push([]);
    const width = Math.max(1, ...rows.map((row) => row.length));
    return rows.map((row) => [...row, ...new Array<string>(width - row.length).fill('')]);
};

const TABLE_CELL_COLOR_RE = /^#[0-9a-f]{6}$/i;
const TABLE_VALIGNS = ['top', 'middle', 'bottom'] as const;

/** Zellraster passend zu `rows` (Farbe, senkrechte Ausrichtung); nichts gesetzt = weg. */
const tableCellGrid = (value: unknown, rows: string[][], accept: (cell: unknown) => string): string[][] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const grid = rows.map((row, rowIndex) => {
        const source: unknown[] = Array.isArray(value[rowIndex]) ? value[rowIndex] : [];
        return row.map((_, columnIndex) => accept(source[columnIndex]));
    });
    return grid.some((row) => row.some(Boolean)) ? grid : undefined;
};

/**
 * Tabelle (14.09.2026): Zellen, Spaltenbreiten (px, beim Einpassen Gewichte),
 * Hintergrund und senkrechte Ausrichtung je Zelle, Breite «note»/«window».
 */
const tableMeta = (meta: RawRecord): RawRecord => {
    const rows = tableRows(meta.rows);
    const out: RawRecord = { rows };
    const width = rows[0]?.length ?? 1;
    if (Array.isArray(meta.colWidths) && meta.colWidths.length === width
        && meta.colWidths.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
        out.colWidths = (meta.colWidths as number[]).map((entry) => Math.round(Math.min(4000, Math.max(24, entry))));
    }
    if (meta.fit === 'note' || meta.fit === 'window') out.fit = meta.fit;
    const bg = tableCellGrid(meta.cellBg, rows, (cell) => (typeof cell === 'string' && TABLE_CELL_COLOR_RE.test(cell) ? cell.toLowerCase() : ''));
    if (bg) out.cellBg = bg;
    const valign = tableCellGrid(meta.cellVAlign, rows, (cell) => ((TABLE_VALIGNS as readonly unknown[]).includes(cell) ? String(cell) : ''));
    if (valign) out.cellVAlign = valign;
    return out;
};

/** Text und `meta` eines Blocks nach seiner Art; null = der Block fällt weg. */
const blockBody = (type: BlockType, raw: RawRecord, rules: ContentRules): BlockBody | null => {
    const meta: RawRecord = isRecord(raw.meta) ? raw.meta : {};
    if (TEXT_BLOCK_TYPES.has(type)) {
        const align = BLOCK_ALIGNMENTS.find((value) => value === meta.align);
        return {
            text: sanitizeInlineHtml(typeof raw.text === 'string' ? raw.text : '', TASK_LIMITS.blockTextMax),
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
export const normalizeContentBlocks = (input: readonly unknown[], rules: ContentRules): ContentBlock[] => {
    if (input.length > TASK_LIMITS.blocksMax) throw contentTooLarge();
    const blocks: ContentBlock[] = [];
    const usedIds = new Set<string>();

    for (const raw of input) {
        if (!isRecord(raw)) continue;
        const type = raw.type;
        if (!isBlockType(type)) continue;
        const body = blockBody(type, raw, rules);
        if (!body) continue;

        const id = typeof raw.id === 'string' && BLOCK_ID_RE.test(raw.id) && !usedIds.has(raw.id)
            ? raw.id
            : freshBlockId(usedIds);
        usedIds.add(id);

        // Ein Teammitglied behält Tabellen und Trenner nur, wenn genau dieser Block
        // schon so gespeichert ist — eine neue Kennung oder eine umgewandelte Art
        // wäre ein neu eingefügter Block.
        if (!rules.isManager && MANAGER_ONLY_BLOCK_TYPES.has(type) && rules.storedBlockTypes.get(id) !== type) {
            throw taskForbidden('CONTENT_BLOCK_FORBIDDEN', 'Tabellen und Trennlinien fügt nur die Leitung ein.', { blockType: type });
        }
        blocks.push({ id, type, ...body });
    }

    assertContentSize(blocks);
    return blocks;
};

/** Fügt einen Checklistenblock für die Gruppe hinter `afterBlockId` ein (sonst am Ende). */
export const insertChecklistBlock = (
    blocks: readonly ContentBlock[],
    groupId: string,
    afterBlockId: string | null | undefined,
): ContentBlock[] => {
    const block: ContentBlock = {
        id: freshBlockId(new Set(blocks.map((entry) => entry.id))),
        type: 'checklist',
        text: '',
        meta: { groupId },
    };
    const index = afterBlockId ? blocks.findIndex((entry) => entry.id === afterBlockId) : -1;
    return index < 0 ? [...blocks, block] : [...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)];
};

/** Die Blöcke ohne die Checklistenblöcke dieser Gruppe. */
export const removeChecklistBlocks = (blocks: readonly ContentBlock[], groupId: string): ContentBlock[] =>
    blocks.filter((block) => !(block.type === 'checklist' && block.meta.groupId === groupId));

/* ── Lesen und Schreiben ────────────────────────────────────────────────── */

/** Gespeicherte Blöcke lesen — sie sind beim Schreiben schon bereinigt worden. */
const parseStoredBlocks = (value: unknown): ContentBlock[] => {
    const parsed = rawJson(value);
    if (!Array.isArray(parsed)) return [];
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

const selectContent = async (db: TasksDb, tenantId: string, taskId: string, lock: Prisma.Sql): Promise<ContentDto> => {
    const rows = await db.$queryRaw<Array<{ blocks: unknown; version: unknown; updatedAt: unknown; updatedById: unknown }>>(Prisma.sql`
        SELECT blocks, version, updatedAt, updatedById
        FROM TaskContent
        WHERE taskId = ${taskId} AND tenantId = ${tenantId}
        ${lock}
    `);
    const row = rows[0];
    if (!row) return { ...EMPTY_CONTENT, blocks: [] };
    return {
        blocks: parseStoredBlocks(row.blocks),
        version: rawNumber(row.version),
        updatedAt: rawDate(row.updatedAt),
        updatedById: rawString(row.updatedById),
    };
};

/** Gespeicherter Inhalt einer Aufgabe der Firma (Version 0 = noch nie gespeichert). */
export const readTaskContent = (db: TasksDb, tenantId: string, taskId: string): Promise<ContentDto> =>
    selectContent(db, tenantId, taskId, Prisma.empty);

/**
 * Wie readTaskContent, sperrt aber die Zeile — oder, solange es keine gibt,
 * ihre Lücke — bis zum Ende der Transaktion. Liest den neuesten Stand, auch
 * wenn die Transaktion schon anderes gelesen hat: ein serverseitiges Einfügen
 * oder Entfernen von Blöcken überholt so kein gleichzeitiges Speichern.
 */
export const lockTaskContent = (tx: TasksDb, tenantId: string, taskId: string): Promise<ContentDto> =>
    selectContent(tx, tenantId, taskId, Prisma.sql`FOR UPDATE`);

const contentConflict = (content: ContentDto): TaskError =>
    taskConflict('CONTENT_CONFLICT', 'Der Inhalt wurde inzwischen anderswo gespeichert. Bitte neu laden.', { content });

const isUniqueViolation = (error: unknown): boolean =>
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * Schreibt `blocks` auf den Stand `base`: eine vorhandene Zeile nur, solange sie
 * noch dieselbe Version trägt (dann Version + 1); ohne Zeile wird sie mit
 * Version 1 angelegt. Hat inzwischen jemand anders gespeichert, kommt 409
 * CONTENT_CONFLICT mit dem aktuellen Inhalt.
 */
export const writeTaskContent = async (
    db: TasksDb,
    actor: TasksActor,
    taskId: string,
    base: ContentDto,
    blocks: ContentBlock[],
): Promise<ContentDto> => {
    const now = new Date();
    const json = blocks as unknown as Prisma.InputJsonValue;
    let written: boolean;
    if (base.version > 0) {
        const { count } = await db.taskContent.updateMany({
            where: { taskId, tenantId: actor.tenantId, version: base.version },
            data: { blocks: json, version: { increment: 1 }, updatedById: actor.employeeId, updatedAt: now },
        });
        written = count > 0;
    } else {
        try {
            // createMany statt create: MySQL kennt kein RETURNING, create läse die Zeile ein zweites Mal.
            await db.taskContent.createMany({
                data: [{
                    id: nanoid(12),
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
        } catch (error) {
            if (!isUniqueViolation(error)) throw error;
            written = false;
        }
    }
    // Den Konflikt frisch über den gemeinsamen Client lesen — nicht aus einer Transaktion.
    if (!written) throw contentConflict(await readTaskContent(prisma, actor.tenantId, taskId));
    return { blocks, version: base.version + 1, updatedAt: now, updatedById: actor.employeeId };
};

/* ── Zugriff und Speichern ──────────────────────────────────────────────── */

/** Aufgabe, deren Inhalt (Blöcke, Checklisten, Punkte) die handelnde Person bearbeiten darf. */
export const requireContentEditableTask = async (actor: TasksActor, taskId: string): Promise<VisibleTask> => {
    const visible = await requireVisibleTask(prisma, actor, taskId);
    if (!visible.permissions.canEditContent) {
        throw taskForbidden('CONTENT_EDIT_FORBIDDEN', 'Den Inhalt dieser Aufgabe dürfen Sie nicht bearbeiten.');
    }
    return visible;
};

const NO_IDS: ReadonlySet<string> = new Set();

const loadChecklistIds = async (tenantId: string, taskId: string): Promise<ReadonlySet<string>> =>
    new Set((await prisma.taskChecklist.findMany({ where: { tenantId, taskId }, select: { id: true } })).map((row) => row.id));

const loadTaskAttachmentIds = async (tenantId: string, taskId: string): Promise<ReadonlySet<string>> =>
    new Set((await prisma.taskAttachment.findMany({
        where: { tenantId, taskId, kind: 'TASK' },
        select: { id: true },
    })).map((row) => row.id));

export interface ContentSaveInput {
    blocks: readonly unknown[];
    /** Version, auf der der Browser gearbeitet hat (0 = noch nie gespeichert). */
    baseVersion: number;
}

/** PUT /:taskId/content — die ganze Blockliste auf dem Stand `baseVersion` speichern. */
export const saveTaskContent = async (
    actor: TasksActor,
    taskId: string,
    input: ContentSaveInput,
): Promise<{ content: ContentDto }> => {
    // Gespeichert wird beim Tippen: Checklisten und Dateien nur laden, wenn Blöcke darauf verweisen.
    const types = new Set(input.blocks.map((block) => (isRecord(block) ? block.type : undefined)));
    const [, current, checklistIds, attachmentIds] = await Promise.all([
        requireContentEditableTask(actor, taskId),
        readTaskContent(prisma, actor.tenantId, taskId),
        types.has('checklist') ? loadChecklistIds(actor.tenantId, taskId) : NO_IDS,
        types.has('image') || types.has('file') ? loadTaskAttachmentIds(actor.tenantId, taskId) : NO_IDS,
    ]);

    // Vor den Blockregeln: ob ein Block «neu» ist, lässt sich nur am eigenen Stand entscheiden.
    if (current.version !== input.baseVersion) throw contentConflict(current);

    const blocks = normalizeContentBlocks(input.blocks, {
        checklistIds,
        attachmentIds,
        storedBlockTypes: new Map(current.blocks.map((block) => [block.id, block.type])),
        isManager: actor.isManager,
    });
    return { content: await writeTaskContent(prisma, actor, taskId, current, blocks) };
};
