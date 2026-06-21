"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Inventory_1 = require("../../domain/entities/Inventory");
const Article_1 = require("../../domain/entities/Article");
const nanoid_1 = require("nanoid");
const inboundCostMovementTypes = new Set(['IN', 'RETURN', 'ADJUSTMENT']);
const computeArticleCostSummary = (article) => {
    const suppliers = Array.isArray(article.articleSuppliers) ? article.articleSuppliers : [];
    const balances = Array.isArray(article.stockBalances) ? article.stockBalances : [];
    const movements = Array.isArray(article.stockMovements) ? article.stockMovements : [];
    const supplierIds = new Set(suppliers.map((row) => row.id));
    const supplierCostQuantity = suppliers.reduce((sum, row) => sum + Math.max(0, Number(row.quantity || 0)), 0);
    const supplierCostValue = suppliers.reduce((sum, row) => sum + Math.max(0, Number(row.quantity || 0)) * Math.max(0, Number(row.purchasePrice || 0)), 0);
    const totalQuantity = balances.reduce((sum, row) => sum + Number(row.currentQuantity || 0), 0);
    const manualUnitCost = Math.max(0, Number(article.baseCost || 0));
    // Manuel stok girişleri: her hareket kendi birim maliyetini taşır (yoksa ürün kartı maliyetine düşer).
    const manualMovements = movements
        .filter((movement) => inboundCostMovementTypes.has(String(movement.movementType)))
        .filter((movement) => !movement.referenceId || !supplierIds.has(movement.referenceId))
        .filter((movement) => !String(movement.description || '').toLocaleLowerCase('tr-TR').startsWith('tedarik'));
    let manualCostQuantity = manualMovements.reduce((sum, movement) => sum + Math.max(0, Number(movement.quantity || 0)), 0);
    let manualCostValue = manualMovements.reduce((sum, movement) => {
        const qty = Math.max(0, Number(movement.quantity || 0));
        const unitCost = movement.unitCost != null && Number(movement.unitCost) > 0
            ? Number(movement.unitCost)
            : manualUnitCost;
        return sum + qty * unitCost;
    }, 0);
    // Hareket kaydı olmayan eski/açılış stoğu varsa, kalanı ürün kartı maliyetiyle değerle.
    if (manualCostQuantity <= 0 && totalQuantity > supplierCostQuantity) {
        manualCostQuantity = totalQuantity - supplierCostQuantity;
        manualCostValue = manualCostQuantity * manualUnitCost;
    }
    const costBasisQuantity = supplierCostQuantity + manualCostQuantity;
    const costBasisValue = supplierCostValue + manualCostValue;
    const weightedAverageCost = costBasisQuantity > 0
        ? costBasisValue / costBasisQuantity
        : manualUnitCost;
    return {
        weightedAverageCost,
        costBasisQuantity,
        costBasisValue,
        supplierCostQuantity,
        supplierCostValue,
        manualCostQuantity,
        manualCostValue,
    };
};
class InventoryRepository {
    async createLocation(locationData) {
        const data = await prisma_client_1.default.location.create({
            data: {
                id: locationData.id || (0, nanoid_1.nanoid)(8),
                tenantId: locationData.tenantId,
                locationName: locationData.locationName,
                locationType: locationData.locationType,
                parentLocationId: locationData.parentLocationId || null,
                isActive: locationData.isActive ?? true
            }
        });
        return new Inventory_1.Location(data.id, data.tenantId, data.locationName, data.locationType, data.isActive, data.parentLocationId);
    }
    async getLocations(tenantId) {
        const data = await prisma_client_1.default.location.findMany({ where: { tenantId } });
        return data.map(d => new Inventory_1.Location(d.id, d.tenantId, d.locationName, d.locationType, d.isActive, d.parentLocationId));
    }
    async getStockBalance(articleId, locationId) {
        const data = await prisma_client_1.default.stockBalance.findUnique({
            where: { articleId_locationId: { articleId, locationId } }
        });
        if (!data)
            return null;
        return new Inventory_1.StockBalance(data.id, data.tenantId, data.articleId, data.locationId, data.currentQuantity, data.reservedQuantity, data.updatedAt);
    }
    async getAllBalances(tenantId, locationId) {
        const where = { tenantId };
        if (locationId)
            where.locationId = locationId;
        return await prisma_client_1.default.stockBalance.findMany({
            where,
            include: {
                article: { select: { id: true, articleCode: true, name: true, unit: true, baseCost: true, salePrice: true, minStockLevel: true, criticalStockLevel: true, imageUrl: true, systemBarcode: true } },
                location: { select: { locationName: true, locationType: true } }
            }
        });
    }
    async getArticleStockSummary(tenantId) {
        const articles = await prisma_client_1.default.article.findMany({
            where: { tenantId },
            include: {
                stockBalances: {
                    include: { location: { select: { locationName: true, locationType: true } } }
                },
                articleSuppliers: {
                    include: {
                        supplier: true,
                        location: { select: { id: true, locationName: true, locationType: true } }
                    },
                    orderBy: [{ isPreferred: 'desc' }, { lastPurchaseDate: 'desc' }, { updatedAt: 'desc' }]
                },
                stockMovements: {
                    select: {
                        id: true,
                        movementType: true,
                        quantity: true,
                        unitCost: true,
                        referenceId: true,
                        transactionDate: true,
                        description: true,
                    }
                },
            }
        });
        return articles.map((a) => {
            const costSummary = computeArticleCostSummary(a);
            return {
                id: a.id,
                articleCode: a.articleCode,
                name: a.name,
                description: a.description,
                unit: a.unit,
                baseCost: a.baseCost,
                salePrice: a.salePrice ?? 0,
                defaultSupplierId: a.defaultSupplierId,
                imageUrl: a.imageUrl,
                systemBarcode: a.systemBarcode,
                supplierBarcode: a.supplierBarcode,
                isActive: a.isActive,
                status: a.status,
                category: a.category,
                minStockLevel: a.minStockLevel,
                criticalStockLevel: a.criticalStockLevel,
                maxStockLevel: a.maxStockLevel,
                lastPurchaseDate: a.lastPurchaseDate,
                totalQuantity: a.stockBalances.reduce((s, b) => s + (b.currentQuantity || 0), 0),
                totalReserved: a.stockBalances.reduce((s, b) => s + (b.reservedQuantity || 0), 0),
                balances: a.stockBalances.map((b) => ({
                    locationId: b.locationId,
                    locationName: b.location?.locationName,
                    locationType: b.location?.locationType,
                    currentQuantity: b.currentQuantity,
                    reservedQuantity: b.reservedQuantity,
                })),
                suppliers: a.articleSuppliers,
                ...costSummary,
            };
        });
    }
    async findArticleByBarcodeOrCode(tenantId, codeOrBarcode) {
        const data = await prisma_client_1.default.article.findFirst({
            where: {
                tenantId,
                OR: [
                    { systemBarcode: codeOrBarcode },
                    { supplierBarcode: codeOrBarcode },
                    { articleCode: codeOrBarcode }
                ]
            }
        });
        if (!data)
            return null;
        return new Article_1.Article(data.id, data.tenantId, data.articleCode, data.name, data.baseCost, data.unit, data.description, data.systemBarcode, data.supplierBarcode, data.imageUrl, data.category, data.status ?? 'ACTIVE', data.isActive, data.minStockLevel, data.criticalStockLevel, data.maxStockLevel, data.lastPurchaseDate, data.salePrice ?? 0, data.defaultSupplierId ?? null);
    }
    async processMovement(movementData, articleId, sourceLocationId, destLocationId, quantity) {
        const result = await prisma_client_1.default.$transaction(async (tx) => {
            if (sourceLocationId) {
                const sourceBalance = await tx.stockBalance.findUnique({
                    where: { articleId_locationId: { articleId, locationId: sourceLocationId } }
                });
                if (!sourceBalance || sourceBalance.currentQuantity < quantity) {
                    if (movementData.movementType !== 'ADJUSTMENT') {
                        throw new Error(`[BLOCKED] Kaynak lokasyonda yeterli stok yok. Mevcut: ${sourceBalance?.currentQuantity || 0}, İstenen: ${quantity}`);
                    }
                }
                await tx.stockBalance.upsert({
                    where: { articleId_locationId: { articleId, locationId: sourceLocationId } },
                    update: { currentQuantity: { decrement: quantity } },
                    create: { id: (0, nanoid_1.nanoid)(10), tenantId: movementData.tenantId, articleId, locationId: sourceLocationId, currentQuantity: -quantity } // Sadece Adjustment eksiye düşürebilir
                });
            }
            if (destLocationId) {
                await tx.stockBalance.upsert({
                    where: { articleId_locationId: { articleId, locationId: destLocationId } },
                    update: { currentQuantity: { increment: quantity } },
                    create: { id: (0, nanoid_1.nanoid)(10), tenantId: movementData.tenantId, articleId, locationId: destLocationId, currentQuantity: quantity }
                });
            }
            // Birim maliyet yalnızca stok girişi yapan hareketlerde anlamlıdır (ağırlıklı ortalama için).
            const rawUnitCost = movementData.unitCost;
            const unitCost = inboundCostMovementTypes.has(String(movementData.movementType)) && rawUnitCost != null && Number(rawUnitCost) > 0
                ? Number(rawUnitCost)
                : null;
            const movement = await tx.stockMovement.create({
                data: {
                    id: (0, nanoid_1.nanoid)(12),
                    tenantId: movementData.tenantId,
                    articleId,
                    movementType: movementData.movementType,
                    quantity,
                    unitCost,
                    sourceLocationId,
                    destinationLocationId: destLocationId,
                    employeeId: movementData.employeeId,
                    referenceId: movementData.referenceId || null,
                    description: movementData.description || null,
                }
            });
            return movement;
        });
        return new Inventory_1.StockMovement(result.id, result.tenantId, result.articleId, result.movementType, result.quantity, result.employeeId, result.transactionDate, result.sourceLocationId, result.destinationLocationId, result.referenceId || undefined, result.description || undefined, result.unitCost ?? undefined);
    }
    async getMovements(articleId) {
        const data = await prisma_client_1.default.stockMovement.findMany({
            where: { articleId },
            orderBy: { transactionDate: 'desc' },
            include: { employee: { select: { firstName: true, lastName: true } } }
        });
        return data.map(d => new Inventory_1.StockMovement(d.id, d.tenantId, d.articleId, d.movementType, d.quantity, d.employeeId, d.transactionDate, d.sourceLocationId, d.destinationLocationId, d.referenceId || undefined, d.description || undefined, d.unitCost ?? undefined));
    }
    async createPurchaseProposal(proposal) {
        const data = await prisma_client_1.default.purchaseProposal.create({
            data: {
                id: (0, nanoid_1.nanoid)(8),
                tenantId: proposal.tenantId,
                articleId: proposal.articleId,
                proposedQuantity: proposal.proposedQuantity,
                supplierId: proposal.supplierId || null,
                status: 'PENDING'
            }
        });
        return new Inventory_1.PurchaseProposal(data.id, data.tenantId, data.articleId, data.proposedQuantity, data.status, data.createdAt, data.supplierId);
    }
    async getPendingProposals(tenantId) {
        const data = await prisma_client_1.default.purchaseProposal.findMany({
            where: { tenantId, status: 'PENDING' },
            include: { article: { select: { articleCode: true, name: true, imageUrl: true } } }
        });
        return data.map(d => new Inventory_1.PurchaseProposal(d.id, d.tenantId, d.articleId, d.proposedQuantity, d.status, d.createdAt, d.supplierId));
    }
    async resolveProposal(proposalId, status, employeeId) {
        await prisma_client_1.default.purchaseProposal.update({
            where: { id: proposalId },
            data: {
                status,
                resolvedAt: new Date(),
                resolvedByEmpId: employeeId
            }
        });
    }
}
exports.InventoryRepository = InventoryRepository;
//# sourceMappingURL=InventoryRepository.js.map