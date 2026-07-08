
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

// Error that carries the HTTP status the controller should surface, so a
// "not found / not owned" case is not reported as a generic 403/500.
export class CalculatePositionCostError extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = 'CalculatePositionCostError';
    }
}

export class CalculatePositionCostUseCase {
    constructor(
        private positionRepository: IPositionRepository,
        private tenderRepository: ITenderRepository
    ) {}

    async execute(positionId: string, tenderId: string, costs: CostInput, tenantId: string): Promise<CalculationItem> {

        // 1) Tender must exist within the caller's accessible tenant scope.
        const tender: any = await this.tenderRepository.findById(tenderId, tenantId);
        if (!tender) throw new CalculatePositionCostError(404, "İhale bulunamadı.");

        // 2) Only draft tenders can be (re)priced.
        if (tender.status !== 'Draft') {
            throw new CalculatePositionCostError(403, "Erişim Engellendi: Onaylanmış veya dışa aktarılmış bir teklifin fiyatları değiştirilemez. Lütfen yeni bir versiyon oluşturun.");
        }

        // 3) Position must belong to THIS tender, and (through the tender) to the
        //    same tenant. This ownership check runs immediately before the write,
        //    so saveCalculation-by-positionId can no longer touch a foreign row.
        const position: any = await this.positionRepository.findById(positionId);
        if (!position || position.tenderId !== tenderId || position.tenantId !== tender.tenantId) {
            throw new CalculatePositionCostError(404, "Satır bu teklife ait değil.");
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