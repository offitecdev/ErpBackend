"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timerUnauthenticated = exports.timerConflict = exports.timerRejected = exports.TimerError = void 0;
const AuthErrors_1 = require("../../errors/AuthErrors");
/**
 * Ein Fehler der Zeitmessung, der nach draussen darf: HTTP-Status, ein fester
 * `code` (die Oberfläche übersetzt danach — nie den deutschen Satz zeigen)
 * und ein Satz als Rückfallnetz. Alles andere bleibt innerlich und wird zur
 * allgemeinen 500 (siehe serverTimer.routes.ts).
 */
class TimerError extends AuthErrors_1.PublicError {
    status;
    code;
    extra;
    constructor(status, code, message, extra) {
        super(message);
        this.name = 'TimerError';
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}
exports.TimerError = TimerError;
const REJECTION_MESSAGES = {
    NOT_RUNNING: 'Die Messung läuft nicht.',
    NOT_PAUSED: 'Die Messung ist nicht pausiert.',
    NOT_STARTED: 'Die Messung wurde noch nicht gestartet.',
    COMPLETED: 'Die Messung ist abgeschlossen — zuerst zurücksetzen.',
};
/** Unzulässiger Wechsel (409): Handlung und aktueller Zustand reisen mit, damit die Oberfläche ihn übernehmen kann. */
const timerRejected = (reason, action, status) => new TimerError(409, `TIMER_${reason}`, REJECTION_MESSAGES[reason], { action, status });
exports.timerRejected = timerRejected;
/** Zwischen Lesen und Schreiben hat ein anderes Gerät den Zähler verändert — auch nach Wiederholung. */
const timerConflict = () => new TimerError(409, 'TIMER_CONFLICT', 'Die Messung wurde gleichzeitig geändert. Bitte neu laden.');
exports.timerConflict = timerConflict;
const timerUnauthenticated = () => new TimerError(401, 'UNAUTHENTICATED', 'Nicht angemeldet.');
exports.timerUnauthenticated = timerUnauthenticated;
//# sourceMappingURL=timerErrors.js.map