import prisma from "../database/prisma.client";
import { IInventoryRepository } from "../../domain/repositories/IInventoryRepository";
import { Location, StockBalance, StockMovement, PurchaseProposal } from "../../domain/entities/Inventory";
import { Article } from "../../domain/entities/Article";
import { nanoid } from "nanoid";

export class InventoryRepository implements IInventoryRepository {
    
    async createLocation(locationData: Partial<Location>): Promise<Location> {
        const data = await prisma.location.create({
            data: {
                id: locationData.id || nanoid(8),
                tenantId: locationData.tenantId!,
                locationName: locationData.locationName!,
                locationType: locationData.locationType!,
                parentLocationId: locationData.parentLocationId || null,
                isActive: locationData.isActive ?? true
            }
        });
        return new Location(data.id, data.tenantId, data.locationName, data.locationType as any, data.isActive, data.parentLocationId);
    }

    async getLocations(tenantId: string): Promise<Location[]> {
        const data = await prisma.location.findMany({ where: { tenantId } });
        return data.map(d => new Location(d.id, d.tenantId, d.locationName, d.locationType as any, d.isActive, d.parentLocationId));
    }

    async getStockBalance(articleId: string, locationId: string): Promise<StockBalance | null> {
        const data = await prisma.stockBalance.findUnique({
            where: { articleId_locationId: { articleId, locationId } }
        });
        if (!data) return null;
        return new StockBalance(data.id, data.tenantId, data.articleId, data.locationId, data.currentQuantity, data.reservedQuantity, data.updatedAt);
    }

    async getAllBalances(tenantId: string, locationId?: string): Promise<any[]> {
        const where: any = { tenantId };
        if (locationId) where.locationId = locationId;

        return await prisma.stockBalance.findMany({
            where,
            include: {
                article: { select: { id: true, articleCode: true, name: true, unit: true, baseCost: true, minStockLevel: true, criticalStockLevel: true, imageUrl: true, systemBarcode: true } },
                location: { select: { locationName: true, locationType: true } }
            }
        });
    }

    async getArticleStockSummary(tenantId: string): Promise<any[]> {
        const articles = await prisma.article.findMany({
            where: { tenantId },
            include: {
                stockBalances: {
                    include: { location: { select: { locationName: true, locationType: true } } }
                }
            }
        });
        return articles.map((a: any) => ({
            id: a.id,
            articleCode: a.articleCode,
            name: a.name,
            unit: a.unit,
            baseCost: a.baseCost,
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
            totalQuantity: a.stockBalances.reduce((s: number, b: any) => s + (b.currentQuantity || 0), 0),
            totalReserved: a.stockBalances.reduce((s: number, b: any) => s + (b.reservedQuantity || 0), 0),
            balances: a.stockBalances.map((b: any) => ({
                locationId: b.locationId,
                locationName: b.location?.locationName,
                locationType: b.location?.locationType,
                currentQuantity: b.currentQuantity,
                reservedQuantity: b.reservedQuantity,
            })),
        }));
    }

    async findArticleByBarcodeOrCode(tenantId: string, codeOrBarcode: string): Promise<Article | null> {
        const data = await prisma.article.findFirst({
            where: {
                tenantId,
                OR: [
                    { systemBarcode: codeOrBarcode },
                    { supplierBarcode: codeOrBarcode },
                    { articleCode: codeOrBarcode }
                ]
            }
        });

        if (!data) return null;
        return new Article(
            data.id,
            data.tenantId,
            data.articleCode,
            data.name,
            data.baseCost,
            data.unit,
            data.description,
            data.systemBarcode,
            data.supplierBarcode,
            data.imageUrl,
            (data as any).category,
            ((data as any).status as any) ?? 'ACTIVE',
            data.isActive,
            data.minStockLevel,
            data.criticalStockLevel,
            data.maxStockLevel,
            (data as any).lastPurchaseDate
        );
    }

