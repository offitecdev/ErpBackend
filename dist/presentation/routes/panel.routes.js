"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const ItGateMiddleware_1 = require("../middlewares/ItGateMiddleware");
const panelCatalog_1 = require("../../application/services/panelCatalog");
const panelModelNumber_1 = require("../../shared/panelModelNumber");
const panelSerial_1 = require("../../shared/panelSerial");
/**
 * ── /production/panels — SCHALTSCHRÄNKE (20.09.2026, Vorgabe Baris) ─────────
 *
 *   GET    /settings                  die acht Entscheidungen als Einstellung
 *   PUT    /settings                  … ändern (Verwaltung + IT-Schleuse)
 *   GET    /families                  Typenfamilien (CP, DB, MCC …)
 *   POST   /families                  anlegen        PATCH /families/:id
 *   DELETE /families/:id              nur solange kein Modell daran hängt
 *   POST   /models/preview            welche Modellnummer käme heraus?
 *   GET    /models                    Modelliste (Suche, Familie, aktiv)
 *   POST   /models                    Modell + Produktkarte + ERP-Code
 *   GET    /models/:id                Modell mit fehlenden Schildangaben
 *   PATCH  /models/:id                technische Werte pflegen
 *   DELETE /models/:id                nur ohne gebaute Schränke
 *   GET    /units                     Schränke (Serienliste, Filter, Suche)
 *   POST   /units                     `count` Seriennummern ziehen
 *   GET    /units/:id                 ein Schrank mit allem, was an ihm hängt
 *   PATCH  /units/:id                 Schaltplan, Kunde, Baustelle, Daten
 *   DELETE /units/:id                 nur vor Etikett/Lager/Fertigstellung
 *   POST   /units/:id/status          Stufe weiterschalten
 *   POST   /units/:id/stock-in        ins Lager buchen (IN, Menge 1)
 *   POST   /units/:id/label           Typenschild einfrieren + drucken
 *   GET    /lookup?serial=2026-000157 der Weg vom Etikett/QR zum Schrank
 *
 * Lesen darf, wer die Produktion ODER das Lager sieht (der Wareneingang fragt
 * mit); schreiben darf die Produktion.
 */
