"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArticleController = void 0;
const nanoid_1 = require("nanoid");
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
            const article = await this.articleRepository.findArticleById(id);
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
            const { articleCode, name, baseCost, unit, description, systemBarcode, supplierBarcode, imageUrl, category, status, isActive, minStockLevel, criticalStockLevel, maxStockLevel, lastPurchaseDate, salePrice, defaultSupplierId, } = req.body;
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
                description: description ?? null,
                systemBarcode: systemBarcode ?? null,
                supplierBarcode: supplierBarcode ?? null,
                imageUrl: imageUrl ?? null,
                category: category ?? null,
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
    async remove(req, res) {
        try {
            const id = req.params.id;
            await this.articleRepository.deleteArticle(id);
            res.status(200).json({ message: 'Ürün silindi.' });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.ArticleController = ArticleController;
//# sourceMappingURL=ArticleController.js.map