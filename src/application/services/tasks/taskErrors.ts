import { PublicError } from '../../errors/AuthErrors';

/**
 * Ein Fehler des Görevler-Moduls, der nach draussen darf: HTTP-Status, ein
 * fester `code` (die Oberfläche übersetzt danach) und ein deutscher Satz als
 * Rückfallnetz. Alles, was KEIN TaskError ist, bleibt innerlich und wird zu
 * einer allgemeinen Antwort (siehe taskHttp.sendTaskError).
 */
export class TaskError extends PublicError {
    readonly status: number;
    readonly code: string;
    readonly extra: Record<string, unknown> | undefined;

    constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
        super(message);
        this.name = 'TaskError';
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

export const taskBadRequest = (code: string, message: string, extra?: Record<string, unknown>): TaskError =>
    new TaskError(400, code, message, extra);

export const taskForbidden = (code: string, message: string, extra?: Record<string, unknown>): TaskError =>
    new TaskError(403, code, message, extra);

export const taskNotFound = (code = 'TASK_NOT_FOUND', message = 'Aufgabe nicht gefunden.'): TaskError =>
    new TaskError(404, code, message);

export const taskConflict = (code: string, message: string, extra?: Record<string, unknown>): TaskError =>
    new TaskError(409, code, message, extra);

export const managerOnly = (): TaskError =>
    taskForbidden('MANAGER_ONLY', 'Das darf nur die Leitung.');
