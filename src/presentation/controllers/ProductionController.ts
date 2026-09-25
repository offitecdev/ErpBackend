import { NextFunction, Request, Response } from 'express';
import { isProductionEnabled, productionModule } from '../composition/productionModule';
import { isProductionError, productionErrorBody } from '../../application/use-cases/production/productionErrors';
import { userHasPermission } from '../middlewares/RbacMiddleware';

/**
 * ── DIE WEGE DES PRODUKTIONSMODULS ──────────────────────────────────────────
 * Dünn: Anfrage lesen, Anwendungsfall rufen, Antwort schreiben. Fachliche
 * Fehler tragen eine Kennung (`production.err.*` in der Oberfläche);
 * alles andere landet als 500 im globalen Fehlerbehandler.
 */

const fail = (res: Response, next: NextFunction, error: unknown) => {
    if (isProductionError(error)) {
        res.status(error.status).json(productionErrorBody(error));
        return;
    }
    next(error);
};

const tenantOf = (req: Request) => req.user!.tenantId;

export class ProductionController {
    /** Nur wo die Produktion eingeschaltet ist (Firmenkategorie). */
    static requireModule = async (req: Request, res: Response, next: NextFunction) => {
        try {
            if (await isProductionEnabled(tenantOf(req))) return next();
            res.status(403).json({ error: 'Das Produktionsmodul ist für diese Firma nicht eingeschaltet.', code: 'MODULE_DISABLED' });
        } catch (error) {
            next(error);
        }
    };

    async status(req: Request, res: Response, next: NextFunction) {
        try {
            res.json({ enabled: await isProductionEnabled(tenantOf(req)) });
        } catch (error) { fail(res, next, error); }
    }

    /**
     * Ohne `force` gleicht der Server nur ab, wenn der letzte Abgleich älter
     * als fünf Minuten ist — das ruft jede Seite des Moduls beim Öffnen.
     * SOFORT abgleichen (der Knopf «Aktualisieren») ist Stufe 2.
     */
    async sync(req: Request, res: Response, next: NextFunction) {
        try {
            const wantsForce = req.body?.force === true;
            const mayForce = wantsForce && (
                await userHasPermission(req.user!.id, 'production.manage')
                || await userHasPermission(req.user!.id, 'inventory.transfer')
            );
            res.json(await productionModule.sync.execute(tenantOf(req), { force: mayForce }));
        } catch (error) { fail(res, next, error); }
    }

    async overview(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionModule.overview.execute(tenantOf(req)));
        } catch (error) { fail(res, next, error); }
    }

    async project(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionModule.project.execute(tenantOf(req), String(req.params.id)));
        } catch (error) { fail(res, next, error); }
    }

    /** Projekttabelle und Geräte — Projektseite und Geräteseite (24.09.2026). */
    async projectDevices(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionModule.devices.execute(tenantOf(req), String(req.params.id)));
        } catch (error) { fail(res, next, error); }
    }

    async lines(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionModule.lines.execute(tenantOf(req), {
                ...(req.query.projectId ? { projectId: String(req.query.projectId) } : {}),
                ...(req.query.search ? { search: String(req.query.search).slice(0, 120) } : {}),
            }));
        } catch (error) { fail(res, next, error); }
    }

    async item(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionModule.item.execute(tenantOf(req), String(req.params.id)));
        } catch (error) { fail(res, next, error); }
    }

    async pickerProjects(req: Request, res: Response, next: NextFunction) {
        try {
            const search = req.query.search ? String(req.query.search).slice(0, 120) : undefined;
            res.json({ items: await productionModule.picker.listProjects(tenantOf(req), search) });
        } catch (error) { fail(res, next, error); }
    }

    async pickerProject(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionModule.picker.projectTree(tenantOf(req), String(req.params.id)));
        } catch (error) { fail(res, next, error); }
    }

    async pickerAssignment(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionModule.picker.assignmentFor(tenantOf(req), String(req.params.purchaseOrderId)));
        } catch (error) { fail(res, next, error); }
    }

    async getSettings(req: Request, res: Response, next: NextFunction) {
        try {
            const tenantId = tenantOf(req);
            res.json(await productionModule.settings.get(tenantId, await isProductionEnabled(tenantId)));
        } catch (error) { fail(res, next, error); }
    }

    async saveSettings(req: Request, res: Response, next: NextFunction) {
        try {
            const tenantId = tenantOf(req);
            res.json(await productionModule.settings.save(
                tenantId,
                req.body?.sourceTenantIds,
                req.user!.id,
                await isProductionEnabled(tenantId),
            ));
        } catch (error) { fail(res, next, error); }
    }
}
