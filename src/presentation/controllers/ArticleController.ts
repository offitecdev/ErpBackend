import { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { IArticleRepository } from '../../domain/repositories/IArticleRepository';
import { IInventoryRepository } from '../../domain/repositories/IInventoryRepository';
import { TenderActivityLogRepository } from '../../infrastructure/repositories/TenderActivityLogRepository';

export class ArticleController {
    constructor(
        private articleRepository: IArticleRepository,
        private inventoryRepository?: IInventoryRepository,
        private tenderLogRepo?: TenderActivityLogRepository
    ) {}

    async list(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const includeStock = req.query.includeStock === 'true';
            
            if (includeStock && this.inventoryRepository) {
                const summary = await this.inventoryRepository.getArticleStockSummary(tenantId);
                return res.status(200).json(summary);
            }

            const filter: any = { tenantId };
            if (req.query.search) filter.search = req.query.search;
            if (req.query.category) filter.category = req.query.category;
            if (req.query.status) filter.status = req.query.status;
            if (req.query.onlyActive === 'true') filter.onlyActive = true;
            const data = await this.articleRepository.findAllArticles(filter);
            res.status(200).json(data);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getById(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const includeImages = req.query.includeImages !== 'false';
            const article = await this.articleRepository.findArticleById(id, { includeImages });
            if (!article) return res.status(404).json({ error: 'Ürün bulunamadı.' });
            res.status(200).json(article);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async lookupByCode(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const code = req.params.code as string;
            const article = await this.articleRepository.findArticleByCode(tenantId, code);
            if (!article) return res.status(404).json({ error: 'Bu kod ya da barkoda sahip ürün bulunamadı.' });
            res.status(200).json(article);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async create(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const {
                articleCode, name, baseCost, unit, description,
                systemBarcode, supplierBarcode, imageUrl, category, itemType,
                status, isActive,
                minStockLevel, criticalStockLevel, maxStockLevel,
                lastPurchaseDate, salePrice, defaultSupplierId,
            } = req.body;

            if (!articleCode || !name || !unit) {
                return res.status(400).json({ error: "Ürün kodu, ad ve birim zorunludur." });
            }

            const created = await this.articleRepository.createArticle({
                id: nanoid(10),
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
                itemType: itemType === 'MATERIAL' ? 'MATERIAL' : 'PRODUCT',
                status: status ?? 'ACTIVE',
                isActive: isActive ?? true,
                minStockLevel: Number(minStockLevel ?? 0),
                criticalStockLevel: Number(criticalStockLevel ?? 0),
                maxStockLevel: maxStockLevel != null ? Number(maxStockLevel) : null,
                lastPurchaseDate: lastPurchaseDate ? new Date(lastPurchaseDate) : null,
            });
            res.status(201).json(created);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async update(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const before = await this.articleRepository.findArticleById(id);
            const patch: any = { ...req.body };
            const tenderId = patch.tenderId as string | undefined;
            const positionId = patch.positionId as string | undefined;
            const mappingId = patch.mappingId as string | undefined;
            delete patch.tenderId;
            delete patch.positionId;
            delete patch.mappingId;
            if (patch.baseCost != null) patch.baseCost = Number(patch.baseCost);
            if (patch.salePrice != null) patch.salePrice = Number(patch.salePrice);
            if (patch.minStockLevel != null) patch.minStockLevel = Number(patch.minStockLevel);
            if (patch.criticalStockLevel != null) patch.criticalStockLevel = Number(patch.criticalStockLevel);
            if (patch.maxStockLevel != null) patch.maxStockLevel = Number(patch.maxStockLevel);
            if (patch.lastPurchaseDate) patch.lastPurchaseDate = new Date(patch.lastPurchaseDate);
            const updated = await this.articleRepository.updateArticle(id, patch);

            if (before && tenderId && this.tenderLogRepo) {
                const tenantId = (req as any).user!.tenantId;
                const employeeId = (req as any).user!.id;
                const labels: Record<string, string> = {
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
                    .filter((field) => String((before as any)[field] ?? '') !== String((updated as any)[field] ?? ''))
                    .map((field) => ({
                        tenantId,
                        tenderId,
                        positionId: positionId ?? null,
                        mappingId: mappingId ?? null,
                        articleId: id,
                        employeeId,
                        actionType: field === 'baseCost' ? "ARTICLE_PRICE_UPDATED" : "ARTICLE_UPDATED",
                        fieldName: field,
                        oldValue: (before as any)[field] == null ? null : String((before as any)[field]),
                        newValue: (updated as any)[field] == null ? null : String((updated as any)[field]),
                        description: `${updated.name} - ${labels[field] ?? field} deÄŸiÅŸtirildi: ${(before as any)[field] ?? 'boÅŸ'} -> ${(updated as any)[field] ?? 'boÅŸ'}`
                    }));
                await this.tenderLogRepo.createMany(logs);
            }
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async remove(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            await this.articleRepository.deleteArticle(id);
            res.status(200).json({ message: 'Ürün silindi.' });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
