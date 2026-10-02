"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionTaskController = void 0;
const productionTasksModule_1 = require("../composition/productionTasksModule");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
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
const roles = new RoleRepository_1.RoleRepository();
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
    async assignDeviceSubtask(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.assignSubtask(tenantOf(req), await actorOf(req), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async updateDeviceTasks(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.updateTasks(tenantOf(req), await actorOf(req), param(req, 'itemId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async addDeviceStage(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.addStage(tenantOf(req), await actorOf(req), param(req, 'itemId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async setDeviceTaskStatus(req, res, next) {
        try {
            // Keine Ausnahme für die Verwaltung (29.09.2026) — nur wer in der Aufgabe steht.
            res.json(await productionTasksModule_1.productionTasksModule.devices.setStatus(tenantOf(req), await actorOf(req), param(req, 'itemId'), param(req, 'taskId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async setDeviceSubtaskStatus(req, res, next) {
        try {
            // Keine Ausnahme für die Verwaltung (29.09.2026) — nur wer an der Unteraufgabe steht.
            res.json(await productionTasksModule_1.productionTasksModule.devices.setSubtaskStatus(tenantOf(req), await actorOf(req), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async completeDeviceSubtask(req, res, next) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user.id);
            res.json(await productionTasksModule_1.productionTasksModule.devices.completeSubtask(tenantOf(req), await actorOf(req), Boolean(isSystemAdmin), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async addDeviceSubtaskChecklistItem(req, res, next) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user.id);
            res.json(await productionTasksModule_1.productionTasksModule.devices.addSubtaskChecklistItem(tenantOf(req), await actorOf(req), Boolean(isSystemAdmin), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /** Die Standards als PDF hochladen (01.10.2026) — nur die Verwaltung. */
    async uploadStandardsFile(req, res, next) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user.id);
            const file = req.file;
            res.json(await productionTasksModule_1.productionTasksModule.devices.uploadStandardsFile(tenantOf(req), Boolean(isSystemAdmin), 
            // multer liefert den Namen als latin1 — zurück nach UTF-8.
            file ? { body: file.buffer, contentType: file.mimetype, fileName: Buffer.from(file.originalname, 'latin1').toString('utf8') } : null));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /** Das PDF der Standards lesen (`?ref=…&name=…`) — nur aus der eigenen Firma. */
    /* ── Vorlagen der Dokument-Standards (02.10.2026) ── */
    async standardsTemplates(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.standards.list(tenantOf(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async createStandardsTemplate(req, res, next) {
        try {
            res.status(201).json(await productionTasksModule_1.productionTasksModule.standards.create(tenantOf(req), (await actorOf(req)).id, req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async updateStandardsTemplate(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.standards.update(tenantOf(req), (await actorOf(req)).id, param(req, 'templateId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async removeStandardsTemplate(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.standards.remove(tenantOf(req), param(req, 'templateId')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async readStandardsFile(req, res, next) {
        try {
            const file = await productionTasksModule_1.productionTasksModule.devices.readStandardsFile(tenantOf(req), typeof req.query.ref === 'string' ? req.query.ref : '', typeof req.query.name === 'string' ? req.query.name : '');
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.send(file.body);
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /** Die KI-Prüfung eines PDFs noch einmal (01.10.2026) — nur die Verwaltung. */
    async retryDeviceFileAnalysis(req, res, next) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user.id);
            res.json(await productionTasksModule_1.productionTasksModule.devices.retryFileAnalysis(tenantOf(req), await actorOf(req), Boolean(isSystemAdmin), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), param(req, 'fileId')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async unlockDeviceSubtask(req, res, next) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user.id);
            res.json(await productionTasksModule_1.productionTasksModule.devices.unlockSubtask(tenantOf(req), await actorOf(req), Boolean(isSystemAdmin), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async requestDeviceSubtaskRevision(req, res, next) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user.id);
            res.json(await productionTasksModule_1.productionTasksModule.devices.requestSubtaskRevision(tenantOf(req), await actorOf(req), Boolean(isSystemAdmin), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async uploadDeviceSubtaskFile(req, res, next) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user.id);
            const file = req.file;
            res.json(await productionTasksModule_1.productionTasksModule.devices.uploadSubtaskFile(tenantOf(req), await actorOf(req), Boolean(isSystemAdmin), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), 
            // multer liefert den Namen als latin1 — zurück nach UTF-8 (wie beim Angebot der BOM).
            file ? { body: file.buffer, contentType: file.mimetype, fileName: Buffer.from(file.originalname, 'latin1').toString('utf8') } : null, 
            // Neue Fassung einer vorhandenen Datei (Feld `revisionOf` im Formular, 28.09.2026).
            typeof req.body?.revisionOf === 'string' && req.body.revisionOf.trim() ? req.body.revisionOf.trim() : null, 
            // … und was sich geändert hat (Feld `revisionNote`, Pflicht für eine neue Fassung).
            req.body?.revisionNote));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async readDeviceSubtaskFile(req, res, next) {
        try {
            const file = await productionTasksModule_1.productionTasksModule.devices.readSubtaskFile(tenantOf(req), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), param(req, 'fileId'));
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.send(file.body);
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async removeDeviceSubtaskFile(req, res, next) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user.id);
            res.json(await productionTasksModule_1.productionTasksModule.devices.removeSubtaskFile(tenantOf(req), await actorOf(req), Boolean(isSystemAdmin), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), param(req, 'fileId')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async unloadDeviceTasks(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.unload(tenantOf(req), await actorOf(req), param(req, 'itemId')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /* ── «Görevlerim» (30.09.2026): die eigenen Aufgaben, ohne Produktionsrechte ──
       Wer hier handelt, handelt als Person an der Unteraufgabe — nie als Verwaltung
       (`isAdmin` false): Stand setzen, eigene PDFs hochladen, lesen und entfernen.
       Nur zwei Stellen kennen die Verwaltung (02.10.2026): sie sieht dazu jede Stufe mit
       wartender Freigabe und liest deren Dateien. Freigeben selbst läuft über die Wege
       der Geräteseite. */
    async myTasks(req, res, next) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user.id);
            res.json(await productionTasksModule_1.productionTasksModule.devices.myTasks(tenantOf(req), await actorOf(req), Boolean(isSystemAdmin)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async mySubtaskStatus(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.setSubtaskStatus(tenantOf(req), await actorOf(req), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async myUploadSubtaskFile(req, res, next) {
        try {
            const file = req.file;
            res.json(await productionTasksModule_1.productionTasksModule.devices.uploadSubtaskFile(tenantOf(req), await actorOf(req), false, param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), file ? { body: file.buffer, contentType: file.mimetype, fileName: Buffer.from(file.originalname, 'latin1').toString('utf8') } : null, typeof req.body?.revisionOf === 'string' && req.body.revisionOf.trim() ? req.body.revisionOf.trim() : null, req.body?.revisionNote));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async myReadSubtaskFile(req, res, next) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user.id);
            const file = await productionTasksModule_1.productionTasksModule.devices.readSubtaskFileAsAssignee(tenantOf(req), await actorOf(req), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), param(req, 'fileId'), Boolean(isSystemAdmin));
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.send(file.body);
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async myRemoveSubtaskFile(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.removeSubtaskFile(tenantOf(req), await actorOf(req), false, param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), param(req, 'fileId')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /* ── Anfragen an die Verwaltung (30.09.2026) ── */
    /** Bitte um Entsperren — auf dem Gerät (mit Produktionsrecht) und über «Görevlerim». */
    async requestUnlock(req, res, next) {
        try {
            res.status(201).json(await productionTasksModule_1.productionTasksModule.devices.requestUnlock(tenantOf(req), await actorOf(req), param(req, 'itemId'), param(req, 'taskId'), param(req, 'subtaskId'), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /** Projekte und Geräte mit Aufgaben — die Auswahl der Startseite der Verwaltung (30.09.2026). */
    async workload(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.workload(tenantOf(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async taskDevices(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.taskDevices(tenantOf(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async deviceRequests(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.listRequests(tenantOf(req), param(req, 'itemId'), req.query));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async solveDeviceRequest(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.solveRequest(tenantOf(req), await actorOf(req), param(req, 'itemId'), param(req, 'requestId')));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /** Der Verlauf einer Stufe (30.09.2026) — `?area=&stage=`, seitenweise, mit Arten, Person und Zeitraum. */
    async deviceActivities(req, res, next) {
        try {
            res.json(await productionTasksModule_1.productionTasksModule.devices.listActivities(tenantOf(req), param(req, 'itemId'), req.query));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
}
exports.ProductionTaskController = ProductionTaskController;
//# sourceMappingURL=ProductionTaskController.js.map