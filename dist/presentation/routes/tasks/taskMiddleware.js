"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tasksActor = exports.requireTasksAccess = void 0;
const tenantModules_1 = require("../../../shared/tenantModules");
const taskActor_1 = require("../../../application/services/tasks/taskActor");
const taskConstants_1 = require("../../../application/services/tasks/taskConstants");
const taskErrors_1 = require("../../../application/services/tasks/taskErrors");
const taskHttp_1 = require("./taskHttp");
/**
 * Tor des Görevler-Moduls, NACH requireAuth:
 *   1. Ist das Modul für die ausgewählte Firma freigeschaltet (Firmenkategorie)?
 *   2. Darf die Person es benutzen (tasks.view / tasks.manage / Administrator)?
 * Das Ergebnis liegt danach in `res.locals.tasksActor`.
 */
const requireTasksAccess = async (req, res, next) => {
    try {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Nicht angemeldet.', code: 'UNAUTHENTICATED' });
            return;
        }
        if (!(await (0, tenantModules_1.isModuleEnabledForTenant)(user.tenantId, taskConstants_1.TASKS_MODULE_KEY))) {
            res.status(403).json({
                error: 'Das Modul «Görevler» ist für diese Firma nicht freigeschaltet.',
                code: 'TASKS_MODULE_DISABLED',
            });
            return;
        }
        const actor = await (0, taskActor_1.resolveTasksActor)(user.id, user.tenantId);
        if (!actor) {
            res.status(403).json({ error: 'Keine Berechtigung für das Modul «Görevler».', code: 'TASKS_NO_ACCESS' });
            return;
        }
        res.locals.tasksActor = actor;
        next();
    }
    catch (error) {
        (0, taskHttp_1.sendTaskError)(res, error, 'tasks.access');
    }
};
exports.requireTasksAccess = requireTasksAccess;
/** Die handelnde Person — nur hinter requireTasksAccess aufrufen. */
const tasksActor = (res) => {
    const actor = res.locals.tasksActor;
    if (!actor)
        throw new taskErrors_1.TaskError(500, 'INTERNAL', 'Anfrage ohne Modulzugang.');
    return actor;
};
exports.tasksActor = tasksActor;
//# sourceMappingURL=taskMiddleware.js.map