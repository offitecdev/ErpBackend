"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.managerOnly = exports.taskConflict = exports.taskNotFound = exports.taskForbidden = exports.taskBadRequest = exports.TaskError = void 0;
const AuthErrors_1 = require("../../errors/AuthErrors");
/**
 * Ein Fehler des Görevler-Moduls, der nach draussen darf: HTTP-Status, ein
 * fester `code` (die Oberfläche übersetzt danach) und ein deutscher Satz als
 * Rückfallnetz. Alles, was KEIN TaskError ist, bleibt innerlich und wird zu
 * einer allgemeinen Antwort (siehe taskHttp.sendTaskError).
 */
class TaskError extends AuthErrors_1.PublicError {
    status;
    code;
    extra;
    constructor(status, code, message, extra) {
        super(message);
        this.name = 'TaskError';
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}
exports.TaskError = TaskError;
const taskBadRequest = (code, message, extra) => new TaskError(400, code, message, extra);
exports.taskBadRequest = taskBadRequest;
const taskForbidden = (code, message, extra) => new TaskError(403, code, message, extra);
exports.taskForbidden = taskForbidden;
const taskNotFound = (code = 'TASK_NOT_FOUND', message = 'Aufgabe nicht gefunden.') => new TaskError(404, code, message);
exports.taskNotFound = taskNotFound;
const taskConflict = (code, message, extra) => new TaskError(409, code, message, extra);
exports.taskConflict = taskConflict;
const managerOnly = () => (0, exports.taskForbidden)('MANAGER_ONLY', 'Das darf nur die Leitung.');
exports.managerOnly = managerOnly;
//# sourceMappingURL=taskErrors.js.map