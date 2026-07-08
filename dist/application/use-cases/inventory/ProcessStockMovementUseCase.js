"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessStockMovementUseCase = void 0;
class ProcessStockMovementUseCase {
    inventoryRepository;
    constructor(inventoryRepository) {
        this.inventoryRepository = inventoryRepository;
    }
    async execute(input) {
        if (input.quantity <= 0) {
            throw new Error("Miktar 0'dan büyük olmalıdır.");
        }
        const article = await this.inventoryRepository.findArticleByBarcodeOrCode(input.tenantId, input.codeOrBarcode);
        if (!article) {
            throw new Error(`Barkod veya Stok Kodu eşleşmedi: ${input.codeOrBarcode}`);
        }
        if (input.movementType === 'IN' || input.movementType === 'RETURN') {
            // Lokasyon UI'dan kaldırıldı: hedef verilmezse tek global ana depoya yazılır.
            if (!input.destLocationId) {
                const defaultLocation = await this.inventoryRepository.ensureDefaultLocation(input.tenantId);
                input.destLocationId = defaultLocation.id;
            }
            input.sourceLocationId = null;
        }
        else if (input.movementType === 'OUT') {
            // Lokasyon UI'dan kaldırıldı: kaynak verilmezse tek global ana depodan düşülür.
            if (!input.sourceLocationId) {
                const defaultLocation = await this.inventoryRepository.ensureDefaultLocation(input.tenantId);
                input.sourceLocationId = defaultLocation.id;
            }
            input.destLocationId = null;
        }
        else if (input.movementType === 'ADJUSTMENT') {
            // Düzeltme tek global ana depo üzerinde yapılır (hedef verilmezse).
            if (!input.sourceLocationId && !input.destLocationId) {
                const defaultLocation = await this.inventoryRepository.ensureDefaultLocation(input.tenantId);
                input.destLocationId = defaultLocation.id;
            }
        }
        else if (input.movementType === 'TRANSFER') {
            if (!input.sourceLocationId || !input.destLocationId)
                throw new Error("Transfer için hem Kaynak hem de Hedef lokasyon zorunludur.");
            if (input.sourceLocationId === input.destLocationId)
                throw new Error("Kaynak ve Hedef lokasyon aynı olamaz.");
        }
        const movement = await this.inventoryRepository.processMovement(input, article.id, input.sourceLocationId || null, input.destLocationId || null, input.quantity);
        if (['OUT', 'ADJUSTMENT'].includes(input.movementType)) {
            const allBalances = await this.inventoryRepository.getAllBalances(input.tenantId);
            const totalStock = allBalances
                .filter(b => b.articleId === article.id)
                .reduce((sum, b) => sum + b.currentQuantity, 0);
            if (article.criticalStockLevel > 0 && totalStock <= article.criticalStockLevel) {
                const pendingProposals = await this.inventoryRepository.getPendingProposals(input.tenantId);
                const hasPending = pendingProposals.some(p => p.articleId === article.id);
                if (!hasPending) {
                    const proposedQuantity = Math.max((article.minStockLevel || 0) - totalStock, 1);
                    await this.inventoryRepository.createPurchaseProposal({
                        tenantId: input.tenantId,
                        articleId: article.id,
                        proposedQuantity: proposedQuantity
                    });
                }
            }
        }
        return movement;
    }
}
exports.ProcessStockMovementUseCase = ProcessStockMovementUseCase;
//# sourceMappingURL=ProcessStockMovementUseCase.js.map