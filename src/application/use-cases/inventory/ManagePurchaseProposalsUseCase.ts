import { IInventoryRepository } from "../../../domain/repositories/IInventoryRepository";
import { PurchaseProposal } from "../../../domain/entities/Inventory";

export class ManagePurchaseProposalsUseCase {
    constructor(private inventoryRepository: IInventoryRepository) {}

    async listPending(tenantId: string): Promise<PurchaseProposal[]> {
        return await this.inventoryRepository.getPendingProposals(tenantId);
    }

    async resolve(tenantId: string, proposalId: string, employeeId: string, isApproved: boolean): Promise<void> {
        // Normalde burada onaylanınca Satın Alma (Purchase) modülüne veri gönderilir.
        // Şimdilik sadece statüyü güncelliyoruz.
        const status = isApproved ? 'APPROVED' : 'REJECTED';
        await this.inventoryRepository.resolveProposal(proposalId, status, employeeId);
    }
}