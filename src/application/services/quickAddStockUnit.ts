import type prisma from '../../infrastructure/database/prisma.client';
import { nanoid } from 'nanoid';

export const quickScanArticleSelect = {
    id: true, articleCode: true, name: true, unit: true,
    modelNumber: true, serialNumber: true, supplierBarcode: true, systemBarcode: true,
    stockBalances: { select: { currentQuantity: true } },
} as const;

export const quickScanArticleWhere = (tenantId: string, code: string) => ({
    tenantId, deletedAt: null,
    OR: [
        { supplierBarcode: code }, { systemBarcode: code }, { serialNumber: code },
        { articleCode: code }, { modelNumber: code }, { barcodes: { some: { barcode: code } } },
    ],
});

export const quickScanError = (code: string, message: string, status = 409) =>
    Object.assign(new Error(message), { code, status });

/** Caller owns the transaction: device, optional article and stock must commit together. */
export async function receiveQuickStockUnit(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], input: {
    tenantId: string;
    employeeId: string;
    locationId: string;
    barcode: string;
    serialNumber: string | null;
    articleId?: string | undefined;
    newArticle?: { articleCode: string; name: string; modelNumber: string | null; unit: string } | undefined;
}) {
    const { tenantId, barcode, serialNumber } = input;
    const duplicate = await tx.stockUnit.findFirst({
        where: { tenantId, OR: [{ barcode }, ...(serialNumber ? [{ serialNumber }] : [])] },
    });
    if (duplicate) throw quickScanError('STOCK_UNIT_EXISTS', 'Dieses Gerät wurde bereits erfasst.');

    const matches = await tx.article.findMany({
        where: quickScanArticleWhere(tenantId, barcode), select: quickScanArticleSelect,
    });
    if (input.articleId && matches.length && !matches.some((row) => row.id === input.articleId)) {
        throw quickScanError('ARTICLE_MISMATCH', 'Dieser Barcode gehört zu einem anderen Artikel.');
    }
    let article = input.articleId
        ? await tx.article.findFirst({ where: { id: input.articleId, tenantId, deletedAt: null }, select: quickScanArticleSelect })
        : matches.length === 1 ? matches[0] : null;
    let createdArticle = false;
    if (!article) {
        if (input.articleId) throw quickScanError('ARTICLE_NOT_FOUND', 'Artikel nicht gefunden.', 404);
        if (matches.length > 1 || !input.newArticle) {
            throw quickScanError('ARTICLE_REQUIRED', 'Bitte einen vorhandenen Artikel wählen oder einen neuen anlegen.', 400);
        }
        article = await tx.article.create({
            data: { id: nanoid(10), tenantId, ...input.newArticle, itemType: 'PRODUCT' },
            select: quickScanArticleSelect,
        });
        createdArticle = true;
    }
    // A unique key also protects against concurrent scans from other sessions.
    const stockUnit = await tx.stockUnit.create({
        data: { id: nanoid(12), tenantId, articleId: article.id, barcode, serialNumber },
    });
    await tx.stockMovement.create({
        data: {
            id: nanoid(12), tenantId, articleId: article.id, employeeId: input.employeeId,
            destinationLocationId: input.locationId, movementType: 'IN', quantity: 1,
            origin: 'QUICK_ADD', scannedBarcode: barcode, serialNumber,
        },
    });
    await tx.stockBalance.upsert({
        where: { articleId_locationId: { articleId: article.id, locationId: input.locationId } },
        create: { id: nanoid(12), tenantId, articleId: article.id, locationId: input.locationId, currentQuantity: 1 },
        update: { currentQuantity: { increment: 1 } },
    });
    const { stockBalances, ...details } = article;
    return {
        stockUnit, createdArticle,
        article: { ...details, totalQuantity: stockBalances.reduce((sum, row) => sum + row.currentQuantity, 0) + 1 },
    };
}