const router = (0, express_1.Router)();
const VIEW = (0, RbacMiddleware_1.requirePermission)('panels.view');
const MANAGE = (0, RbacMiddleware_1.requirePermission)('panels.manage');
/** Fachliche Fehler tragen eine Kennung; die Oberfläche übersetzt sie. */
const sendError = (res, error) => {
    const status = Number(error?.status) || 400;
    const body = { error: error?.message || 'Error' };
    if (error?.code)
        body.code = error.code;
    if (error?.details)
        body.details = error.details;
    return res.status(status).json(body);
};
/* ── EINSTELLUNGEN ──────────────────────────────────────────────────────────*/
router.get('/settings', VIEW, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const settings = await (0, panelCatalog_1.ensurePanelSettings)(tenantId);
        const scopeTenantId = await (0, panelCatalog_1.serialScopeTenantId)(tenantId, settings);
        const year = new Date().getFullYear();
        // Was die nächste Nummer wäre — die Seite zeigt es, ohne etwas zu ziehen.
        const docType = settings.serialYearlyReset ? `PANEL_SERIAL:${year}` : 'PANEL_SERIAL';
        const rows = await prisma_client_1.default.$queryRaw `
            SELECT \`lastValue\` FROM \`DocumentCounter\`
            WHERE \`tenantId\` = ${scopeTenantId} AND \`docType\` = ${docType}
            LIMIT 1`;
        const lastValue = Number(rows?.[0]?.lastValue ?? 0);
        res.json({
            settings,
            scopeTenantId,
            nextSerialPreview: (0, panelSerial_1.formatPanelSerial)(year, lastValue + 1, settings.serialDigits),
            ratingUnits: panelModelNumber_1.PANEL_RATING_UNITS.map((unit) => ({ value: unit, label: (0, panelModelNumber_1.ratingUnitLabel)(unit) || unit })),
            defaultFamilies: panelCatalog_1.DEFAULT_TYPE_FAMILIES,
        });
    }
    catch (error) {
        sendError(res, error);
    }
});
// Einstellungen sind Sache der Verwaltung und stehen hinter dem IT-Kennwort —
// wie das übrige Einstellungsmenü.
router.put('/settings', (0, RbacMiddleware_1.requirePermission)('roles.manage'), ItGateMiddleware_1.requireItGate, async (req, res) => {
    try {
        res.json(await (0, panelCatalog_1.savePanelSettings)(req.user.tenantId, req.body || {}, req.user.id));
    }
    catch (error) {
        sendError(res, error);
    }
});
/* ── TYPENFAMILIEN (FRAGE 1 + 2 + 6) ────────────────────────────────────────*/
router.get('/families', VIEW, async (req, res) => {
    try {
        const families = await (0, panelCatalog_1.listTypeFamilies)(req.user.tenantId, { activeOnly: req.query.active === 'true' });
        res.json(families);
    }
    catch (error) {
        sendError(res, error);
    }
});
router.post('/families', MANAGE, async (req, res) => {
    try {
        res.status(201).json(await (0, panelCatalog_1.saveTypeFamily)(req.user.tenantId, null, req.body || {}));
    }
    catch (error) {
        sendError(res, error);
    }
});
router.patch('/families/:id', MANAGE, async (req, res) => {
    try {
        res.json(await (0, panelCatalog_1.saveTypeFamily)(req.user.tenantId, String(req.params.id), req.body || {}));
    }
    catch (error) {
        sendError(res, error);
    }
});
router.delete('/families/:id', MANAGE, async (req, res) => {
    try {
        await (0, panelCatalog_1.deleteTypeFamily)(req.user.tenantId, String(req.params.id));
        res.status(204).send();
    }
    catch (error) {
        sendError(res, error);
    }
});
/* ── MODELLE ────────────────────────────────────────────────────────────────*/
/** Die Nummer, die herauskäme — die Maske zeigt sie, während getippt wird. */
router.post('/models/preview', VIEW, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const settings = await (0, panelCatalog_1.ensurePanelSettings)(tenantId);
        const family = await prisma_client_1.default.panelTypeFamily.findFirst({
            where: { id: String(req.body?.typeFamilyId || ''), tenantId },
        });
        if (!family)
            return sendError(res, { status: 404, code: 'FAMILY_NOT_FOUND', message: 'Typenfamilie nicht gefunden.' });
        const modelNumber = (0, panelModelNumber_1.formatPanelModelNumber)({
            prefix: settings.modelPrefix,
            typeCode: family.code,
            ratingValue: Number(req.body?.ratingValue) || 0,
            variantCode: req.body?.variantCode || null,
        });
        const taken = await prisma_client_1.default.panelModel.findFirst({ where: { tenantId, modelNumber }, select: { id: true } });
        res.json({
            modelNumber,
            taken: Boolean(taken),
            takenBy: taken?.id || null,
            ratingUnit: family.ratingUnit,
            ratingUnitLabel: (0, panelModelNumber_1.ratingUnitLabel)(family.ratingUnit),
            requiresShortCircuit: family.requiresShortCircuit,
        });
    }
    catch (error) {
        sendError(res, error);
    }
});
router.get('/models', VIEW, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const search = String(req.query.q || '').trim();
        const where = { tenantId };
        if (req.query.familyId)
            where.typeFamilyId = String(req.query.familyId);
        if (req.query.active === 'true')
            where.isActive = true;
        if (search) {
            where.OR = [
                { modelNumber: { contains: search } },
                { typeCode: { contains: search } },
            ];
        }
        const models = await prisma_client_1.default.panelModel.findMany({
            where,
            include: { typeFamily: true, _count: { select: { units: true } } },
            orderBy: [{ typeCode: 'asc' }, { ratingValue: 'asc' }],
            take: 500,
        });
        // Die Produktkarte liefert Bezeichnung und ERP-Code dazu.
        const articleIds = models.map((model) => model.articleId).filter(Boolean);
        const articles = articleIds.length
            ? await prisma_client_1.default.article.findMany({
                where: { id: { in: articleIds } },
                select: { id: true, articleCode: true, name: true, unit: true, salePrice: true },
            })
            : [];
        const articleById = new Map(articles.map((row) => [row.id, row]));
        res.json(models.map((model) => ({
            ...model,
            article: articleById.get(model.articleId) || null,
            unitCount: model._count?.units ?? 0,
        })));
    }
    catch (error) {
        sendError(res, error);
    }
});
router.post('/models', MANAGE, async (req, res) => {
    try {
        res.status(201).json(await (0, panelCatalog_1.createPanelModel)(req.user.tenantId, req.body || {}, req.user.id));
    }
    catch (error) {
        sendError(res, error);
    }
});
router.get('/models/:id', VIEW, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const model = await prisma_client_1.default.panelModel.findFirst({
            where: { id: String(req.params.id), tenantId },
            include: { typeFamily: true },
        });
        if (!model)
            return sendError(res, { status: 404, code: 'MODEL_NOT_FOUND', message: 'Modell nicht gefunden.' });
        const article = model.articleId
            ? await prisma_client_1.default.article.findFirst({
                where: { id: model.articleId },
                select: { id: true, articleCode: true, name: true, unit: true, salePrice: true },
            })
            : null;
        res.json({ ...model, article, missingNameplate: (0, panelCatalog_1.missingNameplateFields)(model, model.typeFamily) });
    }
    catch (error) {
        sendError(res, error);
    }
});
router.patch('/models/:id', MANAGE, async (req, res) => {
    try {
        res.json(await (0, panelCatalog_1.updatePanelModel)(req.user.tenantId, String(req.params.id), req.body || {}));
    }
    catch (error) {
        sendError(res, error);
    }
});
router.delete('/models/:id', MANAGE, async (req, res) => {
    try {
        await (0, panelCatalog_1.deletePanelModel)(req.user.tenantId, String(req.params.id));
        res.status(204).send();
    }
    catch (error) {
        sendError(res, error);
    }
});
/* ── SCHRÄNKE / SERIENNUMMERN ───────────────────────────────────────────────*/
router.get('/units', VIEW, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const where = { tenantId };
        if (req.query.status)
            where.status = String(req.query.status).toUpperCase();
        if (req.query.modelId)
            where.panelModelId = String(req.query.modelId);
        if (req.query.projectId)
            where.projectId = String(req.query.projectId);
        if (req.query.productionProjectId)
            where.productionProjectId = String(req.query.productionProjectId);
        const search = String(req.query.q || '').trim();
        if (search) {
            where.OR = [
                { serialNumber: { contains: search } },
                { modelNumberSnapshot: { contains: search } },
                { orderNumber: { contains: search } },
                { customerName: { contains: search } },
                { schemaNumber: { contains: search } },
            ];
        }
        const take = Math.min(500, Math.max(1, Number(req.query.take) || 200));
        const [rows, total] = await Promise.all([
            prisma_client_1.default.panelUnit.findMany({
                where,
                include: { model: { select: { modelNumber: true, typeCode: true, ratingValue: true, ratingUnit: true } } },
                orderBy: [{ serialYear: 'desc' }, { serialSeq: 'desc' }],
                take,
                skip: Math.max(0, Number(req.query.skip) || 0),
            }),
            prisma_client_1.default.panelUnit.count({ where }),
        ]);
        res.json({ rows, total });
    }
    catch (error) {
        sendError(res, error);
    }
});
/** `count` Seriennummern ziehen — der Augenblick, in dem Schränke entstehen. */
router.post('/units', MANAGE, async (req, res) => {
    try {
        const units = await (0, panelCatalog_1.issuePanelUnits)(req.user.tenantId, req.body || {}, req.user.id);
        res.status(201).json({ units, count: units.length });
    }
    catch (error) {
        sendError(res, error);
    }
});
router.get('/units/:id', VIEW, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const unit = await prisma_client_1.default.panelUnit.findFirst({
            where: { id: String(req.params.id), tenantId },
            include: { model: { include: { typeFamily: true } } },
        });
        if (!unit)
            return sendError(res, { status: 404, code: 'UNIT_NOT_FOUND', message: 'Schaltschrank nicht gefunden.' });
        // Die Lagerbewegungen, die seine Seriennummer tragen — der Lebenslauf
        // im Lager (Zugang aus der Fertigung, Abgang bei der Lieferung).
        const movements = await prisma_client_1.default.stockMovement.findMany({
            where: { tenantId, serialNumber: unit.serialNumber },
            select: { id: true, movementType: true, quantity: true, transactionDate: true, origin: true, description: true },
            orderBy: { transactionDate: 'desc' },
            take: 50,
        });
        res.json({
            ...unit,
            movements,
            missingNameplate: (0, panelCatalog_1.missingNameplateFields)(unit.model, unit.model?.typeFamily),
        });
    }
    catch (error) {
        sendError(res, error);
    }
});
router.patch('/units/:id', MANAGE, async (req, res) => {
    try {
        res.json(await (0, panelCatalog_1.updatePanelUnit)(req.user.tenantId, String(req.params.id), req.body || {}));
    }
    catch (error) {
        sendError(res, error);
    }
});
router.delete('/units/:id', MANAGE, async (req, res) => {
    try {
        await (0, panelCatalog_1.deletePanelUnit)(req.user.tenantId, String(req.params.id));
        res.status(204).send();
    }
    catch (error) {
        sendError(res, error);
    }
});
router.post('/units/:id/status', MANAGE, async (req, res) => {
    try {
        res.json(await (0, panelCatalog_1.setPanelUnitStatus)(req.user.tenantId, String(req.params.id), String(req.body?.status || ''), req.user.id));
    }
    catch (error) {
        sendError(res, error);
    }
});
router.post('/units/:id/stock-in', MANAGE, async (req, res) => {
    try {
        res.json(await (0, panelCatalog_1.stockInPanelUnit)(req.user.tenantId, String(req.params.id), req.user.id, req.body || {}));
    }
    catch (error) {
        sendError(res, error);
    }
});
router.post('/units/:id/label', MANAGE, async (req, res) => {
    try {
        res.json(await (0, panelCatalog_1.freezeNameplate)(req.user.tenantId, String(req.params.id), req.user.id));
    }
    catch (error) {
        sendError(res, error);
    }
});
/* ── VOM ETIKETT ZUM SCHRANK ────────────────────────────────────────────────*/
router.get('/lookup', (0, RbacMiddleware_1.requireAnyPermission)(['panels.view', 'inventory.view']), async (req, res) => {
    try {
        const unit = await (0, panelCatalog_1.findPanelBySerial)(req.user.tenantId, String(req.query.serial || ''));
        if (!unit)
            return res.status(404).json({ error: 'Zu dieser Seriennummer gibt es keinen Schrank.', code: 'SERIAL_UNKNOWN' });
        res.json(unit);
    }
    catch (error) {
        sendError(res, error);
    }
});
exports.default = router;
//# sourceMappingURL=panel.routes.js.map