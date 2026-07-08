"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArticleRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Article_1 = require("../../domain/entities/Article");
const nanoid_1 = require("nanoid");
const mappingArticleSelect = {
    id: true,
    tenantId: true,
    articleCode: true,
    name: true,
    baseCost: true,
    unit: true,
    category: true,
    status: true,
    isActive: true,
    minStockLevel: true,
    criticalStockLevel: true,
    maxStockLevel: true,
    lastPurchaseDate: true,
    salePrice: true,
    defaultSupplierId: true,
};
class ArticleRepository {
    mapToEntity(d) {
        return new Article_1.Article(d.id, d.tenantId, d.articleCode, d.name, d.baseCost, d.unit, d.description, d.systemBarcode, d.supplierBarcode, d.imageUrl, d.category, d.status ?? 'ACTIVE', d.isActive ?? true, d.minStockLevel ?? 0, d.criticalStockLevel ?? 0, d.maxStockLevel, d.lastPurchaseDate, d.salePrice ?? 0, d.defaultSupplierId ?? null, d.itemType ?? 'PRODUCT');
    }
    mapToMappingEntity(data) {
        const articleEntity = data.article ? this.mapToEntity(data.article) : undefined;
        return new Article_1.PositionArticleMapping(data.id, data.positionId, data.articleId, data.quantityMultiplier, data.discount, articleEntity);
    }
    async createArticle(articleData) {
        const data = await prisma_client_1.default.article.create({
            data: {
                id: articleData.id || (0, nanoid_1.nanoid)(10),
                tenantId: articleData.tenantId,
                articleCode: articleData.articleCode,
                name: articleData.name,
                baseCost: articleData.baseCost ?? 0,
                salePrice: articleData.salePrice ?? 0,
                defaultSupplierId: articleData.defaultSupplierId ?? null,
                unit: articleData.unit,
                description: articleData.description ?? null,
                systemBarcode: articleData.systemBarcode ?? null,
                supplierBarcode: articleData.supplierBarcode ?? null,
                imageUrl: articleData.imageUrl ?? null,
                category: articleData.category ?? null,
                itemType: articleData.itemType ?? 'PRODUCT',
                status: articleData.status ?? 'ACTIVE',
                isActive: articleData.isActive ?? true,
                minStockLevel: articleData.minStockLevel ?? 0,
                criticalStockLevel: articleData.criticalStockLevel ?? 0,
                maxStockLevel: articleData.maxStockLevel ?? null,
                lastPurchaseDate: articleData.lastPurchaseDate ?? null,
            }
        });
        return this.mapToEntity(data);
    }
    async updateArticle(id, patch) {
        const updateData = {};
        const fields = [
            'articleCode', 'name', 'baseCost', 'unit', 'description',
            'systemBarcode', 'supplierBarcode', 'imageUrl', 'category',
            'status', 'isActive', 'minStockLevel', 'criticalStockLevel',
            'maxStockLevel', 'lastPurchaseDate', 'salePrice', 'defaultSupplierId',
            'itemType'
        ];
        for (const f of fields) {
            if (patch[f] !== undefined)
                updateData[f] = patch[f];
        }
        const data = await prisma_client_1.default.article.update({ where: { id }, data: updateData });
        return this.mapToEntity(data);
    }
    async deleteArticle(id) {
        await prisma_client_1.default.$transaction(async (tx) => {
            await tx.positionArticleMapping.deleteMany({ where: { articleId: id } });
            await tx.stockBalance.deleteMany({ where: { articleId: id } });
            await tx.purchaseProposal.deleteMany({ where: { articleId: id } });
            await tx.stockMovement.deleteMany({ where: { articleId: id } });
            await tx.articleSupplier.deleteMany({ where: { articleId: id } });
            await tx.article.delete({ where: { id } });
        });
    }
    async findAllArticles(filter) {
        const where = { tenantId: filter.tenantId };
        if (filter.onlyActive)
            where.isActive = true;
        if (filter.category)
            where.category = filter.category;
        if (filter.status)
            where.status = filter.status;
        if (filter.search) {
            where.OR = [
                { articleCode: { contains: filter.search } },
                { name: { contains: filter.search } },
                { systemBarcode: { contains: filter.search } },
                { supplierBarcode: { contains: filter.search } },
            ];
        }
        const data = await prisma_client_1.default.article.findMany({
            where,
            orderBy: { name: 'asc' }
        });
        return data.map(d => this.mapToEntity(d));
    }
    async findArticleById(id) {
        const data = await prisma_client_1.default.article.findUnique({ where: { id } });
        return data ? this.mapToEntity(data) : null;
    }
    async findArticleByCode(tenantId, codeOrBarcode) {
        const data = await prisma_client_1.default.article.findFirst({
            where: {
                tenantId,
                OR: [
                    { articleCode: codeOrBarcode },
                    { systemBarcode: codeOrBarcode },
                    { supplierBarcode: codeOrBarcode },
                ]
            }
        });
        return data ? this.mapToEntity(data) : null;
    }
    async mapArticleToPosition(mapping) {
        const data = await prisma_client_1.default.positionArticleMapping.create({
            data: {
                id: (0, nanoid_1.nanoid)(10),
                positionId: mapping.positionId,
                articleId: mapping.articleId,
                quantityMultiplier: mapping.quantityMultiplier,
                discount: mapping.discount ?? 0
            },
            select: {
                id: true,
                positionId: true,
                articleId: true,
                quantityMultiplier: true,
                discount: true,
                article: { select: mappingArticleSelect },
            }
        });
        return this.mapToMappingEntity(data);
    }
    async findMappingById(mappingId) {
        const data = await prisma_client_1.default.positionArticleMapping.findUnique({
            where: { id: mappingId },
            select: {
                id: true,
                positionId: true,
                articleId: true,
                quantityMultiplier: true,
                discount: true,
                article: { select: mappingArticleSelect },
            }
        });
        if (!data)
            return null;
        return this.mapToMappingEntity(data);
    }
    async updateMapping(mappingId, patch) {
        const data = await prisma_client_1.default.positionArticleMapping.update({
            where: { id: mappingId },
            data: {
                ...(patch.quantityMultiplier !== undefined ? { quantityMultiplier: patch.quantityMultiplier } : {}),
                ...(patch.discount !== undefined ? { discount: patch.discount ?? 0 } : {}),
            },
            select: {
                id: true,
                positionId: true,
                articleId: true,
                quantityMultiplier: true,
                discount: true,
                article: { select: mappingArticleSelect },
            }
        });
        return this.mapToMappingEntity(data);
    }
    async getMappingsByPositionId(positionId) {
        const data = await prisma_client_1.default.positionArticleMapping.findMany({
            where: { positionId },
            select: {
                id: true,
                positionId: true,
                articleId: true,
                quantityMultiplier: true,
                discount: true,
                article: { select: mappingArticleSelect },
            }
        });
        return data.map(d => this.mapToMappingEntity(d));
    }
    async removeMapping(mappingId) {
        await prisma_client_1.default.positionArticleMapping.delete({ where: { id: mappingId } });
    }
}
exports.ArticleRepository = ArticleRepository;
//# sourceMappingURL=ArticleRepository.js.map