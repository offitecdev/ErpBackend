"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const nanoid_1 = require("nanoid");
const Position_1 = require("../../domain/entities/Position");
const CalculationItem_1 = require("../../domain/entities/CalculationItem");
class PositionRepository {
    articleSelect(includeImages = false) {
        return {
            id: true,
            tenantId: true,
            articleCode: true,
            name: true,
            description: true,
            baseCost: true,
            salePrice: true,
            defaultSupplierId: true,
            unit: true,
            category: true,
            status: true,
            isActive: true,
            minStockLevel: true,
            criticalStockLevel: true,
            maxStockLevel: true,
            lastPurchaseDate: true,
            ...(includeImages ? { imageUrl: true } : {}),
        };
    }
    positionSelect(includeImages = false) {
        return {
            id: true,
            tenantId: true,
            tenderId: true,
            parentPositionId: true,
            rowType: true,
            sourceArticleId: true,
            displayOrder: true,
            npkCode: true,
            positionNumber: true,
            shortDescription: true,
            longDescription: true,
            quantity: true,
            unit: true,
            hierarchyLevel: true,
            unitPrice: true,
            discount: true,
            taxRate: true,
            ...(includeImages ? { imageUrl: true } : {}),
            calculation: true,
            articleMappings: {
                select: {
                    id: true,
                    positionId: true,
                    articleId: true,
                    quantityMultiplier: true,
                    discount: true,
                    article: { select: this.articleSelect(includeImages) },
                },
            },
            materialMappings: {
                select: {
                    id: true,
                    positionId: true,
                    materialId: true,
                    quantityMultiplier: true,
                    discount: true,
                    material: {
                        select: {
                            id: true,
                            tenantId: true,
                            serialId: true,
                            name: true,
                            stockQuantity: true,
                            unitCost: true,
                            isActive: true,
                        },
                    },
                },
            },
        };
    }
    mapToPositionEntity(data) {
        return new Position_1.Position(data.id, data.tenantId, data.tenderId, data.positionNumber, data.shortDescription, data.hierarchyLevel, data.quantity ?? 0, data.parentPositionId, data.npkCode, data.longDescription, data.unit, data.rowType ?? 'SECTION', data.sourceArticleId, data.displayOrder ?? 0);
    }
    mapToCalculationEntity(data) {
        return new CalculationItem_1.CalculationItem(data.id, data.positionId, data.materialCost, data.laborCost, data.overheadCost, data.riskAmount, data.additionalCost || 0, data.profitMargin, data.totalCalculatedPrice);
    }
    async createMany(positions) {
        if (!positions || positions.length === 0) {
            return;
        }
        const data = positions.map(p => ({
            id: p.id,
            tenantId: p.tenantId,
            tenderId: p.tenderId,
            parentPositionId: p.parentPositionId || null,
            rowType: p.rowType || 'SECTION',
            sourceArticleId: p.sourceArticleId || null,
            displayOrder: Number(p.displayOrder ?? 0),
            positionNumber: p.positionNumber,
            shortDescription: p.shortDescription,
            longDescription: p.longDescription || null,
            hierarchyLevel: p.hierarchyLevel ?? 0,
            quantity: p.quantity ?? 0,
            unit: p.unit || null,
            npkCode: p.npkCode || null,
            unitPrice: p.unitPrice ?? null,
            discount: p.discount ?? 0,
            taxRate: p.taxRate ?? 0,
            imageUrl: p.imageUrl ?? null
        }));
        await prisma_client_1.default.position.createMany({
            data
        });
    }
    async findById(positionId, options) {
        return await prisma_client_1.default.position.findUnique({
            where: { id: positionId },
            select: this.positionSelect(!!options?.includeImages),
        });
    }
    async findByTenderId(tenderId, options) {
        // Bu metod artık raporlamaya veri sağlamak için calculation ve bağlı ürünleri include ediyor.
        const data = await prisma_client_1.default.position.findMany({
            where: { tenderId },
            select: this.positionSelect(!!options?.includeImages),
            orderBy: [
                { displayOrder: 'asc' },
                { positionNumber: 'asc' }
            ]
        });
        return data;
    }
    async saveCalculation(calculationItem) {
        // Check if calculation already exists for this position
        const existing = await prisma_client_1.default.calculationItem.findUnique({
            where: { positionId: calculationItem.positionId }
        });
        if (existing) {
            const updated = await prisma_client_1.default.calculationItem.update({
                where: { positionId: calculationItem.positionId },
                data: {
                    materialCost: calculationItem.materialCost ?? 0,
                    laborCost: calculationItem.laborCost ?? 0,
                    overheadCost: calculationItem.overheadCost ?? 0,
                    riskAmount: calculationItem.riskAmount ?? 0,
                    additionalCost: calculationItem.additionalCost ?? 0,
                    profitMargin: calculationItem.profitMargin ?? 0,
                    totalCalculatedPrice: calculationItem.totalCalculatedPrice ?? 0
                }
            });
            return this.mapToCalculationEntity(updated);
        }
        const created = await prisma_client_1.default.calculationItem.create({
            data: {
                id: calculationItem.id || (0, nanoid_1.nanoid)(10),
                positionId: calculationItem.positionId,
                materialCost: calculationItem.materialCost ?? 0,
                laborCost: calculationItem.laborCost ?? 0,
                overheadCost: calculationItem.overheadCost ?? 0,
                riskAmount: calculationItem.riskAmount ?? 0,
                additionalCost: calculationItem.additionalCost ?? 0,
                profitMargin: calculationItem.profitMargin ?? 0,
                totalCalculatedPrice: calculationItem.totalCalculatedPrice ?? 0
            }
        });
        return this.mapToCalculationEntity(created);
    }
    async getCalculationByPositionId(positionId) {
        const data = await prisma_client_1.default.calculationItem.findUnique({
            where: { positionId }
        });
        return data ? this.mapToCalculationEntity(data) : null;
    }
    async deletePosition(positionId) {
        await prisma_client_1.default.$transaction(async (tx) => {
            const collectIds = async (parentId) => {
                const children = await tx.position.findMany({
                    where: { parentPositionId: parentId },
                    select: { id: true }
                });
                let ids = [];
                for (const child of children) {
                    ids = ids.concat(await collectIds(child.id));
                }
                ids.push(parentId);
                return ids;
            };
            const allIds = await collectIds(positionId);
            await tx.positionArticleMapping.deleteMany({ where: { positionId: { in: allIds } } });
            await tx.calculationItem.deleteMany({ where: { positionId: { in: allIds } } });
            for (const id of allIds) {
                await tx.position.delete({ where: { id } });
            }
        });
    }
    async updatePosition(positionId, patch) {
        const data = {};
        if (patch.shortDescription !== undefined)
            data.shortDescription = patch.shortDescription;
        if (patch.longDescription !== undefined)
            data.longDescription = patch.longDescription;
        if (patch.quantity !== undefined)
            data.quantity = patch.quantity;
        if (patch.unit !== undefined)
            data.unit = patch.unit;
        if (patch.unitPrice !== undefined)
            data.unitPrice = patch.unitPrice;
        if (patch.discount !== undefined)
            data.discount = patch.discount;
        if (patch.taxRate !== undefined)
            data.taxRate = patch.taxRate;
        if (patch.imageUrl !== undefined)
            data.imageUrl = patch.imageUrl;
        if (patch.npkCode !== undefined)
            data.npkCode = patch.npkCode;
        if (patch.rowType !== undefined)
            data.rowType = patch.rowType;
        if (patch.sourceArticleId !== undefined)
            data.sourceArticleId = patch.sourceArticleId;
        if (patch.displayOrder !== undefined)
            data.displayOrder = Number(patch.displayOrder);
        return await prisma_client_1.default.position.update({ where: { id: positionId }, data });
    }
}
exports.PositionRepository = PositionRepository;
//# sourceMappingURL=PositionRepository.js.map