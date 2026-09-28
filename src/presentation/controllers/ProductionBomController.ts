import type { NextFunction, Request, Response } from 'express';

import { productionBomModule } from '../composition/productionBomModule';
import { bomError, bomErrorBody, isBomError } from '../../domain/services/productionBom';
import { withoutSupplierFacts } from '../../domain/services/productionBomProcurement';
import type { BomActor } from '../../application/use-cases/production/bom/BomTemplatesUseCase';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
import { userHasPermission } from '../middlewares/RbacMiddleware';

/**
 * ── DIE WEGE DER BOM (27.09.2026) ────────────────────────────────────────────
 * Dünn: Anfrage lesen, Anwendungsfall rufen, Antwort schreiben. Fachliche
 * Fehler tragen eine Kennung (`productionBom.err.*` in der Oberfläche); alles
 * andere landet als 500 im globalen Fehlerbehandler.
 */

const roles = new RoleRepository();

const fail = (res: Response, next: NextFunction, error: unknown) => {
    if (isBomError(error)) {
        res.status(error.status).json(bomErrorBody(error));
        return;
    }
    next(error);
};

const tenantOf = (req: Request) => req.user!.tenantId;
const param = (req: Request, name: string) => String(req.params[name] ?? '');

/** Wer handelt — Rolle und die zwei Rechte, die die BOM unterscheidet. */
const actorOf = async (req: Request): Promise<BomActor> => {
    const user = req.user!;
    const [roleInfo, canManage, canPurchase] = await Promise.all([
        roles.getEmployeeRoleInfo(user.id),
        userHasPermission(user.id, 'production.manage'),
        userHasPermission(user.id, 'inventory.transfer'),
    ]);
    const fromToken = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    // «Satın alma» (27.09.2026 abends): Buchhaltung / Administratorrolle — die Seitenstufe
    // (mit der Vererbung von «Giden faturalar», siehe PAGE_LEVEL_FALLBACKS).
    const procurementLevel = Number(roleInfo?.pageAccess?.[PROCUREMENT_PAGE] ?? 0);
    return {
        id: user.id,
        name: fromToken || null,
        isAdmin: Boolean(roleInfo?.isSystemAdmin),
        canManage,
        canPurchase,
        canSeeProcurement: procurementLevel >= 1,
        canProcure: procurementLevel >= 2,
        canSeeCosting: Number(roleInfo?.pageAccess?.[COSTING_PAGE] ?? 0) >= 1,
    };
};

/** Die Seite «Kalkülasyon» im Seitenkatalog. */
const COSTING_PAGE = 'production.costing';

/** Die Seite «Satın alma» im Seitenkatalog. */
const PROCUREMENT_PAGE = 'production.purchasing';

/**
 * «Tedarikçi ve fiyatlar gözükmesin» (27.09.2026 abends): wer den Einkauf
 * nicht sieht, bekommt jede BOM-Antwort ohne Lieferant und Preis.
 */
const shaped = <T>(actor: BomActor, payload: T): T =>
    (actor.isAdmin || actor.canSeeProcurement ? payload : withoutSupplierFacts(payload));

export class ProductionBomController {
    /** Die Schranke: nur in einer Produktionsfirma mit Produktionsmodul (wie das Depo). */
    static async requireAvailable(req: Request, res: Response, next: NextFunction) {
        try {
            if (await productionBomModule.available(tenantOf(req))) return next();
            res.status(403).json(bomErrorBody(bomError('NOT_AVAILABLE', 'Die BOM gibt es nur in einer Produktionsfirma.', { status: 403 })));
        } catch (error) {
            next(error);
        }
    }

    /* ── Einstellungen ──────────────────────────────────────────────────── */

    async getSettings(req: Request, res: Response, next: NextFunction) {
        try {
            const [settings, actor] = await Promise.all([
                productionBomModule.settings.get(tenantOf(req)),
                actorOf(req),
            ]);
            res.json({ ...settings, canEdit: actor.isAdmin });
        } catch (error) { fail(res, next, error); }
    }

