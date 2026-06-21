import { IProjectRepository } from "../../../domain/repositories/IProjectRepository";
import { IMaterialRepository } from "../../../domain/repositories/IMaterialRepository";
import { nanoid } from "nanoid";

export class RequestExtraMaterialUseCase {
    constructor(
        private projectRepository: IProjectRepository,
        private materialRepository: IMaterialRepository
    ) {}

    async execute(projectId: string, employeeId: string, materialId: string, quantity: number, description: string, salesOrderId?: string | null, appointmentId?: string | null) {
        const project = await this.projectRepository.findById(projectId);
        if (!project) throw new Error("Proje bulunamadı.");

        const material = await this.materialRepository.findById(materialId);
        if (!material) throw new Error("Ek malzeme bulunamadı.");

        const normalizedQuantity = Number(quantity || 0);
        if (normalizedQuantity <= 0) throw new Error("Miktar sıfırdan büyük olmalıdır.");
        if (material.stockQuantity < normalizedQuantity) {
            throw new Error(`[Stok uyarısı] ${material.name} için kayıtlı miktar yetersiz.`);
        }

        return await (this.projectRepository as any).createExtraMaterial({
            id: nanoid(10),
            projectId,
            salesOrderId: salesOrderId || null,
            appointmentId: appointmentId || null,
            materialId,
            quantity: normalizedQuantity,
            unitPrice: material.unitCost,
            description: description || null
        });
    }
}
