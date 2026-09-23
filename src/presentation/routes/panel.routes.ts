import { Router } from 'express';
import prisma from '../../infrastructure/database/prisma.client';
import { requirePermission, requireAnyPermission } from '../middlewares/RbacMiddleware';
import { requireItGate } from '../middlewares/ItGateMiddleware';
import {
    ensurePanelSettings,
    savePanelSettings,
    listTypeFamilies,
    saveTypeFamily,
    deleteTypeFamily,
    createPanelModel,
    updatePanelModel,
    deletePanelModel,
    issuePanelUnits,
    stockInPanelUnit,
    freezeNameplate,
    setPanelUnitStatus,
    updatePanelUnit,
    deletePanelUnit,
    findPanelBySerial,
    missingNameplateFields,
    serialScopeTenantId,
    DEFAULT_TYPE_FAMILIES,
} from '../../application/services/panelCatalog';
import { formatPanelModelNumber, ratingUnitLabel, PANEL_RATING_UNITS } from '../../shared/panelModelNumber';
import { formatPanelSerial } from '../../shared/panelSerial';

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
const router = Router();

const VIEW = requirePermission('panels.view');
const MANAGE = requirePermission('panels.manage');

/** Fachliche Fehler tragen eine Kennung; die Oberfläche übersetzt sie. */
const sendError = (res: any, error: any) => {
    const status = Number(error?.status) || 400;
    const body: any = { error: error?.message || 'Error' };
    if (error?.code) body.code = error.code;
    if (error?.details) body.details = error.details;
    return res.status(status).json(body);
};

/* ── EINSTELLUNGEN ──────────────────────────────────────────────────────────*/

router.get('/settings', VIEW, async (req: any, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const settings = await ensurePanelSettings(tenantId);
        const scopeTenantId = await serialScopeTenantId(tenantId, settings);
        const year = new Date().getFullYear();
        // Was die nächste Nummer wäre — die Seite zeigt es, ohne etwas zu ziehen.
        const docType = settings.serialYearlyReset ? `PANEL_SERIAL:${year}` : 'PANEL_SERIAL';
        const rows: any[] = await (prisma as any).$queryRaw`
            SELECT \`lastValue\` FROM \`DocumentCounter\`
            WHERE \`tenantId\` = ${scopeTenantId} AND \`docType\` = ${docType}
            LIMIT 1`;
        const lastValue = Number(rows?.[0]?.lastValue ?? 0);
        res.json({
            settings,
            scopeTenantId,
            nextSerialPreview: formatPanelSerial(year, lastValue + 1, settings.serialDigits),
            ratingUnits: PANEL_RATING_UNITS.map((unit) => ({ value: unit, label: ratingUnitLabel(unit) || unit })),
            defaultFamilies: DEFAULT_TYPE_FAMILIES,
        });
    } catch (error) { sendError(res, error); }
});

// Einstellungen sind Sache der Verwaltung und stehen hinter dem IT-Kennwort —
// wie das übrige Einstellungsmenü.
router.put('/settings', requirePermission('roles.manage'), requireItGate, async (req: any, res) => {
    try {
        res.json(await savePanelSettings(req.user!.tenantId, req.body || {}, req.user!.id));
    } catch (error) { sendError(res, error); }
});

/* ── TYPENFAMILIEN (FRAGE 1 + 2 + 6) ────────────────────────────────────────*/

router.get('/families', VIEW, async (req: any, res) => {
    try {
        const families = await listTypeFamilies(req.user!.tenantId, { activeOnly: req.query.active === 'true' });
        res.json(families);
    } catch (error) { sendError(res, error); }
});

router.post('/families', MANAGE, async (req: any, res) => {
    try {
        res.status(201).json(await saveTypeFamily(req.user!.tenantId, null, req.body || {}));
    } catch (error) { sendError(res, error); }
});

router.patch('/families/:id', MANAGE, async (req: any, res) => {
    try {
        res.json(await saveTypeFamily(req.user!.tenantId, String(req.params.id), req.body || {}));
    } catch (error) { sendError(res, error); }
});