    async saveSettings(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json({ ...(await productionBomModule.settings.save(tenantOf(req), actor, req.body)), canEdit: actor.isAdmin });
        } catch (error) { fail(res, next, error); }
    }

    /* ── Vorlagen ───────────────────────────────────────────────────────── */

    async listTemplates(req: Request, res: Response, next: NextFunction) {
        try {
            const [list, actor] = await Promise.all([productionBomModule.templates.list(tenantOf(req)), actorOf(req)]);
            res.json(shaped(actor, { ...list, canEdit: actor.isAdmin || actor.canManage }));
        } catch (error) { fail(res, next, error); }
    }

    async getTemplate(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.templates.get(tenantOf(req), param(req, 'id'))));
        } catch (error) { fail(res, next, error); }
    }

    async createTemplate(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.status(201).json(shaped(actor, await productionBomModule.templates.create(tenantOf(req), actor, req.body)));
        } catch (error) { fail(res, next, error); }
    }

    async updateTemplate(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.templates.update(tenantOf(req), actor, param(req, 'id'), req.body)));
        } catch (error) { fail(res, next, error); }
    }

    async deleteTemplate(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.templates.remove(tenantOf(req), await actorOf(req), param(req, 'id')));
        } catch (error) { fail(res, next, error); }
    }

    async seedExamples(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.templates.seedExamples(tenantOf(req), await actorOf(req)));
        } catch (error) { fail(res, next, error); }
    }

    async searchProducts(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.templates.searchProducts(tenantOf(req), req.query.q)));
        } catch (error) { fail(res, next, error); }
    }

    /* ── BOMs eines Geräts ──────────────────────────────────────────────── */

    async deviceView(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.devices.view(tenantOf(req), actor, param(req, 'itemId'), req.query.area)));
        } catch (error) { fail(res, next, error); }
    }

    async addBom(req: Request, res: Response, next: NextFunction) {
        try {
            // Eine leere Alt-BOM unter der Haupt-BOM (Kod aus den Einstellungen).
            const actor = await actorOf(req);
            res.status(201).json(shaped(actor, await productionBomModule.devices.addSub(tenantOf(req), actor, param(req, 'itemId'), req.body)));
        } catch (error) { fail(res, next, error); }
    }

    async getBom(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, { bom: await productionBomModule.devices.get(tenantOf(req), param(req, 'bomId')) }));
        } catch (error) { fail(res, next, error); }
    }

    async saveLines(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.devices.saveLines(tenantOf(req), actor, param(req, 'bomId'), req.body)));
        } catch (error) { fail(res, next, error); }
    }

    async deleteBom(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.devices.remove(tenantOf(req), await actorOf(req), param(req, 'bomId')));
        } catch (error) { fail(res, next, error); }
    }

    async transition(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            const tenantId = tenantOf(req);
            const bomId = param(req, 'bomId');
            const action = param(req, 'action');
            const devices = productionBomModule.devices;
            const result = action === 'approve' ? await devices.approve(tenantId, actor, bomId)
                : action === 'unapprove' ? await devices.unapprove(tenantId, actor, bomId)
                    : action === 'complete' ? await devices.complete(tenantId, actor, bomId)
                        : action === 'reopen' ? await devices.reopen(tenantId, actor, bomId)
                            : action === 'consume' ? await devices.consume(tenantId, actor, bomId)
                                : null;
            if (!result) {
                res.status(404).json({ error: 'Unbekannte Handlung.', code: 'NOT_FOUND' });
                return;
            }
            res.json(shaped(actor, result));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Revisionen (27.09.2026: «bom onaylanırsa geri dönüş yok, revize olması lazım») ── */

    async startRevision(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.status(201).json(shaped(actor, await productionBomModule.revisions.start(tenantOf(req), actor, param(req, 'bomId'), req.body)));
        } catch (error) { fail(res, next, error); }
    }

    async discardRevision(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.revisions.discard(tenantOf(req), actor, param(req, 'bomId'))));
        } catch (error) { fail(res, next, error); }
    }

    async revisionPreview(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.revisions.preview(tenantOf(req), actor, param(req, 'bomId'), req.query.keep)));
        } catch (error) { fail(res, next, error); }
    }

    async approveRevision(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.revisions.approve(tenantOf(req), actor, param(req, 'bomId'), req.body)));
        } catch (error) { fail(res, next, error); }
    }

    async revisionDetail(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.revisions.detail(tenantOf(req), param(req, 'bomId'), param(req, 'number'))));
        } catch (error) { fail(res, next, error); }
    }

    async purchaseRevision(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.revisions.purchaseRevision(tenantOf(req), param(req, 'purchaseOrderId'), param(req, 'number'))));
        } catch (error) { fail(res, next, error); }
    }

    async purchaseRevisionQuote(req: Request, res: Response, next: NextFunction) {
        try {
            const file = await productionBomModule.revisions.purchaseRevisionQuote(tenantOf(req), param(req, 'purchaseOrderId'), param(req, 'number'));
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'private, no-store');
            res.send(file.body);
        } catch (error) { fail(res, next, error); }
    }

    async proposal(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.devices.proposal(tenantOf(req), await actorOf(req), param(req, 'bomId')));
        } catch (error) { fail(res, next, error); }
    }

    async createOrders(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(201).json(await productionBomModule.devices.createOrders(tenantOf(req), await actorOf(req), param(req, 'bomId'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async requestProposal(req: Request, res: Response, next: NextFunction) {
        try {
            const raw = req.query.procurementRequestId;
            const procurementRequestId = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 64) : null;
            res.json(await productionBomModule.devices.requestProposal(tenantOf(req), await actorOf(req), param(req, 'bomId'), procurementRequestId));
        } catch (error) { fail(res, next, error); }
    }

    async createRequests(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(201).json(await productionBomModule.devices.createRequests(tenantOf(req), await actorOf(req), param(req, 'bomId'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Satın alma talebi (27.09.2026 abends) ───────────────────────────── */

    /** Die BOM stellt einen Talep: { kind: PRICE|ORDER, lines: [{ lineId, quantity, note }], note }. */
    async createProcurementRequest(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.status(201).json(shaped(actor, await productionBomModule.procurement.createFromBom(tenantOf(req), actor, param(req, 'bomId'), req.body)));
        } catch (error) { fail(res, next, error); }
    }

    /** Die BOM zieht einen unberührten Talep zurück. */
    async withdrawProcurementRequest(req: Request, res: Response, next: NextFunction) {
        try {
            const actor = await actorOf(req);
            res.json(shaped(actor, await productionBomModule.procurement.cancelFromBom(tenantOf(req), actor, param(req, 'requestId'))));
        } catch (error) { fail(res, next, error); }
    }

    /** «Satın alma» (28.09.2026): die Liste, 20 je Seite, mit Stand, nächstem Schritt und letztem Handgriff. */
    async procurementFeed(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.desk.feed(tenantOf(req), await actorOf(req), req.query as Record<string, unknown>));
        } catch (error) { fail(res, next, error); }
    }

    async getProcurement(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.desk.detail(tenantOf(req), await actorOf(req), param(req, 'requestId')));
        } catch (error) { fail(res, next, error); }
    }

    async reportProcurement(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.desk.report(tenantOf(req), await actorOf(req), param(req, 'requestId'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async saveProcurementSelection(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.desk.saveSelection(tenantOf(req), await actorOf(req), param(req, 'requestId'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async setPurchasePrices(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.desk.setPrices(tenantOf(req), await actorOf(req), param(req, 'purchaseOrderId'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async procurementAction(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.procurement.setStatus(tenantOf(req), await actorOf(req), param(req, 'requestId'), param(req, 'action')));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Kalkülasyon (27.09.2026 abends) ─────────────────────────────────── */

    async costingProjects(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.costing.projects(tenantOf(req), await actorOf(req)));
        } catch (error) { fail(res, next, error); }
    }

    async costingProject(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.costing.project(tenantOf(req), await actorOf(req), param(req, 'projectId')));
        } catch (error) { fail(res, next, error); }
    }

    /**
     * Die Wege der Assistenten und Belege erreicht auch der Einkauf ohne
     * Produktionsrechte: Stufe der Seite «Satın alma», Administratorrolle,
     * `production.view` oder `inventory.view`. Was er dort DARF, prüft der
     * Anwendungsfall (`canProcure`).
     */
    static async requireBomOrProcurement(req: Request, res: Response, next: NextFunction) {
        try {
            const user = req.user!;
            const [roleInfo, view, inventory] = await Promise.all([
                roles.getEmployeeRoleInfo(user.id),
                userHasPermission(user.id, 'production.view'),
                userHasPermission(user.id, 'inventory.view'),
            ]);
            const pages = roleInfo?.pageAccess ?? {};
            if (roleInfo?.isSystemAdmin || view || inventory
                || Number(pages[PROCUREMENT_PAGE] ?? 0) >= 1 || Number(pages[COSTING_PAGE] ?? 0) >= 1) return next();
            res.status(403).json(bomErrorBody(bomError('FORBIDDEN', 'Kein Zugriff.', { status: 403 })));
        } catch (error) {
            next(error);
        }
    }

    /* ── Bestellungen einer BOM ─────────────────────────────────────────── */

    async setQuoteNumber(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.purchases.setQuoteNumber(tenantOf(req), await actorOf(req), param(req, 'purchaseOrderId'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async uploadQuote(req: Request, res: Response, next: NextFunction) {
        try {
            const file = (req as Request & { file?: { buffer: Buffer; mimetype: string; originalname: string } }).file;
            res.json(await productionBomModule.purchases.uploadQuote(
                tenantOf(req),
                await actorOf(req),
                param(req, 'purchaseOrderId'),
                file ? { body: file.buffer, contentType: file.mimetype, fileName: Buffer.from(file.originalname, 'latin1').toString('utf8') } : null,
            ));
        } catch (error) { fail(res, next, error); }
    }

    async readQuote(req: Request, res: Response, next: NextFunction) {
        try {
            const file = await productionBomModule.purchases.readQuote(tenantOf(req), param(req, 'purchaseOrderId'));
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'private, no-store');
            res.send(file.body);
        } catch (error) { fail(res, next, error); }
    }

    async removeQuote(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.purchases.removeQuote(tenantOf(req), await actorOf(req), param(req, 'purchaseOrderId')));
        } catch (error) { fail(res, next, error); }
    }

    async receive(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.purchases.receive(tenantOf(req), await actorOf(req), param(req, 'purchaseOrderId'), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async fillTable(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await productionBomModule.purchases.fillTable(tenantOf(req), await actorOf(req), param(req, 'purchaseOrderId'), req.body));
        } catch (error) { fail(res, next, error); }
    }
}
