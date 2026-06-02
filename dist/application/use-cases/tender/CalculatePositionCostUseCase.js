"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalculatePositionCostUseCase = void 0;
const nanoid_1 = require("nanoid");
class CalculatePositionCostUseCase {
    positionRepository;
    tenderRepository;
    constructor(positionRepository, tenderRepository) {
        this.positionRepository = positionRepository;
        this.tenderRepository = tenderRepository;
    }
    async execute(positionId, tenderId, costs) {
        const tender = await this.tenderRepository.findById(tenderId);
        if (!tender)
            throw new Error("İhale bulunamadı.");
        if (tender.status !== 'Draft') {
            throw new Error("Erişim Engellendi: Onaylanmış veya dışa aktarılmış bir teklifin fiyatları değiştirilemez. Lütfen yeni bir versiyon oluşturun.");
        }
        const totalCalculatedPrice = costs.materialCost +
            costs.laborCost +
            costs.overheadCost +
            costs.riskAmount +
            costs.additionalCost +
            costs.profitMargin;
        const calculationData = {
            id: (0, nanoid_1.nanoid)(8),
            positionId: positionId,
            ...costs,
            totalCalculatedPrice
        };
        return await this.positionRepository.saveCalculation(calculationData);
    }
}
exports.CalculatePositionCostUseCase = CalculatePositionCostUseCase;
//# sourceMappingURL=CalculatePositionCostUseCase.js.map