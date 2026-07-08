import { Request, Response } from 'express';
import { IInventoryRepository } from '../../domain/repositories/IInventoryRepository';
import { ProcessStockMovementUseCase } from '../../application/use-cases/inventory/ProcessStockMovementUseCase';
import { ManagePurchaseProposalsUseCase } from '../../application/use-cases/inventory/ManagePurchaseProposalsUseCase';
import prisma from '../../infrastructure/database/prisma.client';
import { nanoid } from 'nanoid';

export class InventoryController {
    constructor(
        private inventoryRepository: IInventoryRepository,
        private processMovementUseCase: ProcessStockMovementUseCase,
        private proposalsUseCase: ManagePurchaseProposalsUseCase
    ) {}

    // --- LOKASYON YÖNETİMİ ---
    async createLocation(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const { locationName, locationType, parentLocationId } = req.body;
            
            const location = await this.inventoryRepository.createLocation({
                id: nanoid(8),
                tenantId,
                locationName,
                locationType,
                parentLocationId,
                isActive: true
            });
            res.status(201).json(location);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listLocations(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const locations = await this.inventoryRepository.getLocations(tenantId);
            res.status(200).json(locations);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // --- STOK BAKİYELERİ VE HAREKETLER ---
    async getBalances(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const locationId = req.query.locationId as string;
            const balances = await this.inventoryRepository.getAllBalances(tenantId, locationId);
            res.status(200).json(balances);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getArticleStockSummary(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const includeImages = req.query.includeImages === 'true';
            const summary = await this.inventoryRepository.getArticleStockSummary(tenantId, includeImages);
            res.status(200).json(summary);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getArticleStockInfo(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const articleId = req.params.id as string;
            const info = await this.inventoryRepository.getArticleStockInfo(tenantId, articleId);
            if (!info) return res.status(404).json({ error: 'Ürün bulunamadı.' });
            res.status(200).json(info);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getArticleStockSummaryPaged(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const result = await this.inventoryRepository.getArticleStockSummaryPaged(tenantId, {
                page: req.query.page ? Number(req.query.page) : 1,
                pageSize: req.query.pageSize ? Number(req.query.pageSize) : 15,
                search: req.query.search ? String(req.query.search) : undefined,
                status: req.query.status ? String(req.query.status) : undefined,
                itemType: req.query.itemType ? String(req.query.itemType) : undefined,
            });
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getDashboard(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const [summary, proposals, locations] = await Promise.all([
                this.inventoryRepository.getArticleStockSummary(tenantId),
                this.proposalsUseCase.listPending(tenantId),
                this.inventoryRepository.getLocations(tenantId),
            ]);
            const critical = summary.filter((a: any) => a.criticalStockLevel > 0 && a.totalQuantity <= a.criticalStockLevel);
            const belowMin = summary.filter((a: any) => a.minStockLevel > 0 && a.totalQuantity <= a.minStockLevel);
            const totalValue = summary.reduce((s: number, a: any) => s + (a.totalQuantity * (a.weightedAverageCost ?? a.baseCost ?? 0)), 0);
            res.status(200).json({
                kpis: {
                    totalArticles: summary.length,
                    activeArticles: summary.filter((a: any) => a.isActive).length,
                    totalLocations: locations.length,
                    pendingProposals: proposals.length,
                    criticalCount: critical.length,
                    belowMinCount: belowMin.length,
                    inventoryValue: totalValue,
                },
                criticalArticles: critical,
                proposals,
                locations,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async scanMovement(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const { codeOrBarcode, movementType, quantity, unitCost, supplierId, itemKind, materialId, sourceLocationId, destLocationId, referenceId, description } = req.body;

            // Malzeme (Material) hareketleri ayrı tabloda; tek satış fiyatı + basit stok güncellemesi.
            if (itemKind === 'MATERIAL' || materialId) {
                const movement = await this.scanMaterialMovement({
                    tenantId,
                    materialId,
                    codeOrBarcode,
                    movementType,
                    quantity: Number(quantity),
                    salePrice: unitCost === null || unitCost === undefined || unitCost === '' ? null : Number(unitCost),
                });
                return res.status(201).json({ message: "Malzeme hareketi başarıyla kaydedildi.", data: movement });
            }

            const movement = await this.processMovementUseCase.execute({
                tenantId,
                employeeId,
                codeOrBarcode,
                movementType,
                quantity: Number(quantity),
                unitCost: unitCost === null || unitCost === undefined || unitCost === '' ? null : Number(unitCost),
                supplierId: supplierId ? String(supplierId) : null,
                sourceLocationId,
                destLocationId,
                referenceId,
                description
            });

            res.status(201).json({ message: "Stok hareketi başarıyla kaydedildi.", data: movement });
        } catch (error: any) {
            // Eksi bakiye veya barkod bulunamadı hataları burada 400 döner
            res.status(400).json({ error: error.message });
        }
    }

    private async scanMaterialMovement(input: {
        tenantId: string;
        materialId?: string;
        codeOrBarcode?: string;
        movementType: string;
        quantity: number;
        salePrice: number | null;
    }) {
        if (input.quantity <= 0) throw new Error("Miktar 0'dan büyük olmalıdır.");

        const material = input.materialId
            ? await prisma.material.findFirst({ where: { id: input.materialId, tenantId: input.tenantId } })
            : await prisma.material.findFirst({ where: { tenantId: input.tenantId, serialId: String(input.codeOrBarcode || '') } });

        if (!material) throw new Error(`Malzeme bulunamadı: ${input.materialId || input.codeOrBarcode}`);

        const isInbound = input.movementType === 'IN' || input.movementType === 'RETURN';
        const delta = isInbound ? input.quantity : -input.quantity;
        const nextStock = Number(material.stockQuantity || 0) + delta;
        if (nextStock < 0) {
            throw new Error(`[BLOCKED] Malzeme stoğu yetersiz. Mevcut: ${material.stockQuantity}, İstenen: ${input.quantity}`);
        }

        const updated = await prisma.material.update({
            where: { id: material.id },
            data: {
                stockQuantity: nextStock,
                // Malzemelerde yalnızca satış fiyatı girilir (unitCost alanında tutulur).
                ...(input.salePrice != null && input.salePrice > 0 ? { unitCost: input.salePrice } : {}),
            },
        });

        return {
            id: nanoid(12),
            materialId: updated.id,
            itemKind: 'MATERIAL',
            name: updated.name,
            serialId: updated.serialId,
            movementType: input.movementType,
            quantity: input.quantity,
            stockQuantity: updated.stockQuantity,
            salePrice: updated.unitCost,
            transactionDate: new Date(),
        };
    }

    async getMovements(req: Request, res: Response) {
        try {
            const articleId = req.params.articleId as string;
            const movements = await this.inventoryRepository.getMovements(articleId);
            res.status(200).json(movements);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // --- SATIN ALMA ÖNERİLERİ (KRİTİK STOK) ---
    async listProposals(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const proposals = await this.proposalsUseCase.listPending(tenantId);
            res.status(200).json(proposals);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async resolveProposal(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const proposalId = req.params.id as string;
            const { isApproved } = req.body;

            await this.proposalsUseCase.resolve(tenantId, proposalId, employeeId, isApproved);
            res.status(200).json({ message: `Satın alma önerisi ${isApproved ? 'onaylandı' : 'reddedildi'}.` });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
