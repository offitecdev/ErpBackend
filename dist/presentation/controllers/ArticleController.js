"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArticleController = void 0;
const nanoid_1 = require("nanoid");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const richText_1 = require("../../shared/richText");
const dangerGate_1 = require("../utils/dangerGate");
class ArticleController {
    articleRepository;
    inventoryRepository;
    tenderLogRepo;
    constructor(articleRepository, inventoryRepository, tenderLogRepo) {
        this.articleRepository = articleRepository;
        this.inventoryRepository = inventoryRepository;
        this.tenderLogRepo = tenderLogRepo;
    }
    async list(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const includeStock = req.query.includeStock === 'true';
            if (includeStock && this.inventoryRepository) {
                const summary = await this.inventoryRepository.getArticleStockSummary(tenantId);
                return res.status(200).json(summary);
            }
            const filter = { tenantId };
            if (req.query.search)
                filter.search = req.query.search;
            if (req.query.category)
                filter.category = req.query.category;
            if (req.query.status)
                filter.status = req.query.status;
            if (req.query.onlyActive === 'true')
                filter.onlyActive = true;
            const data = await this.articleRepository.findAllArticles(filter);
            res.status(200).json(data);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getById(req, res) {
        try {
            const id = req.params.id;
            const includeImages = req.query.includeImages !== 'false';
            const article = await this.articleRepository.findArticleById(id, { includeImages });
            if (!article)
                return res.status(404).json({ error: 'Ürün bulunamadı.' });
            res.status(200).json(article);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async lookupByCode(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const code = req.params.code;
            const article = await this.articleRepository.findArticleByCode(tenantId, code);
            if (!article)
                return res.status(404).json({ error: 'Bu kod ya da barkoda sahip ürün bulunamadı.' });
            res.status(200).json(article);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async create(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const { articleCode, name, baseCost, unit, description, systemBarcode, supplierBarcode, imageUrl, category, itemType, status, isActive, minStockLevel, criticalStockLevel, maxStockLevel, lastPurchaseDate, salePrice, defaultSupplierId, } = req.body;
            if (!articleCode || !name || !unit) {
                return res.status(400).json({ error: "Ürün kodu, ad ve birim zorunludur." });
            }
            const created = await this.articleRepository.createArticle({
                id: (0, nanoid_1.nanoid)(10),
                tenantId,
                articleCode,
                name,
                baseCost: Number(baseCost ?? 0),
                salePrice: Number(salePrice ?? 0),
                defaultSupplierId: defaultSupplierId ?? null,
                unit,
                // Açıklama biçimli metindir (kalın/italik/madde) — dar beyaz listeden geçer.
                description: (0, richText_1.normalizeRichText)(description),
                systemBarcode: systemBarcode ?? null,
                supplierBarcode: supplierBarcode ?? null,
                imageUrl: imageUrl ?? null,
                category: category ?? null,
                itemType: itemType === 'SERVICE' ? 'SERVICE' : 'PRODUCT',
                status: status ?? 'ACTIVE',
                isActive: isActive ?? true,
                minStockLevel: Number(minStockLevel ?? 0),
                criticalStockLevel: Number(criticalStockLevel ?? 0),
                maxStockLevel: maxStockLevel != null ? Number(maxStockLevel) : null,
                lastPurchaseDate: lastPurchaseDate ? new Date(lastPurchaseDate) : null,
            });
            res.status(201).json(created);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async update(req, res) {
        try {
            const id = req.params.id;
            const before = await this.articleRepository.findArticleById(id);
            const patch = { ...req.body };
            const tenderId = patch.tenderId;
            const positionId = patch.positionId;
            const mappingId = patch.mappingId;
            delete patch.tenderId;
            delete patch.positionId;
            delete patch.mappingId;
            if ('description' in patch)
                patch.description = (0, richText_1.normalizeRichText)(patch.description);
            if (patch.baseCost != null)
                patch.baseCost = Number(patch.baseCost);
            if (patch.salePrice != null)
                patch.salePrice = Number(patch.salePrice);
            if (patch.minStockLevel != null)
                patch.minStockLevel = Number(patch.minStockLevel);
            if (patch.criticalStockLevel != null)
                patch.criticalStockLevel = Number(patch.criticalStockLevel);
            if (patch.maxStockLevel != null)
                patch.maxStockLevel = Number(patch.maxStockLevel);
            if (patch.lastPurchaseDate)
                patch.lastPurchaseDate = new Date(patch.lastPurchaseDate);
            const updated = await this.articleRepository.updateArticle(id, patch);
            if (before && tenderId && this.tenderLogRepo) {
                const tenantId = req.user.tenantId;
                const employeeId = req.user.id;
                const labels = {
                    articleCode: "Stok kodu",
                    name: "ÃœrÃ¼n adÄ±",
                    baseCost: "Birim maliyet",
                    salePrice: "Satış fiyatı",
                    defaultSupplierId: "Varsayılan tedarikçi",
                    unit: "Birim",
                    description: "AÃ§Ä±klama",
                    systemBarcode: "Sistem barkodu",
                    supplierBarcode: "TedarikÃ§i barkodu",
                    imageUrl: "GÃ¶rsel",
                    category: "Kategori",
                    status: "Durum",
                    isActive: "Aktiflik",
                    minStockLevel: "Minimum seviye",
                    criticalStockLevel: "Kritik seviye",
                    maxStockLevel: "Maksimum seviye",
                    lastPurchaseDate: "Son alÄ±m tarihi",
                };
                const logs = Object.keys(patch)
                    .filter((field) => String(before[field] ?? '') !== String(updated[field] ?? ''))
                    .map((field) => ({
                    tenantId,
                    tenderId,
                    positionId: positionId ?? null,
                    mappingId: mappingId ?? null,
                    articleId: id,
                    employeeId,
                    actionType: field === 'baseCost' ? "ARTICLE_PRICE_UPDATED" : "ARTICLE_UPDATED",
                    fieldName: field,
                    oldValue: before[field] == null ? null : String(before[field]),
                    newValue: updated[field] == null ? null : String(updated[field]),
                    description: `${updated.name} - ${labels[field] ?? field} deÄŸiÅŸtirildi: ${before[field] ?? 'boÅŸ'} -> ${updated[field] ?? 'boÅŸ'}`
                }));
                await this.tenderLogRepo.createMany(logs);
            }
            res.status(200).json(updated);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * Einzelne Produktkarte in den Papierkorb. Zwei Dinge gelten hier seit
     * 17.08.2026 und ebenso für die Sammellöschung darunter:
     *   • die Karte muss der ANGEMELDETEN Firma gehören (vorher löschte die
     *     Kennung allein, ganz gleich aus welchem Mandanten sie stammte),
     *   • jedes Konto ausser dem Administrator weist sein Kennwort vor.
     */
    async remove(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const id = req.params.id;
            const gate = await (0, dangerGate_1.checkDangerPassword)(employeeId, (0, dangerGate_1.passwordFromRequest)(req));
            if (!gate.ok)
                return res.status(gate.status).json({ error: gate.error, code: gate.code });
            const deleted = await this.articleRepository.softDeleteArticles(tenantId, [id]);
            if (!deleted)
                return res.status(404).json({ error: 'Ürün bulunamadı.' });
            AuditLogService_1.auditLog.log({
                action: 'inventory.article.delete',
                tenantId,
                employeeId,
                entityType: 'Article',
                entityId: id,
                ...AuditLogService_1.auditLog.context(req),
            });
            res.status(200).json({ message: 'Ürün silindi.', deleted });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * Sammellöschung aus der Produktliste (Auswahlkästchen). Eine Anweisung für
     * die ganze Auswahl; die Obergrenze deckt jede Seitengrösse der Liste ab und
     * hält zugleich die IN-Liste der Datenbank in vernünftigen Grenzen.
     */
    async removeMany(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
            const ids = [...new Set(raw.map((value) => String(value || '').trim()).filter(Boolean))];
            if (!ids.length)
                return res.status(400).json({ error: 'Silinecek ürün seçilmedi.' });
            if (ids.length > 500)
                return res.status(400).json({ error: 'Tek seferde en fazla 500 ürün silinebilir.' });
            const gate = await (0, dangerGate_1.checkDangerPassword)(employeeId, (0, dangerGate_1.passwordFromRequest)(req));
            if (!gate.ok)
                return res.status(gate.status).json({ error: gate.error, code: gate.code });
            const deleted = await this.articleRepository.softDeleteArticles(tenantId, ids);
            AuditLogService_1.auditLog.log({
                action: 'inventory.article.bulkDelete',
                tenantId,
                employeeId,
                entityType: 'Article',
                metadata: { requested: ids.length, deleted },
                ...AuditLogService_1.auditLog.context(req),
            });
            res.status(200).json({ deleted, requested: ids.length });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.ArticleController = ArticleController;
//# sourceMappingURL=ArticleController.js.map