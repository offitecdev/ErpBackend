import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z, ZodError } from 'zod';

import { toPublicMessage } from '../../application/errors/AuthErrors';
import {
    applyTimerAction,
    listTimers,
    readTimer,
    type TimerScope,
    type TimerSubject,
} from '../../application/services/timers/serverTimerService';
import { TimerError, timerUnauthenticated } from '../../application/services/timers/timerErrors';
import { TIMER_ACTIONS, TIMER_STATUSES, type TimerStatus } from '../../application/services/timers/timerMachine';
import { requireAuth } from '../middlewares/AuthMiddleware';

/**
 * ── /api/v1/timers — ZEITMESSUNG NACH ZEITSTEMPELN (14.09.2026) ──────────────
 *
 * Wiederverwendbarer Zähler für jeden Bereich der Anwendung (Aufgabe, Projekt,
 * Montage …): der Gegenstand ist nur eine Kennung (`subjectType/subjectId`),
 * der Zähler gehört der angemeldeten Person in der ausgewählten Firma.
 *
 *   GET  /                                   meine Zähler (?status=RUNNING)
 *   GET  /:subjectType/:subjectId            Stand — ohne Zeile ein IDLE-Stand
 *   POST /:subjectType/:subjectId/start      {}  IDLE|PAUSED → RUNNING
 *   POST /:subjectType/:subjectId/pause      {}  RUNNING → PAUSED
 *   POST /:subjectType/:subjectId/resume     {}  PAUSED → RUNNING
 *   POST /:subjectType/:subjectId/stop       {}  RUNNING|PAUSED → COMPLETED
 *   POST /:subjectType/:subjectId/reset      {}  * → IDLE
 *
 * Jede Antwort: `{ timer, serverTime }` — `serverTime` ist die Uhr des Servers
 * beim Senden; der Browser misst daraus einmal seinen Versatz. Kein Weg nimmt
 * eine Dauer oder Client-Zeit entgegen. Antworten werden nie zwischengespeichert.
 *
 * Fehler: `{ error, code }` — 409 TIMER_NOT_RUNNING | TIMER_NOT_PAUSED |
 * TIMER_NOT_STARTED | TIMER_COMPLETED | TIMER_CONFLICT, 400 VALIDATION.
 */

const router = Router();
router.use(requireAuth);

/* ── Eingaben ───────────────────────────────────────────────────────────── */

const subjectSchema = z.object({
    subjectType: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'subjectType: Grossbuchstaben, Ziffern, _ (2–40 Zeichen).'),
    subjectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, 'subjectId: 1–64 Zeichen (Buchstaben, Ziffern, _ . : -).'),
});

const scopeOf = (req: Request): TimerScope => {
    const user = req.user;
    if (!user) throw timerUnauthenticated();
    return { tenantId: user.tenantId, ownerId: user.id };
};

const subjectOf = (req: Request): TimerSubject => subjectSchema.parse(req.params);

const statusFilterOf = (req: Request): TimerStatus | undefined => {
    const raw = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : '';
    return (TIMER_STATUSES as readonly string[]).includes(raw) ? (raw as TimerStatus) : undefined;
};

/* ── Antworten ──────────────────────────────────────────────────────────── */

/** Nutzlast plus `serverTime` — gestempelt beim Senden, nach aller Datenbankarbeit. */
const send = (res: Response, payload: Record<string, unknown>): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...payload, serverTime: new Date().toISOString() });
};

const sendTimerError = (res: Response, error: unknown, context: string): void => {
    if (res.headersSent) {
        console.error(`[${context}] Fehler nach gesendeter Antwort`, error);
        return;
    }
    if (error instanceof TimerError) {
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
    res.status(500).json({ error: toPublicMessage(error, context), code: 'INTERNAL' });
};

const timerRoute = (
    context: string,
    handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler => async (req, res) => {
    try {
        await handler(req, res);
    } catch (error) {
        sendTimerError(res, error, context);
    }
};

/* ── Wege ───────────────────────────────────────────────────────────────── */

router.get('/', timerRoute('timers.list', async (req, res) => {
    send(res, { timers: await listTimers(scopeOf(req), statusFilterOf(req)) });
}));

router.get('/:subjectType/:subjectId', timerRoute('timers.read', async (req, res) => {
    send(res, { timer: await readTimer(scopeOf(req), subjectOf(req)) });
}));

// Express 5 kennt keine Alternativen im Pfadparameter — ein Weg je Handlung.
for (const action of TIMER_ACTIONS) {
    router.post(`/:subjectType/:subjectId/${action}`, timerRoute(`timers.${action}`, async (req, res) => {
        send(res, { timer: await applyTimerAction(scopeOf(req), subjectOf(req), action) });
    }));
}

export default router;
