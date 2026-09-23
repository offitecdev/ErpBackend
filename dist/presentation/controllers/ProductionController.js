"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionController = void 0;
const productionModule_1 = require("../composition/productionModule");
const productionErrors_1 = require("../../application/use-cases/production/productionErrors");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
/**
 * ── DIE WEGE DES PRODUKTIONSMODULS ──────────────────────────────────────────
 * Dünn: Anfrage lesen, Anwendungsfall rufen, Antwort schreiben. Fachliche
 * Fehler tragen eine Kennung (`production.err.*` in der Oberfläche);
 * alles andere landet als 500 im globalen Fehlerbehandler.
 */
const fail = (res, next, error) => {
    if ((0, productionErrors_1.isProductionError)(error)) {
        res.status(error.status).json((0, productionErrors_1.productionErrorBody)(error));
        return;
    }
    next(error);
};
const tenantOf = (req) => req.user.tenantId;
class ProductionController {
    /** Nur wo die Produktion eingeschaltet ist (Firmenkategorie). */
    static requireModule = async (req, res, next) => {
        try {
            if (await (0, productionModule_1.isProductionEnabled)(tenantOf(req)))
                return next();
            res.status(403).json({ error: 'Das Produktionsmodul ist für diese Firma nicht eingeschaltet.', code: 'MODULE_DISABLED' });
        }
        catch (error) {
            next(error);
        }
    };
    async status(req, res, next) {
        try {
            res.json({ enabled: await (0, productionModule_1.isProductionEnabled)(tenantOf(req)) });
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /**
     * Ohne `force` gleicht der Server nur ab, wenn der letzte Abgleich älter
     * als fünf Minuten ist — das ruft jede Seite des Moduls beim Öffnen.
     * SOFORT abgleichen (der Knopf «Aktualisieren») ist Stufe 2.
     */
    async sync(req, res, next) {
        try {
            const wantsForce = req.body?.force === true;
            const mayForce = wantsForce && (await (0, RbacMiddleware_1.userHasPermission)(req.user.id, 'production.manage')
                || await (0, RbacMiddleware_1.userHasPermission)(req.user.id, 'inventory.transfer'));
            res.json(await productionModule_1.productionModule.sync.execute(tenantOf(req), { force: mayForce }));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async overview(req, res, next) {
        try {
            res.json(await productionModule_1.productionModule.overview.execute(tenantOf(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async project(req, res, next) {
        try {
            res.json(await productionModule_1.productionModule.project.execute(tenantOf(req), String(req.params.id)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async lines(req, res, next) {
        try {
            res.json(await productionModule_1.productionModule.lines.execute(tenantOf(req), {
                ...(req.query.projectId ? { projectId: String(req.query.projectId) } : {}),
                ...(req.query.search ? { search: String(req.query.search).slice(0, 120) } : {}),
            }));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async item(req, res, next) {
        try {
            res.json(await productionModule_1.productionModule.item.execute(tenantOf(req), String(req.params.id)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async pickerProjects(req, res, next) {
        try {
            const search = req.query.search ? String(req.query.search).slice(0, 120) : undefined;
            res.json({ items: await productionModule_1.productionModule.picker.listProjects(tenantOf(req), search) });
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async pickerProject(req, res, next) {
        try {
            res.json(await productionModule_1.productionModule.picker.projectTree(tenantOf(req), String(req.params.id)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async pickerAssignment(req, res, next) {
        try {
            res.json(await productionModule_1.productionModule.picker.assignmentFor(tenantOf(req), String(req.params.purchaseOrderId)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async getSettings(req, res, next) {
        try {
            const tenantId = tenantOf(req);
            res.json(await productionModule_1.productionModule.settings.get(tenantId, await (0, productionModule_1.isProductionEnabled)(tenantId)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async saveSettings(req, res, next) {
        try {
            const tenantId = tenantOf(req);
            res.json(await productionModule_1.productionModule.settings.save(tenantId, req.body?.sourceTenantIds, req.user.id, await (0, productionModule_1.isProductionEnabled)(tenantId)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
}
exports.ProductionController = ProductionController;
//# sourceMappingURL=ProductionController.js.map