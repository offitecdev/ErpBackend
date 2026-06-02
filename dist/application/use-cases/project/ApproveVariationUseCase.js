"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApproveVariationUseCase = void 0;
class ApproveVariationUseCase {
    projectRepository;
    constructor(projectRepository) {
        this.projectRepository = projectRepository;
    }
    async execute(variationId, managerId, isApproved) {
        const variation = await this.projectRepository.findVariationById(variationId);
        if (!variation)
            throw new Error("Varyasyon talebi bulunamadı.");
        if (variation.status !== 'PENDING')
            throw new Error("Bu talep zaten değerlendirilmiş.");
        const newStatus = isApproved ? 'APPROVED' : 'REJECTED';
        await this.projectRepository.updateVariationStatus(variationId, newStatus, managerId);
        const project = await this.projectRepository.findById(variation.projectId);
        if (project && project.status === 'ON_HOLD') {
            const pendingVariations = await this.projectRepository.getPendingVariations(project.id);
            if (pendingVariations.length === 0) {
                await this.projectRepository.updateProject(project.id, { status: 'ACTIVE' });
            }
        }
        if (isApproved) {
            const extraCost = variation.costAtTime * variation.quantity;
            await this.projectRepository.updateActualCost(variation.projectId, extraCost);
        }
        return { message: isApproved ? "Ekstra malzeme onaylandı ve bütçeye eklendi." : "Ekstra malzeme reddedildi." };
    }
}
exports.ApproveVariationUseCase = ApproveVariationUseCase;
//# sourceMappingURL=ApproveVariationUseCase.js.map