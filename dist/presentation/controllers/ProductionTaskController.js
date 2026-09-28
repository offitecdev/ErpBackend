"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionTaskController = void 0;
const productionTasksModule_1 = require("../composition/productionTasksModule");
const productionTasks_1 = require("../../domain/services/productionTasks");
/**
 * ── DIE WEGE DER GÖREVLENDİRME (26.09.2026) ─────────────────────────────────
 * Dünn: Anfrage lesen, Anwendungsfall rufen, Antwort schreiben. Fachliche
 * Fehler tragen eine Kennung (`productionTasks.err.*` in der Oberfläche);
 * alles andere landet als 500 im globalen Fehlerbehandler.
 */
const fail = (res, next, error) => {
    if ((0, productionTasks_1.isProductionTaskError)(error)) {
        res.status(error.status).json((0, productionTasks_1.productionTaskErrorBody)(error));
        return;
    }
    next(error);
};
const tenantOf = (req) => req.user.tenantId;
const param = (req, name) => String(req.params[name] ?? '');
/** Wer handelt: Kennung und Name (aus dem Anmeldetoken, sonst aus Personal). */
const actorOf = async (req) => {
    const user = req.user;
    const fromToken = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    const name = fromToken || await productionTasksModule_1.productionTasksModule.directory.personName(user.id);
    return { id: user.id, name: name || null };
};
class ProductionTaskController {
    /* ── Vorlagen ───────────────────────────────────────────────────────── */
    async listTemplates(req, res, next) {
        try {
            res.json({ items: await productionTasksModule_1.productionTasksModule.templates.list(tenantOf(req)) });
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async getTemplate(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.templates.get(tenantOf(req), param(req, 'id')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async createTemplate(req, res, next) {
        try {
            res.status(201).json(await productionTasksModule_1.productionTasksModule.templates.create(tenantOf(req), await actorOf(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async updateTemplate(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.templates.update(tenantOf(req), await actorOf(req), param(req, 'id'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async deleteTemplate(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.templates.remove(tenantOf(req), await actorOf(req), param(req, 'id')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /* ── Aufgaben eines Geräts ──────────────────────────────────────────── */
    async deviceTasks(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.get(tenantOf(req), param(req, 'itemId')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async loadDeviceTasks(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.load(tenantOf(req), await actorOf(req), param(req, 'itemId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async assignDeviceTask(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.assign(tenantOf(req), await actorOf(req), param(req, 'itemId'), param(req, 'taskId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async unloadDeviceTasks(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.unload(tenantOf(req), param(req, 'itemId')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
}
exports.ProductionTaskController = ProductionTaskController;
//# sourceMappingURL=ProductionTaskController.js.map