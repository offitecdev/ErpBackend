"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventoryController = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const nanoid_1 = require("nanoid");
class InventoryController {
    inventoryRepository;
    processMovementUseCase;
    proposalsUseCase;
    constructor(inventoryRepository, processMovementUseCase, proposalsUseCase) {
        this.inventoryRepository = inventoryRepository;
        this.processMovementUseCase = processMovementUseCase;
        this.proposalsUseCase = proposalsUseCase;
    }
    // --- LOKASYON YÖNETİMİ ---
    async createLocation(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const { locationName, locationType, parentLocationId } = req.body;
            const location = await this.inventoryRepository.createLocation({
                id: (0, nanoid_1.nanoid)(8),
                tenantId,
                locationName,
                locationType,
                parentLocationId,
                isActive: true
            });
            res.status(201).json(location);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async listLocations(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const locations = await this.inventoryRepository.getLocations(tenantId);
            res.status(200).json(locations);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // --- STOK BAKİYELERİ VE HAREKETLER ---
    async getBalances(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const locationId = req.query.locationId;
            const balances = await this.inventoryRepository.getAllBalances(tenantId, locationId);
            res.status(200).json(balances);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getArticleStockSummary(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const includeImages = req.query.includeImages === 'true';
            const summary = await this.inventoryRepository.getArticleStockSummary(tenantId, includeImages);
            res.status(200).json(summary);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getArticleStockInfo(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const articleId = req.params.id;
            const info = await this.inventoryRepository.getArticleStockInfo(tenantId, articleId);
            if (!info)
                return res.status(404).json({ error: 'Ürün bulunamadı.' });
            res.status(200).json(info);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getArticleStockSummaryPaged(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const result = await this.inventoryRepository.getArticleStockSummaryPaged(tenantId, {
                page: req.query.page ? Number(req.query.page) : 1,
                pageSize: req.query.pageSize ? Number(req.query.pageSize) : 15,
                search: req.query.search ? String(req.query.search) : undefined,
                status: req.query.status ? String(req.query.status) : undefined,
                itemType: req.query.itemType ? String(req.query.itemType) : undefined,
                includeDescription: req.query.includeDescription === 'true',
                code: req.query.code ? String(req.query.code) : undefined,
                name: req.query.name ? String(req.query.name) : undefined,
                barcode: req.query.barcode ? String(req.query.barcode) : undefined,
                sortBy: req.query.sortBy ? String(req.query.sortBy) : undefined,
                sortDirection: req.query.sortDirection === 'asc' ? 'asc' : 'desc',
            });
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getDashboard(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const [summary, proposals, locations] = await Promise.all([
                this.inventoryRepository.getArticleStockSummary(tenantId),
                this.proposalsUseCase.listPending(tenantId),
                this.inventoryRepository.getLocations(tenantId),
            ]);
            const critical = summary.filter((a) => a.criticalStockLevel > 0 && a.totalQuantity <= a.criticalStockLevel);
            const belowMin = summary.filter((a) => a.minStockLevel > 0 && a.totalQuantity <= a.minStockLevel);
            const totalValue = summary.reduce((s, a) => s + (a.totalQuantity * (a.weightedAverageCost ?? a.baseCost ?? 0)), 0);
            res.status(200).json({
                kpis: {
                    totalArticles: summary.length,
                    activeArticles: summary.filter((a) => a.isActive).length,
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async scanMovement(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
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
        }
        catch (error) {
            // Eksi bakiye veya barkod bulunamadı hataları burada 400 döner
            res.status(400).json({ error: error.message });
        }
    }
    async scanMaterialMovement(input) {
        if (input.quantity <= 0)
            throw new Error("Miktar 0'dan büyük olmalıdır.");
        const material = input.materialId
            ? await prisma_client_1.default.material.findFirst({ where: { id: input.materialId, tenantId: input.tenantId } })
            : await prisma_client_1.default.material.findFirst({ where: { tenantId: input.tenantId, serialId: String(input.codeOrBarcode || '') } });
        if (!material)
            throw new Error(`Malzeme bulunamadı: ${input.materialId || input.codeOrBarcode}`);
        const isInbound = input.movementType === 'IN' || input.movementType === 'RETURN';
        const delta = isInbound ? input.quantity : -input.quantity;
        const nextStock = Number(material.stockQuantity || 0) + delta;
        if (nextStock < 0) {
            throw new Error(`[BLOCKED] Malzeme stoğu yetersiz. Mevcut: ${material.stockQuantity}, İstenen: ${input.quantity}`);
        }
        const updated = await prisma_client_1.default.material.update({
            where: { id: material.id },
            data: {
                stockQuantity: nextStock,
                // Malzemelerde yalnızca satış fiyatı girilir (unitCost alanında tutulur).
                ...(input.salePrice != null && input.salePrice > 0 ? { unitCost: input.salePrice } : {}),
            },
        });
        return {
            id: (0, nanoid_1.nanoid)(12),
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
    async getMovements(req, res) {
        try {
            const articleId = req.params.articleId;
            const movements = await this.inventoryRepository.getMovements(articleId);
            res.status(200).json(movements);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // --- SATIN ALMA ÖNERİLERİ (KRİTİK STOK) ---
    async listProposals(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const proposals = await this.proposalsUseCase.listPending(tenantId);
            res.status(200).json(proposals);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async resolveProposal(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const proposalId = req.params.id;
            const { isApproved } = req.body;
            await this.proposalsUseCase.resolve(tenantId, proposalId, employeeId, isApproved);
            res.status(200).json({ message: `Satın alma önerisi ${isApproved ? 'onaylandı' : 'reddedildi'}.` });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.InventoryController = InventoryController;
//# sourceMappingURL=InventoryController.js.map