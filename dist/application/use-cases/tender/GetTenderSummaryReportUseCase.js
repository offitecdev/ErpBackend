"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetTenderSummaryReportUseCase = void 0;
class GetTenderSummaryReportUseCase {
    tenderRepository;
    positionRepository;
    constructor(tenderRepository, positionRepository) {
        this.tenderRepository = tenderRepository;
        this.positionRepository = positionRepository;
    }
    async execute(tenderId, tenantId) {
        const tender = await this.tenderRepository.findById(tenderId, tenantId);
        if (!tender)
            throw new Error("İhale bulunamadı.");
        const positions = await this.positionRepository.findByTenderId(tenderId);
        let summary = {
            totalMaterialCost: 0,
            totalLaborCost: 0,
            totalOverheadCost: 0,
            totalRiskAmount: 0,
            totalProfitMargin: 0,
            grandTotal: 0
        };
        const npkGroupAnalysis = {};
        for (const pos of positions) {
            const calc = pos.calculation;
            const qty = pos.quantity ?? 0;
            const price = pos.unitPrice;
            const disc = pos.discount ?? 0;
            let posTotal = 0;
            if (calc) {
                summary.totalMaterialCost += calc.materialCost;
                summary.totalLaborCost += calc.laborCost;
                summary.totalOverheadCost += calc.overheadCost;
                summary.totalRiskAmount += calc.riskAmount;
                summary.totalProfitMargin += calc.profitMargin;
            }
            if (price != null && qty > 0) {
                posTotal = qty * price * (1 - disc / 100);
            }
            else if (calc) {
                posTotal = calc.totalCalculatedPrice;
            }
            summary.grandTotal += posTotal;
            if (pos.npkCode) {
                const groupCode = pos.npkCode.split('.')[0];
                if (!npkGroupAnalysis[groupCode])
                    npkGroupAnalysis[groupCode] = 0;
                npkGroupAnalysis[groupCode] += posTotal;
            }
        }
        const totalCostWithoutProfit = summary.grandTotal - summary.totalProfitMargin;
        const averageMarginPercentage = totalCostWithoutProfit > 0
            ? ((summary.totalProfitMargin / totalCostWithoutProfit) * 100).toFixed(2)
            : 0;
        return {
            tenderInfo: {
                tenderNumber: tender.tenderNumber,
                status: tender.status,
                version: tender.version,
            },
            financialSummary: summary,
            averageMarginPercentage: `${averageMarginPercentage}%`,
            costByNpkGroup: npkGroupAnalysis
        };
    }
}
exports.GetTenderSummaryReportUseCase = GetTenderSummaryReportUseCase;
//# sourceMappingURL=GetTenderSummaryReportUseCase.js.map