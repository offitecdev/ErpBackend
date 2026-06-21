"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MapArticleToPositionUseCase = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
class MapArticleToPositionUseCase {
    articleRepository;
    tenderRepository;
    positionRepository;
    inventoryRepository;
    constructor(articleRepository, tenderRepository, positionRepository, inventoryRepository) {
        this.articleRepository = articleRepository;
        this.tenderRepository = tenderRepository;
        this.positionRepository = positionRepository;
        this.inventoryRepository = inventoryRepository;
    }
    async execute(input) {
        const tender = await prisma_client_1.default.tender.findUnique({
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
        let stockMovement = null;
        if (input.autoConsumeStock && input.sourceLocationId && this.inventoryRepository && input.employeeId && input.tenantId) {
            stockMovement = await this.inventoryRepository.processMovement({
                tenantId: input.tenantId,
                movementType: 'OUT',
                employeeId: input.employeeId,
                referenceId: input.tenderId,
                description: `Teklif rezervasyonu: satır ${input.positionId}`,
            }, input.articleId, input.sourceLocationId, null, input.quantityMultiplier);
        }
        return {
            mapping,
            updatedCalculation: calc,
            stockMovement,
        };
    }
}
exports.MapArticleToPositionUseCase = MapArticleToPositionUseCase;
//# sourceMappingURL=MapArticleToPositionUseCase.js.map