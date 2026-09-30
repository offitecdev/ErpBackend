"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcurementAutomationController = void 0;
const procurementAutomationModule_1 = require("../composition/procurementAutomationModule");
const productionBomModule_1 = require("../composition/productionBomModule");
const ProductionBomController_1 = require("./ProductionBomController");
/**
 * ── DIE WEGE DER AUTOMATIK (30.09.2026) ─────────────────────────────────────
 * Dünn: Anfrage lesen, Recht prüfen, Anwendungsfall rufen. Senden, Bestellen
 * und «Şimdi kontrol et» darf der Einkauf (Seite «Satın alma» Stufe 2) und die
 * Administratorrolle; die Postfächer ändert nur die Administratorrolle.
 */
const tenantOf = (req) => req.user.tenantId;
const param = (req, name) => String(req.params[name] ?? '');
const TRIGGERS = new Set(['MANUAL', 'RESEND']);
const LANGS = new Set(['de', 'tr', 'en']);
class ProcurementAutomationController {
    /* ── Postfächer ─────────────────────────────────────────────────────── */
    async listMailboxes(req, res, next) {
        try {
            res.json(await procurementAutomationModule_1.procurementAutomationModule.mailboxes.list(tenantOf(req), await (0, ProductionBomController_1.actorOf)(req)));
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
    async saveMailbox(req, res, next) {
        try {
            res.json(await procurementAutomationModule_1.procurementAutomationModule.mailboxes.save(tenantOf(req), await (0, ProductionBomController_1.actorOf)(req), param(req, 'purpose'), req.body));
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
    async removeMailbox(req, res, next) {
        try {
            res.json(await procurementAutomationModule_1.procurementAutomationModule.mailboxes.remove(tenantOf(req), await (0, ProductionBomController_1.actorOf)(req), param(req, 'purpose')));
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
    async testMailbox(req, res, next) {
        try {
            res.json(await procurementAutomationModule_1.procurementAutomationModule.mailboxes.test(tenantOf(req), await (0, ProductionBomController_1.actorOf)(req), param(req, 'purpose'), req.body));
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
    async checkInbox(req, res, next) {
        try {
            res.json(await procurementAutomationModule_1.procurementAutomationModule.mailboxes.check(tenantOf(req), await (0, ProductionBomController_1.actorOf)(req)));
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
    /* ── Senden ─────────────────────────────────────────────────────────── */
    /** «Onayla ve gönder» · «Tekrar gönder» · «Gönder» (Preisanfrage) — ein Beleg. */
    async sendDocument(req, res, next) {
        try {
            const actor = await (0, ProductionBomController_1.actorOf)(req);
            productionBomModule_1.productionBomModule.procurement.assertCanProcure(actor);
            const body = (req.body && typeof req.body === 'object' ? req.body : {});
            const trigger = TRIGGERS.has(body.trigger) ? body.trigger : 'MANUAL';
            const lang = LANGS.has(body.lang) ? body.lang : null;
            const to = typeof body.to === 'string' ? body.to : null;
            res.json(await procurementAutomationModule_1.procurementAutomationModule.dispatch.sendDocument(tenantOf(req), actor, param(req, 'purchaseOrderId'), { trigger, lang, to }));
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
    /** «Fiyat taleplerini gönder» — was ein Talep noch nicht hinausgeschickt hat (auch neue Lieferanten der Karten). */
    async dispatchRequest(req, res, next) {
        try {
            const actor = await (0, ProductionBomController_1.actorOf)(req);
            productionBomModule_1.productionBomModule.procurement.assertCanProcure(actor);
            // `send: false` — nur anlegen und nennen; die Seite sendet Beleg für Beleg (sichtbar).
            if (req.body?.send === false) {
                res.json({ pending: await procurementAutomationModule_1.procurementAutomationModule.dispatch.prepareRequest(tenantOf(req), actor, param(req, 'requestId')), results: [] });
                return;
            }
            res.json({ results: await procurementAutomationModule_1.procurementAutomationModule.dispatch.dispatchRequest(tenantOf(req), actor, param(req, 'requestId')), pending: [] });
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
    /** Sendungen und Antworten der Belege (`?ids=a,b`). */
    async dispatchStatus(req, res, next) {
        try {
            const actor = await (0, ProductionBomController_1.actorOf)(req);
            productionBomModule_1.productionBomModule.procurement.assertCanSee(actor);
            const ids = String(req.query.ids ?? '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 100);
            res.json({ items: await procurementAutomationModule_1.procurementAutomationModule.dispatch.status(tenantOf(req), ids) });
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
    /** Das verschickte PDF (`mail`) oder die Datei einer Antwort (`reply`). */
    async file(req, res, next) {
        try {
            const actor = await (0, ProductionBomController_1.actorOf)(req);
            productionBomModule_1.productionBomModule.procurement.assertCanSee(actor);
            const source = param(req, 'source') === 'reply' ? 'reply' : 'mail';
            const file = await procurementAutomationModule_1.procurementAutomationModule.dispatch.file(tenantOf(req), source, param(req, 'id'));
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'private, max-age=300');
            res.send(file.body);
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
    /** Das PDF eines Belegs, wie es jetzt hinausginge (nichts wird gesendet). */
    async documentPdf(req, res, next) {
        try {
            const actor = await (0, ProductionBomController_1.actorOf)(req);
            productionBomModule_1.productionBomModule.procurement.assertCanSee(actor);
            const file = await procurementAutomationModule_1.procurementAutomationModule.dispatch.documentPdf(tenantOf(req), param(req, 'purchaseOrderId'), actor.lang ?? null);
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'no-store');
            res.send(file.body);
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
    /* ── Bestellen aus dem Vergleich ────────────────────────────────────── */
    async ordersFromComparison(req, res, next) {
        try {
            const actor = await (0, ProductionBomController_1.actorOf)(req);
            res.status(201).json(await procurementAutomationModule_1.procurementAutomationModule.ordering.createFromComparison(tenantOf(req), actor, param(req, 'comparisonId'), req.body));
        }
        catch (error) {
            (0, ProductionBomController_1.fail)(res, next, error);
        }
    }
}
exports.ProcurementAutomationController = ProcurementAutomationController;
//# sourceMappingURL=ProcurementAutomationController.js.map