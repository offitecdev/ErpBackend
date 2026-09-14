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

export const TIMER_STATUSES = ['IDLE', 'RUNNING', 'PAUSED', 'COMPLETED'] as const;
export type TimerStatus = (typeof TIMER_STATUSES)[number];

export const TIMER_ACTIONS = ['start', 'pause', 'resume', 'stop', 'reset'] as const;
export type TimerAction = (typeof TIMER_ACTIONS)[number];

export interface TimerState {
    status: TimerStatus;
    /** Beginn des laufenden Abschnitts (ms seit Epoche, Serveruhr) — nur bei RUNNING. */
    startedAtMs: number | null;
    /** Summe der abgeschlossenen Abschnitte in ms. */
    accumulatedMs: number;
    completedAtMs: number | null;
    /** Wirkzeitpunkt des letzten Wechsels; kein neuer Wechsel darf davor liegen. */
    lastTransitionAtMs: number;
}

export const IDLE_STATE: TimerState = Object.freeze({
    status: 'IDLE',
    startedAtMs: null,
    accumulatedMs: 0,
    completedAtMs: null,
    lastTransitionAtMs: 0,
});

export type TransitionRejection = 'NOT_RUNNING' | 'NOT_PAUSED' | 'NOT_STARTED' | 'COMPLETED';

export type TransitionResult =
    | { ok: true; changed: boolean; state: TimerState }
    | { ok: false; reason: TransitionRejection };

/** Verstrichene Zeit zum Zeitpunkt `nowMs` (Serveruhr). */
export const elapsedMsAt = (state: TimerState, nowMs: number): number => {
    const running = state.status === 'RUNNING' && state.startedAtMs !== null
        ? Math.max(0, nowMs - state.startedAtMs)
        : 0;
    return state.accumulatedMs + running;
};

const unchanged = (state: TimerState): TransitionResult => ({ ok: true, changed: false, state });
const rejected = (reason: TransitionRejection): TransitionResult => ({ ok: false, reason });
const changed = (state: TimerState): TransitionResult => ({ ok: true, changed: true, state });

/** Einen (neuen) Abschnitt bei `atMs` beginnen — aus IDLE wie aus PAUSED. */
const run = (state: TimerState, atMs: number): TransitionResult =>
    changed({ ...state, status: 'RUNNING', startedAtMs: atMs, completedAtMs: null, lastTransitionAtMs: atMs });

export const transition = (state: TimerState, action: TimerAction, atMsRaw: number): TransitionResult => {
    // Nie vor den letzten Wechsel: ein verspäteter Klick vom zweiten Gerät
    // darf keinen Abschnitt öffnen, der vor der letzten Pause beginnt.
    const atMs = Math.max(atMsRaw, state.lastTransitionAtMs);

    switch (action) {
        case 'start':
            if (state.status === 'RUNNING') return unchanged(state);
            if (state.status === 'COMPLETED') return rejected('COMPLETED');
            return run(state, atMs);

        case 'resume':
            if (state.status === 'RUNNING') return unchanged(state);
            if (state.status === 'COMPLETED') return rejected('COMPLETED');
            if (state.status === 'IDLE') return rejected('NOT_PAUSED');
            return run(state, atMs);

        case 'pause':
            if (state.status === 'PAUSED') return unchanged(state);
            if (state.status === 'COMPLETED') return rejected('COMPLETED');
            if (state.status === 'IDLE') return rejected('NOT_RUNNING');
            return changed({
                ...state,
                status: 'PAUSED',
                startedAtMs: null,
                accumulatedMs: elapsedMsAt(state, atMs),
                lastTransitionAtMs: atMs,
            });

        case 'stop':
            if (state.status === 'COMPLETED') return unchanged(state);
            if (state.status === 'IDLE') return rejected('NOT_STARTED');
            return changed({
                status: 'COMPLETED',
                startedAtMs: null,
                accumulatedMs: elapsedMsAt(state, atMs),
                completedAtMs: atMs,
                lastTransitionAtMs: atMs,
            });

        case 'reset':
            if (state.status === 'IDLE' && state.accumulatedMs === 0) return unchanged(state);
            return changed({ ...IDLE_STATE, lastTransitionAtMs: atMs });
    }
};
