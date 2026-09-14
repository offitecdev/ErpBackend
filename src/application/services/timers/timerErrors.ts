import { PublicError } from '../../errors/AuthErrors';
import type { TimerAction, TimerStatus, TransitionRejection } from './timerMachine';

/**
 * Ein Fehler der Zeitmessung, der nach draussen darf: HTTP-Status, ein fester
 * `code` (die Oberfläche übersetzt danach — nie den deutschen Satz zeigen)
 * und ein Satz als Rückfallnetz. Alles andere bleibt innerlich und wird zur
 * allgemeinen 500 (siehe serverTimer.routes.ts).
 */
export class TimerError extends PublicError {
    readonly status: number;
    readonly code: string;
    readonly extra: Record<string, unknown> | undefined;

    constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
        super(message);
        this.name = 'TimerError';
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

const REJECTION_MESSAGES: Record<TransitionRejection, string> = {
    NOT_RUNNING: 'Die Messung läuft nicht.',
    NOT_PAUSED: 'Die Messung ist nicht pausiert.',
    NOT_STARTED: 'Die Messung wurde noch nicht gestartet.',
    COMPLETED: 'Die Messung ist abgeschlossen — zuerst zurücksetzen.',
};

/** Unzulässiger Wechsel (409): Handlung und aktueller Zustand reisen mit, damit die Oberfläche ihn übernehmen kann. */
export const timerRejected = (reason: TransitionRejection, action: TimerAction, status: TimerStatus): TimerError =>
    new TimerError(409, `TIMER_${reason}`, REJECTION_MESSAGES[reason], { action, status });

/** Zwischen Lesen und Schreiben hat ein anderes Gerät den Zähler verändert — auch nach Wiederholung. */
export const timerConflict = (): TimerError =>
    new TimerError(409, 'TIMER_CONFLICT', 'Die Messung wurde gleichzeitig geändert. Bitte neu laden.');

export const timerUnauthenticated = (): TimerError =>
    new TimerError(401, 'UNAUTHENTICATED', 'Nicht angemeldet.');
