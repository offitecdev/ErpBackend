import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import { storeNewAttachments } from './attachmentService';
import type { TasksActor } from './taskActor';
import { logTaskActivity } from './taskActivity';
import { ACTIVITY, NOTIFY, TASK_LIMITS, taskLinkUrl } from './taskConstants';
import { runTasksTransaction } from './taskDb';
import { taskBadRequest, taskForbidden, taskNotFound } from './taskErrors';
import {
    ATTACHMENT_SELECT,
    collectAttachmentRefs,
    prepareTaskFiles,
    removeStoredFiles,
    toAttachmentDto,
    type AttachmentDto,
    type IncomingTaskFile,
} from './taskFiles';
import { queueTaskNotification } from './taskNotify';
import { loadPersonRefs, type PersonRef } from './taskPeople';
import { requireVisibleTask } from './taskRows';

/**
 * ── KOMMENTARE (Reiter «Yorumlar») ──────────────────────────────────────────
 *
 * Görevly `tasks.addComment` / `removeComment`, serverseitig:
 *   • Kommentieren darf, wer die Aufgabe sieht — Klartext, Dateien oder beides.
 *   • Löschen darf, wer ihn geschrieben hat, oder die Leitung; beide nur,
 *     solange die Aufgabe für sie sichtbar ist. Die Dateien gehen mit.
 *   • Die Meldung geht an Verantwortliche und Anlegende, nie an sich selbst.
 * Kommentardateien sind TaskAttachment-Zeilen (kind COMMENT) mit taskId UND
 * commentId: das Löschen der Aufgabe wie des Kommentars nimmt sie mit.
 */

export interface CommentDto {
    id: string;
    authorId: string;
    /** Klartext, nie maskiert. */
    text: string;
    createdAt: Date;
    attachments: AttachmentDto[];
    canDelete: boolean;
}

export interface NewCommentInput {
    /** Bereits bereinigter Klartext; "" = nur Dateien. */
    text: string;
    files: readonly IncomingTaskFile[];
}

const canDeleteComment = (actor: TasksActor, authorId: string): boolean =>
    actor.isManager || authorId === actor.employeeId;

const toCommentDto = (
    actor: TasksActor,
    comment: { id: string; authorId: string; text: string; createdAt: Date },
    attachments: AttachmentDto[],
): CommentDto => ({
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
export const loadVisibleTaskComments = async (
    actor: TasksActor,
    taskId: string,
): Promise<{ data: CommentDto[]; personIds: Array<string | null> }> => {
    const [comments, files] = await Promise.all([
        prisma.taskComment.findMany({
            where: { tenantId: actor.tenantId, taskId },
            select: { id: true, authorId: true, text: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma.taskAttachment.findMany({
            where: { tenantId: actor.tenantId, taskId, kind: 'COMMENT' },
            select: ATTACHMENT_SELECT,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
    ]);

    const filesByComment = new Map<string, AttachmentDto[]>();
    for (const file of files) {
        if (!file.commentId) continue;
        const list = filesByComment.get(file.commentId) ?? [];
        list.push(toAttachmentDto(file));
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

export const listTaskComments = async (
    actor: TasksActor,
    taskId: string,
): Promise<{ data: CommentDto[]; people: Record<string, PersonRef> }> => {
    await requireVisibleTask(prisma, actor, taskId);
    const comments = await loadVisibleTaskComments(actor, taskId);
    return { data: comments.data, people: await loadPersonRefs(comments.personIds) };
};

export const addTaskComment = async (
    actor: TasksActor,
    taskId: string,
    input: NewCommentInput,
): Promise<{ comment: CommentDto; people: Record<string, PersonRef> }> => {
    const prepared = prepareTaskFiles(input.files, TASK_LIMITS.commentFilesMax);
    if (!input.text && !prepared.length) {
        throw taskBadRequest('COMMENT_EMPTY', 'Ein Kommentar braucht Text oder eine Datei.');
    }

    // Der eigene Name kommt gleich mit: er steht in der Antwort und in der Meldung.
    const [{ core, permissions }, people] = await Promise.all([
        requireVisibleTask(prisma, actor, taskId),
        loadPersonRefs([actor.employeeId]),
    ]);
    if (!permissions.canComment) {
        throw taskForbidden('COMMENT_FORBIDDEN', 'Diese Aufgabe dürfen Sie nicht kommentieren.');
    }

    const commentId = nanoid(12);
    const files = await storeNewAttachments(
        { tenantId: actor.tenantId, kind: 'COMMENT', taskId, commentId, uploadedById: actor.employeeId },
        prepared,
    );
    const createdAt = new Date();
    try {
        await runTasksTransaction(async (tx) => {
            // createMany schreibt nur und liest die Zeile nicht zurück — alles für die Antwort ist schon bekannt.
            await tx.taskComment.createMany({
                data: [{ id: commentId, tenantId: actor.tenantId, taskId, authorId: actor.employeeId, text: input.text, createdAt }],
            });
            if (files.length) await tx.taskAttachment.createMany({ data: files });
            await logTaskActivity(tx, actor.tenantId, actor.employeeId, { taskId, type: ACTIVITY.COMMENT, meta: {} });
        });
    } catch (error) {
        await removeStoredFiles(files.map((file) => file.fileRef));
        throw error;
    }

    const actorName = people[actor.employeeId]?.name ?? '';
    queueTaskNotification({
        tenantId: actor.tenantId,
        type: NOTIFY.COMMENT,
        recipientIds: [...core.assigneeIds, core.createdById],
        actorId: actor.employeeId,
        title: 'Neuer Kommentar',
        message: `${actorName} hat «${core.title}» kommentiert.`,
        linkUrl: taskLinkUrl(taskId),
        params: { actor: actorName, title: core.title },
        meta: { taskId },
    });

    return {
        comment: toCommentDto(
            actor,
            { id: commentId, authorId: actor.employeeId, text: input.text, createdAt },
            files.map(toAttachmentDto),
        ),
        people,
    };
};

export const deleteTaskComment = async (actor: TasksActor, commentId: string): Promise<void> => {
    const comment = await prisma.taskComment.findFirst({
        where: { id: commentId, tenantId: actor.tenantId },
        select: { id: true, taskId: true, authorId: true },
    });
    if (!comment) throw taskNotFound('COMMENT_NOT_FOUND', 'Kommentar nicht gefunden.');
    await requireVisibleTask(prisma, actor, comment.taskId);
    if (!canDeleteComment(actor, comment.authorId)) {
        throw taskForbidden('COMMENT_DELETE_FORBIDDEN', 'Einen Kommentar dürfen nur die verfassende Person und die Leitung löschen.');
    }

    // Genau die Dateien, die die Kaskade gleich mitnimmt — die Ablage kennt keine Kaskade.
    const refs = await collectAttachmentRefs(prisma, { tenantId: actor.tenantId, commentId: comment.id });
    await prisma.taskComment.deleteMany({ where: { id: comment.id, tenantId: actor.tenantId } });
    await removeStoredFiles(refs);
};
