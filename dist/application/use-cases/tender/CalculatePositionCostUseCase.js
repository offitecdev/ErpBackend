"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalculatePositionCostUseCase = exports.CalculatePositionCostError = void 0;
const nanoid_1 = require("nanoid");
// Error that carries the HTTP status the controller should surface, so a
// "not found / not owned" case is not reported as a generic 403/500.
class CalculatePositionCostError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'CalculatePositionCostError';
    }
}
exports.CalculatePositionCostError = CalculatePositionCostError;
class CalculatePositionCostUseCase {
    positionRepository;
    tenderRepository;
    constructor(positionRepository, tenderRepository) {
        this.positionRepository = positionRepository;
        this.tenderRepository = tenderRepository;
    }
    async execute(positionId, tenderId, costs, tenantId) {
        // 1) Tender must exist within the caller's accessible tenant scope.
        const tender = await this.tenderRepository.findById(tenderId, tenantId);
        if (!tender)
            throw new CalculatePositionCostError(404, "İhale bulunamadı.");
        // 2) Only draft tenders can be (re)priced.
        if (tender.status !== 'Draft') {
            throw new CalculatePositionCostError(403, "Erişim Engellendi: Onaylanmış veya dışa aktarılmış bir teklifin fiyatları değiştirilemez. Lütfen yeni bir versiyon oluşturun.");
        }
        // 3) Position must belong to THIS tender, and (through the tender) to the
        //    same tenant. This ownership check runs immediately before the write,
        //    so saveCalculation-by-positionId can no longer touch a foreign row.
        const position = await this.positionRepository.findById(positionId);
        if (!position || position.tenderId !== tenderId || position.tenantId !== tender.tenantId) {
            throw new CalculatePositionCostError(404, "Satır bu teklife ait değil.");
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