router.delete('/families/:id', MANAGE, async (req: any, res) => {
    try {
        await deleteTypeFamily(req.user!.tenantId, String(req.params.id));
        res.status(204).send();
    } catch (error) { sendError(res, error); }
});

/* ── MODELLE ────────────────────────────────────────────────────────────────*/

/** Die Nummer, die herauskäme — die Maske zeigt sie, während getippt wird. */
router.post('/models/preview', VIEW, async (req: any, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const settings = await ensurePanelSettings(tenantId);
        const family = await (prisma as any).panelTypeFamily.findFirst({
            where: { id: String(req.body?.typeFamilyId || ''), tenantId },
        });
        if (!family) return sendError(res, { status: 404, code: 'FAMILY_NOT_FOUND', message: 'Typenfamilie nicht gefunden.' });

        const modelNumber = formatPanelModelNumber({
            prefix: settings.modelPrefix,
            typeCode: family.code,
            ratingValue: Number(req.body?.ratingValue) || 0,
            variantCode: req.body?.variantCode || null,
        });
        const taken = await (prisma as any).panelModel.findFirst({ where: { tenantId, modelNumber }, select: { id: true } });
        res.json({
            modelNumber,
            taken: Boolean(taken),
            takenBy: taken?.id || null,
            ratingUnit: family.ratingUnit,
            ratingUnitLabel: ratingUnitLabel(family.ratingUnit),
            requiresShortCircuit: family.requiresShortCircuit,
        });
    } catch (error) { sendError(res, error); }
});

router.get('/models', VIEW, async (req: any, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const search = String(req.query.q || '').trim();
        const where: any = { tenantId };
        if (req.query.familyId) where.typeFamilyId = String(req.query.familyId);
        if (req.query.active === 'true') where.isActive = true;
        if (search) {
            where.OR = [
                { modelNumber: { contains: search } },
                { typeCode: { contains: search } },
            ];
        }
        const models = await (prisma as any).panelModel.findMany({
            where,
            include: { typeFamily: true, _count: { select: { units: true } } },
            orderBy: [{ typeCode: 'asc' }, { ratingValue: 'asc' }],
            take: 500,
        });
        // Die Produktkarte liefert Bezeichnung und ERP-Code dazu.
        const articleIds = models.map((model: any) => model.articleId).filter(Boolean);
        const articles = articleIds.length
            ? await (prisma as any).article.findMany({
                where: { id: { in: articleIds } },
                select: { id: true, articleCode: true, name: true, unit: true, salePrice: true },
            })
            : [];
        const articleById = new Map(articles.map((row: any) => [row.id, row]));
        res.json(models.map((model: any) => ({
            ...model,
            article: articleById.get(model.articleId) || null,
            unitCount: model._count?.units ?? 0,
        })));
    } catch (error) { sendError(res, error); }
});

router.post('/models', MANAGE, async (req: any, res) => {
    try {
        res.status(201).json(await createPanelModel(req.user!.tenantId, req.body || {}, req.user!.id));
    } catch (error) { sendError(res, error); }
});

router.get('/models/:id', VIEW, async (req: any, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const model = await (prisma as any).panelModel.findFirst({
            where: { id: String(req.params.id), tenantId },
            include: { typeFamily: true },
        });
        if (!model) return sendError(res, { status: 404, code: 'MODEL_NOT_FOUND', message: 'Modell nicht gefunden.' });
        const article = model.articleId
            ? await (prisma as any).article.findFirst({
                where: { id: model.articleId },
                select: { id: true, articleCode: true, name: true, unit: true, salePrice: true },
            })
            : null;
        res.json({ ...model, article, missingNameplate: missingNameplateFields(model, model.typeFamily) });
    } catch (error) { sendError(res, error); }
});

router.patch('/models/:id', MANAGE, async (req: any, res) => {
    try {
        res.json(await updatePanelModel(req.user!.tenantId, String(req.params.id), req.body || {}));
    } catch (error) { sendError(res, error); }
});

router.delete('/models/:id', MANAGE, async (req: any, res) => {
    try {
        await deletePanelModel(req.user!.tenantId, String(req.params.id));
        res.status(204).send();
    } catch (error) { sendError(res, error); }
});

