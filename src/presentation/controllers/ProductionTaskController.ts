import type { NextFunction, Request, Response } from 'express';

import { productionTasksModule } from '../composition/productionTasksModule';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
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
const roles = new RoleRepository();
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

    async assignDeviceSubtask(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.devices.assignSubtask(
                tenantOf(req),
                await actorOf(req),
                param(req, 'itemId'),
                param(req, 'taskId'),
                param(req, 'subtaskId'),
                req.body,
            ));
        } catch (error) { fail(res, next, error); }
    }

    async updateDeviceTasks(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.devices.updateTasks(tenantOf(req), await actorOf(req), param(req, 'itemId'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async addDeviceStage(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.devices.addStage(tenantOf(req), param(req, 'itemId'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async setDeviceTaskStatus(req: Request, res: Response, next: NextFunction) {
        try {
            // Keine Ausnahme für die Verwaltung (29.09.2026) — nur wer in der Aufgabe steht.
            res.json(await productionTasksModule.devices.setStatus(
                tenantOf(req),
                await actorOf(req),
                param(req, 'itemId'),
                param(req, 'taskId'),
                req.body,
            ));
        } catch (error) { fail(res, next, error); }
    }

    async setDeviceSubtaskStatus(req: Request, res: Response, next: NextFunction) {
        try {
            // Keine Ausnahme für die Verwaltung (29.09.2026) — nur wer an der Unteraufgabe steht.
            res.json(await productionTasksModule.devices.setSubtaskStatus(
                tenantOf(req),
                await actorOf(req),
                param(req, 'itemId'),
                param(req, 'taskId'),
                param(req, 'subtaskId'),
                req.body,
            ));
        } catch (error) { fail(res, next, error); }
    }

    async completeDeviceSubtask(req: Request, res: Response, next: NextFunction) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user!.id);
            res.json(await productionTasksModule.devices.completeSubtask(
                tenantOf(req),
                await actorOf(req),
                Boolean(isSystemAdmin),
                param(req, 'itemId'),
                param(req, 'taskId'),
                param(req, 'subtaskId'),
                req.body,
            ));
        } catch (error) { fail(res, next, error); }
    }

    async addDeviceSubtaskChecklistItem(req: Request, res: Response, next: NextFunction) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user!.id);
            res.json(await productionTasksModule.devices.addSubtaskChecklistItem(
                tenantOf(req),
                await actorOf(req),
                Boolean(isSystemAdmin),
                param(req, 'itemId'),
                param(req, 'taskId'),
                param(req, 'subtaskId'),
                req.body,
            ));
        } catch (error) { fail(res, next, error); }
    }

    async unlockDeviceSubtask(req: Request, res: Response, next: NextFunction) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user!.id);
            res.json(await productionTasksModule.devices.unlockSubtask(
                tenantOf(req),
                await actorOf(req),
                Boolean(isSystemAdmin),
                param(req, 'itemId'),
                param(req, 'taskId'),
                param(req, 'subtaskId'),
            ));
        } catch (error) { fail(res, next, error); }
    }

    async requestDeviceSubtaskRevision(req: Request, res: Response, next: NextFunction) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user!.id);
            res.json(await productionTasksModule.devices.requestSubtaskRevision(
                tenantOf(req),
                await actorOf(req),
                Boolean(isSystemAdmin),
                param(req, 'itemId'),
                param(req, 'taskId'),
                param(req, 'subtaskId'),
                req.body,
            ));
        } catch (error) { fail(res, next, error); }
    }

    async uploadDeviceSubtaskFile(req: Request, res: Response, next: NextFunction) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user!.id);
            const file = (req as Request & { file?: { buffer: Buffer; mimetype: string; originalname: string } }).file;
            res.json(await productionTasksModule.devices.uploadSubtaskFile(
                tenantOf(req),
                await actorOf(req),
                Boolean(isSystemAdmin),
                param(req, 'itemId'),
                param(req, 'taskId'),
                param(req, 'subtaskId'),
                // multer liefert den Namen als latin1 — zurück nach UTF-8 (wie beim Angebot der BOM).
                file ? { body: file.buffer, contentType: file.mimetype, fileName: Buffer.from(file.originalname, 'latin1').toString('utf8') } : null,
                // Neue Fassung einer vorhandenen Datei (Feld `revisionOf` im Formular, 28.09.2026).
                typeof req.body?.revisionOf === 'string' && req.body.revisionOf.trim() ? req.body.revisionOf.trim() : null,
                // … und was sich geändert hat (Feld `revisionNote`, Pflicht für eine neue Fassung).
                req.body?.revisionNote,
            ));
        } catch (error) { fail(res, next, error); }
    }

    async readDeviceSubtaskFile(req: Request, res: Response, next: NextFunction) {
        try {
            const file = await productionTasksModule.devices.readSubtaskFile(
                tenantOf(req),
                param(req, 'itemId'),
                param(req, 'taskId'),
                param(req, 'subtaskId'),
                param(req, 'fileId'),
            );
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'private, no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.send(file.body);
        } catch (error) { fail(res, next, error); }
    }

    async removeDeviceSubtaskFile(req: Request, res: Response, next: NextFunction) {
        try {
            const { isSystemAdmin } = await roles.getEmployeeRoleInfo(req.user!.id);
            res.json(await productionTasksModule.devices.removeSubtaskFile(
                tenantOf(req),
                await actorOf(req),
                Boolean(isSystemAdmin),
                param(req, 'itemId'),
                param(req, 'taskId'),
                param(req, 'subtaskId'),
                param(req, 'fileId'),
            ));
        } catch (error) { fail(res, next, error); }
    }

    async unloadDeviceTasks(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionTasksModule.devices.unload(tenantOf(req), param(req, 'itemId')));
        } catch (error) { fail(res, next, error); }
    }
}
