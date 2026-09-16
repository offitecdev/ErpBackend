"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteAttachment = exports.attachmentPublicUrl = exports.readAttachmentContent = exports.uploadTaskAttachments = exports.listTaskAttachments = exports.storeNewAttachments = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const contentService_1 = require("./contentService");
const taskActivity_1 = require("./taskActivity");
const taskConstants_1 = require("./taskConstants");
const taskDb_1 = require("./taskDb");
const taskErrors_1 = require("./taskErrors");
const taskFiles_1 = require("./taskFiles");
const taskParts_1 = require("./taskParts");
const taskRows_1 = require("./taskRows");
/**
 * ── DATEIEN: Reiter «Dosyalar» und der Auslieferungsweg ─────────────────────
 *
 * Görevly `attachments.js`, serverseitig und mit Rechten:
 *   hochladen   Leitung ODER wer an der Aufgabe messen darf (canUpload);
 *               alle Dateien des Reiters zusammen höchstens `taskFilesBytesMax`
 *   öffnen      NUR über GET /attachments/:id/content — Aufgaben-, Kommentar-
 *               und Fragendateien: wer die Aufgabe sieht; Chatdateien: nur
 *               Mitglieder des Raums (die Leitung hat im Chat keinen Vorrang)
 *   entfernen   wer sie öffnen darf, und dazu — Aufgabendatei: canUpload ·
 *               Kommentar- und Chatdatei: wer sie hochgeladen hat oder die Leitung
 *
 * Datei und Block hängen zusammen (15.09.2026): wird eine Aufgabendatei hier
 * entfernt, verschwinden ihre Blöcke im Inhalt mit; wird ein Bild-/Dateiblock
 * im Editor gelöscht, entfernt `saveTaskContent` die Datei.
 */
const megabytes = (bytes) => Math.round(bytes / (1024 * 1024));
/**
 * Legt die Dateien in die Ablage und baut ihre Zeilen. Scheitert danach das
 * Schreiben, muss der Aufrufer die Ablage über `fileRef` wieder räumen.
 */
