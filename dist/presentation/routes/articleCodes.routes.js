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
const ResponseCacheMiddleware_1 = require("../middlewares/ResponseCacheMiddleware");
/* CODE-EINSTELLUNGEN (Einstellungen → Module → Lager → Code-Einstellungen).
   Kategorien (ELK, KLI …) und ihre Nummernkreise (PLC, PANO-PLC-H …), aus
   denen der ERP-Code entsteht — 2 bis 4 Zellen und ein Zaehler:
   ELK-PLC-00001, ELK-PANO-PLC-H-00400.

   LESEN darf jede:r Angemeldete (die Schnellerfassung und das Artikelformular
   fragen die freigegebenen Kreise ab). PFLEGEN darf, wer die Lagerstammdaten
   pflegen darf — wie bei den Einheiten. FREIGEBEN (aktivieren/stilllegen) darf
   NUR die IT: der Ausweis der IT-Schleuse muss im Kopf `x-it-gate` mitkommen
   (Vorgabe: «Vorbereitete Codes werden nur auf Anfrage der IT aktiviert»).

   Dieselbe Schleuse bewacht seit 22.09.2026 alles, was VERGEBENE Codes
   beruehrt: ein Praefix samt Artikeln umschreiben, einen Kreis mit vergebenen
   Codes loeschen, den Zaehler zuruecksetzen, Artikel neu durchnummerieren. */
const router = (0, express_1.Router)();
const MANAGE = [
    'inventory.manage',
    'inventory.articles.update',
    'inventory.articles.create',
    'roles.manage',
    'tenants.update',
];
const readName = (value) => String(value ?? '').trim().slice(0, articleCodeCatalog_1.MAX_CODE_NAME_LENGTH);
const readFlag = (value) => value === true || value === 'true' || value === 1 || value === '1';
const readDigits = (value, fallback = articleCodeCatalog_1.CODE_DIGITS) => {
    const digits = Math.floor(Number(value));
    if (!Number.isFinite(digits) || digits <= 0)
        return fallback;
    return Math.min(Math.max(digits, articleCodeCatalog_1.MIN_DIGITS), articleCodeCatalog_1.MAX_DIGITS);
};
/**
 * Die IT-Schleuse, aber nur wenn noetig: ein Kreis OHNE vergebene Codes laesst
 * sich pflegen wie jede andere Stammdatenzeile. Sobald Artikel betroffen sind,
 * muss der Ausweis der Schleuse mitkommen — der Aufrufer bekommt sonst 403 und
 * fragt das IT-Kennwort ab (derselbe Weg wie bei der Freigabe).
 */
const itGateOk = (req) => Boolean(req.user?.id) && (0, ItGateMiddleware_1.isItGateConfigured)() && (0, ItGateMiddleware_1.isValidItGateTicket)(req.user.id, req.header(ItGateMiddleware_1.IT_GATE_HEADER));
const needsItGate = (res) => res.status(403).json({ error: 'IT-Schleuse: bitte das Kennwort eingeben.', code: 'IT_GATE_REQUIRED' });
const schemeDto = (category, scheme, articleCount) => ({
    id: scheme.id,
    categoryId: scheme.categoryId,
    /** Die Zellen NACH der Kategorie, verbunden: «PANO-PLC-H». */
    code: scheme.code,
    /** Dieselben Zellen einzeln — das Fenster bearbeitet sie als Zellen. */
    cells: (0, articleCodeCatalog_1.schemeCells)(scheme.code),
    name: scheme.name,
    startNumber: scheme.startNumber,
    lastNumber: scheme.lastNumber,
    digits: scheme.digits ?? articleCodeCatalog_1.CODE_DIGITS,
    isActive: scheme.isActive,
    activatedAt: scheme.activatedAt,
    sortOrder: scheme.sortOrder,
    prefix: (0, articleCodeCatalog_1.codePrefix)(category.code, scheme.code),
    nextCode: (0, articleCodeCatalog_1.previewNextCode)(category, scheme),
    ...(articleCount === undefined ? {} : { articleCount }),
});
const categoryDto = (category, counts) => {
    const schemes = category.schemes.map((scheme) => schemeDto(category, scheme, counts ? (counts[(0, articleCodeCatalog_1.codePrefix)(category.code, scheme.code)] ?? 0) : undefined));
    return {
        id: category.id,
        code: category.code,
        name: category.name,
        sortOrder: category.sortOrder,
        schemes,
        ...(counts ? { articleCount: schemes.reduce((sum, row) => sum + (row.articleCount ?? 0), 0) } : {}),
    };
};
/**
 * GET /settings/article-codes — alle Kategorien mit ihren Nummernkreisen.
 * `?active=true` liefert nur freigegebene Kreise (und nur Kategorien, die
 * welche haben) — das ist die Sicht der Schnellerfassung; sie braucht keine
 * Artikelzahlen. Die Einstellungsseite bekommt sie (eine Abfrage fuer alle).
 */
