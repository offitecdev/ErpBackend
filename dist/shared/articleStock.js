"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.articleStockTotal = exports.adjustArticleStock = void 0;
const nanoid_1 = require("nanoid");
const adjustArticleStock = async (tx, opts) => {
    const quantity = Number(opts.quantity) || 0;
    if (quantity <= 0)
        return;
    // Ana depo — yoksa oluşturulur (InventoryRepository.ensureDefaultLocation
    // ile aynı kural, ama mevcut transaction'ın içinde).
    let location = await tx.location.findFirst({
        where: { tenantId: opts.tenantId, locationType: 'MAIN_WAREHOUSE' },
        orderBy: { locationName: 'asc' },
        select: { id: true },
    });
    if (!location) {
        location = await tx.location.create({
            data: {
                id: (0, nanoid_1.nanoid)(8),
                tenantId: opts.tenantId,
                locationName: 'Ana Depo',
                locationType: 'MAIN_WAREHOUSE',
                isActive: true,
            },
            select: { id: true },
        });
    }
    const isIn = opts.direction === 'IN';
    await tx.stockBalance.upsert({
        where: { articleId_locationId: { articleId: opts.articleId, locationId: location.id } },
        update: { currentQuantity: isIn ? { increment: quantity } : { decrement: quantity } },
        create: {
            id: (0, nanoid_1.nanoid)(10),
            tenantId: opts.tenantId,
            articleId: opts.articleId,
            locationId: location.id,
            currentQuantity: isIn ? quantity : -quantity,
        },
    });
    const unitCost = isIn && opts.unitCost != null && Number(opts.unitCost) > 0 ? Number(opts.unitCost) : null;
    await tx.stockMovement.create({
        data: {
            id: (0, nanoid_1.nanoid)(12),
            tenantId: opts.tenantId,
            articleId: opts.articleId,
            movementType: isIn ? 'IN' : 'OUT',
            quantity,
            unitCost,
            sourceLocationId: isIn ? null : location.id,
            destinationLocationId: isIn ? location.id : null,
            employeeId: opts.employeeId,
            referenceId: opts.referenceId || null,
            description: opts.description || null,
        },
    });
};
exports.adjustArticleStock = adjustArticleStock;
/** Ürünün tüm lokasyonlardaki toplam bakiyesi (stok uyarıları için). */
const articleStockTotal = async (tx, articleId) => {
    const sum = await tx.stockBalance.aggregate({
        where: { articleId },
        _sum: { currentQuantity: true },
    });
    return Number(sum?._sum?.currentQuantity || 0);
};
exports.articleStockTotal = articleStockTotal;
//# sourceMappingURL=articleStock.js.map