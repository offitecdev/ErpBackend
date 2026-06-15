
import { IArticleRepository } from "../../../domain/repositories/IArticleRepository";
import { ITenderRepository } from "../../../domain/repositories/ITenderRepository";
import { IPositionRepository } from "../../../domain/repositories/IPositionRepository";
import { IInventoryRepository } from "../../../domain/repositories/IInventoryRepository";
import prisma from "../../../infrastructure/database/prisma.client";

export interface MapArticleInput {
    tenderId: string;
    positionId: string;
    articleId: string;
    quantityMultiplier: number;
    discount?: number;
    sourceLocationId?: string | null;
    employeeId?: string;
    tenantId?: string;
    autoConsumeStock?: boolean;
}

export class MapArticleToPositionUseCase {
    constructor(
        private articleRepository: IArticleRepository,
        private tenderRepository: ITenderRepository,
        private positionRepository: IPositionRepository,
        private inventoryRepository?: IInventoryRepository
    ) {}

    async execute(input: MapArticleInput) {
        const tender = await prisma.tender.findUnique({
            where: { id: input.tenderId },
            select: { status: true },
        });
        if (!tender || tender.status !== 'Draft') {
            throw new Error("[BLOCKED] Onaylanmış bir ihaleye yeni ürün eşleştirmesi yapılamaz!");
        }

        if (input.quantityMultiplier <= 0) {
            throw new Error("Miktar çarpanı 0'dan büyük olmalıdır.");
        }

        const mapping = await this.articleRepository.mapArticleToPosition({
            positionId: input.positionId,
            articleId: input.articleId,
            quantityMultiplier: input.quantityMultiplier,
            discount: input.discount ?? 0,
        });

        // Position article mappings are used-material lines. Their prices are
        // shown for traceability, but they are not billable offer/project cost.
        const calc = await this.positionRepository.getCalculationByPositionId(input.positionId);

        let stockMovement: any = null;
        if (input.autoConsumeStock && input.sourceLocationId && this.inventoryRepository && input.employeeId && input.tenantId) {
            stockMovement = await this.inventoryRepository.processMovement(
                {
                    tenantId: input.tenantId,
                    movementType: 'OUT',
                    employeeId: input.employeeId,
                    referenceId: input.tenderId,
                    description: `Teklif rezervasyonu: satır ${input.positionId}`,
                },
                input.articleId,
                input.sourceLocationId,
                null,
                input.quantityMultiplier
            );
        }

        return {
            mapping,
            updatedCalculation: calc,
            stockMovement,
        };
    }
}