router.get('/', AuthMiddleware_1.requireAuth, (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog', 'settings'], ttlSec: 300 }), async (req, res) => {
    try {
        const activeOnly = String(req.query.active ?? '') === 'true';
        const rows = await (0, articleCodeCatalog_1.listCodeCategories)(req.user.tenantId, { activeOnly });
        if (activeOnly)
            return res.status(200).json(rows.map((row) => categoryDto(row)));
        const prefixes = rows.flatMap((category) => category.schemes.map((scheme) => (0, articleCodeCatalog_1.codePrefix)(category.code, scheme.code)));
        const counts = await (0, articleCodeCatalog_1.countArticlesByPrefix)(req.user.tenantId, prefixes);
        res.status(200).json(rows.map((row) => categoryDto(row, counts)));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/** Wie viele Artikel einen Kreis (Praefix) schon tragen — entscheidet ueber die Schleuse. */
const articlesUnderPrefix = (tenantId, prefix) => (0, articleCodeCatalog_1.countArticlesUnderPrefix)(tenantId, prefix);
// POST /settings/article-codes/categories — { code, name }
router.post('/categories', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const code = (0, articleCodeCatalog_1.normalizeShortCode)(req.body?.code);
        const name = readName(req.body?.name) || code;
        if (!(0, articleCodeCatalog_1.isValidShortCode)(code))
            return res.status(400).json({ error: 'Eine Zelle braucht 1–4 Grossbuchstaben oder Ziffern (z. B. ELK).', code: 'BAD_CODE' });
        const existing = await prisma_client_1.default.articleCodeCategory.findMany({ where: { tenantId }, select: { code: true, sortOrder: true } });
        if (existing.some((row) => row.code === code))
            return res.status(409).json({ error: `Die Kategorie «${code}» gibt es bereits.`, code: 'CODE_TAKEN' });
        const sortOrder = existing.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 10;
        const created = await prisma_client_1.default.articleCodeCategory.create({
            data: { id: (0, nanoid_1.nanoid)(12), tenantId, code, name, sortOrder },
            include: { schemes: true },
        });
        res.status(201).json(categoryDto(created, {}));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * PATCH /settings/article-codes/categories/:id — { name?, code?, migrateArticles? }
 *
 * Das Kuerzel ist die ERSTE Zelle jedes vergebenen Codes. Es laesst sich jetzt
 * auch dann aendern, wenn Artikel es tragen (Vorgabe Samet 22.09.2026) — dann
 * entscheidet `migrateArticles`, ob die Artikel MITWANDERN (alle Codes werden
 * umgeschrieben) oder ob nur kuenftige Codes neu aussehen. Beides beruehrt
 * vergebene Codes, also braucht beides den Ausweis der IT-Schleuse.
 */
router.patch('/categories/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const current = await prisma_client_1.default.articleCodeCategory.findFirst({
            where: { id, tenantId },
            include: { schemes: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
        });
        if (!current)
            return res.status(404).json({ error: 'Kategorie nicht gefunden.' });
        const data = {};
        if (req.body?.name !== undefined) {
            const name = readName(req.body.name);
            if (!name)
                return res.status(400).json({ error: 'Der Name fehlt.' });
            data.name = name;
        }
        let migrated = 0;
        if (req.body?.code !== undefined) {
            const code = (0, articleCodeCatalog_1.normalizeShortCode)(req.body.code);
            if (!(0, articleCodeCatalog_1.isValidShortCode)(code))
                return res.status(400).json({ error: 'Eine Zelle braucht 1–4 Grossbuchstaben oder Ziffern.', code: 'BAD_CODE' });
            if (code !== current.code) {
                const clash = await prisma_client_1.default.articleCodeCategory.findFirst({ where: { tenantId, code, NOT: { id } }, select: { id: true } });
                if (clash)
                    return res.status(409).json({ error: `Die Kategorie «${code}» gibt es bereits.`, code: 'CODE_TAKEN' });
                const used = await articlesUnderPrefix(tenantId, `${current.code}-`);
                if (used > 0) {
                    if (!itGateOk(req))
                        return needsItGate(res);
                    if (readFlag(req.body?.migrateArticles)) {
                        // Jeder Kreis der Kategorie wandert einzeln — das Praefix
                        // ist je Kreis ein anderes.
                        for (const scheme of current.schemes) {
                            const result = await (0, articleCodeCatalog_1.migrateArticlePrefix)(tenantId, (0, articleCodeCatalog_1.codePrefix)(current.code, scheme.code), (0, articleCodeCatalog_1.codePrefix)(code, scheme.code));
                            migrated += result.movedArticles;
                        }
                    }
                }
                data.code = code;
            }
        }
        const updated = Object.keys(data).length
            ? await prisma_client_1.default.articleCodeCategory.update({ where: { id }, data, include: { schemes: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } } })
            : current;
        if (data.code) {
            AuditLogService_1.auditLog.log({
                action: 'inventory.codeCategory.rename',
                tenantId,
                employeeId: req.user.id,
                entityType: 'ArticleCodeCategory',
                entityId: id,
                metadata: { from: current.code, to: data.code, migratedArticles: migrated },
                ...AuditLogService_1.auditLog.context(req),
            });
        }
        res.status(200).json({ ...categoryDto(updated), migratedArticles: migrated });
    }
    catch (error) {
        res.status(error?.status || 400).json({ error: error.message, code: error?.code });
    }
});
/**
 * DELETE /settings/article-codes/categories/:id
 *
 * Vorgabe Samet 22.09.2026: «wird eine Kategorie geloescht, sollen alle ihre
 * Nummernkreise mitgeloescht werden — die Produkte von frueher aendern sich
 * aber nicht». Genau so: die Kreise fallen (der Fremdschluessel raeumt sie
 * selbst weg), die Artikel behalten ihren Code. Betrifft es vergebene Codes,
 * fragt die IT-Schleuse.
 */
