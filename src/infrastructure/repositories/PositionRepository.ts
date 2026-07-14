import prisma from "../database/prisma.client";
import { nanoid } from "nanoid";
import { IPositionRepository } from "../../domain/repositories/IPositionRepository";
import { Position } from "../../domain/entities/Position";
import { CalculationItem } from "../../domain/entities/CalculationItem";

export class PositionRepository implements IPositionRepository {

    private articleSelect(includeImages = false) {
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

    // Plain figures only — for read-only summaries (e.g. the project positions tab).
    // Skips longDescription, article/material mappings and the full calculation row,
    // which dominate the payload and query time of the full select.
    private positionLightSelect() {
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
            quantity: true,
            unit: true,
            hierarchyLevel: true,
            unitPrice: true,
            discount: true,
            taxRate: true,
            calculation: { select: { totalCalculatedPrice: true } },
        };
    }

    // Mutation responses only need the position's own scalar fields. Returning the
    // full detail select here makes Prisma issue extra relation queries for the
    // calculation and both mapping collections after every PATCH, even when the
    // caller changed only a short/long description.
    private positionMutationSelect() {
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
        };
    }

    private positionSelect(includeImages = false) {
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

    private mapToPositionEntity(data: any): Position {
        return new Position(
            data.id,
            data.tenantId,
            data.tenderId,
            data.positionNumber,
            data.shortDescription,
            data.hierarchyLevel,
            data.quantity ?? 0,
            data.parentPositionId,
            data.npkCode,
            data.longDescription,
            data.unit,
            data.rowType ?? 'SECTION',
            data.sourceArticleId,
            data.displayOrder ?? 0
        );
    }

    private mapToCalculationEntity(data: any): CalculationItem {
        return new CalculationItem(
            data.id,
            data.positionId,
            data.materialCost,
            data.laborCost,
            data.overheadCost,
            data.riskAmount,
            data.additionalCost || 0,
            data.profitMargin,
            data.totalCalculatedPrice
        );
    }

    async createMany(positions: Partial<Position>[]): Promise<void> {
        if (!positions || positions.length === 0) {
            return;
        }

        const data = positions.map(p => ({
            id: p.id!,
            tenantId: p.tenantId!,
            tenderId: p.tenderId!,
            parentPositionId: p.parentPositionId || null,
            rowType: (p as any).rowType || 'SECTION',
            sourceArticleId: (p as any).sourceArticleId || null,
            displayOrder: Number((p as any).displayOrder ?? 0),
            positionNumber: p.positionNumber!,
            shortDescription: p.shortDescription!,
            longDescription: p.longDescription || null,
            hierarchyLevel: p.hierarchyLevel ?? 0,
            quantity: p.quantity ?? 0,
            unit: p.unit || null,
            npkCode: p.npkCode || null,
            unitPrice: (p as any).unitPrice ?? null,
            discount: (p as any).discount ?? 0,
            taxRate: (p as any).taxRate ?? 0,
            imageUrl: (p as any).imageUrl ?? null
        }));

        await prisma.position.createMany({
            data
        });
    }

    async findById(positionId: string, options?: { includeImages?: boolean }): Promise<any | null> {
        return await prisma.position.findUnique({
            where: { id: positionId },
            select: this.positionSelect(!!options?.includeImages),
        });
    }

    async findByTenderId(tenderId: string, options?: { includeImages?: boolean; light?: boolean }): Promise<any[]> {
        // Bu metod artık raporlamaya veri sağlamak için calculation ve bağlı ürünleri include ediyor.
        const data = await prisma.position.findMany({
            where: { tenderId },
            select: options?.light ? this.positionLightSelect() : this.positionSelect(!!options?.includeImages),
            orderBy: [
                { displayOrder: 'asc' },
                { positionNumber: 'asc' }
            ]
        });

        return data;
    }

    async saveCalculation(calculationItem: Partial<CalculationItem>): Promise<CalculationItem> {
        // Check if calculation already exists for this position
        const existing = await prisma.calculationItem.findUnique({
            where: { positionId: calculationItem.positionId! }
        });

        if (existing) {
            const updated = await prisma.calculationItem.update({
                where: { positionId: calculationItem.positionId! },
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

        const created = await prisma.calculationItem.create({
            data: {
                id: calculationItem.id || nanoid(10),
                positionId: calculationItem.positionId!,
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

    async getCalculationByPositionId(positionId: string): Promise<CalculationItem | null> {
        const data = await prisma.calculationItem.findUnique({
            where: { positionId }
        });
        return data ? this.mapToCalculationEntity(data) : null;
    }

    async deletePosition(positionId: string): Promise<void> {
        await prisma.$transaction(async (tx) => {
            // Collect the whole subtree breadth-first: one query per depth level
            // instead of one query per node (avoids the N+1 tree walk).
            const allIds: string[] = [positionId];
            let frontier: string[] = [positionId];
            while (frontier.length > 0) {
                const children = await tx.position.findMany({
                    where: { parentPositionId: { in: frontier } },
                    select: { id: true }
                });
                frontier = children.map((child) => child.id);
                allIds.push(...frontier);
            }

            await tx.positionArticleMapping.deleteMany({ where: { positionId: { in: allIds } } });
            await tx.calculationItem.deleteMany({ where: { positionId: { in: allIds } } });
            // The parentPosition relation is optional (onDelete: SetNull), so a single
            // bulk delete is FK-safe regardless of parent/child ordering.
            await tx.position.deleteMany({ where: { id: { in: allIds } } });
        });
    }

    async updatePosition(positionId: string, patch: {
        shortDescription?: string;
        longDescription?: string | null;
        quantity?: number;
        unit?: string | null;
        unitPrice?: number | null;
        discount?: number | null;
        taxRate?: number | null;
        imageUrl?: string | null;
        npkCode?: string | null;
    }): Promise<any> {
        const data: any = {};
        if (patch.shortDescription !== undefined) data.shortDescription = patch.shortDescription;
        if (patch.longDescription !== undefined) data.longDescription = patch.longDescription;
        if (patch.quantity !== undefined) data.quantity = patch.quantity;
        if (patch.unit !== undefined) data.unit = patch.unit;
        if (patch.unitPrice !== undefined) data.unitPrice = patch.unitPrice;
        if (patch.discount !== undefined) data.discount = patch.discount;
        if (patch.taxRate !== undefined) data.taxRate = patch.taxRate;
        if (patch.imageUrl !== undefined) data.imageUrl = patch.imageUrl;
        if (patch.npkCode !== undefined) data.npkCode = patch.npkCode;
        if ((patch as any).rowType !== undefined) data.rowType = (patch as any).rowType;
        if ((patch as any).sourceArticleId !== undefined) data.sourceArticleId = (patch as any).sourceArticleId;
        if ((patch as any).displayOrder !== undefined) data.displayOrder = Number((patch as any).displayOrder);
        // Scalar-only and image-less: avoids downloading base64 data and avoids
        // relation queries that the client already has in local state.
        return await prisma.position.update({
            where: { id: positionId },
            data,
            select: this.positionMutationSelect(),
        });
    }
}
