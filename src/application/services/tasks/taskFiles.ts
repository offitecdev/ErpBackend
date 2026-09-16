import { Prisma } from '@prisma/client';

import { taskAttachmentStorage } from '../../../infrastructure/services/tasks/taskAttachmentStorage';
import type { TasksDb } from './taskDb';
import { TASK_LIMITS, type AttachmentKind } from './taskConstants';
import { TaskError, taskBadRequest } from './taskErrors';

/**
 * ── DATEIEN DES GÖREVLER-MODULS ─────────────────────────────────────────────
 *
 * Eingang: rohe Dateien (multipart). Geprüft wird die Art — nach dem, was der
 * Browser angibt, notfalls nach der Endung — UND der Anfang der Bytes: ein
 * «PDF», das nicht mit %PDF- beginnt, kommt nicht in die Ablage.
 * Die Bytes liegen in `taskAttachmentStorage` (R2 oder Platte), die Zeile
 * `TaskAttachment` hält nur den Verweis.
 *
 * Aufräumen: Datenbankzeilen verschwinden per Kaskade — die Ablage kennt keine
 * Kaskade. Wer eine Aufgabe, einen Kommentar, eine Nachricht oder einen Raum
 * löscht, sammelt VORHER die Verweise (`collectAttachmentRefs`) und entfernt
 * sie NACH dem Löschen (`removeStoredFiles`).
 */

/** Was multer liefert (strukturell, damit diese Schicht Express nicht kennt). */
export interface IncomingTaskFile {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}

export interface PreparedTaskFile {
    fileName: string;
    contentType: string;
    sizeBytes: number;
    body: Buffer;
}

const TYPE_BY_EXTENSION: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    heic: 'image/heic',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    txt: 'text/plain',
    csv: 'text/csv',
    zip: 'application/zip',
};

const TYPE_ALIASES: Record<string, string> = {
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'application/x-zip-compressed': 'application/zip',
    'application/x-pdf': 'application/pdf',
    'application/csv': 'text/csv',
    'text/comma-separated-values': 'text/csv',
};

const startsWith = (body: Buffer, bytes: number[], offset = 0): boolean =>
    body.length >= offset + bytes.length && bytes.every((byte, index) => body[offset + index] === byte);

const ascii = (body: Buffer, start: number, end: number): string => body.subarray(start, end).toString('latin1');

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Passt der Anfang der Bytes zur angegebenen Art? */
const bytesMatchType = (contentType: string, body: Buffer): boolean => {
    switch (contentType) {
        case 'application/pdf': return ascii(body, 0, 5) === '%PDF-';
        case 'image/png': return startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        case 'image/jpeg': return startsWith(body, [0xff, 0xd8, 0xff]);
        case 'image/gif': return ['GIF87a', 'GIF89a'].includes(ascii(body, 0, 6));
        case 'image/webp': return ascii(body, 0, 4) === 'RIFF' && ascii(body, 8, 12) === 'WEBP';
        case 'image/heic': return ascii(body, 4, 8) === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(ascii(body, 8, 12));
        case 'application/zip':
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        case 'application/vnd.oasis.opendocument.text':
        case 'application/vnd.oasis.opendocument.spreadsheet':
            return startsWith(body, ZIP) || startsWith(body, ZIP_EMPTY);
        case 'application/msword':
        case 'application/vnd.ms-excel':
        case 'application/vnd.ms-powerpoint':
            return startsWith(body, OLE2);
        case 'text/plain':
        case 'text/csv':
            return !body.subarray(0, 8192).includes(0);
        default:
            return false;
    }
};

const extensionOf = (fileName: string): string => {
    const match = /\.([a-z0-9]{1,8})$/i.exec(fileName);
    return (match?.[1] ?? '').toLowerCase();
};

const cleanFileName = (value: unknown): string =>
    String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/]/g, '_')
        .trim()
        .slice(0, 180) || 'datei';

/** Art einer Datei bestimmen: Angabe des Browsers, sonst Endung. */
const resolveContentType = (file: IncomingTaskFile, fileName: string): string | null => {
    const declared = String(file.mimetype ?? '').trim().toLowerCase().split(';')[0] ?? '';
    const normalized = TYPE_ALIASES[declared] ?? declared;
    if (normalized && taskAttachmentStorage.accepts(normalized)) return normalized;
    const byExtension = TYPE_BY_EXTENSION[extensionOf(fileName)];
    return byExtension && taskAttachmentStorage.accepts(byExtension) ? byExtension : null;
};

