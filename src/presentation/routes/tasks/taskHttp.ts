import type { Request, RequestHandler, Response } from 'express';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { z, ZodError } from 'zod';

import { toPublicMessage } from '../../../application/errors/AuthErrors';
import { TaskError } from '../../../application/services/tasks/taskErrors';
import { TASK_LIMITS } from '../../../application/services/tasks/taskConstants';

/**
 * ── HTTP-HILFEN DES GÖREVLER-MODULS ─────────────────────────────────────────
 *
 * Jede Route des Moduls läuft durch `taskRoute`: ein geworfener TaskError wird
 * zu seinem Status + `{ error, code }`, ein Zod-Fehler zu 400 VALIDATION mit
 * Feldliste, ein Mehrfach-Schlüssel zu 409 — und alles andere zu einer
 * allgemeinen 500, deren Inneres nur im Serverprotokoll steht.
 */

const megabytes = (bytes: number): number => Math.round(bytes / (1024 * 1024));

export const sendTaskError = (res: Response, error: unknown, context: string): void => {
    if (res.headersSent) {
        console.error(`[${context}] Fehler nach gesendeter Antwort`, error);
        return;
    }
    if (error instanceof TaskError) {
        res.status(error.status).json({ ...(error.extra ?? {}), error: error.message, code: error.code });
        return;
    }
    if (error instanceof ZodError) {
        res.status(400).json({
            error: 'Ungültige Eingabe.',
            code: 'VALIDATION',
            details: error.issues.map((issue) => ({ field: issue.path.join('.') || '(root)', message: issue.message })),
        });
        return;
    }
    if (error instanceof multer.MulterError) {
        const tooLarge = error.code === 'LIMIT_FILE_SIZE';
        const tooMany = error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE';
        res.status(tooLarge ? 413 : 400).json({
            error: tooLarge
                ? `Eine Datei darf höchstens ${megabytes(TASK_LIMITS.fileBytesMax)} MB gross sein.`
                : tooMany ? 'Zu viele Dateien auf einmal.' : 'Die Dateien konnten nicht gelesen werden.',
            code: tooLarge ? 'FILE_TOO_LARGE' : tooMany ? 'TOO_MANY_FILES' : 'UPLOAD_INVALID',
        });
        return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        res.status(409).json({ error: 'Der Eintrag wurde gleichzeitig geändert. Bitte neu laden.', code: 'CONFLICT' });
        return;
    }
    res.status(500).json({ error: toPublicMessage(error, context), code: 'INTERNAL' });
};

/** Hülle für jeden Handler: Fehler → einheitliche Antwort. */
export const taskRoute = (
    context: string,
    handler: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler => async (req, res) => {
    try {
        await handler(req, res);
    } catch (error) {
        sendTaskError(res, error, context);
    }
};

/** Pfadparameter als getrimmter String. */
export const routeParam = (req: Request, name: string): string => String(req.params[name] ?? '').trim();

/** Zod-Schema anwenden; ein Fehler wird von `taskRoute` zu 400 VALIDATION. */
export const parseInput = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> =>
    schema.parse(value ?? {}) as z.infer<S>;

/* ── Uploads ────────────────────────────────────────────────────────────────
   Rohe Dateien (multipart, Feld `files`), im Speicher, UTF-8-Dateinamen
   (ohne `defParamCharset` wird «Übergabe.pdf» zu «Ãbergabe.pdf»). */

export const withTaskUpload = (maxFiles: number): RequestHandler => {
    const middleware = multer({
        storage: multer.memoryStorage(),
        defParamCharset: 'utf8',
        limits: { fileSize: TASK_LIMITS.fileBytesMax, files: maxFiles, fields: 20, fieldSize: 256 * 1024 },
    }).array('files', maxFiles);
    return (req, res, next) => {
        // Nur multipart-Körper gehen durch multer; JSON-Körper (ohne Dateien) bleiben unberührt.
        if (!req.is('multipart/form-data')) {
            next();
            return;
        }
        middleware(req, res, (error?: unknown) => {
            if (error) {
                sendTaskError(res, error, 'tasks.upload');
                return;
            }
            next();
        });
    };
};

export interface UploadedTaskFile {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}

export const uploadedFiles = (req: Request): UploadedTaskFile[] => {
    const files = (req as Request & { files?: unknown }).files;
    return Array.isArray(files) ? (files as UploadedTaskFile[]) : [];
};

/* ── Zod-Bausteine ──────────────────────────────────────────────────────── */

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Mehrzeiliger Klartext: Zeilenenden vereinheitlicht, Steuerzeichen weg, getrimmt, gekürzt. */
export const cleanText = (value: unknown, max: number): string =>
    String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim().slice(0, max);

/** Einzeiliger Klartext (Titel, Namen). */
export const cleanLine = (value: unknown, max: number): string =>
    String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(CONTROL_CHARS, '').replace(/\s{2,}/g, ' ').trim().slice(0, max);

export const zId = z.string().trim().min(1).max(64);

export const zIdList = (max: number = TASK_LIMITS.idsPerRequestMax) =>
    z.array(zId).max(max).transform((ids) => [...new Set(ids)]);

export const zLine = (max: number) => z.string().max(max * 4).transform((value) => cleanLine(value, max));

export const zRequiredLine = (max: number, message = 'Darf nicht leer sein.') =>
    zLine(max).refine((value) => value.length > 0, { message });

export const zText = (max: number) => z.string().max(max * 4).transform((value) => cleanText(value, max));

/** ISO-Zeitpunkt oder null → Date | null. */
export const zNullableDate = z.union([z.null(), z.string().trim().min(1).max(40)]).transform((value, ctx) => {
    if (value === null) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        ctx.addIssue({ code: 'custom', message: 'Ungültiges Datum.' });
        return z.NEVER;
    }
    return date;
});

/** Schalter aus der Abfragezeile: 1/true/yes → true. */
export const queryFlag = (value: unknown): boolean =>
    ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

/** Ganzzahl aus der Abfragezeile mit Grenzen. */
export const queryInt = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

/** Einzelner String aus der Abfragezeile (Arrays → erstes Element). */
export const queryString = (value: unknown, max = 200): string => {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
};
