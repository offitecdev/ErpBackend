"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contentDisposition = exports.isInlineContentType = exports.attachmentPublicUrlFor = exports.toAttachmentDto = exports.attachmentContentPath = exports.ATTACHMENT_SELECT = exports.collectAttachmentRefs = exports.readStoredFile = exports.removeStoredFiles = exports.storeTaskFiles = exports.prepareTaskFiles = void 0;
const taskAttachmentStorage_1 = require("../../../infrastructure/services/tasks/taskAttachmentStorage");
const taskConstants_1 = require("./taskConstants");
const taskErrors_1 = require("./taskErrors");
const TYPE_BY_EXTENSION = {
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
const TYPE_ALIASES = {
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'application/x-zip-compressed': 'application/zip',
    'application/x-pdf': 'application/pdf',
    'application/csv': 'text/csv',
    'text/comma-separated-values': 'text/csv',
};
const startsWith = (body, bytes, offset = 0) => body.length >= offset + bytes.length && bytes.every((byte, index) => body[offset + index] === byte);
const ascii = (body, start, end) => body.subarray(start, end).toString('latin1');
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** Passt der Anfang der Bytes zur angegebenen Art? */
const bytesMatchType = (contentType, body) => {
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
const extensionOf = (fileName) => {
    const match = /\.([a-z0-9]{1,8})$/i.exec(fileName);
    return (match?.[1] ?? '').toLowerCase();
};
const cleanFileName = (value) => String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 180) || 'datei';
/** Art einer Datei bestimmen: Angabe des Browsers, sonst Endung. */
const resolveContentType = (file, fileName) => {
    const declared = String(file.mimetype ?? '').trim().toLowerCase().split(';')[0] ?? '';
    const normalized = TYPE_ALIASES[declared] ?? declared;
    if (normalized && taskAttachmentStorage_1.taskAttachmentStorage.accepts(normalized))
        return normalized;
    const byExtension = TYPE_BY_EXTENSION[extensionOf(fileName)];
    return byExtension && taskAttachmentStorage_1.taskAttachmentStorage.accepts(byExtension) ? byExtension : null;
};
/** Prüft und bereitet Dateien vor; wirft 400/413/415 mit festem Code. */
const prepareTaskFiles = (files, maxFiles) => {
    if (files.length > maxFiles) {
        throw (0, taskErrors_1.taskBadRequest)('TOO_MANY_FILES', `Höchstens ${maxFiles} Dateien auf einmal.`);
    }
    return files.map((file) => {
        const fileName = cleanFileName(file.originalname);
        const body = file.buffer;
        if (!body || !body.length)
            throw (0, taskErrors_1.taskBadRequest)('FILE_EMPTY', `Die Datei «${fileName}» ist leer.`);
        if (body.length > taskConstants_1.TASK_LIMITS.fileBytesMax) {
            throw new taskErrors_1.TaskError(413, 'FILE_TOO_LARGE', `Die Datei «${fileName}» ist grösser als ${Math.round(taskConstants_1.TASK_LIMITS.fileBytesMax / (1024 * 1024))} MB.`);
        }
        const contentType = resolveContentType(file, fileName);
        if (!contentType) {
            throw new taskErrors_1.TaskError(415, 'FILE_TYPE_NOT_ALLOWED', `Die Dateiart von «${fileName}» ist nicht erlaubt (Bilder, PDF, Office, TXT, CSV, ZIP).`);
        }
        if (!bytesMatchType(contentType, body)) {
            throw new taskErrors_1.TaskError(415, 'FILE_TYPE_MISMATCH', `Der Inhalt von «${fileName}» passt nicht zu seiner Dateiart.`);
        }
        return { fileName, contentType, sizeBytes: body.length, body };
    });
};
exports.prepareTaskFiles = prepareTaskFiles;
/**
 * Legt vorbereitete Dateien in die Ablage. Scheitert eine, werden die schon
 * abgelegten wieder entfernt — es bleiben keine Waisen.
 */
const storeTaskFiles = async (tenantId, files) => {
    const refs = [];
    try {
        for (const file of files) {
            refs.push(await taskAttachmentStorage_1.taskAttachmentStorage.store(tenantId, file.body, file.contentType));
        }
        return refs;
    }
    catch (error) {
        await (0, exports.removeStoredFiles)(refs);
        throw error;
    }
};
exports.storeTaskFiles = storeTaskFiles;
/** Entfernt Verweise aus der Ablage; fehlende Dateien sind kein Fehler. */
const removeStoredFiles = async (refs) => {
    await Promise.all([...new Set(refs)].filter(Boolean).map((ref) => taskAttachmentStorage_1.taskAttachmentStorage.remove(ref).catch((error) => {
        console.warn('[tasks.files] Datei konnte nicht entfernt werden', ref, error);
    })));
};
exports.removeStoredFiles = removeStoredFiles;
/** Die Bytes einer Datei (für den Auslieferungsweg und das Duplizieren). */
const readStoredFile = (ref) => taskAttachmentStorage_1.taskAttachmentStorage.read(ref);
exports.readStoredFile = readStoredFile;
/** Verweise aller Dateien, die eine Löschung per Kaskade mitnimmt. */
const collectAttachmentRefs = async (db, where) => (await db.taskAttachment.findMany({ where, select: { fileRef: true } })).map((row) => row.fileRef);
exports.collectAttachmentRefs = collectAttachmentRefs;
exports.ATTACHMENT_SELECT = {
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
};
const attachmentContentPath = (id) => `/tasks/attachments/${id}/content`;
exports.attachmentContentPath = attachmentContentPath;
const toAttachmentDto = (row) => ({
    id: row.id,
    kind: row.kind,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    isImage: row.contentType.startsWith('image/'),
    isPdf: row.contentType === 'application/pdf',
    uploadedById: row.uploadedById,
    createdAt: row.createdAt,
    contentPath: (0, exports.attachmentContentPath)(row.id),
    url: row.fileRef ? (0, exports.attachmentPublicUrlFor)(row.contentType, row.fileRef) : null,
});
exports.toAttachmentDto = toAttachmentDto;
/** Cloudflare-Adresse eines Bildes/PDFs in R2; null für Plattendateien und andere Formate. */
const attachmentPublicUrlFor = (contentType, fileRef) => (0, exports.isInlineContentType)(contentType) ? taskAttachmentStorage_1.taskAttachmentStorage.publicReadUrl(fileRef) : null;
exports.attachmentPublicUrlFor = attachmentPublicUrlFor;
/** Darf der Browser die Datei direkt anzeigen (sonst Download)? */
const isInlineContentType = (contentType) => contentType === 'application/pdf' || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType);
exports.isInlineContentType = isInlineContentType;
/** `Content-Disposition` mit UTF-8-Dateinamen (RFC 5987) und ASCII-Rückfall. */
const contentDisposition = (fileName, inline) => {
    const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
};
exports.contentDisposition = contentDisposition;
//# sourceMappingURL=taskFiles.js.map