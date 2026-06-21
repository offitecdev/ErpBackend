"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionArticleMapping = exports.Article = void 0;
class Article {
    id;
    tenantId;
    articleCode;
    name;
    baseCost;
    unit;
    description;
    systemBarcode;
    supplierBarcode;
    imageUrl;
    category;
    status;
    isActive;
    minStockLevel;
    criticalStockLevel;
    maxStockLevel;
    lastPurchaseDate;
    salePrice;
    defaultSupplierId;
    constructor(id, tenantId, articleCode, name, baseCost, unit, description, systemBarcode, supplierBarcode, imageUrl, category, status = 'ACTIVE', isActive = true, minStockLevel = 0, criticalStockLevel = 0, maxStockLevel, lastPurchaseDate, salePrice = 0, defaultSupplierId) {
        this.id = id;
        this.tenantId = tenantId;
        this.articleCode = articleCode;
        this.name = name;
        this.baseCost = baseCost;
        this.unit = unit;
        this.description = description;
        this.systemBarcode = systemBarcode;
        this.supplierBarcode = supplierBarcode;
        this.imageUrl = imageUrl;
        this.category = category;
        this.status = status;
        this.isActive = isActive;
        this.minStockLevel = minStockLevel;
        this.criticalStockLevel = criticalStockLevel;
        this.maxStockLevel = maxStockLevel;
        this.lastPurchaseDate = lastPurchaseDate;
        this.salePrice = salePrice;
        this.defaultSupplierId = defaultSupplierId;
    }
}
exports.Article = Article;
class PositionArticleMapping {
    id;
    positionId;
    articleId;
    quantityMultiplier;
    discount;
    article;
    constructor(id, positionId, articleId, quantityMultiplier, discount, article) {
        this.id = id;
        this.positionId = positionId;
        this.articleId = articleId;
        this.quantityMultiplier = quantityMultiplier;
        this.discount = discount;
        this.article = article;
    }
}
exports.PositionArticleMapping = PositionArticleMapping;
//# sourceMappingURL=Article.js.map