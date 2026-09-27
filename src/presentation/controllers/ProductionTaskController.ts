import type { NextFunction, Request, Response } from 'express';

import { productionTasksModule } from '../composition/productionTasksModule';
import { isProductionTaskError, productionTaskErrorBody } from '../../domain/services/productionTasks';
import type { ProductionTaskActor } from '../../application/use-cases/production/ProductionTaskTemplatesUseCase';

/**
 * ── DIE WEGE DER GÖREVLENDİRME (26.09.2026) ─────────────────────────────────
 * Dünn: Anfrage lesen, Anwendungsfall rufen, Antwort schreiben. Fachliche
 * Fehler tragen eine Kennung (`productionTasks.err.*` in der Oberfläche);
 * alles andere landet als 500 im globalen Fehlerbehandler.
 */

const fail = (res: Response, next: NextFunction, error: unknown) => {
    if (isProductionTaskError(error)) {
        res.status(error.status).json(productionTaskErrorBody(error));
        return;
    }
    next(error);
};

const tenantOf = (req: Request) => req.user!.tenantId;
const param = (req: Request, name: string) => String(req.params[name] ?? '');

/** Wer handelt: Kennung und Name (aus dem Anmeldetoken, sonst aus Personal). */
const actorOf = async (req: Request): Promise<ProductionTaskActor> => {
    const user = req.user!;
    const fromToken = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    const name = fromToken || await productionTasksModule.directory.personName(user.id);
    return { id: user.id, name: name || null };
};

export class ProductionTaskController {
    /* ── Vorlagen ───────────────────────────────────────────────────────── */

    async listTemplates(req: Request, res: Response, next: NextFunction) {
        try {
            res.json({ items: await productionTasksModule.templates.list(tenantOf(req)) });
        } catch (error) { fail(res, next, error); }
    }

    async getTemplate(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.templates.get(tenantOf(req), param(req, 'id')));
        } catch (error) { fail(res, next, error); }
    }

    async createTemplate(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(201).json(await productionTasksModule.templates.create(tenantOf(req), await actorOf(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async updateTemplate(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.templates.update(tenantOf(req), await actorOf(req), param(req, 'id'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async deleteTemplate(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.templates.remove(tenantOf(req), await actorOf(req), param(req, 'id')));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Aufgaben eines Geräts ──────────────────────────────────────────── */

    async deviceTasks(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.devices.get(tenantOf(req), param(req, 'itemId')));
        } catch (error) { fail(res, next, error); }
    }

    async loadDeviceTasks(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.devices.load(tenantOf(req), await actorOf(req), param(req, 'itemId'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async assignDeviceTask(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.devices.assign(
                tenantOf(req),
                await actorOf(req),
                param(req, 'itemId'),
                param(req, 'taskId'),
                req.body,
            ));
        } catch (error) { fail(res, next, error); }
    }

    async unloadDeviceTasks(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.devices.unload(tenantOf(req), param(req, 'itemId')));
        } catch (error) { fail(res, next, error); }
    }
}
