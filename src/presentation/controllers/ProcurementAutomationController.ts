import type { NextFunction, Request, Response } from 'express';

import { procurementAutomationModule } from '../composition/procurementAutomationModule';
import { productionBomModule } from '../composition/productionBomModule';
import type { ProcurementMailTrigger } from '../../infrastructure/repositories/ProcurementMailRepository';
import type { SupplierPdfLang } from '../../infrastructure/services/supplierPdfRenderer';
import { actorOf, fail } from './ProductionBomController';

/**
 * ── DIE WEGE DER AUTOMATIK (30.09.2026) ─────────────────────────────────────
 * Dünn: Anfrage lesen, Recht prüfen, Anwendungsfall rufen. Senden, Bestellen
 * und «Şimdi kontrol et» darf der Einkauf (Seite «Satın alma» Stufe 2) und die
 * Administratorrolle; die Postfächer ändert nur die Administratorrolle.
 */

const tenantOf = (req: Request) => req.user!.tenantId;
const param = (req: Request, name: string) => String(req.params[name] ?? '');

const TRIGGERS = new Set<ProcurementMailTrigger>(['MANUAL', 'RESEND']);
const LANGS = new Set<SupplierPdfLang>(['de', 'tr', 'en']);

export class ProcurementAutomationController {
    /* ── Postfächer ─────────────────────────────────────────────────────── */

    async listMailboxes(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await procurementAutomationModule.mailboxes.list(tenantOf(req), await actorOf(req)));
        } catch (error) { fail(res, next, error); }
    }

    async saveMailbox(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await procurementAutomationModule.mailboxes.save(tenantOf(req), await actorOf(req), param(req, 'purpose'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async removeMailbox(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await procurementAutomationModule.mailboxes.remove(tenantOf(req), await actorOf(req), param(req, 'purpose')));
        } catch (error) { fail(res, next, error); }
    }

    async testMailbox(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await procurementAutomationModule.mailboxes.test(tenantOf(req), await actorOf(req), param(req, 'purpose'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async checkInbox(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await procurementAutomationModule.mailboxes.check(tenantOf(req), await actorOf(req)));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Senden ─────────────────────────────────────────────────────────── */

    /** «Onayla ve gönder» · «Tekrar gönder» · «Gönder» (Preisanfrage) — ein Beleg. */
    async sendDocument(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            productionBomModule.procurement.assertCanProcure(actor);
            const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
            const trigger = TRIGGERS.has(body.trigger as ProcurementMailTrigger) ? body.trigger as ProcurementMailTrigger : 'MANUAL';
            const lang = LANGS.has(body.lang as SupplierPdfLang) ? body.lang as SupplierPdfLang : null;
            const to = typeof body.to === 'string' ? body.to : null;
            res.json(await procurementAutomationModule.dispatch.sendDocument(tenantOf(req), actor, param(req, 'purchaseOrderId'), { trigger, lang, to }));
        } catch (error) { fail(res, next, error); }
    }

    /** «Fiyat taleplerini gönder» — was ein Talep noch nicht hinausgeschickt hat (auch neue Lieferanten der Karten). */
    async dispatchRequest(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            productionBomModule.procurement.assertCanProcure(actor);
            // `send: false` — nur anlegen und nennen; die Seite sendet Beleg für Beleg (sichtbar).
            if ((req.body as Record<string, unknown> | undefined)?.send === false) {
                res.json({ pending: await procurementAutomationModule.dispatch.prepareRequest(tenantOf(req), actor, param(req, 'requestId')), results: [] });
                return;
            }
            res.json({ results: await procurementAutomationModule.dispatch.dispatchRequest(tenantOf(req), actor, param(req, 'requestId')), pending: [] });
        } catch (error) { fail(res, next, error); }
    }

    /** Sendungen und Antworten der Belege (`?ids=a,b`). */
    async dispatchStatus(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            productionBomModule.procurement.assertCanSee(actor);
            const ids = String(req.query.ids ?? '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 100);
            res.json({ items: await procurementAutomationModule.dispatch.status(tenantOf(req), ids) });
        } catch (error) { fail(res, next, error); }
    }

    /** Das verschickte PDF (`mail`) oder die Datei einer Antwort (`reply`). */
    async file(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            productionBomModule.procurement.assertCanSee(actor);
            const source = param(req, 'source') === 'reply' ? 'reply' : 'mail';
            const file = await procurementAutomationModule.dispatch.file(tenantOf(req), source, param(req, 'id'));
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'private, max-age=300');
            res.send(file.body);
        } catch (error) { fail(res, next, error); }
    }

    /** Das PDF eines Belegs, wie es jetzt hinausginge (nichts wird gesendet). */
    async documentPdf(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            productionBomModule.procurement.assertCanSee(actor);
            const file = await procurementAutomationModule.dispatch.documentPdf(tenantOf(req), param(req, 'purchaseOrderId'), actor.lang ?? null);
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'no-store');
            res.send(file.body);
        } catch (error) { fail(res, next, error); }
    }

    /* ── Bestellen aus dem Vergleich ────────────────────────────────────── */

    async ordersFromComparison(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.status(201).json(await procurementAutomationModule.ordering.createFromComparison(tenantOf(req), actor, param(req, 'comparisonId'), req.body));
        } catch (error) { fail(res, next, error); }
    }
}
