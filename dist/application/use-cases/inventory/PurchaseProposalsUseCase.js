"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManagePurchaseProposalsUseCase = void 0;
class ManagePurchaseProposalsUseCase {
    inventoryRepository;
    constructor(inventoryRepository) {
        this.inventoryRepository = inventoryRepository;
    }
    async listPending(tenantId) {
        return await this.inventoryRepository.getPendingProposals(tenantId);
    }
    async resolve(tenantId, proposalId, employeeId, isApproved) {
        const status = isApproved ? 'APPROVED' : 'REJECTED';
        await this.inventoryRepository.resolveProposal(proposalId, status, employeeId);
    }
}
exports.ManagePurchaseProposalsUseCase = ManagePurchaseProposalsUseCase;
//# sourceMappingURL=PurchaseProposalsUseCase.js.map