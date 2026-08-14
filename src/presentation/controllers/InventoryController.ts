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
                includeDescription: req.query.includeDescription === 'true',
                lean: req.query.lean === 'true',
                code: req.query.code ? String(req.query.code) : undefined,
                name: req.query.name ? String(req.query.name) : undefined,
                barcode: req.query.barcode ? String(req.query.barcode) : undefined,
                sortBy: req.query.sortBy ? String(req.query.sortBy) : undefined,
                sortDirection: req.query.sortDirection === 'asc' ? 'asc' : 'desc',
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
            // Malzeme/ürün birleşmesi (2026-08-14): ayrı Material tablosu ve
            // itemKind/materialId dalı kalktı — her tarama Article hareketidir.
            const { codeOrBarcode, movementType, quantity, unitCost, supplierId, sourceLocationId, destLocationId, referenceId, description } = req.body;

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
