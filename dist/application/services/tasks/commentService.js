"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteTaskComment = exports.addTaskComment = exports.listTaskComments = exports.loadVisibleTaskComments = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const attachmentService_1 = require("./attachmentService");
const taskActivity_1 = require("./taskActivity");
const taskConstants_1 = require("./taskConstants");
const taskDb_1 = require("./taskDb");
const taskErrors_1 = require("./taskErrors");
const taskFiles_1 = require("./taskFiles");
const taskNotify_1 = require("./taskNotify");
const taskPeople_1 = require("./taskPeople");
const taskRows_1 = require("./taskRows");
const canDeleteComment = (actor, authorId) => actor.isManager || authorId === actor.employeeId;
const toCommentDto = (actor, comment, attachments) => ({
    id: comment.id,
    authorId: comment.authorId,
    text: comment.text,
    createdAt: comment.createdAt,
    attachments,
    canDelete: canDeleteComment(actor, comment.authorId),
});
/**
 * Kommentare einer bereits sichtbarkeitsgeprueften Aufgabe. Die Detailroute
 * laedt sie zusammen mit Inhalt, Checklisten und Dateien; dadurch ist der
 * Kommentar-Reiter ohne einen zweiten HTTP-/DB-Rundgang sofort bereit.
 */
const loadVisibleTaskComments = async (actor, taskId) => {
    const [comments, files] = await Promise.all([
        prisma_client_1.default.taskComment.findMany({
            where: { tenantId: actor.tenantId, taskId },
            select: { id: true, authorId: true, text: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma_client_1.default.taskAttachment.findMany({
            where: { tenantId: actor.tenantId, taskId, kind: 'COMMENT' },
            select: taskFiles_1.ATTACHMENT_SELECT,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
    ]);
    const filesByComment = new Map();
    for (const file of files) {
        if (!file.commentId)
            continue;
        const list = filesByComment.get(file.commentId) ?? [];
        list.push((0, taskFiles_1.toAttachmentDto)(file));
        filesByComment.set(file.commentId, list);
    }
    return {
        data: comments.map((comment) => toCommentDto(actor, comment, filesByComment.get(comment.id) ?? [])),
        personIds: [
            ...comments.map((comment) => comment.authorId),
            ...files.map((file) => file.uploadedById),
        ],
    };
};
exports.loadVisibleTaskComments = loadVisibleTaskComments;
const listTaskComments = async (actor, taskId) => {
    await (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId);
    const comments = await (0, exports.loadVisibleTaskComments)(actor, taskId);
    return { data: comments.data, people: await (0, taskPeople_1.loadPersonRefs)(comments.personIds) };
};
exports.listTaskComments = listTaskComments;
const addTaskComment = async (actor, taskId, input) => {
    const prepared = (0, taskFiles_1.prepareTaskFiles)(input.files, taskConstants_1.TASK_LIMITS.commentFilesMax);
    if (!input.text && !prepared.length) {
        throw (0, taskErrors_1.taskBadRequest)('COMMENT_EMPTY', 'Ein Kommentar braucht Text oder eine Datei.');
    }
    // Der eigene Name kommt gleich mit: er steht in der Antwort und in der Meldung.
    const [{ core, permissions }, people] = await Promise.all([
        (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId),
        (0, taskPeople_1.loadPersonRefs)([actor.employeeId]),
    ]);
    if (!permissions.canComment) {
        throw (0, taskErrors_1.taskForbidden)('COMMENT_FORBIDDEN', 'Diese Aufgabe dürfen Sie nicht kommentieren.');
    }
    const commentId = (0, nanoid_1.nanoid)(12);
    const files = await (0, attachmentService_1.storeNewAttachments)({ tenantId: actor.tenantId, kind: 'COMMENT', taskId, commentId, uploadedById: actor.employeeId }, prepared);
    const createdAt = new Date();
    try {
        await (0, taskDb_1.runTasksTransaction)(async (tx) => {
            // createMany schreibt nur und liest die Zeile nicht zurück — alles für die Antwort ist schon bekannt.
            await tx.taskComment.createMany({
                data: [{ id: commentId, tenantId: actor.tenantId, taskId, authorId: actor.employeeId, text: input.text, createdAt }],
            });
            if (files.length)
                await tx.taskAttachment.createMany({ data: files });
            await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, actor.employeeId, { taskId, type: taskConstants_1.ACTIVITY.COMMENT, meta: {} });
        });
    }
    catch (error) {
        await (0, taskFiles_1.removeStoredFiles)(files.map((file) => file.fileRef));
        throw error;
    }
    const actorName = people[actor.employeeId]?.name ?? '';
    (0, taskNotify_1.queueTaskNotification)({
        tenantId: actor.tenantId,
        type: taskConstants_1.NOTIFY.COMMENT,
        recipientIds: [...core.assigneeIds, core.createdById],
        actorId: actor.employeeId,
        title: 'Neuer Kommentar',
        message: `${actorName} hat «${core.title}» kommentiert.`,
        linkUrl: (0, taskConstants_1.taskLinkUrl)(taskId),
        params: { actor: actorName, title: core.title },
        meta: { taskId },
    });
    return {
        comment: toCommentDto(actor, { id: commentId, authorId: actor.employeeId, text: input.text, createdAt }, files.map(taskFiles_1.toAttachmentDto)),
        people,
    };
};
exports.addTaskComment = addTaskComment;
const deleteTaskComment = async (actor, commentId) => {
    const comment = await prisma_client_1.default.taskComment.findFirst({
        where: { id: commentId, tenantId: actor.tenantId },
        select: { id: true, taskId: true, authorId: true },
    });
    if (!comment)
        throw (0, taskErrors_1.taskNotFound)('COMMENT_NOT_FOUND', 'Kommentar nicht gefunden.');
    await (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, comment.taskId);
    if (!canDeleteComment(actor, comment.authorId)) {
        throw (0, taskErrors_1.taskForbidden)('COMMENT_DELETE_FORBIDDEN', 'Einen Kommentar dürfen nur die verfassende Person und die Leitung löschen.');
    }
    // Genau die Dateien, die die Kaskade gleich mitnimmt — die Ablage kennt keine Kaskade.
    const refs = await (0, taskFiles_1.collectAttachmentRefs)(prisma_client_1.default, { tenantId: actor.tenantId, commentId: comment.id });
    await prisma_client_1.default.taskComment.deleteMany({ where: { id: comment.id, tenantId: actor.tenantId } });
    await (0, taskFiles_1.removeStoredFiles)(refs);
};
exports.deleteTaskComment = deleteTaskComment;
//# sourceMappingURL=commentService.js.map