router.delete('/categories/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const current = await prisma_client_1.default.articleCodeCategory.findFirst({ where: { id, tenantId }, include: { schemes: { select: { id: true } } } });
        if (!current)
            return res.status(404).json({ error: 'Kategorie nicht gefunden.' });
        const keptArticles = await articlesUnderPrefix(tenantId, `${current.code}-`);
        if (keptArticles > 0 && !itGateOk(req))
            return needsItGate(res);
        await prisma_client_1.default.articleCodeCategory.delete({ where: { id } });
        AuditLogService_1.auditLog.log({
            action: 'inventory.codeCategory.delete',
            tenantId,
            employeeId: req.user.id,
            entityType: 'ArticleCodeCategory',
            entityId: id,
            metadata: { code: current.code, schemes: current.schemes.length, keptArticles },
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json({ removedSchemes: current.schemes.length, keptArticles });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/** Die Zellen aus dem Rumpf lesen — `cells: []` oder `code: "PANO-PLC-H"`. */
const readCells = (body) => {
    const cells = (0, articleCodeCatalog_1.normalizeCells)(body?.cells ?? body?.code);
    if (!cells.length)
        return { cells, error: 'Der Nummernkreis braucht mindestens eine Zelle (z. B. PLC).' };
    if (cells.length > articleCodeCatalog_1.MAX_SCHEME_CELLS)
        return { cells, error: `Ein Code hat höchstens ${articleCodeCatalog_1.MAX_CELLS} Zellen — die Kategorie stellt die erste.` };
    if (!cells.every(articleCodeCatalog_1.isValidShortCode))
        return { cells, error: 'Jede Zelle braucht 1–4 Grossbuchstaben oder Ziffern.' };
    return { cells };
};
// POST /settings/article-codes/schemes — { categoryId, cells | code, name, startNumber, digits }
// Legt einen VORBEREITETEN Kreis an (nicht freigegeben).
router.post('/schemes', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const categoryId = String(req.body?.categoryId ?? '');
        const category = await prisma_client_1.default.articleCodeCategory.findFirst({ where: { id: categoryId, tenantId }, include: { schemes: { select: { code: true, sortOrder: true } } } });
        if (!category)
            return res.status(404).json({ error: 'Kategorie nicht gefunden.' });
        const { cells, error } = readCells(req.body);
        if (error)
            return res.status(400).json({ error, code: 'BAD_CODE' });
        const code = (0, articleCodeCatalog_1.joinCells)(cells);
        const name = readName(req.body?.name) || code;
        if (category.schemes.some((row) => row.code === code))
            return res.status(409).json({ error: `Den Nummernkreis «${category.code}-${code}» gibt es bereits.`, code: 'CODE_TAKEN' });
        const startNumber = Math.max(1, Math.floor(Number(req.body?.startNumber)) || 1);
        const digits = readDigits(req.body?.digits);
        const sortOrder = category.schemes.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 10;
        const created = await prisma_client_1.default.articleCodeScheme.create({
            data: (0, articleCodeCatalog_1.newSchemeData)(tenantId, category.id, code, name, startNumber, sortOrder, digits),
        });
        res.status(201).json(schemeDto(category, created, 0));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * PATCH /settings/article-codes/schemes/:id — { name?, cells?/code?, startNumber?, digits?, migrateArticles? }
 *
 * Zellen und Zaehlerbreite lassen sich auch dann noch aendern, wenn der Kreis
 * schon Codes vergeben hat — dann entscheidet `migrateArticles`, ob die
 * bestehenden Artikel mitwandern. Ohne diese Angabe bleiben sie, wie sie sind;
 * nur neue Codes sehen neu aus.
 */
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
        let migrated = 0;
        const wantsMigration = readFlag(req.body?.migrateArticles);
        const used = await articlesUnderPrefix(tenantId, (0, articleCodeCatalog_1.codePrefix)(current.category.code, current.code));
        if (req.body?.cells !== undefined || req.body?.code !== undefined) {
            const { cells, error } = readCells(req.body);
            if (error)
                return res.status(400).json({ error, code: 'BAD_CODE' });
            const code = (0, articleCodeCatalog_1.joinCells)(cells);
            if (code !== current.code) {
                const clash = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { tenantId, categoryId: current.categoryId, code, NOT: { id } }, select: { id: true } });
                if (clash)
                    return res.status(409).json({ error: `Den Nummernkreis «${current.category.code}-${code}» gibt es bereits.`, code: 'CODE_TAKEN' });
                if (used > 0) {
                    if (!itGateOk(req))
                        return needsItGate(res);
                    if (wantsMigration) {
                        const result = await (0, articleCodeCatalog_1.migrateArticlePrefix)(tenantId, (0, articleCodeCatalog_1.codePrefix)(current.category.code, current.code), (0, articleCodeCatalog_1.codePrefix)(current.category.code, code));
                        migrated += result.movedArticles;
                    }
                }
                data.code = code;
            }
        }
        let repadded = 0;
        if (req.body?.digits !== undefined) {
            const digits = readDigits(req.body.digits, current.digits ?? undefined);
            if (digits !== current.digits) {
                if (used > 0 && !itGateOk(req))
                    return needsItGate(res);
                data.digits = digits;
            }
        }
        if (req.body?.startNumber !== undefined) {
            const startNumber = Math.max(1, Math.floor(Number(req.body.startNumber)) || 1);
            // Der Zaehler darf nie hinter die Startnummer zurueckfallen; nach
            // OBEN verschoben heisst das: ab jetzt ab hier weiterzaehlen.
            data.startNumber = startNumber;
        }
        const updated = Object.keys(data).length
            ? await prisma_client_1.default.articleCodeScheme.update({
                where: { id },
                data: {
                    ...data,
                    // Eine Startnummer ueber dem Zaehler hebt ihn mit — sonst
                    // vergaebe der Kreis weiter unterhalb seines Starts.
                    ...(data.startNumber !== undefined && data.startNumber - 1 > current.lastNumber
                        ? { lastNumber: data.startNumber - 1 }
                        : {}),
                },
            })
            : current;
        // Eine neue ZÄHLERBREITE gilt sonst nur für künftige Codes — die alten
        // stünden weiter in der alten Breite, und dieselbe Nummer gäbe es
        // zweimal (ELK-PLC-00042 neben ELK-PLC-042). Wer die Artikel mitnehmen
        // will, bekommt sie deshalb umgepolstert; ihre Nummer bleibt.
        if (data.digits !== undefined && used > 0 && wantsMigration) {
            const result = await (0, articleCodeCatalog_1.renumberSchemeArticles)(tenantId, id, { keepNumbers: true });
            repadded = result.renumbered;
        }
        if (data.code || data.digits !== undefined) {
            AuditLogService_1.auditLog.log({
                action: 'inventory.codeScheme.reshape',
                tenantId,
                employeeId: req.user.id,
                entityType: 'ArticleCodeScheme',
                entityId: id,
                metadata: { from: current.code, to: data.code ?? current.code, digits: data.digits ?? current.digits, migratedArticles: migrated, repaddedArticles: repadded },
                ...AuditLogService_1.auditLog.context(req),
            });
        }
        res.status(200).json({ ...schemeDto(current.category, updated, used), migratedArticles: migrated + repadded });
    }
    catch (error) {
        res.status(error?.status || 400).json({ error: error.message, code: error?.code });
    }
});
/**
 * DELETE /settings/article-codes/schemes/:id
 *
 * Auch mit vergebenen Codes (Vorgabe Samet 22.09.2026). Der Kreis verschwindet
 * aus den Einstellungen; die Artikel behalten ihren Code unveraendert. Hinter
 * der IT-Schleuse, sobald Artikel betroffen sind.
 */
