"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const ItGateMiddleware_1 = require("../middlewares/ItGateMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const articleCodeCatalog_1 = require("../../application/services/articleCodeCatalog");
/* CODE-EINSTELLUNGEN (Einstellungen → Module → Lager → Code-Einstellungen).
   Kategorien (ELK, KLI …) und ihre Nummernkreise (PLC, TCL, VIDA …), aus denen
   der ERP-Code `KAT-UNTER-NNNNN` entsteht.

   LESEN darf jede:r Angemeldete (die Schnellerfassung und das Artikelformular
   fragen die freigegebenen Kreise ab). PFLEGEN darf, wer die Lagerstammdaten
   pflegen darf — wie bei den Einheiten. FREIGEBEN (aktivieren/stilllegen) darf
   NUR die IT: der Ausweis der IT-Schleuse muss im Kopf `x-it-gate` mitkommen
   (Vorgabe: «Vorbereitete Codes werden nur auf Anfrage der IT aktiviert»). */
const router = (0, express_1.Router)();
const MANAGE = [
    'inventory.manage',
    'inventory.articles.update',
    'inventory.articles.create',
    'roles.manage',
    'tenants.update',
];
const readName = (value) => String(value ?? '').trim().slice(0, articleCodeCatalog_1.MAX_CODE_NAME_LENGTH);
const schemeDto = (category, scheme) => ({
    id: scheme.id,
    categoryId: scheme.categoryId,
    code: scheme.code,
    name: scheme.name,
    startNumber: scheme.startNumber,
    lastNumber: scheme.lastNumber,
    isActive: scheme.isActive,
    activatedAt: scheme.activatedAt,
    sortOrder: scheme.sortOrder,
    prefix: (0, articleCodeCatalog_1.codePrefix)(category.code, scheme.code),
    nextCode: (0, articleCodeCatalog_1.previewNextCode)(category, scheme),
});
const categoryDto = (category) => ({
    id: category.id,
    code: category.code,
    name: category.name,
    sortOrder: category.sortOrder,
    schemes: category.schemes.map((scheme) => schemeDto(category, scheme)),
});
/**
 * GET /settings/article-codes — alle Kategorien mit ihren Nummernkreisen.
 * `?active=true` liefert nur freigegebene Kreise (und nur Kategorien, die
 * welche haben) — das ist die Sicht der Schnellerfassung.
 */