/** Prüft und bereitet Dateien vor; wirft 400/413/415 mit festem Code. */
export const prepareTaskFiles = (files: readonly IncomingTaskFile[], maxFiles: number): PreparedTaskFile[] => {
    if (files.length > maxFiles) {
        throw taskBadRequest('TOO_MANY_FILES', `Höchstens ${maxFiles} Dateien auf einmal.`);
    }
    return files.map((file) => {
        const fileName = cleanFileName(file.originalname);
        const body = file.buffer;
        if (!body || !body.length) throw taskBadRequest('FILE_EMPTY', `Die Datei «${fileName}» ist leer.`);
        if (body.length > TASK_LIMITS.fileBytesMax) {
            throw new TaskError(413, 'FILE_TOO_LARGE', `Die Datei «${fileName}» ist grösser als ${Math.round(TASK_LIMITS.fileBytesMax / (1024 * 1024))} MB.`);
        }
        const contentType = resolveContentType(file, fileName);
        if (!contentType) {
            throw new TaskError(415, 'FILE_TYPE_NOT_ALLOWED', `Die Dateiart von «${fileName}» ist nicht erlaubt (Bilder, PDF, Office, TXT, CSV, ZIP).`);
        }
        if (!bytesMatchType(contentType, body)) {
            throw new TaskError(415, 'FILE_TYPE_MISMATCH', `Der Inhalt von «${fileName}» passt nicht zu seiner Dateiart.`);
        }
        return { fileName, contentType, sizeBytes: body.length, body };
    });
};

/**
 * Legt vorbereitete Dateien in die Ablage. Scheitert eine, werden die schon
 * abgelegten wieder entfernt — es bleiben keine Waisen.
 */
export const storeTaskFiles = async (tenantId: string, files: readonly PreparedTaskFile[]): Promise<string[]> => {
    const refs: string[] = [];
    try {
        for (const file of files) {
            refs.push(await taskAttachmentStorage.store(tenantId, file.body, file.contentType));
        }
        return refs;
    } catch (error) {
        await removeStoredFiles(refs);
        throw error;
    }
};

/** Entfernt Verweise aus der Ablage; fehlende Dateien sind kein Fehler. */
export const removeStoredFiles = async (refs: Iterable<string>): Promise<void> => {
    await Promise.all([...new Set(refs)].filter(Boolean).map((ref) =>
        taskAttachmentStorage.remove(ref).catch((error) => {
            console.warn('[tasks.files] Datei konnte nicht entfernt werden', ref, error);
        })));
};

/** Die Bytes einer Datei (für den Auslieferungsweg und das Duplizieren). */
export const readStoredFile = (ref: string): Promise<Buffer> => taskAttachmentStorage.read(ref);

/** Verweise aller Dateien, die eine Löschung per Kaskade mitnimmt. */
export const collectAttachmentRefs = async (db: TasksDb, where: Prisma.TaskAttachmentWhereInput): Promise<string[]> =>
    (await db.taskAttachment.findMany({ where, select: { fileRef: true } })).map((row) => row.fileRef);

export const ATTACHMENT_SELECT = {
    id: true,
    kind: true,
    taskId: true,
    commentId: true,
    roomId: true,
    messageId: true,
    issueMessageId: true,
    fileName: true,
    contentType: true,
    sizeBytes: true,
    uploadedById: true,
    createdAt: true,
    fileRef: true,
} satisfies Prisma.TaskAttachmentSelect;

export interface AttachmentDto {
    id: string;
    kind: AttachmentKind;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    isImage: boolean;
    isPdf: boolean;
    uploadedById: string | null;
    createdAt: Date;
    /** API-Pfad ohne Präfix: `/tasks/attachments/<id>/content`. */
    contentPath: string;
    /**
     * Bilder und PDFs in R2: die Adresse direkt bei Cloudflare
     * (`assets…/tasks-file/…`) — der Browser lädt sie ohne Umweg über den
     * Server. null = Datei liegt (noch) auf der Platte oder ist ein anderes
     * Format; dann gilt `contentPath`.
     */
    url: string | null;
}

export const attachmentContentPath = (id: string): string => `/tasks/attachments/${id}/content`;

export const toAttachmentDto = (row: {
    id: string;
    kind: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    uploadedById: string | null;
    createdAt: Date;
    fileRef?: string | null;
}): AttachmentDto => ({
    id: row.id,
    kind: row.kind as AttachmentKind,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    isImage: row.contentType.startsWith('image/'),
    isPdf: row.contentType === 'application/pdf',
    uploadedById: row.uploadedById,
    createdAt: row.createdAt,
    contentPath: attachmentContentPath(row.id),
    url: row.fileRef ? attachmentPublicUrlFor(row.contentType, row.fileRef) : null,
});

/** Cloudflare-Adresse eines Bildes/PDFs in R2; null für Plattendateien und andere Formate. */
export const attachmentPublicUrlFor = (contentType: string, fileRef: string): string | null =>
    isInlineContentType(contentType) ? taskAttachmentStorage.publicReadUrl(fileRef) : null;

/** Darf der Browser die Datei direkt anzeigen (sonst Download)? */
export const isInlineContentType = (contentType: string): boolean =>
    contentType === 'application/pdf' || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType);

/** `Content-Disposition` mit UTF-8-Dateinamen (RFC 5987) und ASCII-Rückfall. */
export const contentDisposition = (fileName: string, inline: boolean): string => {
    const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};
