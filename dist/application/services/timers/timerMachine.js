"use strict";
/**
 * ── ZEITMESSUNG NACH ZEITSTEMPELN: DIE REINEN REGELN ─────────────────────────
 *
 * Der Server hält nie eine vom Browser gemeldete Dauer. Ein Zähler ist nur
 *   status          IDLE | RUNNING | PAUSED | COMPLETED
 *   startedAtMs     Beginn des LAUFENDEN Abschnitts (nur bei RUNNING)
 *   accumulatedMs   Summe aller abgeschlossenen Abschnitte
 * und die verstrichene Zeit ist immer `accumulatedMs + (jetzt − startedAtMs)`.
 *
 * Diese Datei kennt weder Datenbank noch HTTP: `transition()` nimmt einen
 * Stand, eine Handlung und den Wirkzeitpunkt und liefert den nächsten Stand —
 * oder den Grund, warum der Wechsel nicht erlaubt ist. Wiederholte Handlungen
 * (Start auf RUNNING, Pause auf PAUSED, …) sind KEIN Fehler, sondern
 * `changed: false`: ein Doppelklick oder eine wiederholte Anfrage ändert nichts.
 *
 * Der Browser trägt dieselben Regeln als Vorhersage für den Klick
 * (ErpFront … src/lib/serverTimer/timerMachine.ts) — beide Fassungen müssen
 * gleich bleiben, sonst springt die Anzeige, sobald die Antwort eintrifft.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.transition = exports.elapsedMsAt = exports.IDLE_STATE = exports.TIMER_ACTIONS = exports.TIMER_STATUSES = void 0;
exports.TIMER_STATUSES = ['IDLE', 'RUNNING', 'PAUSED', 'COMPLETED'];
exports.TIMER_ACTIONS = ['start', 'pause', 'resume', 'stop', 'reset'];
exports.IDLE_STATE = Object.freeze({
    status: 'IDLE',
    startedAtMs: null,
    accumulatedMs: 0,
    completedAtMs: null,
    lastTransitionAtMs: 0,
});
/** Verstrichene Zeit zum Zeitpunkt `nowMs` (Serveruhr). */
const elapsedMsAt = (state, nowMs) => {
    const running = state.status === 'RUNNING' && state.startedAtMs !== null
        ? Math.max(0, nowMs - state.startedAtMs)
        : 0;
    return state.accumulatedMs + running;
};
exports.elapsedMsAt = elapsedMsAt;
const unchanged = (state) => ({ ok: true, changed: false, state });
const rejected = (reason) => ({ ok: false, reason });
const changed = (state) => ({ ok: true, changed: true, state });
/** Einen (neuen) Abschnitt bei `atMs` beginnen — aus IDLE wie aus PAUSED. */
const run = (state, atMs) => changed({ ...state, status: 'RUNNING', startedAtMs: atMs, completedAtMs: null, lastTransitionAtMs: atMs });
const transition = (state, action, atMsRaw) => {
    // Nie vor den letzten Wechsel: ein verspäteter Klick vom zweiten Gerät
    // darf keinen Abschnitt öffnen, der vor der letzten Pause beginnt.
    const atMs = Math.max(atMsRaw, state.lastTransitionAtMs);
    switch (action) {
        case 'start':
            if (state.status === 'RUNNING')
                return unchanged(state);
            if (state.status === 'COMPLETED')
                return rejected('COMPLETED');
            return run(state, atMs);
        case 'resume':
            if (state.status === 'RUNNING')
                return unchanged(state);
            if (state.status === 'COMPLETED')
                return rejected('COMPLETED');
            if (state.status === 'IDLE')
                return rejected('NOT_PAUSED');
            return run(state, atMs);
        case 'pause':
            if (state.status === 'PAUSED')
                return unchanged(state);
            if (state.status === 'COMPLETED')
                return rejected('COMPLETED');
            if (state.status === 'IDLE')
                return rejected('NOT_RUNNING');
            return changed({
                ...state,
                status: 'PAUSED',
                startedAtMs: null,
                accumulatedMs: (0, exports.elapsedMsAt)(state, atMs),
                lastTransitionAtMs: atMs,
            });
        case 'stop':
            if (state.status === 'COMPLETED')
                return unchanged(state);
            if (state.status === 'IDLE')
                return rejected('NOT_STARTED');
            return changed({
                status: 'COMPLETED',
                startedAtMs: null,
                accumulatedMs: (0, exports.elapsedMsAt)(state, atMs),
                completedAtMs: atMs,
                lastTransitionAtMs: atMs,
            });
        case 'reset':
            if (state.status === 'IDLE' && state.accumulatedMs === 0)
                return unchanged(state);
            return changed({ ...exports.IDLE_STATE, lastTransitionAtMs: atMs });
    }
};
exports.transition = transition;
//# sourceMappingURL=timerMachine.js.map