router.get('/', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const activeOnly = String(req.query.active ?? '') === 'true';
        const rows = await (0, articleCodeCatalog_1.listCodeCategories)(req.user.tenantId, { activeOnly });
        res.status(200).json(rows.map(categoryDto));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/** Wie viele Artikel einen Kreis (Praefix) schon tragen — entscheidet ueber Loeschen. */
const articlesUnderPrefix = (tenantId, prefix) => prisma_client_1.default.article.count({ where: { tenantId, articleCode: { startsWith: prefix } } });
// POST /settings/article-codes/categories — { code, name }
router.post('/categories', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const code = (0, articleCodeCatalog_1.normalizeShortCode)(req.body?.code);
        const name = readName(req.body?.name) || code;
        if (!(0, articleCodeCatalog_1.isValidShortCode)(code))
            return res.status(400).json({ error: 'Das Kürzel braucht 2–4 Grossbuchstaben oder Ziffern (z. B. ELK).', code: 'BAD_CODE' });
        const existing = await prisma_client_1.default.articleCodeCategory.findMany({ where: { tenantId }, select: { code: true, sortOrder: true } });
        if (existing.some((row) => row.code === code))
            return res.status(409).json({ error: `Die Kategorie «${code}» gibt es bereits.`, code: 'CODE_TAKEN' });
        const sortOrder = existing.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 10;
        const created = await prisma_client_1.default.articleCodeCategory.create({
            data: { id: (0, nanoid_1.nanoid)(12), tenantId, code, name, sortOrder },
            include: { schemes: true },
        });
        res.status(201).json(categoryDto(created));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// PATCH /settings/article-codes/categories/:id — { name?, code? }
// Das Kuerzel ist Teil jedes vergebenen Codes: es laesst sich nur aendern,
// solange noch kein Artikel einen Code aus dieser Kategorie traegt.
router.patch('/categories/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const current = await prisma_client_1.default.articleCodeCategory.findFirst({ where: { id, tenantId }, include: { schemes: true } });
        if (!current)
            return res.status(404).json({ error: 'Kategorie nicht gefunden.' });
        const data = {};
        if (req.body?.name !== undefined) {
            const name = readName(req.body.name);
            if (!name)
                return res.status(400).json({ error: 'Der Name fehlt.' });
            data.name = name;
        }
        if (req.body?.code !== undefined) {
            const code = (0, articleCodeCatalog_1.normalizeShortCode)(req.body.code);
            if (!(0, articleCodeCatalog_1.isValidShortCode)(code))
                return res.status(400).json({ error: 'Das Kürzel braucht 2–4 Grossbuchstaben oder Ziffern.', code: 'BAD_CODE' });
            if (code !== current.code) {
                const used = await articlesUnderPrefix(tenantId, `${current.code}-`);
                if (used > 0)
                    return res.status(409).json({ error: `Das Kürzel ist auf ${used} Artikeln vergeben und kann nicht mehr geändert werden.`, code: 'IN_USE' });
                const clash = await prisma_client_1.default.articleCodeCategory.findFirst({ where: { tenantId, code, NOT: { id } }, select: { id: true } });
                if (clash)
                    return res.status(409).json({ error: `Die Kategorie «${code}» gibt es bereits.`, code: 'CODE_TAKEN' });
                data.code = code;
            }
        }
        const updated = Object.keys(data).length
            ? await prisma_client_1.default.articleCodeCategory.update({ where: { id }, data, include: { schemes: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } } })
            : current;
        res.status(200).json(categoryDto(updated));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// DELETE /settings/article-codes/categories/:id — nur ohne vergebene Codes.
router.delete('/categories/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const current = await prisma_client_1.default.articleCodeCategory.findFirst({ where: { id, tenantId }, select: { code: true } });
        if (!current)
            return res.status(404).json({ error: 'Kategorie nicht gefunden.' });
        const used = await articlesUnderPrefix(tenantId, `${current.code}-`);
        if (used > 0)
            return res.status(409).json({ error: `${used} Artikel tragen einen Code dieser Kategorie — sie kann nicht gelöscht werden.`, code: 'IN_USE' });
        await prisma_client_1.default.articleCodeCategory.delete({ where: { id } });
        res.status(204).end();
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// POST /settings/article-codes/schemes — { categoryId, code, name, startNumber }
// Legt einen VORBEREITETEN Kreis an (nicht freigegeben).
router.post('/schemes', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const categoryId = String(req.body?.categoryId ?? '');
        const category = await prisma_client_1.default.articleCodeCategory.findFirst({ where: { id: categoryId, tenantId }, include: { schemes: { select: { code: true, sortOrder: true } } } });
        if (!category)
            return res.status(404).json({ error: 'Kategorie nicht gefunden.' });
        const code = (0, articleCodeCatalog_1.normalizeShortCode)(req.body?.code);
        const name = readName(req.body?.name) || code;
        if (!(0, articleCodeCatalog_1.isValidShortCode)(code))
            return res.status(400).json({ error: 'Das Kürzel braucht 2–4 Grossbuchstaben oder Ziffern (z. B. PLC).', code: 'BAD_CODE' });
        if (category.schemes.some((row) => row.code === code))
            return res.status(409).json({ error: `Den Nummernkreis «${category.code}-${code}» gibt es bereits.`, code: 'CODE_TAKEN' });
        const startNumber = Math.max(1, Math.floor(Number(req.body?.startNumber)) || 1);
        const sortOrder = category.schemes.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 10;
        const created = await prisma_client_1.default.articleCodeScheme.create({
            data: (0, articleCodeCatalog_1.newSchemeData)(tenantId, category.id, code, name, startNumber, sortOrder),
        });
        res.status(201).json(schemeDto(category, created));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// PATCH /settings/article-codes/schemes/:id — { name?, code?, startNumber? }
router.patch('/schemes/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const current = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { id, tenantId }, include: { category: true } });
        if (!current)
            return res.status(404).json({ error: 'Nummernkreis nicht gefunden.' });
        const data = {};
        if (req.body?.name !== undefined) {
            const name = readName(req.body.name);
            if (!name)
                return res.status(400).json({ error: 'Der Name fehlt.' });
            data.name = name;
        }
        if (req.body?.code !== undefined) {
            const code = (0, articleCodeCatalog_1.normalizeShortCode)(req.body.code);
            if (!(0, articleCodeCatalog_1.isValidShortCode)(code))
                return res.status(400).json({ error: 'Das Kürzel braucht 2–4 Grossbuchstaben oder Ziffern.', code: 'BAD_CODE' });
            if (code !== current.code) {
                if (current.lastNumber > 0)
                    return res.status(409).json({ error: 'Der Kreis hat schon Codes vergeben — das Kürzel bleibt.', code: 'IN_USE' });
                const clash = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { tenantId, categoryId: current.categoryId, code, NOT: { id } }, select: { id: true } });
                if (clash)
                    return res.status(409).json({ error: `Den Nummernkreis «${current.category.code}-${code}» gibt es bereits.`, code: 'CODE_TAKEN' });
                data.code = code;
            }
        }
        if (req.body?.startNumber !== undefined) {
            const startNumber = Math.max(1, Math.floor(Number(req.body.startNumber)) || 1);
            // Die Startnummer darf nicht hinter das schon Vergebene zurueck.
            if (current.lastNumber > 0 && startNumber <= current.lastNumber) {
                return res.status(409).json({ error: `Es wurde schon bis ${current.lastNumber} vergeben — die Startnummer muss darüber liegen.`, code: 'IN_USE' });
            }
            data.startNumber = startNumber;
        }
        const updated = Object.keys(data).length
            ? await prisma_client_1.default.articleCodeScheme.update({ where: { id }, data })
            : current;
        res.status(200).json(schemeDto(current.category, updated));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// DELETE /settings/article-codes/schemes/:id — nur, solange nichts vergeben ist.
router.delete('/schemes/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const current = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { id, tenantId }, include: { category: { select: { code: true } } } });
        if (!current)
            return res.status(404).json({ error: 'Nummernkreis nicht gefunden.' });
        const used = await articlesUnderPrefix(tenantId, (0, articleCodeCatalog_1.codePrefix)(current.category.code, current.code));
        if (used > 0 || current.lastNumber > 0)
            return res.status(409).json({ error: 'Der Kreis hat schon Codes vergeben — stattdessen stilllegen.', code: 'IN_USE' });
        await prisma_client_1.default.articleCodeScheme.delete({ where: { id } });
        res.status(204).end();
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * POST /settings/article-codes/schemes/:id/activation — { active: boolean }
 * FREIGABE durch die IT: hinter der IT-Schleuse (Ausweis im Kopf), nicht hinter
 * einer normalen Rolle. Eine Stilllegung nimmt den Kreis nur aus der Auswahl —
 * vergebene Codes bleiben, wie sie sind.
 */
router.post('/schemes/:id/activation', AuthMiddleware_1.requireAuth, ItGateMiddleware_1.requireItGate, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const active = req.body?.active !== false;
        const current = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { id, tenantId }, include: { category: true } });
        if (!current)
            return res.status(404).json({ error: 'Nummernkreis nicht gefunden.' });
        const updated = await prisma_client_1.default.articleCodeScheme.update({
            where: { id },
            data: active
                ? { isActive: true, activatedById: req.user.id, activatedAt: new Date() }
                : { isActive: false },
        });
        AuditLogService_1.auditLog.log({
            action: active ? 'inventory.codeScheme.activate' : 'inventory.codeScheme.deactivate',
            tenantId,
            employeeId: req.user.id,
            entityType: 'ArticleCodeScheme',
            entityId: id,
            metadata: { prefix: (0, articleCodeCatalog_1.codePrefix)(current.category.code, current.code) },
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json(schemeDto(current.category, updated));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=articleCodes.routes.js.map