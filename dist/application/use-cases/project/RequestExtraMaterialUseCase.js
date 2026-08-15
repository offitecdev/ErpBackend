"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestExtraMaterialUseCase = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const articleStock_1 = require("../../../shared/articleStock");
const nanoid_1 = require("nanoid");
/**
 * Zusatzmaterial talebi. Malzeme/ürün birleşmesinden (2026-08-14) beri satırlar
 * doğrudan Article'a bağlanır; istek gövdesi geriye uyum için `materialId`
 * adıyla gelmeye devam eder ve artık bir ürün id'si taşır.
 */
class RequestExtraMaterialUseCase {
    projectRepository;
    constructor(projectRepository) {
        this.projectRepository = projectRepository;
    }
    async execute(projectId, employeeId, articleId, quantity, description, salesOrderId, appointmentId) {
        const project = await this.projectRepository.findById(projectId);
        if (!project)
            throw new Error("Proje bulunamadı.");
        const article = await prisma_client_1.default.article.findFirst({
            where: { id: articleId, deletedAt: null },
            select: { id: true, name: true, salePrice: true },
        });
        if (!article)
            throw new Error("Ek malzeme bulunamadı.");
        const normalizedQuantity = Number(quantity || 0);
        if (normalizedQuantity <= 0)
            throw new Error("Miktar sıfırdan büyük olmalıdır.");
        const stock = await (0, articleStock_1.articleStockTotal)(prisma_client_1.default, articleId);
        if (stock < normalizedQuantity) {
            throw new Error(`[Stok uyarısı] ${article.name} için kayıtlı miktar yetersiz.`);
        }
        return await this.projectRepository.createExtraMaterial({
            id: (0, nanoid_1.nanoid)(10),
            projectId,
            salesOrderId: salesOrderId || null,
            appointmentId: appointmentId || null,
            articleId,
            quantity: normalizedQuantity,
            unitPrice: article.salePrice,
            description: description || null
        }, employeeId, project.tenantId);
    }
}
exports.RequestExtraMaterialUseCase = RequestExtraMaterialUseCase;
//# sourceMappingURL=RequestExtraMaterialUseCase.js.map