const storeNewAttachments = async (owner, files) => {
    const refs = await (0, taskFiles_1.storeTaskFiles)(owner.tenantId, files);
    const createdMs = Date.now();
    return files.map((file, index) => ({
        ...owner,
        id: (0, nanoid_1.nanoid)(12),
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        // storeTaskFiles liefert genau einen Verweis je Datei, in derselben Reihenfolge.
        fileRef: refs[index],
        // Die Listen sortieren nach createdAt: +1 ms je Datei hält die Reihenfolge der Auswahl.
        createdAt: new Date(createdMs + index),
    }));
};
exports.storeNewAttachments = storeNewAttachments;
/* ── Reiter «Dosyalar» ──────────────────────────────────────────────────── */
const listTaskAttachments = async (actor, taskId) => {
    await (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId);
    return { data: await (0, taskParts_1.loadTaskAttachments)(prisma_client_1.default, actor.tenantId, taskId) };
};
exports.listTaskAttachments = listTaskAttachments;
/** 413, wenn die Dateien des Reiters mit `addedBytes` die Grenze der Aufgabe überschreiten. */
const assertTaskFilesBudget = async (db, tenantId, taskId, addedBytes) => {
    const usage = await db.taskAttachment.aggregate({
        where: { tenantId, taskId, kind: 'TASK' },
        _sum: { sizeBytes: true },
    });
    const usedBytes = usage._sum.sizeBytes ?? 0;
    if (usedBytes + addedBytes > taskConstants_1.TASK_LIMITS.taskFilesBytesMax) {
        throw new taskErrors_1.TaskError(413, 'TASK_FILES_LIMIT', `Die Dateien einer Aufgabe dürfen zusammen höchstens ${megabytes(taskConstants_1.TASK_LIMITS.taskFilesBytesMax)} MB gross sein.`, { usedBytes, maxBytes: taskConstants_1.TASK_LIMITS.taskFilesBytesMax });
    }
};
const uploadTaskAttachments = async (actor, taskId, files) => {
    const prepared = (0, taskFiles_1.prepareTaskFiles)(files, taskConstants_1.TASK_LIMITS.filesPerUpload);
    if (!prepared.length)
        throw (0, taskErrors_1.taskBadRequest)('NO_FILES', 'Es wurde keine Datei übergeben.');
    const { permissions } = await (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId);
    if (!permissions.canUpload) {
        throw (0, taskErrors_1.taskForbidden)('UPLOAD_FORBIDDEN', 'Dateien hinzufügen dürfen nur die Leitung und die Verantwortlichen einer offenen Aufgabe.');
    }
    const addedBytes = prepared.reduce((sum, file) => sum + file.sizeBytes, 0);
    // Vorab prüfen: was ohnehin abgewiesen würde, geht gar nicht erst in die Ablage.
    await assertTaskFilesBudget(prisma_client_1.default, actor.tenantId, taskId, addedBytes);
    const rows = await (0, exports.storeNewAttachments)({ tenantId: actor.tenantId, kind: 'TASK', taskId, commentId: null, uploadedById: actor.employeeId }, prepared);
    try {
        await (0, taskDb_1.runTasksTransaction)(async (tx) => {
            if (!(await (0, taskRows_1.lockTaskRow)(tx, actor.tenantId, taskId)))
                throw (0, taskErrors_1.taskNotFound)();
            // Verbindlich erst unter der Sperre: zwei gleichzeitige Uploads dürfen die Grenze nicht gemeinsam sprengen.
            await assertTaskFilesBudget(tx, actor.tenantId, taskId, addedBytes);
            await tx.taskAttachment.createMany({ data: rows });
            await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, actor.employeeId, {
                taskId,
                type: taskConstants_1.ACTIVITY.ATTACHMENT,
                meta: { count: rows.length },
            });
        });
    }
    catch (error) {
        await (0, taskFiles_1.removeStoredFiles)(rows.map((row) => row.fileRef));
        throw error;
    }
    return { data: rows.map(taskFiles_1.toAttachmentDto) };
};
exports.uploadTaskAttachments = uploadTaskAttachments;
/* ── Öffnen und Entfernen (alle Arten) ──────────────────────────────────── */
const ATTACHMENT_ACCESS_SELECT = {
    id: true,
    kind: true,
    taskId: true,
    roomId: true,
    fileName: true,
    contentType: true,
    fileRef: true,
    uploadedById: true,
};
const attachmentNotFound = () => (0, taskErrors_1.taskNotFound)('ATTACHMENT_NOT_FOUND', 'Datei nicht gefunden.');
const loadAttachment = async (actor, attachmentId) => {
    const row = await prisma_client_1.default.taskAttachment.findFirst({
        where: { id: attachmentId, tenantId: actor.tenantId },
        select: ATTACHMENT_ACCESS_SELECT,
    });
    if (!row)
        throw attachmentNotFound();
    return row;
};
/**
 * Darf die Person die Datei überhaupt erreichen? Chatdateien: nur als Mitglied
 * des Raums (kein Vorrang der Leitung, Görevly). Dateien des Gün sonu raporu:
 * wer sie hochgeladen hat — und wer alle Rapporte liest (wie im Arbeitsrapport).
 * Aufgaben- und Kommentardateien: die Aufgabe muss für sie sichtbar sein — sie
 * kommt samt Rechten zurück.
 */
