"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionBomController = exports.actorOf = exports.fail = void 0;
const productionBomModule_1 = require("../composition/productionBomModule");
const productionBom_1 = require("../../domain/services/productionBom");
const productionBomProcurement_1 = require("../../domain/services/productionBomProcurement");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
/**
 * ── DIE WEGE DER BOM (27.09.2026) ────────────────────────────────────────────
 * Dünn: Anfrage lesen, Anwendungsfall rufen, Antwort schreiben. Fachliche
 * Fehler tragen eine Kennung (`productionBom.err.*` in der Oberfläche); alles
 * andere landet als 500 im globalen Fehlerbehandler.
 */
const roles = new RoleRepository_1.RoleRepository();
const fail = (res, next, error) => {
    if ((0, productionBom_1.isBomError)(error)) {
        res.status(error.status).json((0, productionBom_1.bomErrorBody)(error));
        return;
    }
    next(error);
};
exports.fail = fail;
const tenantOf = (req) => req.user.tenantId;
const param = (req, name) => String(req.params[name] ?? '');
/** Wer handelt — Rolle und die zwei Rechte, die die BOM unterscheidet. */
/** Die Sprache der Oberfläche — die Seite schickt sie als `Accept-Language` (tr · de · en). */
const uiLangOf = (req) => {
    const first = String(req.get('accept-language') ?? '').split(',')[0]?.trim().slice(0, 2).toLowerCase();
    return first === 'de' || first === 'tr' || first === 'en' ? first : null;
};
const actorOf = async (req) => {
    const user = req.user;
    const [roleInfo, canManage, canPurchase] = await Promise.all([
        roles.getEmployeeRoleInfo(user.id),
        (0, RbacMiddleware_1.userHasPermission)(user.id, 'production.manage'),
        (0, RbacMiddleware_1.userHasPermission)(user.id, 'inventory.transfer'),
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
        lang: uiLangOf(req),
    };
};
exports.actorOf = actorOf;
/** Die Seite «Kalkülasyon» im Seitenkatalog. */
const COSTING_PAGE = 'production.costing';
/** Die Seite «Satın alma» im Seitenkatalog. */
const PROCUREMENT_PAGE = 'production.purchasing';
/**
 * «Tedarikçi ve fiyatlar gözükmesin» (27.09.2026 abends): wer den Einkauf
 * nicht sieht, bekommt jede BOM-Antwort ohne Lieferant und Preis.
 */
const shaped = (actor, payload) => (actor.isAdmin || actor.canSeeProcurement ? payload : (0, productionBomProcurement_1.withoutSupplierFacts)(payload));
class ProductionBomController {
    /** Die Schranke: nur in einer Produktionsfirma mit Produktionsmodul (wie das Depo). */
    static async requireAvailable(req, res, next) {
        try {
            if (await productionBomModule_1.productionBomModule.available(tenantOf(req)))
                return next();
            res.status(403).json((0, productionBom_1.bomErrorBody)((0, productionBom_1.bomError)('NOT_AVAILABLE', 'Die BOM gibt es nur in einer Produktionsfirma.', { status: 403 })));
        }
        catch (error) {
            next(error);
        }
    }
    /* ── Einstellungen ──────────────────────────────────────────────────── */
    async getSettings(req, res, next) {
        try {
            const [settings, actor] = await Promise.all([
                productionBomModule_1.productionBomModule.settings.get(tenantOf(req)),
                (0, exports.actorOf)(req),
            ]);
            res.json({ ...settings, canEdit: actor.isAdmin });
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async saveSettings(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json({ ...(await productionBomModule_1.productionBomModule.settings.save(tenantOf(req), actor, req.body)), canEdit: actor.isAdmin });
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /* ── Vorlagen ───────────────────────────────────────────────────────── */
    async listTemplates(req, res, next) {
        try {
            const [list, actor] = await Promise.all([productionBomModule_1.productionBomModule.templates.list(tenantOf(req)), (0, exports.actorOf)(req)]);
            res.json(shaped(actor, { ...list, canEdit: actor.isAdmin || actor.canManage }));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async getTemplate(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.templates.get(tenantOf(req), param(req, 'id'))));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async createTemplate(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.status(201).json(shaped(actor, await productionBomModule_1.productionBomModule.templates.create(tenantOf(req), actor, req.body)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async updateTemplate(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.templates.update(tenantOf(req), actor, param(req, 'id'), req.body)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async deleteTemplate(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.templates.remove(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'id')));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async seedExamples(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.templates.seedExamples(tenantOf(req), await (0, exports.actorOf)(req)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async searchProducts(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.templates.searchProducts(tenantOf(req), req.query.q)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /* ── BOMs eines Geräts ──────────────────────────────────────────────── */
    async deviceView(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.devices.view(tenantOf(req), actor, param(req, 'itemId'), req.query.area, req.query.view === 'summary')));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async addBom(req, res, next) {
        try {
            // Eine leere Alt-BOM unter der Haupt-BOM (Kod aus den Einstellungen).
            const actor = await (0, exports.actorOf)(req);
            res.status(201).json(shaped(actor, await productionBomModule_1.productionBomModule.devices.addSub(tenantOf(req), actor, param(req, 'itemId'), req.body)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async getBom(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            const tenantId = tenantOf(req);
            const bomId = param(req, 'bomId');
            const section = req.query.view;
            if (section === 'history')
                res.json(shaped(actor, await productionBomModule_1.productionBomModule.devices.history(tenantId, bomId)));
            else if (section === 'requests' || section === 'goods')
                res.json(shaped(actor, await productionBomModule_1.productionBomModule.devices.section(tenantId, bomId, section)));
            else
                res.json(shaped(actor, { bom: await productionBomModule_1.productionBomModule.devices.get(tenantId, bomId, section === 'lines') }));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async saveLines(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.devices.saveLines(tenantOf(req), actor, param(req, 'bomId'), req.body)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async deleteBom(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.devices.remove(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'bomId')));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async transition(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            const tenantId = tenantOf(req);
            const bomId = param(req, 'bomId');
            const action = param(req, 'action');
            const devices = productionBomModule_1.productionBomModule.devices;
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
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /* ── Revisionen (27.09.2026: «bom onaylanırsa geri dönüş yok, revize olması lazım») ── */
    async startRevision(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.status(201).json(shaped(actor, await productionBomModule_1.productionBomModule.revisions.start(tenantOf(req), actor, param(req, 'bomId'), req.body)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async discardRevision(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.revisions.discard(tenantOf(req), actor, param(req, 'bomId'))));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async revisionPreview(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.revisions.preview(tenantOf(req), actor, param(req, 'bomId'), req.query.keep)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /** «Onaya gönder» — die Revision bei der Administratorrolle einreichen (30.09.2026). */
    async submitRevision(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.revisions.submit(tenantOf(req), actor, param(req, 'bomId'))));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /** «Reddet» — nur die Administratorrolle. */
    async rejectRevision(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.revisions.reject(tenantOf(req), actor, param(req, 'bomId'), req.body)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async approveRevision(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.revisions.approve(tenantOf(req), actor, param(req, 'bomId'), req.body)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async revisionDetail(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.revisions.detail(tenantOf(req), param(req, 'bomId'), param(req, 'number'))));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async purchaseRevision(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.revisions.purchaseRevision(tenantOf(req), param(req, 'purchaseOrderId'), param(req, 'number'))));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async purchaseRevisionQuote(req, res, next) {
        try {
            const file = await productionBomModule_1.productionBomModule.revisions.purchaseRevisionQuote(tenantOf(req), param(req, 'purchaseOrderId'), param(req, 'number'));
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'private, no-store');
            res.send(file.body);
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async proposal(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.devices.proposal(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'bomId')));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async createOrders(req, res, next) {
        try {
            res.status(201).json(await productionBomModule_1.productionBomModule.devices.createOrders(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'bomId'), req.body));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async requestProposal(req, res, next) {
        try {
            const raw = req.query.procurementRequestId;
            const procurementRequestId = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 64) : null;
            res.json(await productionBomModule_1.productionBomModule.devices.requestProposal(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'bomId'), procurementRequestId));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async createRequests(req, res, next) {
        try {
            res.status(201).json(await productionBomModule_1.productionBomModule.devices.createRequests(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'bomId'), req.body));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /* ── Satın alma talebi (27.09.2026 abends) ───────────────────────────── */
    /** Die BOM stellt einen Talep: { kind: PRICE|ORDER, lines: [{ lineId, quantity, note }], note }. */
    async createProcurementRequest(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.status(201).json(shaped(actor, await productionBomModule_1.productionBomModule.procurement.createFromBom(tenantOf(req), actor, param(req, 'bomId'), req.body)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /** Die BOM zieht einen unberührten Talep zurück. */
    async withdrawProcurementRequest(req, res, next) {
        try {
            const actor = await (0, exports.actorOf)(req);
            res.json(shaped(actor, await productionBomModule_1.productionBomModule.procurement.cancelFromBom(tenantOf(req), actor, param(req, 'requestId'))));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /** «Satın alma» (28.09.2026): die Liste, 20 je Seite, mit Stand, nächstem Schritt und letztem Handgriff. */
    async procurementFeed(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.desk.feed(tenantOf(req), await (0, exports.actorOf)(req), req.query));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async getProcurement(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.desk.detail(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'requestId')));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async reportProcurement(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.desk.report(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'requestId'), req.body));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async saveProcurementSelection(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.desk.saveSelection(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'requestId'), req.body));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async setPurchasePrices(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.desk.setPrices(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'purchaseOrderId'), req.body));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /* ── Fiyat karşılaştırması (29.09.2026) ───────────────────────────────── */
    /** Bis zu vier Angebots-PDFs des Talep per KI vergleichen — gespeichert, danach eine eigene Seite. */
    async createComparison(req, res, next) {
        try {
            res.status(201).json(await productionBomModule_1.productionBomModule.comparisons.create(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'requestId'), req.body));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async listComparisons(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.comparisons.list(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'requestId')));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async getComparison(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.comparisons.get(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'comparisonId')));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async procurementAction(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.procurement.setStatus(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'requestId'), param(req, 'action')));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /* ── Kalkülasyon (27.09.2026 abends) ─────────────────────────────────── */
    async costingProjects(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.costing.projects(tenantOf(req), await (0, exports.actorOf)(req)));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async costingProject(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.costing.project(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'projectId')));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    /**
     * Die Wege der Assistenten und Belege erreicht auch der Einkauf ohne
     * Produktionsrechte: Stufe der Seite «Satın alma», Administratorrolle,
     * `production.view` oder `inventory.view`. Was er dort DARF, prüft der
     * Anwendungsfall (`canProcure`).
     */
    static async requireBomOrProcurement(req, res, next) {
        try {
            const user = req.user;
            const [roleInfo, view, inventory] = await Promise.all([
                roles.getEmployeeRoleInfo(user.id),
                (0, RbacMiddleware_1.userHasPermission)(user.id, 'production.view'),
                (0, RbacMiddleware_1.userHasPermission)(user.id, 'inventory.view'),
            ]);
            const pages = roleInfo?.pageAccess ?? {};
            if (roleInfo?.isSystemAdmin || view || inventory
                || Number(pages[PROCUREMENT_PAGE] ?? 0) >= 1 || Number(pages[COSTING_PAGE] ?? 0) >= 1)
                return next();
            res.status(403).json((0, productionBom_1.bomErrorBody)((0, productionBom_1.bomError)('FORBIDDEN', 'Kein Zugriff.', { status: 403 })));
        }
        catch (error) {
            next(error);
        }
    }
    /* ── Bestellungen einer BOM ─────────────────────────────────────────── */
    async setQuoteNumber(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.purchases.setQuoteNumber(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'purchaseOrderId'), req.body));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async uploadQuote(req, res, next) {
        try {
            const file = req.file;
            res.json(await productionBomModule_1.productionBomModule.purchases.uploadQuote(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'purchaseOrderId'), file ? { body: file.buffer, contentType: file.mimetype, fileName: Buffer.from(file.originalname, 'latin1').toString('utf8') } : null, { lean: req.query.lean === '1' }));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async readQuote(req, res, next) {
        try {
            const file = await productionBomModule_1.productionBomModule.purchases.readQuote(tenantOf(req), param(req, 'purchaseOrderId'));
            res.setHeader('Content-Type', file.contentType);
            res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
            res.setHeader('Cache-Control', 'private, no-store');
            res.send(file.body);
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async removeQuote(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.purchases.removeQuote(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'purchaseOrderId')));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async receive(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.purchases.receive(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'purchaseOrderId'), req.body));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
    async fillTable(req, res, next) {
        try {
            res.json(await productionBomModule_1.productionBomModule.purchases.fillTable(tenantOf(req), await (0, exports.actorOf)(req), param(req, 'purchaseOrderId'), req.body));
        }
        catch (error) {
            (0, exports.fail)(res, next, error);
        }
    }
}
exports.ProductionBomController = ProductionBomController;
//# sourceMappingURL=ProductionBomController.js.map