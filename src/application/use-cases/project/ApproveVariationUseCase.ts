import { IProjectRepository } from "../../../domain/repositories/IProjectRepository";

export class ApproveVariationUseCase {
    constructor(private projectRepository: IProjectRepository) {}

    async execute(variationId: string, managerId: string, isApproved: boolean) {
        const variation = await (this.projectRepository as any).findVariationById(variationId);
        if (!variation) throw new Error("Varyasyon talebi bulunamadı.");
        if (variation.status !== 'PENDING') throw new Error("Bu talep zaten değerlendirilmiş.");

        const newStatus = isApproved ? 'APPROVED' : 'REJECTED';
        await (this.projectRepository as any).updateVariationStatus(variationId, newStatus, managerId);

        const project = await this.projectRepository.findById(variation.projectId);
        if (project && project.status === 'ON_HOLD') {

            const pendingVariations = await (this.projectRepository as any).getPendingVariations(project.id);
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