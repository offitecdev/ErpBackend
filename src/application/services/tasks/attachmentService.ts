import type { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import type { TasksActor } from './taskActor';
import { logTaskActivity } from './taskActivity';
import { ACTIVITY, TASK_LIMITS } from './taskConstants';
import { runTasksTransaction, type TasksDb } from './taskDb';
import { TaskError, taskBadRequest, taskForbidden, taskNotFound } from './taskErrors';
import {
    attachmentPublicUrlFor,
    prepareTaskFiles,
    readStoredFile,
    removeStoredFiles,
    storeTaskFiles,
    toAttachmentDto,
    type AttachmentDto,
    type IncomingTaskFile,
    type PreparedTaskFile,
} from './taskFiles';
import { loadTaskAttachments } from './taskParts';
import { lockTaskRow, requireVisibleTask, type VisibleTask } from './taskRows';

/**
 * ── DATEIEN: Reiter «Dosyalar» und der Auslieferungsweg ─────────────────────
 *
 * Görevly `attachments.js`, serverseitig und mit Rechten:
 *   hochladen   Leitung ODER wer an der Aufgabe messen darf (canUpload);
 *               alle Dateien des Reiters zusammen höchstens `taskFilesBytesMax`
 *   öffnen      NUR über GET /attachments/:id/content — Aufgaben- und
 *               Kommentardateien: wer die Aufgabe sieht; Chatdateien: nur
 *               Mitglieder des Raums (die Leitung hat im Chat keinen Vorrang)
 *   entfernen   wer sie öffnen darf, und dazu — Aufgabendatei: canUpload ·
 *               Kommentar- und Chatdatei: wer sie hochgeladen hat oder die Leitung
 *
 * Ein Bild- oder Dateiblock im Inhalt, dessen Datei entfernt wurde, bleibt
 * stehen: das nächste Speichern des Inhalts wirft den toten Verweis hinaus.
 */

const megabytes = (bytes: number): number => Math.round(bytes / (1024 * 1024));

/* ── Neue Dateien (Aufgabe und Kommentar) ───────────────────────────────── */

/** Eine abgelegte, noch nicht geschriebene Datei — Datenbankzeile und Quelle des DTO zugleich. */
export interface NewAttachmentRow {
    id: string;
    tenantId: string;
    kind: 'TASK' | 'COMMENT';
    taskId: string;
    commentId: string | null;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    fileRef: string;
    uploadedById: string;
    createdAt: Date;
}

export type AttachmentOwner = Pick<NewAttachmentRow, 'tenantId' | 'kind' | 'taskId' | 'commentId' | 'uploadedById'>;

/**
 * Legt die Dateien in die Ablage und baut ihre Zeilen. Scheitert danach das
 * Schreiben, muss der Aufrufer die Ablage über `fileRef` wieder räumen.
 */
export const storeNewAttachments = async (
    owner: AttachmentOwner,
    files: readonly PreparedTaskFile[],
): Promise<NewAttachmentRow[]> => {
    const refs = await storeTaskFiles(owner.tenantId, files);
    const createdMs = Date.now();
    return files.map((file, index) => ({
        ...owner,
        id: nanoid(12),
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        // storeTaskFiles liefert genau einen Verweis je Datei, in derselben Reihenfolge.
        fileRef: refs[index] as string,
        // Die Listen sortieren nach createdAt: +1 ms je Datei hält die Reihenfolge der Auswahl.
        createdAt: new Date(createdMs + index),
    }));
};

/* ── Reiter «Dosyalar» ──────────────────────────────────────────────────── */

export const listTaskAttachments = async (actor: TasksActor, taskId: string): Promise<{ data: AttachmentDto[] }> => {
    await requireVisibleTask(prisma, actor, taskId);
    return { data: await loadTaskAttachments(prisma, actor.tenantId, taskId) };
};

/** 413, wenn die Dateien des Reiters mit `addedBytes` die Grenze der Aufgabe überschreiten. */
const assertTaskFilesBudget = async (db: TasksDb, tenantId: string, taskId: string, addedBytes: number): Promise<void> => {
    const usage = await db.taskAttachment.aggregate({
        where: { tenantId, taskId, kind: 'TASK' },
        _sum: { sizeBytes: true },
    });
    const usedBytes = usage._sum.sizeBytes ?? 0;
    if (usedBytes + addedBytes > TASK_LIMITS.taskFilesBytesMax) {
        throw new TaskError(
            413,
            'TASK_FILES_LIMIT',
            `Die Dateien einer Aufgabe dürfen zusammen höchstens ${megabytes(TASK_LIMITS.taskFilesBytesMax)} MB gross sein.`,
            { usedBytes, maxBytes: TASK_LIMITS.taskFilesBytesMax },
        );
    }
};

export const uploadTaskAttachments = async (
    actor: TasksActor,
    taskId: string,
    files: readonly IncomingTaskFile[],
): Promise<{ data: AttachmentDto[] }> => {
    const prepared = prepareTaskFiles(files, TASK_LIMITS.filesPerUpload);
    if (!prepared.length) throw taskBadRequest('NO_FILES', 'Es wurde keine Datei übergeben.');

    const { permissions } = await requireVisibleTask(prisma, actor, taskId);
    if (!permissions.canUpload) {
        throw taskForbidden('UPLOAD_FORBIDDEN', 'Dateien hinzufügen dürfen nur die Leitung und die Verantwortlichen einer offenen Aufgabe.');
    }

    const addedBytes = prepared.reduce((sum, file) => sum + file.sizeBytes, 0);
    // Vorab prüfen: was ohnehin abgewiesen würde, geht gar nicht erst in die Ablage.
    await assertTaskFilesBudget(prisma, actor.tenantId, taskId, addedBytes);

    const rows = await storeNewAttachments(
        { tenantId: actor.tenantId, kind: 'TASK', taskId, commentId: null, uploadedById: actor.employeeId },
        prepared,
    );
    try {
        await runTasksTransaction(async (tx) => {
            if (!(await lockTaskRow(tx, actor.tenantId, taskId))) throw taskNotFound();
            // Verbindlich erst unter der Sperre: zwei gleichzeitige Uploads dürfen die Grenze nicht gemeinsam sprengen.
            await assertTaskFilesBudget(tx, actor.tenantId, taskId, addedBytes);
            await tx.taskAttachment.createMany({ data: rows });
            await logTaskActivity(tx, actor.tenantId, actor.employeeId, {
                taskId,
                type: ACTIVITY.ATTACHMENT,
                meta: { count: rows.length },
            });
        });
    } catch (error) {
        await removeStoredFiles(rows.map((row) => row.fileRef));
        throw error;
    }
    return { data: rows.map(toAttachmentDto) };
};

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
} satisfies Prisma.TaskAttachmentSelect;

