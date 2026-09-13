"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queryString = exports.queryInt = exports.queryFlag = exports.zNullableDate = exports.zText = exports.zRequiredLine = exports.zLine = exports.zIdList = exports.zId = exports.cleanLine = exports.cleanText = exports.uploadedFiles = exports.withTaskUpload = exports.parseInput = exports.routeParam = exports.taskRoute = exports.sendTaskError = void 0;
const client_1 = require("@prisma/client");
const multer_1 = __importDefault(require("multer"));
const zod_1 = require("zod");
const AuthErrors_1 = require("../../../application/errors/AuthErrors");
const taskErrors_1 = require("../../../application/services/tasks/taskErrors");
const taskConstants_1 = require("../../../application/services/tasks/taskConstants");
/**
 * ── HTTP-HILFEN DES GÖREVLER-MODULS ─────────────────────────────────────────
 *
 * Jede Route des Moduls läuft durch `taskRoute`: ein geworfener TaskError wird
 * zu seinem Status + `{ error, code }`, ein Zod-Fehler zu 400 VALIDATION mit
 * Feldliste, ein Mehrfach-Schlüssel zu 409 — und alles andere zu einer
 * allgemeinen 500, deren Inneres nur im Serverprotokoll steht.
 */
const megabytes = (bytes) => Math.round(bytes / (1024 * 1024));
const sendTaskError = (res, error, context) => {
    if (res.headersSent) {
        console.error(`[${context}] Fehler nach gesendeter Antwort`, error);
        return;
    }
    if (error instanceof taskErrors_1.TaskError) {
        res.status(error.status).json({ ...(error.extra ?? {}), error: error.message, code: error.code });
        return;
    }
    if (error instanceof zod_1.ZodError) {
        res.status(400).json({
            error: 'Ungültige Eingabe.',
            code: 'VALIDATION',
            details: error.issues.map((issue) => ({ field: issue.path.join('.') || '(root)', message: issue.message })),
        });
        return;
    }
    if (error instanceof multer_1.default.MulterError) {
        const tooLarge = error.code === 'LIMIT_FILE_SIZE';
        const tooMany = error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE';
        res.status(tooLarge ? 413 : 400).json({
            error: tooLarge
                ? `Eine Datei darf höchstens ${megabytes(taskConstants_1.TASK_LIMITS.fileBytesMax)} MB gross sein.`
                : tooMany ? 'Zu viele Dateien auf einmal.' : 'Die Dateien konnten nicht gelesen werden.',
            code: tooLarge ? 'FILE_TOO_LARGE' : tooMany ? 'TOO_MANY_FILES' : 'UPLOAD_INVALID',
        });
        return;
    }
    if (error instanceof client_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        res.status(409).json({ error: 'Der Eintrag wurde gleichzeitig geändert. Bitte neu laden.', code: 'CONFLICT' });
        return;
    }
    res.status(500).json({ error: (0, AuthErrors_1.toPublicMessage)(error, context), code: 'INTERNAL' });
};
exports.sendTaskError = sendTaskError;
/** Hülle für jeden Handler: Fehler → einheitliche Antwort. */
const taskRoute = (context, handler) => async (req, res) => {
    try {
        await handler(req, res);
    }
    catch (error) {
        (0, exports.sendTaskError)(res, error, context);
    }
};
exports.taskRoute = taskRoute;
/** Pfadparameter als getrimmter String. */
const routeParam = (req, name) => String(req.params[name] ?? '').trim();
exports.routeParam = routeParam;
/** Zod-Schema anwenden; ein Fehler wird von `taskRoute` zu 400 VALIDATION. */
const parseInput = (schema, value) => schema.parse(value ?? {});
exports.parseInput = parseInput;
/* ── Uploads ────────────────────────────────────────────────────────────────
   Rohe Dateien (multipart, Feld `files`), im Speicher, UTF-8-Dateinamen
   (ohne `defParamCharset` wird «Übergabe.pdf» zu «Ãbergabe.pdf»). */
const withTaskUpload = (maxFiles) => {
    const middleware = (0, multer_1.default)({
        storage: multer_1.default.memoryStorage(),
        defParamCharset: 'utf8',
        limits: { fileSize: taskConstants_1.TASK_LIMITS.fileBytesMax, files: maxFiles, fields: 20, fieldSize: 256 * 1024 },
    }).array('files', maxFiles);
    return (req, res, next) => {
        // Nur multipart-Körper gehen durch multer; JSON-Körper (ohne Dateien) bleiben unberührt.
        if (!req.is('multipart/form-data')) {
            next();
            return;
        }
        middleware(req, res, (error) => {
            if (error) {
                (0, exports.sendTaskError)(res, error, 'tasks.upload');
                return;
            }
            next();
        });
    };
};
exports.withTaskUpload = withTaskUpload;
const uploadedFiles = (req) => {
    const files = req.files;
    return Array.isArray(files) ? files : [];
};
exports.uploadedFiles = uploadedFiles;
/* ── Zod-Bausteine ──────────────────────────────────────────────────────── */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** Mehrzeiliger Klartext: Zeilenenden vereinheitlicht, Steuerzeichen weg, getrimmt, gekürzt. */
const cleanText = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim().slice(0, max);
exports.cleanText = cleanText;
/** Einzeiliger Klartext (Titel, Namen). */
const cleanLine = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(CONTROL_CHARS, '').replace(/\s{2,}/g, ' ').trim().slice(0, max);
exports.cleanLine = cleanLine;
exports.zId = zod_1.z.string().trim().min(1).max(64);
const zIdList = (max = taskConstants_1.TASK_LIMITS.idsPerRequestMax) => zod_1.z.array(exports.zId).max(max).transform((ids) => [...new Set(ids)]);
exports.zIdList = zIdList;
const zLine = (max) => zod_1.z.string().max(max * 4).transform((value) => (0, exports.cleanLine)(value, max));
exports.zLine = zLine;
const zRequiredLine = (max, message = 'Darf nicht leer sein.') => (0, exports.zLine)(max).refine((value) => value.length > 0, { message });
exports.zRequiredLine = zRequiredLine;
const zText = (max) => zod_1.z.string().max(max * 4).transform((value) => (0, exports.cleanText)(value, max));
exports.zText = zText;
/** ISO-Zeitpunkt oder null → Date | null. */
exports.zNullableDate = zod_1.z.union([zod_1.z.null(), zod_1.z.string().trim().min(1).max(40)]).transform((value, ctx) => {
    if (value === null)
        return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        ctx.addIssue({ code: 'custom', message: 'Ungültiges Datum.' });
        return zod_1.z.NEVER;
    }
    return date;
});
/** Schalter aus der Abfragezeile: 1/true/yes → true. */
const queryFlag = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
exports.queryFlag = queryFlag;
/** Ganzzahl aus der Abfragezeile mit Grenzen. */
const queryInt = (value, fallback, min, max) => {
    const parsed = parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
};
exports.queryInt = queryInt;
/** Einzelner String aus der Abfragezeile (Arrays → erstes Element). */
const queryString = (value, max = 200) => {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
};
exports.queryString = queryString;
//# sourceMappingURL=taskHttp.js.map