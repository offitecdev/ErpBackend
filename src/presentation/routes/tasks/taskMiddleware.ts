import type { RequestHandler, Response } from 'express';

import { isModuleEnabledForTenant } from '../../../shared/tenantModules';
import { resolveTasksActor, type TasksActor } from '../../../application/services/tasks/taskActor';
import { TASKS_MODULE_KEY } from '../../../application/services/tasks/taskConstants';
import { TaskError } from '../../../application/services/tasks/taskErrors';
import { sendTaskError } from './taskHttp';

/**
 * Tor des Görevler-Moduls, NACH requireAuth:
 *   1. Ist das Modul für die ausgewählte Firma freigeschaltet (Firmenkategorie)?
 *   2. Darf die Person es benutzen (tasks.view / tasks.manage / Administrator)?
 * Das Ergebnis liegt danach in `res.locals.tasksActor`.
 */
export const requireTasksAccess: RequestHandler = async (req, res, next) => {
    try {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Nicht angemeldet.', code: 'UNAUTHENTICATED' });
            return;
        }
        if (!(await isModuleEnabledForTenant(user.tenantId, TASKS_MODULE_KEY))) {
            res.status(403).json({
                error: 'Das Modul «Görevler» ist für diese Firma nicht freigeschaltet.',
                code: 'TASKS_MODULE_DISABLED',
            });
            return;
        }
        const actor = await resolveTasksActor(user.id, user.tenantId);
        if (!actor) {
            res.status(403).json({ error: 'Keine Berechtigung für das Modul «Görevler».', code: 'TASKS_NO_ACCESS' });
            return;
        }
        res.locals.tasksActor = actor;
        next();
    } catch (error) {
        sendTaskError(res, error, 'tasks.access');
    }
};

/** Die handelnde Person — nur hinter requireTasksAccess aufrufen. */
export const tasksActor = (res: Response): TasksActor => {
    const actor = res.locals.tasksActor as TasksActor | undefined;
    if (!actor) throw new TaskError(500, 'INTERNAL', 'Anfrage ohne Modulzugang.');
    return actor;
};