/* ── SCHRÄNKE / SERIENNUMMERN ───────────────────────────────────────────────*/

router.get('/units', VIEW, async (req: any, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const where: any = { tenantId };
        if (req.query.status) where.status = String(req.query.status).toUpperCase();
        if (req.query.modelId) where.panelModelId = String(req.query.modelId);
        if (req.query.projectId) where.projectId = String(req.query.projectId);
        if (req.query.productionProjectId) where.productionProjectId = String(req.query.productionProjectId);
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
            (prisma as any).panelUnit.findMany({
                where,
                include: { model: { select: { modelNumber: true, typeCode: true, ratingValue: true, ratingUnit: true } } },
                orderBy: [{ serialYear: 'desc' }, { serialSeq: 'desc' }],
                take,
                skip: Math.max(0, Number(req.query.skip) || 0),
            }),
            (prisma as any).panelUnit.count({ where }),
        ]);
        res.json({ rows, total });
    } catch (error) { sendError(res, error); }
});

/** `count` Seriennummern ziehen — der Augenblick, in dem Schränke entstehen. */
router.post('/units', MANAGE, async (req: any, res) => {
    try {
        const units = await issuePanelUnits(req.user!.tenantId, req.body || {}, req.user!.id);
        res.status(201).json({ units, count: units.length });
    } catch (error) { sendError(res, error); }
});

router.get('/units/:id', VIEW, async (req: any, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const unit = await (prisma as any).panelUnit.findFirst({
            where: { id: String(req.params.id), tenantId },
            include: { model: { include: { typeFamily: true } } },
        });
        if (!unit) return sendError(res, { status: 404, code: 'UNIT_NOT_FOUND', message: 'Schaltschrank nicht gefunden.' });
        // Die Lagerbewegungen, die seine Seriennummer tragen — der Lebenslauf
        // im Lager (Zugang aus der Fertigung, Abgang bei der Lieferung).
        const movements = await (prisma as any).stockMovement.findMany({
            where: { tenantId, serialNumber: unit.serialNumber },
            select: { id: true, movementType: true, quantity: true, transactionDate: true, origin: true, description: true },
            orderBy: { transactionDate: 'desc' },
            take: 50,
        });
        res.json({
            ...unit,
            movements,
            missingNameplate: missingNameplateFields(unit.model, unit.model?.typeFamily),
        });
    } catch (error) { sendError(res, error); }
});

router.patch('/units/:id', MANAGE, async (req: any, res) => {
    try {
        res.json(await updatePanelUnit(req.user!.tenantId, String(req.params.id), req.body || {}));
    } catch (error) { sendError(res, error); }
});

router.delete('/units/:id', MANAGE, async (req: any, res) => {
    try {
        await deletePanelUnit(req.user!.tenantId, String(req.params.id));
        res.status(204).send();
    } catch (error) { sendError(res, error); }
});

router.post('/units/:id/status', MANAGE, async (req: any, res) => {
    try {
        res.json(await setPanelUnitStatus(req.user!.tenantId, String(req.params.id), String(req.body?.status || ''), req.user!.id));
    } catch (error) { sendError(res, error); }
});

router.post('/units/:id/stock-in', MANAGE, async (req: any, res) => {
    try {
        res.json(await stockInPanelUnit(req.user!.tenantId, String(req.params.id), req.user!.id, req.body || {}));
    } catch (error) { sendError(res, error); }
});

router.post('/units/:id/label', MANAGE, async (req: any, res) => {
    try {
        res.json(await freezeNameplate(req.user!.tenantId, String(req.params.id), req.user!.id));
    } catch (error) { sendError(res, error); }
});

/* ── VOM ETIKETT ZUM SCHRANK ────────────────────────────────────────────────*/

router.get('/lookup', requireAnyPermission(['panels.view', 'inventory.view']), async (req: any, res) => {
    try {
        const unit = await findPanelBySerial(req.user!.tenantId, String(req.query.serial || ''));
        if (!unit) return res.status(404).json({ error: 'Zu dieser Seriennummer gibt es keinen Schrank.', code: 'SERIAL_UNKNOWN' });
        res.json(unit);
    } catch (error) { sendError(res, error); }
});

export default router;
