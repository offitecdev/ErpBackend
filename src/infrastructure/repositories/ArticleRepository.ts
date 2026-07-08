

import prisma from "../database/prisma.client";
import { IArticleRepository, IArticleFilter } from "../../domain/repositories/IArticleRepository";
import { Article, PositionArticleMapping, ArticleStatus } from "../../domain/entities/Article";
import { nanoid } from "nanoid";

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
} as const;

export class ArticleRepository implements IArticleRepository {

    private mapToEntity(d: any): Article {
        return new Article(
            d.id,
            d.tenantId,
            d.articleCode,
            d.name,
            d.baseCost,
            d.unit,
            d.description,
            d.systemBarcode,
            d.supplierBarcode,
            d.imageUrl,
            d.category,
            (d.status as ArticleStatus) ?? 'ACTIVE',
            d.isActive ?? true,
            d.minStockLevel ?? 0,
            d.criticalStockLevel ?? 0,
            d.maxStockLevel,
            d.lastPurchaseDate,
            d.salePrice ?? 0,
            d.defaultSupplierId ?? null,
            d.itemType ?? 'PRODUCT'
        );
    }

    private mapToMappingEntity(data: any): PositionArticleMapping {
        const articleEntity = data.article ? this.mapToEntity(data.article) : undefined;
        return new PositionArticleMapping(
            data.id,
            data.positionId,
            data.articleId,
            data.quantityMultiplier,
            data.discount,
            articleEntity
        );
    }

    async createArticle(articleData: Partial<Article>): Promise<Article> {
        const data = await prisma.article.create({
            data: {
                id: articleData.id || nanoid(10),
                tenantId: articleData.tenantId!,
                articleCode: articleData.articleCode!,
                name: articleData.name!,
                baseCost: articleData.baseCost ?? 0,
                salePrice: (articleData as any).salePrice ?? 0,
                defaultSupplierId: (articleData as any).defaultSupplierId ?? null,
                unit: articleData.unit!,
                description: articleData.description ?? null,
                systemBarcode: articleData.systemBarcode ?? null,
                supplierBarcode: articleData.supplierBarcode ?? null,
                imageUrl: articleData.imageUrl ?? null,
                category: articleData.category ?? null,
                itemType: (articleData as any).itemType ?? 'PRODUCT',
                status: articleData.status ?? 'ACTIVE',
                isActive: articleData.isActive ?? true,
                minStockLevel: articleData.minStockLevel ?? 0,
                criticalStockLevel: articleData.criticalStockLevel ?? 0,
                maxStockLevel: articleData.maxStockLevel ?? null,
                lastPurchaseDate: articleData.lastPurchaseDate ?? null,
            } as any
        });
        return this.mapToEntity(data);
    }

    async updateArticle(id: string, patch: Partial<Article>): Promise<Article> {
        const updateData: any = {};
        const fields: (keyof Article)[] = [
            'articleCode', 'name', 'baseCost', 'unit', 'description',
            'systemBarcode', 'supplierBarcode', 'imageUrl', 'category',
            'status', 'isActive', 'minStockLevel', 'criticalStockLevel',
            'maxStockLevel', 'lastPurchaseDate', 'salePrice', 'defaultSupplierId',
            'itemType'
        ];
        for (const f of fields) {
            if (patch[f] !== undefined) updateData[f] = patch[f];
        }
        const data = await prisma.article.update({ where: { id }, data: updateData });
        return this.mapToEntity(data);
    }

    async deleteArticle(id: string): Promise<void> {
        await prisma.$transaction(async (tx) => {
            await tx.positionArticleMapping.deleteMany({ where: { articleId: id } });
            await tx.stockBalance.deleteMany({ where: { articleId: id } });
            await tx.purchaseProposal.deleteMany({ where: { articleId: id } });
            await tx.stockMovement.deleteMany({ where: { articleId: id } });
            await (tx as any).articleSupplier.deleteMany({ where: { articleId: id } });
            await tx.article.delete({ where: { id } });
        });
    }

    async findAllArticles(filter: IArticleFilter): Promise<Article[]> {
        const where: any = { tenantId: filter.tenantId };
        if (filter.onlyActive) where.isActive = true;
        if (filter.category) where.category = filter.category;
        if (filter.status) where.status = filter.status;
        if (filter.search) {
            where.OR = [
                { articleCode: { contains: filter.search } },
                { name: { contains: filter.search } },
                { systemBarcode: { contains: filter.search } },
                { supplierBarcode: { contains: filter.search } },
            ];
        }
        const data = await prisma.article.findMany({
            where,
            orderBy: { name: 'asc' }
        });
        return data.map(d => this.mapToEntity(d));
    }

    async findArticleById(id: string): Promise<Article | null> {
        const data = await prisma.article.findUnique({ where: { id } });
        return data ? this.mapToEntity(data) : null;
    }

    async findArticleByCode(tenantId: string, codeOrBarcode: string): Promise<Article | null> {
        const data = await prisma.article.findFirst({
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

    async mapArticleToPosition(mapping: Partial<PositionArticleMapping>): Promise<PositionArticleMapping> {
        const data = await prisma.positionArticleMapping.create({
            data: {
                id: nanoid(10),
                positionId: mapping.positionId!,
                articleId: mapping.articleId!,
                quantityMultiplier: mapping.quantityMultiplier!,
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

    async findMappingById(mappingId: string): Promise<PositionArticleMapping | null> {
        const data = await prisma.positionArticleMapping.findUnique({
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
        if (!data) return null;
        return this.mapToMappingEntity(data);
    }

    async updateMapping(mappingId: string, patch: { quantityMultiplier?: number; discount?: number | null }): Promise<PositionArticleMapping> {
        const data = await prisma.positionArticleMapping.update({
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

    async getMappingsByPositionId(positionId: string): Promise<PositionArticleMapping[]> {
        const data = await prisma.positionArticleMapping.findMany({
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

    async removeMapping(mappingId: string): Promise<void> {
        await prisma.positionArticleMapping.delete({ where: { id: mappingId } });
    }
}
