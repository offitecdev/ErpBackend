"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const AuthErrors_1 = require("../../application/errors/AuthErrors");
const serverTimerService_1 = require("../../application/services/timers/serverTimerService");
const timerErrors_1 = require("../../application/services/timers/timerErrors");
const timerMachine_1 = require("../../application/services/timers/timerMachine");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
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
const router = (0, express_1.Router)();
router.use(AuthMiddleware_1.requireAuth);
/* ── Eingaben ───────────────────────────────────────────────────────────── */
const subjectSchema = zod_1.z.object({
    subjectType: zod_1.z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'subjectType: Grossbuchstaben, Ziffern, _ (2–40 Zeichen).'),
    subjectId: zod_1.z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, 'subjectId: 1–64 Zeichen (Buchstaben, Ziffern, _ . : -).'),
});
const scopeOf = (req) => {
    const user = req.user;
    if (!user)
        throw (0, timerErrors_1.timerUnauthenticated)();
    return { tenantId: user.tenantId, ownerId: user.id };
};
const subjectOf = (req) => subjectSchema.parse(req.params);
const statusFilterOf = (req) => {
    const raw = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : '';
    return timerMachine_1.TIMER_STATUSES.includes(raw) ? raw : undefined;
};
/* ── Antworten ──────────────────────────────────────────────────────────── */
/** Nutzlast plus `serverTime` — gestempelt beim Senden, nach aller Datenbankarbeit. */
const send = (res, payload) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...payload, serverTime: new Date().toISOString() });
};
const sendTimerError = (res, error, context) => {
    if (res.headersSent) {
        console.error(`[${context}] Fehler nach gesendeter Antwort`, error);
        return;
    }
    if (error instanceof timerErrors_1.TimerError) {
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
    res.status(500).json({ error: (0, AuthErrors_1.toPublicMessage)(error, context), code: 'INTERNAL' });
};
const timerRoute = (context, handler) => async (req, res) => {
    try {
        await handler(req, res);
    }
    catch (error) {
        sendTimerError(res, error, context);
    }
};
/* ── Wege ───────────────────────────────────────────────────────────────── */
router.get('/', timerRoute('timers.list', async (req, res) => {
    send(res, { timers: await (0, serverTimerService_1.listTimers)(scopeOf(req), statusFilterOf(req)) });
}));
router.get('/:subjectType/:subjectId', timerRoute('timers.read', async (req, res) => {
    send(res, { timer: await (0, serverTimerService_1.readTimer)(scopeOf(req), subjectOf(req)) });
}));
// Express 5 kennt keine Alternativen im Pfadparameter — ein Weg je Handlung.
for (const action of timerMachine_1.TIMER_ACTIONS) {
    router.post(`/:subjectType/:subjectId/${action}`, timerRoute(`timers.${action}`, async (req, res) => {
        send(res, { timer: await (0, serverTimerService_1.applyTimerAction)(scopeOf(req), subjectOf(req), action) });
    }));
}
exports.default = router;
//# sourceMappingURL=serverTimer.routes.js.map