router.delete('/schemes/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(MANAGE), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const current = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { id, tenantId }, include: { category: { select: { code: true } } } });
        if (!current)
            return res.status(404).json({ error: 'Nummernkreis nicht gefunden.' });
        const keptArticles = await articlesUnderPrefix(tenantId, (0, articleCodeCatalog_1.codePrefix)(current.category.code, current.code));
        if ((keptArticles > 0 || current.lastNumber > 0) && !itGateOk(req))
            return needsItGate(res);
        await prisma_client_1.default.articleCodeScheme.delete({ where: { id } });
        AuditLogService_1.auditLog.log({
            action: 'inventory.codeScheme.delete',
            tenantId,
            employeeId: req.user.id,
            entityType: 'ArticleCodeScheme',
            entityId: id,
            metadata: { prefix: (0, articleCodeCatalog_1.codePrefix)(current.category.code, current.code), keptArticles },
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json({ keptArticles });
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
/**
 * POST /settings/article-codes/schemes/:id/reset — { mode, value? }
 *
 * Die Nummerierung zuruecksetzen (Vorgabe Samet 22.09.2026). Zwei Wege, beide
 * hinter der IT-Schleuse:
 *
 *   counter  — der Zaehler faengt wieder bei der Startnummer an (oder bei
 *              `value`). Schon vergebene Nummern werden uebersprungen, damit
 *              kein Code zweimal entsteht: der Kreis vergibt in die Luecken.
 *   renumber — die Artikel dieses Kreises bekommen ihre Codes NEU, lueckenlos
 *              ab der Startnummer, in der Reihenfolge ihres Entstehens.
 */
router.post('/schemes/:id/reset', AuthMiddleware_1.requireAuth, ItGateMiddleware_1.requireItGate, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const mode = String(req.body?.mode ?? 'counter');
        const current = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { id, tenantId }, include: { category: true } });
        if (!current)
            return res.status(404).json({ error: 'Nummernkreis nicht gefunden.' });
        if (mode === 'renumber') {
            const result = await (0, articleCodeCatalog_1.renumberSchemeArticles)(tenantId, id);
            AuditLogService_1.auditLog.log({
                action: 'inventory.codeScheme.renumber',
                tenantId,
                employeeId: req.user.id,
                entityType: 'ArticleCodeScheme',
                entityId: id,
                metadata: { prefix: (0, articleCodeCatalog_1.codePrefix)(current.category.code, current.code), renumbered: result.renumbered },
                ...AuditLogService_1.auditLog.context(req),
            });
            const after = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { id, tenantId } });
            return res.status(200).json({
                ...schemeDto(current.category, after, result.renumbered),
                renumbered: result.renumbered,
            });
        }
        if (mode !== 'counter')
            return res.status(400).json({ error: 'Unbekannte Art des Zurücksetzens.', code: 'BAD_MODE' });
        const value = req.body?.value === undefined || req.body?.value === null || req.body?.value === ''
            ? undefined
            : Math.max(1, Math.floor(Number(req.body.value)) || 1);
        const result = await (0, articleCodeCatalog_1.resetSchemeCounter)(tenantId, id, { value });
        AuditLogService_1.auditLog.log({
            action: 'inventory.codeScheme.resetCounter',
            tenantId,
            employeeId: req.user.id,
            entityType: 'ArticleCodeScheme',
            entityId: id,
            metadata: { prefix: (0, articleCodeCatalog_1.codePrefix)(current.category.code, current.code), nextNumber: result.nextNumber },
            ...AuditLogService_1.auditLog.context(req),
        });
        const after = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { id, tenantId } });
        const used = await articlesUnderPrefix(tenantId, (0, articleCodeCatalog_1.codePrefix)(current.category.code, current.code));
        res.status(200).json({ ...schemeDto(current.category, after, used), ...result });
    }
    catch (error) {
        res.status(error?.status || 400).json({ error: error.message, code: error?.code });
    }
});
exports.default = router;
//# sourceMappingURL=articleCodes.routes.js.map