"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.quickScanError = exports.quickScanArticleWhere = exports.quickScanArticleSelect = void 0;
exports.receiveQuickStockUnit = receiveQuickStockUnit;
const nanoid_1 = require("nanoid");
exports.quickScanArticleSelect = {
    id: true, articleCode: true, name: true, unit: true,
    modelNumber: true, serialNumber: true, supplierBarcode: true, systemBarcode: true,
    stockBalances: { select: { currentQuantity: true } },
};
const quickScanArticleWhere = (tenantId, code) => ({
    tenantId, deletedAt: null,
    OR: [
        { supplierBarcode: code }, { systemBarcode: code }, { serialNumber: code },
        { articleCode: code }, { modelNumber: code }, { barcodes: { some: { barcode: code } } },
    ],
});
exports.quickScanArticleWhere = quickScanArticleWhere;
const quickScanError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
exports.quickScanError = quickScanError;
/** Caller owns the transaction: device, optional article and stock must commit together. */
async function receiveQuickStockUnit(tx, input) {
    const { tenantId, barcode, serialNumber } = input;
    const duplicate = await tx.stockUnit.findFirst({
        where: { tenantId, OR: [{ barcode }, ...(serialNumber ? [{ serialNumber }] : [])] },
    });
    if (duplicate)
        throw (0, exports.quickScanError)('STOCK_UNIT_EXISTS', 'Dieses Gerät wurde bereits erfasst.');
    const matches = await tx.article.findMany({
        where: (0, exports.quickScanArticleWhere)(tenantId, barcode), select: exports.quickScanArticleSelect,
    });
    if (input.articleId && matches.length && !matches.some((row) => row.id === input.articleId)) {
        throw (0, exports.quickScanError)('ARTICLE_MISMATCH', 'Dieser Barcode gehört zu einem anderen Artikel.');
    }
    let article = input.articleId
        ? await tx.article.findFirst({ where: { id: input.articleId, tenantId, deletedAt: null }, select: exports.quickScanArticleSelect })
        : matches.length === 1 ? matches[0] : null;
    let createdArticle = false;
    if (!article) {
        if (input.articleId)
            throw (0, exports.quickScanError)('ARTICLE_NOT_FOUND', 'Artikel nicht gefunden.', 404);
        if (matches.length > 1 || !input.newArticle) {
            throw (0, exports.quickScanError)('ARTICLE_REQUIRED', 'Bitte einen vorhandenen Artikel wählen oder einen neuen anlegen.', 400);
        }
        article = await tx.article.create({
            data: { id: (0, nanoid_1.nanoid)(10), tenantId, ...input.newArticle, itemType: 'PRODUCT' },
            select: exports.quickScanArticleSelect,
        });
        createdArticle = true;
    }
    // A unique key also protects against concurrent scans from other sessions.
    const stockUnit = await tx.stockUnit.create({
        data: { id: (0, nanoid_1.nanoid)(12), tenantId, articleId: article.id, barcode, serialNumber },
    });
    await tx.stockMovement.create({
        data: {
            id: (0, nanoid_1.nanoid)(12), tenantId, articleId: article.id, employeeId: input.employeeId,
            destinationLocationId: input.locationId, movementType: 'IN', quantity: 1,
            origin: 'QUICK_ADD', scannedBarcode: barcode, serialNumber,
        },
    });
    await tx.stockBalance.upsert({
        where: { articleId_locationId: { articleId: article.id, locationId: input.locationId } },
        create: { id: (0, nanoid_1.nanoid)(12), tenantId, articleId: article.id, locationId: input.locationId, currentQuantity: 1 },
        update: { currentQuantity: { increment: 1 } },
    });
    const { stockBalances, ...details } = article;
    return {
        stockUnit, createdArticle,
        article: { ...details, totalQuantity: stockBalances.reduce((sum, row) => sum + row.currentQuantity, 0) + 1 },
    };
}
//# sourceMappingURL=quickAddStockUnit.js.map