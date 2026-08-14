import { IProjectRepository } from "../../../domain/repositories/IProjectRepository";
import prisma from "../../../infrastructure/database/prisma.client";
import { articleStockTotal } from "../../../shared/articleStock";
import { nanoid } from "nanoid";

/**
 * Zusatzmaterial talebi. Malzeme/ürün birleşmesinden (2026-08-14) beri satırlar
 * doğrudan Article'a bağlanır; istek gövdesi geriye uyum için `materialId`
 * adıyla gelmeye devam eder ve artık bir ürün id'si taşır.
 */
export class RequestExtraMaterialUseCase {
    constructor(
        private projectRepository: IProjectRepository
    ) {}

    async execute(projectId: string, employeeId: string, articleId: string, quantity: number, description: string, salesOrderId?: string | null, appointmentId?: string | null) {
        const project = await this.projectRepository.findById(projectId);
        if (!project) throw new Error("Proje bulunamadı.");

        const article = await (prisma as any).article.findFirst({
            where: { id: articleId, deletedAt: null },
            select: { id: true, name: true, salePrice: true },
        });
        if (!article) throw new Error("Ek malzeme bulunamadı.");

        const normalizedQuantity = Number(quantity || 0);
        if (normalizedQuantity <= 0) throw new Error("Miktar sıfırdan büyük olmalıdır.");
        const stock = await articleStockTotal(prisma as any, articleId);
        if (stock < normalizedQuantity) {
            throw new Error(`[Stok uyarısı] ${article.name} için kayıtlı miktar yetersiz.`);
        }

        return await (this.projectRepository as any).createExtraMaterial({
            id: nanoid(10),
            projectId,
            salesOrderId: salesOrderId || null,
            appointmentId: appointmentId || null,
            articleId,
            quantity: normalizedQuantity,
            unitPrice: article.salePrice,
            description: description || null
        }, employeeId, (project as any).tenantId);
    }
}
