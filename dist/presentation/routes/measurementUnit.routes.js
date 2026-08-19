"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const measurementUnits_1 = require("../../shared/measurementUnits");
const measurementUnitCatalog_1 = require("../../application/services/measurementUnitCatalog");
/* MENGENEINHEITEN (Einstellungen → Module → Lager → Einheiten).
   Je Mandant EINE pflegbare Liste, aus der beim Artikel gewählt wird: Stück,
   Meter, Kilogramm, Liter, Set, Packung … Eigene Einheiten kommen einfach
   dazu. Gespeichert wird auf dem Artikel weiterhin nur der kurze Code
   (`Article.unit`) — die Liste sagt, was zur Auswahl steht.

   LESEN darf jede:r Angemeldete (das Auswahlfeld steht in jedem Artikel- und
   Bestellformular); ÄNDERN darf, wer die Lagerstammdaten pflegen darf. */
const router = (0, express_1.Router)();
const MANAGE = [
    'inventory.manage',
    'inventory.articles.update',
    'inventory.articles.create',
    'roles.manage',
    'tenants.update',
];
const toDto = (row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    isDefault: row.isDefault,
});
/** Wie oft eine Einheit heute auf einem Artikel steht — entscheidet über Löschen. */
const usageCount = (tenantId, code) => prisma_client_1.default.article.count({ where: { tenantId, unit: code } });
const emptyUsage = () => ({ salesPositions: 0, articles: 0, stockQuantity: 0 });
const loadUsage = async (tenantId) => {
    const [articleRows, positionRows, stockRows] = await Promise.all([
        prisma_client_1.default.$queryRaw `
            SELECT \`unit\` AS unit, COUNT(*) AS n
            FROM \`Article\`
            WHERE \`tenantId\` = ${tenantId} AND \`deletedAt\` IS NULL
            GROUP BY \`unit\``,
        prisma_client_1.default.$queryRaw `
            SELECT \`unit\` AS unit, COUNT(*) AS n
            FROM \`Position\`
            WHERE \`tenantId\` = ${tenantId} AND \`unit\` IS NOT NULL AND \`unit\` <> ''
            GROUP BY \`unit\``,
        prisma_client_1.default.$queryRaw `
            SELECT a.\`unit\` AS unit, SUM(b.\`currentQuantity\`) AS q
            FROM \`StockBalance\` b
            JOIN \`Article\` a ON a.\`id\` = b.\`articleId\`
            WHERE b.\`tenantId\` = ${tenantId} AND a.\`deletedAt\` IS NULL
            GROUP BY a.\`unit\``,
    ]);
    const usage = new Map();
    const bucket = (unit) => {
        const key = (0, measurementUnits_1.unitKey)(unit);
        if (!key)
            return null;
        const existing = usage.get(key);
        if (existing)
            return existing;
        const fresh = emptyUsage();
        usage.set(key, fresh);
        return fresh;
    };
    for (const row of articleRows) {
        const entry = bucket(row.unit);
        if (entry)
            entry.articles += Number(row.n);
    }
    for (const row of positionRows) {
        const entry = bucket(row.unit);
        if (entry)
            entry.salesPositions += Number(row.n);
    }
    for (const row of stockRows) {
        const entry = bucket(row.unit);
        if (entry)
            entry.stockQuantity += Number(row.q ?? 0);
    }
    return usage;
};
const readCode = (value) => String(value ?? '').trim().slice(0, measurementUnits_1.MAX_UNIT_CODE_LENGTH);
const readName = (value) => String(value ?? '').trim().slice(0, measurementUnits_1.MAX_UNIT_NAME_LENGTH);
/**
 * GET /settings/units — die ganze Liste, stillgelegte Einheiten eingeschlossen
 * (die Einstellungsseite zeigt sie, das Auswahlfeld blendet sie aus).
 *
 * `?usage=true` hängt je Einheit an, wo sie steckt (Verkauf, Lager, Bestand).
 * NUR die Einstellungsseite fragt danach: das Auswahlfeld holt dieselbe Liste
 * in jedem Artikelformular und soll dafür nicht drei Gruppierungen bezahlen.
 */
