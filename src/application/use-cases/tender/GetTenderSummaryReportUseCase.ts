
import { IPositionRepository } from "../../../domain/repositories/IPositionRepository";
import { ITenderRepository } from "../../../domain/repositories/ITenderRepository";

export interface CostSummary {
    totalMaterialCost: number;
    totalLaborCost: number;
    totalOverheadCost: number;
    totalRiskAmount: number;
    totalProfitMargin: number;
    grandTotal: number;
}

export class GetTenderSummaryReportUseCase {
    constructor(
        private tenderRepository: ITenderRepository,
        private positionRepository: IPositionRepository
    ) {}

    async execute(tenderId: string, tenantId: string) {
        const tender = await this.tenderRepository.findById(tenderId, tenantId);
        if (!tender) throw new Error("İhale bulunamadı.");

        const positions = await this.positionRepository.findByTenderId(tenderId);

        let summary: CostSummary = {
            totalMaterialCost: 0,
            totalLaborCost: 0,
            totalOverheadCost: 0,
            totalRiskAmount: 0,
            totalProfitMargin: 0,
            grandTotal: 0
        };

        const npkGroupAnalysis: Record<string, number> = {}; 

        for (const pos of positions) {
            const calc = (pos as any).calculation;
            const qty = pos.quantity ?? 0;
            const price = (pos as any).unitPrice;
            const disc = (pos as any).discount ?? 0;
            
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
            } else if (calc) {
                posTotal = calc.totalCalculatedPrice;
            }

            summary.grandTotal += posTotal;

            if (pos.npkCode) {
                const groupCode = pos.npkCode.split('.')[0] as string; 
                if (!npkGroupAnalysis[groupCode]) npkGroupAnalysis[groupCode] = 0;
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