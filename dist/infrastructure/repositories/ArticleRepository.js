"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArticleRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Article_1 = require("../../domain/entities/Article");
const nanoid_1 = require("nanoid");
const PdfImageThumbnailService_1 = require("../services/PdfImageThumbnailService");
// Das Produktbild liegt in R2. Die Spalte traegt den Verweis, der Browser
// bekommt die feste Adresse am Eimer (assets.demo.offitec.ch) — dieselbe
// Bauart wie die Terminunterlagen im Kalender.
const ImageStore_1 = require("../services/ImageStore");
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
    articleSelect(includeImages = true) {
        return {
            id: true,
            tenantId: true,
            articleCode: true,
            name: true,
            baseCost: true,
            salePrice: true,
            defaultSupplierId: true,
            unit: true,
            description: true,
            systemBarcode: true,
            supplierBarcode: true,
            ...(includeImages ? { imageUrl: true } : {}),
            category: true,
            itemType: true,
            status: true,
            isActive: true,
            minStockLevel: true,
            criticalStockLevel: true,
            maxStockLevel: true,
            lastPurchaseDate: true,
        };
    }
    mapToEntity(d) {
        return new Article_1.Article(d.id, d.tenantId, d.articleCode, d.name, d.baseCost, d.unit, d.description, d.systemBarcode, d.supplierBarcode, d.imageUrl, d.category, d.status ?? 'ACTIVE', d.isActive ?? true, d.minStockLevel ?? 0, d.criticalStockLevel ?? 0, d.maxStockLevel, d.lastPurchaseDate, d.salePrice ?? 0, d.defaultSupplierId ?? null, d.itemType ?? 'PRODUCT');
    }
    mapToMappingEntity(data) {
        const articleEntity = data.article ? this.mapToEntity(data.article) : undefined;
        return new Article_1.PositionArticleMapping(data.id, data.positionId, data.articleId, data.quantityMultiplier, data.discount, articleEntity);
    }
    async createArticle(articleData) {
        // Eine frische Daten-URI wandert nach R2; die Spalte bekommt den
        // Verweis. Alles andere (schon abgelegt, leer) bleibt, wie es ist.
        const incomingImage = articleData.imageUrl ?? null;
        const imageUrl = await (0, ImageStore_1.storeArticleImage)(articleData.tenantId, incomingImage);
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
                imageUrl,
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
        // Das Vorschaubild entsteht aus den Bytes, die ohnehin schon hier
        // liegen — der Verweis muesste dafuer erst wieder gelesen werden.
        await (0, PdfImageThumbnailService_1.persistPdfThumbnail)(data.tenantId, 'ARTICLE', data.id, incomingImage || imageUrl, String(data.updatedAt.getTime()));
        const entity = this.mapToEntity(data);
        await (0, ImageStore_1.resolveArticleImagesInPlace)([entity]);
        return entity;
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
        /* DIE ZURUECKGESCHICKTE ADRESSE WIRD NICHT GESCHRIEBEN.
         *
         * Beim Lesen steht in `imageUrl` die Adresse am Eimer; der Browser
         * schickt sie beim naechsten Speichern arglos mit. Wuerde sie in die
         * Spalte wandern, stuende dort die Adresse statt des Verweises auf die
         * Datei — und ein Domainwechsel machte sie unbrauchbar. `valueForWrite`
         * ist die Regel, hier ihre Anwendung: nur eine NEUE Daten-URI oder ein
         * ausdrueckliches `null` fassen die Spalte an. */
        if (patch.imageUrl !== undefined) {
            const owner = await prisma_client_1.default.article.findUnique({ where: { id }, select: { tenantId: true } });
            const next = await (0, ImageStore_1.valueForWrite)(ImageStore_1.articleImageStorage, owner?.tenantId ?? '', patch.imageUrl);
            if (next === undefined)
                delete updateData.imageUrl;
            else
                updateData.imageUrl = next;
        }
        const data = await prisma_client_1.default.article.update({ where: { id }, data: updateData });
        if (updateData.imageUrl !== undefined) {
            await (0, PdfImageThumbnailService_1.persistPdfThumbnail)(data.tenantId, 'ARTICLE', data.id, 
            // Die frische Daten-URI, solange sie hier noch liegt.
            (typeof patch.imageUrl === 'string' && patch.imageUrl.startsWith('data:'))
                ? patch.imageUrl
                : updateData.imageUrl, String(data.updatedAt.getTime()));
        }
        const entity = this.mapToEntity(data);
        await (0, ImageStore_1.resolveArticleImagesInPlace)([entity]);
        return entity;
    }
    async deleteArticle(id) {
        // Keep stock history and references intact; deletion moves the product card
        // to trash so it can be recovered administratively.
        await prisma_client_1.default.article.update({
            where: { id },
            data: {
                deletedAt: new Date(),
                status: 'INACTIVE',
                isActive: false,
            },
        });
    }
    /**
     * Mehrere Produktkarten in einem Zug in den Papierkorb — dieselbe Wirkung
     * wie `deleteArticle`, aber MANDANTENGEBUNDEN und als eine Anweisung, damit
     * eine Auswahl von 200 Zeilen nicht 200 Rundgänge zur fernen Datenbank
     * kostet. Fremde oder schon gelöschte Karten fallen durch die Bedingung
     * heraus; zurück kommt, was wirklich gelöscht wurde.
     */
    async softDeleteArticles(tenantId, ids) {
        if (!ids.length)
            return 0;
        const result = await prisma_client_1.default.article.updateMany({
            where: { id: { in: ids }, tenantId, deletedAt: null },
            data: { deletedAt: new Date(), status: 'INACTIVE', isActive: false },
        });
        return result.count;
    }
    /** Die GANZE Produktliste einer Firma in den Papierkorb (Zurücksetzen). */
    async softDeleteAllArticles(tenantId) {
        const result = await prisma_client_1.default.article.updateMany({
            where: { tenantId, deletedAt: null },
            data: { deletedAt: new Date(), status: 'INACTIVE', isActive: false },
        });
        return result.count;
    }
    async findAllArticles(filter) {
        const where = { tenantId: filter.tenantId, deletedAt: null };
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
        const entities = data.map(d => this.mapToEntity(d));
        await (0, ImageStore_1.resolveArticleImagesInPlace)(entities);
        return entities;
    }
    async findArticleById(id, options) {
        const data = await prisma_client_1.default.article.findFirst({
            where: { id, deletedAt: null },
            // `includeImages=false` must prevent MariaDB from reading the LONGTEXT
            // column, not merely remove it from the JSON response afterwards.
            select: this.articleSelect(options?.includeImages !== false),
        });
        if (!data)
            return null;
        const entity = this.mapToEntity(data);
        await (0, ImageStore_1.resolveArticleImagesInPlace)([entity]);
        return entity;
    }
    async findArticleByCode(tenantId, codeOrBarcode) {
        const data = await prisma_client_1.default.article.findFirst({
            where: {
                tenantId,
                deletedAt: null,
                OR: [
                    { articleCode: codeOrBarcode },
                    { systemBarcode: codeOrBarcode },
                    { supplierBarcode: codeOrBarcode },
                ]
            }
        });
        if (!data)
            return null;
        const entity = this.mapToEntity(data);
        await (0, ImageStore_1.resolveArticleImagesInPlace)([entity]);
        return entity;
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