    async processMovement(
        movementData: Partial<StockMovement>, 
        articleId: string,
        sourceLocationId: string | null,
        destLocationId: string | null,
        quantity: number
    ): Promise<StockMovement> {
        const result = await prisma.$transaction(async (tx) => {
            
            if (sourceLocationId) {
                const sourceBalance = await tx.stockBalance.findUnique({
                    where: { articleId_locationId: { articleId, locationId: sourceLocationId } }
                });

                if (!sourceBalance || sourceBalance.currentQuantity < quantity) {
                    if(movementData.movementType !== 'ADJUSTMENT') {
                        throw new Error(`[BLOCKED] Kaynak lokasyonda yeterli stok yok. Mevcut: ${sourceBalance?.currentQuantity || 0}, İstenen: ${quantity}`);
                    }
                }

                await tx.stockBalance.upsert({
                    where: { articleId_locationId: { articleId, locationId: sourceLocationId } },
                    update: { currentQuantity: { decrement: quantity } },
                    create: { id: nanoid(10), tenantId: movementData.tenantId!, articleId, locationId: sourceLocationId, currentQuantity: -quantity } // Sadece Adjustment eksiye düşürebilir
                });
            }

            if (destLocationId) {
                await tx.stockBalance.upsert({
                    where: { articleId_locationId: { articleId, locationId: destLocationId } },
                    update: { currentQuantity: { increment: quantity } },
                    create: { id: nanoid(10), tenantId: movementData.tenantId!, articleId, locationId: destLocationId, currentQuantity: quantity }
                });
            }

            const movement = await tx.stockMovement.create({
                data: {
                    id: nanoid(12),
                    tenantId: movementData.tenantId!,
                    articleId,
                    movementType: movementData.movementType as any,
                    quantity,
                    sourceLocationId,
                    destinationLocationId: destLocationId,
                    employeeId: movementData.employeeId!,
                    referenceId: movementData.referenceId || null,
                    description: movementData.description || null,
                }
            });

            return movement;
        });

        return new StockMovement(result.id, result.tenantId, result.articleId, result.movementType as any, result.quantity, result.employeeId, result.transactionDate, result.sourceLocationId, result.destinationLocationId, result.referenceId || undefined, result.description || undefined);
    }

    async getMovements(articleId: string): Promise<StockMovement[]> {
        const data = await prisma.stockMovement.findMany({
            where: { articleId },
            orderBy: { transactionDate: 'desc' },
            include: { employee: { select: { firstName: true, lastName: true } } }
        });
        return data.map(d => new StockMovement(d.id, d.tenantId, d.articleId, d.movementType as any, d.quantity, d.employeeId, d.transactionDate, d.sourceLocationId, d.destinationLocationId, d.referenceId || undefined, d.description || undefined));
    }

    async createPurchaseProposal(proposal: Partial<PurchaseProposal>): Promise<PurchaseProposal> {
        const data = await prisma.purchaseProposal.create({
            data: {
                id: nanoid(8),
                tenantId: proposal.tenantId!,
                articleId: proposal.articleId!,
                proposedQuantity: proposal.proposedQuantity!,
                supplierId: proposal.supplierId || null,
                status: 'PENDING'
            }
        });
        return new PurchaseProposal(data.id, data.tenantId, data.articleId, data.proposedQuantity, data.status as any, data.createdAt, data.supplierId);
    }

    async getPendingProposals(tenantId: string): Promise<PurchaseProposal[]> {
        const data = await prisma.purchaseProposal.findMany({
            where: { tenantId, status: 'PENDING' },
            include: { article: { select: { articleCode: true, name: true, imageUrl: true } } }
        });
        return data.map(d => new PurchaseProposal(d.id, d.tenantId, d.articleId, d.proposedQuantity, d.status as any, d.createdAt, d.supplierId));
    }

    async resolveProposal(proposalId: string, status: 'APPROVED' | 'REJECTED', employeeId: string): Promise<void> {
        await prisma.purchaseProposal.update({
            where: { id: proposalId },
            data: {
                status,
                resolvedAt: new Date(),
                resolvedByEmpId: employeeId
            }
        });
    }
}