type AttachmentAccessRow = Prisma.TaskAttachmentGetPayload<{ select: typeof ATTACHMENT_ACCESS_SELECT }>;

const attachmentNotFound = (): TaskError => taskNotFound('ATTACHMENT_NOT_FOUND', 'Datei nicht gefunden.');

const loadAttachment = async (actor: TasksActor, attachmentId: string): Promise<AttachmentAccessRow> => {
    const row = await prisma.taskAttachment.findFirst({
        where: { id: attachmentId, tenantId: actor.tenantId },
        select: ATTACHMENT_ACCESS_SELECT,
    });
    if (!row) throw attachmentNotFound();
    return row;
};

/**
 * Darf die Person die Datei überhaupt erreichen? Chatdateien: nur als Mitglied
 * des Raums (kein Vorrang der Leitung, Görevly). Aufgaben- und Kommentardateien:
 * die Aufgabe muss für sie sichtbar sein — sie kommt samt Rechten zurück.
 */
const requireAttachmentAccess = async (actor: TasksActor, row: AttachmentAccessRow): Promise<VisibleTask | null> => {
    if (row.kind === 'CHAT') {
        const member = row.roomId
            ? await prisma.taskChatMember.findFirst({
                where: { tenantId: actor.tenantId, roomId: row.roomId, employeeId: actor.employeeId },
                select: { id: true },
            })
            : null;
        if (!member) throw taskForbidden('ROOM_FORBIDDEN', 'Sie sind nicht Mitglied dieses Chat-Raums.');
        return null;
    }
    if (!row.taskId) throw attachmentNotFound();
    return requireVisibleTask(prisma, actor, row.taskId);
};

/** Fehlt die Datei in der Ablage? Platte: ENOENT · R2: NoSuchKey bzw. HTTP 404. */
const isMissingStoredFile = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const { code, name, $metadata } = error as { code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: unknown } };
    return code === 'ENOENT' || name === 'NoSuchKey' || name === 'NotFound' || $metadata?.httpStatusCode === 404;
};

export interface AttachmentContent {
    fileName: string;
    contentType: string;
    body: Buffer;
}

export const readAttachmentContent = async (actor: TasksActor, attachmentId: string): Promise<AttachmentContent> => {
    const row = await loadAttachment(actor, attachmentId);
    await requireAttachmentAccess(actor, row);
    const body = await readStoredFile(row.fileRef).catch((error: unknown) => {
        throw isMissingStoredFile(error) ? taskNotFound('FILE_MISSING', 'Die Datei fehlt in der Ablage.') : error;
    });
    return { fileName: row.fileName, contentType: row.contentType, body };
};

/** Cloudflare-Adresse eines Bildes/PDFs in R2 (nach Berechtigungsprüfung), sonst null. */
export const attachmentPublicUrl = async (actor: TasksActor, attachmentId: string): Promise<string | null> => {
    const row = await loadAttachment(actor, attachmentId);
    await requireAttachmentAccess(actor, row);
    return attachmentPublicUrlFor(row.contentType, row.fileRef);
};

export const deleteAttachment = async (actor: TasksActor, attachmentId: string): Promise<void> => {
    const row = await loadAttachment(actor, attachmentId);
    const task = await requireAttachmentAccess(actor, row);
    // Aufgabendateien gehören der Aufgabe: wer hochladen darf, darf entfernen.
    // Kommentar- und Chatdateien gehören der Person, die sie hochgeladen hat — und der Leitung.
    const allowed = row.kind === 'TASK'
        ? task?.permissions.canUpload === true
        : row.uploadedById === actor.employeeId || actor.isManager;
    if (!allowed) throw taskForbidden('ATTACHMENT_DELETE_FORBIDDEN', 'Diese Datei dürfen Sie nicht entfernen.');

    await prisma.taskAttachment.deleteMany({ where: { id: row.id, tenantId: actor.tenantId } });
    await removeStoredFiles([row.fileRef]);
};