const requireAttachmentAccess = async (actor, row) => {
    if (row.kind === 'DAILY') {
        if (row.uploadedById !== actor.employeeId && !actor.seesAll) {
            throw (0, taskErrors_1.taskForbidden)('REPORT_FORBIDDEN', 'Diese Datei gehört zum Rapport einer anderen Person.');
        }
        return null;
    }
    if (row.kind === 'CHAT') {
        const member = row.roomId
            ? await prisma_client_1.default.taskChatMember.findFirst({
                where: { tenantId: actor.tenantId, roomId: row.roomId, employeeId: actor.employeeId },
                select: { id: true },
            })
            : null;
        if (!member)
            throw (0, taskErrors_1.taskForbidden)('ROOM_FORBIDDEN', 'Sie sind nicht Mitglied dieses Chat-Raums.');
        return null;
    }
    if (!row.taskId)
        throw attachmentNotFound();
    return (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, row.taskId);
};
/** Fehlt die Datei in der Ablage? Platte: ENOENT · R2: NoSuchKey bzw. HTTP 404. */
const isMissingStoredFile = (error) => {
    if (!error || typeof error !== 'object')
        return false;
    const { code, name, $metadata } = error;
    return code === 'ENOENT' || name === 'NoSuchKey' || name === 'NotFound' || $metadata?.httpStatusCode === 404;
};
const readAttachmentContent = async (actor, attachmentId) => {
    const row = await loadAttachment(actor, attachmentId);
    await requireAttachmentAccess(actor, row);
    const body = await (0, taskFiles_1.readStoredFile)(row.fileRef).catch((error) => {
        throw isMissingStoredFile(error) ? (0, taskErrors_1.taskNotFound)('FILE_MISSING', 'Die Datei fehlt in der Ablage.') : error;
    });
    return { fileName: row.fileName, contentType: row.contentType, body };
};
exports.readAttachmentContent = readAttachmentContent;
/** Cloudflare-Adresse eines Bildes/PDFs in R2 (nach Berechtigungsprüfung), sonst null. */
const attachmentPublicUrl = async (actor, attachmentId) => {
    const row = await loadAttachment(actor, attachmentId);
    await requireAttachmentAccess(actor, row);
    return (0, taskFiles_1.attachmentPublicUrlFor)(row.contentType, row.fileRef);
};
exports.attachmentPublicUrl = attachmentPublicUrl;
const deleteAttachment = async (actor, attachmentId) => {
    const row = await loadAttachment(actor, attachmentId);
    const task = await requireAttachmentAccess(actor, row);
    // Aufgabendateien gehören der Aufgabe: wer hochladen darf, darf entfernen.
    // Kommentar-, Frage- und Chatdateien gehören der Person, die sie hochgeladen hat — und der Leitung.
    const allowed = row.kind === 'TASK'
        ? task?.permissions.canUpload === true
        : row.uploadedById === actor.employeeId || actor.isManager;
    if (!allowed)
        throw (0, taskErrors_1.taskForbidden)('ATTACHMENT_DELETE_FORBIDDEN', 'Diese Datei dürfen Sie nicht entfernen.');
    if (row.kind === 'TASK' && row.taskId) {
        const taskId = row.taskId;
        // Aufgabendatei: ihre Bild-/Dateiblöcke im Inhalt gehen in derselben Transaktion mit (wie bei Checklisten).
        await (0, taskDb_1.runTasksTransaction)(async (tx) => {
            if (!(await (0, taskRows_1.lockTaskRow)(tx, actor.tenantId, taskId)))
                throw (0, taskErrors_1.taskNotFound)();
            await tx.taskAttachment.deleteMany({ where: { id: row.id, tenantId: actor.tenantId } });
            const base = await (0, contentService_1.lockTaskContent)(tx, actor.tenantId, taskId);
            const blocks = base.blocks.filter((block) => !((block.type === 'image' || block.type === 'file') && block.meta.attId === row.id));
            if (blocks.length !== base.blocks.length)
                await (0, contentService_1.writeTaskContent)(tx, actor, taskId, base, blocks);
        });
    }
    else {
        await prisma_client_1.default.taskAttachment.deleteMany({ where: { id: row.id, tenantId: actor.tenantId } });
    }
    await (0, taskFiles_1.removeStoredFiles)([row.fileRef]);
};
exports.deleteAttachment = deleteAttachment;
//# sourceMappingURL=attachmentService.js.map