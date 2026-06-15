"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestExtraMaterialUseCase = void 0;
const nanoid_1 = require("nanoid");
class RequestExtraMaterialUseCase {
    projectRepository;
    materialRepository;
    constructor(projectRepository, materialRepository) {
        this.projectRepository = projectRepository;
        this.materialRepository = materialRepository;
    }
    async execute(projectId, employeeId, materialId, quantity, description, salesOrderId, appointmentId) {
        const project = await this.projectRepository.findById(projectId);
        if (!project)
            throw new Error("Proje bulunamadı.");
        const material = await this.materialRepository.findById(materialId);
        if (!material)
            throw new Error("Ek malzeme bulunamadı.");
        const normalizedQuantity = Number(quantity || 0);
        if (normalizedQuantity <= 0)
            throw new Error("Miktar sıfırdan büyük olmalıdır.");
        if (material.stockQuantity < normalizedQuantity) {
            throw new Error(`[Stok uyarısı] ${material.name} için kayıtlı miktar yetersiz.`);
        }
        return await this.projectRepository.createExtraMaterial({
            id: (0, nanoid_1.nanoid)(10),
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
exports.RequestExtraMaterialUseCase = RequestExtraMaterialUseCase;
//# sourceMappingURL=RequestExtraMaterialUseCase.js.map