router.get('/', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const wantsUsage = String(req.query.usage ?? '') === 'true';
        const rows = await (0, measurementUnitCatalog_1.listUnits)(tenantId);
        if (!wantsUsage)
            return res.status(200).json(rows.map(toDto));
        const usage = await loadUsage(tenantId);
        res.status(200).json(rows.map((row) => ({
            ...toDto(row),
            usage: usage.get((0, measurementUnits_1.unitKey)(row.code)) ?? emptyUsage(),
        })));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// POST /settings/units — { code, name } eine eigene Einheit anlegen.
router.post('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const code = readCode(req.body?.code);
        const name = readName(req.body?.name) || code;
        if (!code)
            return res.status(400).json({ error: 'Das Zeichen der Einheit fehlt.' });
        const existing = await (0, measurementUnitCatalog_1.listUnits)(tenantId);
        const clash = existing.find((unit) => (0, measurementUnits_1.unitKey)(unit.code) === (0, measurementUnits_1.unitKey)(code));
        if (clash)
            return res.status(409).json({ error: `Die Einheit «${clash.code}» gibt es bereits.` });
        const sortOrder = existing.reduce((max, unit) => Math.max(max, unit.sortOrder), 0) + 10;
        const created = await prisma_client_1.default.measurementUnit.create({
            data: { id: (0, nanoid_1.nanoid)(12), tenantId, code, name, sortOrder, isActive: true, isDefault: false },
        });
        res.status(201).json(toDto(created));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * PATCH /settings/units/:id — { code?, name?, isActive?, isDefault? }
 *
 * Wird der Code geändert, ziehen die Artikel mit: sie tragen ihn als Text, und
 * eine umbenannte Einheit darf ihre Artikel nicht zurücklassen. `isDefault`
 * gibt es genau einmal — die bisherige Vorgabe gibt sie ab. Die Vorgabe kann
 * nicht stillgelegt werden, sonst wäre sie für neue Artikel nicht wählbar.
 */
router.patch('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const current = await prisma_client_1.default.measurementUnit.findFirst({ where: { id: String(req.params.id), tenantId } });
        if (!current)
            return res.status(404).json({ error: 'Einheit nicht gefunden.' });
        const data = {};
        if (req.body?.code !== undefined) {
            const code = readCode(req.body.code);
            if (!code)
                return res.status(400).json({ error: 'Das Zeichen der Einheit fehlt.' });
            if ((0, measurementUnits_1.unitKey)(code) !== (0, measurementUnits_1.unitKey)(current.code)) {
                const clash = await prisma_client_1.default.measurementUnit.findFirst({ where: { tenantId, code } });
                if (clash)
                    return res.status(409).json({ error: `Die Einheit «${clash.code}» gibt es bereits.` });
            }
            data.code = code;
        }
        if (req.body?.name !== undefined) {
            const name = readName(req.body.name);
            if (!name)
                return res.status(400).json({ error: 'Der Name der Einheit fehlt.' });
            data.name = name;
        }
        if (req.body?.isDefault !== undefined)
            data.isDefault = req.body.isDefault === true;
        if (req.body?.isActive !== undefined) {
            const isActive = req.body.isActive !== false;
            if (!isActive && (data.isDefault ?? current.isDefault)) {
                return res.status(400).json({ error: 'Die Vorgabe kann nicht stillgelegt werden. Bitte zuerst eine andere Einheit als Vorgabe wählen.' });
            }
            data.isActive = isActive;
        }
        // Eine stillgelegte Einheit zur Vorgabe zu machen, weckt sie wieder auf.
        if (data.isDefault === true && data.isActive === undefined && !current.isActive)
            data.isActive = true;
        const renamedTo = data.code && data.code !== current.code ? data.code : null;
        const saved = await prisma_client_1.default.$transaction(async (tx) => {
            if (data.isDefault === true) {
                await tx.measurementUnit.updateMany({
                    where: { tenantId, isDefault: true, NOT: { id: current.id } },
                    data: { isDefault: false },
                });
            }
            const row = await tx.measurementUnit.update({ where: { id: current.id }, data });
            if (renamedTo) {
                await tx.article.updateMany({ where: { tenantId, unit: current.code }, data: { unit: renamedTo } });
            }
            return row;
        });
        res.status(200).json(toDto(saved));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * DELETE /settings/units/:id — nur, solange KEIN Artikel die Einheit trägt.
 * Sonst antwortet der Aufruf mit 409 und der Anzahl; die Oberfläche bietet dann
 * das Stilllegen an, damit bestehende Artikel ihre Einheit behalten.
 */
router.delete('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const current = await prisma_client_1.default.measurementUnit.findFirst({ where: { id: String(req.params.id), tenantId } });
        if (!current)
            return res.status(404).json({ error: 'Einheit nicht gefunden.' });
        if (current.isDefault) {
            return res.status(400).json({ error: 'Die Vorgabe kann nicht gelöscht werden. Bitte zuerst eine andere Einheit als Vorgabe wählen.' });
        }
        const inUse = await usageCount(tenantId, current.code);
        if (inUse > 0) {
            return res.status(409).json({
                error: `Die Einheit «${current.code}» steht auf ${inUse} Artikel(n) und kann nicht gelöscht werden. Sie lässt sich stilllegen.`,
                inUse,
            });
        }
        await prisma_client_1.default.measurementUnit.delete({ where: { id: current.id } });
        res.status(204).end();
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=measurementUnit.routes.js.map