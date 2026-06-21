import { IInventoryRepository } from "../../../domain/repositories/IInventoryRepository";
import { StockMovement } from "../../../domain/entities/Inventory";

export interface MovementInput {
    tenantId: string;
    employeeId: string;
    codeOrBarcode: string;
    movementType: 'IN' | 'OUT' | 'TRANSFER' | 'RETURN' | 'ADJUSTMENT';
    quantity: number;
    unitCost?: number | null;
    sourceLocationId?: string | null;
    destLocationId?: string | null;
    referenceId?: string | null;
    description?: string | null;
}

export class ProcessStockMovementUseCase {
    constructor(private inventoryRepository: IInventoryRepository) {}

    async execute(input: MovementInput): Promise<StockMovement> {
        if (input.quantity <= 0) {
            throw new Error("Miktar 0'dan büyük olmalıdır.");
        }

        const article = await this.inventoryRepository.findArticleByBarcodeOrCode(input.tenantId, input.codeOrBarcode);
        if (!article) {
            throw new Error(`Barkod veya Stok Kodu eşleşmedi: ${input.codeOrBarcode}`);
        }

        if (input.movementType === 'IN' || input.movementType === 'RETURN') {
            if (!input.destLocationId) throw new Error("Giriş/İade işlemleri için Hedef Lokasyon (Nereye) zorunludur.");
            input.sourceLocationId = null;
        } else if (input.movementType === 'OUT') {
            if (!input.sourceLocationId) throw new Error("Çıkış işlemleri için Kaynak Lokasyon (Nereden) zorunludur.");
            input.destLocationId = null;
        } else if (input.movementType === 'TRANSFER') {
            if (!input.sourceLocationId || !input.destLocationId) throw new Error("Transfer için hem Kaynak hem de Hedef lokasyon zorunludur.");
            if (input.sourceLocationId === input.destLocationId) throw new Error("Kaynak ve Hedef lokasyon aynı olamaz.");
        }

        const movement = await this.inventoryRepository.processMovement(
            input,
            article.id,
            input.sourceLocationId || null,
            input.destLocationId || null,
            input.quantity
        );

        if (['OUT', 'ADJUSTMENT'].includes(input.movementType)) {
            const allBalances = await this.inventoryRepository.getAllBalances(input.tenantId);
            const totalStock = allBalances
                .filter(b => b.articleId === article.id)
                .reduce((sum, b) => sum + b.currentQuantity, 0);

            if ((article as any).criticalStockLevel > 0 && totalStock <= (article as any).criticalStockLevel) {
                const pendingProposals = await this.inventoryRepository.getPendingProposals(input.tenantId);
                const hasPending = pendingProposals.some(p => p.articleId === article.id);

                if (!hasPending) {
                   
                    const proposedQuantity = Math.max(((article as any).minStockLevel || 0) - totalStock, 1);
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