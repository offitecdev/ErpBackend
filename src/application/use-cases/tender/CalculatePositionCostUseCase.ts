
import { IPositionRepository } from "../../../domain/repositories/IPositionRepository";
import { ITenderRepository } from "../../../domain/repositories/ITenderRepository";
import { CalculationItem } from "../../../domain/entities/CalculationItem";
import { nanoid } from "nanoid";

export interface CostInput {
    materialCost: number;
    laborCost: number;
    overheadCost: number;
    riskAmount: number;
    additionalCost: number;
    profitMargin: number;
}

export class CalculatePositionCostUseCase {
    constructor(
        private positionRepository: IPositionRepository,
        private tenderRepository: ITenderRepository
    ) {}

    async execute(positionId: string, tenderId: string, costs: CostInput): Promise<CalculationItem> {

        const tender = await this.tenderRepository.findById(tenderId);
        if (!tender) throw new Error("İhale bulunamadı.");
        
        if (tender.status !== 'Draft') {
            throw new Error("Erişim Engellendi: Onaylanmış veya dışa aktarılmış bir teklifin fiyatları değiştirilemez. Lütfen yeni bir versiyon oluşturun.");
        }

        const totalCalculatedPrice = 
            costs.materialCost + 
            costs.laborCost + 
            costs.overheadCost + 
            costs.riskAmount + 
            costs.additionalCost +
            costs.profitMargin;

        const calculationData: Partial<CalculationItem> = {
            id: nanoid(8),
            positionId: positionId,
            ...costs,
            totalCalculatedPrice
        };

        return await this.positionRepository.saveCalculation(calculationData);
    }
}