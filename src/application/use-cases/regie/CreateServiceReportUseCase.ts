import { IRegieRepository } from "../../../domain/repositories/IRegieRepository";
import { IInventoryRepository } from "../../../domain/repositories/IInventoryRepository";
import { ServiceReport } from "../../../domain/entities/Regie";
import { nanoid } from "nanoid";

export interface RegieMaterialInput {
    articleId: string;
    quantity: number;
    unitCost: number;
    sourceLocationId: string;
}

export class CreateServiceReportUseCase {
    constructor(
        private regieRepository: IRegieRepository,
        private inventoryRepository: IInventoryRepository
    ) {}

    async execute(input: {
        tenantId: string;
        employeeId: string;
        callId: string;
        workDone: string;
        workingMinutes: number;
        gasAmount: number;
        isWarranty: boolean;
        materials?: RegieMaterialInput[];
        observations?: string;
        recommendations?: string;
        beforePhotoUrls?: unknown;
        afterPhotoUrls?: unknown;
        fileUrls?: unknown;
    }): Promise<ServiceReport> {
        if (!input.callId) throw new Error("Servis cagrisi zorunludur.");
        if (!input.workDone?.trim()) throw new Error("Yapilan is aciklamasi zorunludur.");

        const call = await this.regieRepository.getCallById(input.callId);
        if (!call) throw new Error("Ariza kaydi bulunamadi.");
        if ((call as any).tenantId !== input.tenantId) throw new Error("Bu cagri icin yetkiniz yok.");

        const existingReport = await this.regieRepository.getReportByCallId(input.callId);
        if (existingReport?.isSigned) throw new Error("Imzalanmis rapor kilitlidir.");
        if (existingReport) throw new Error("Bu ariza icin zaten bir rapor olusturulmus.");

        const reportId = nanoid(10);

        const report = await this.regieRepository.createReport({
            id: reportId,
            callId: input.callId,
            techId: input.employeeId,
            workDone: input.workDone,
            workingMinutes: Number(input.workingMinutes || 0),
            gasAmount: Number(input.gasAmount || 0),
            observations: input.observations,
            recommendations: input.recommendations,
            beforePhotoUrls: input.beforePhotoUrls,
            afterPhotoUrls: input.afterPhotoUrls,
            fileUrls: input.fileUrls,
            isWarranty: Boolean(input.isWarranty),
            isSigned: false,
        });

        for (const mat of input.materials || []) {
            if (!mat.sourceLocationId) {
                throw new Error("Kullanilan malzemeler icin cikis yapilacak depo/lokasyon secimi zorunludur.");
            }
            if (!mat.articleId || Number(mat.quantity) <= 0) throw new Error("Malzeme ve miktar zorunludur.");

            await this.inventoryRepository.processMovement(
                {
                    tenantId: input.tenantId,
                    movementType: "OUT",
                    employeeId: input.employeeId,
                    referenceId: input.callId,
                    description: `Regie ariza (Cagri ID: ${input.callId}) kullanimi`,
                },
                mat.articleId,
                mat.sourceLocationId,
                null,
                Number(mat.quantity)
            );

            await this.regieRepository.addMaterialToReport({
                id: nanoid(12),
                reportId,
                articleId: mat.articleId,
                quantity: Number(mat.quantity),
                unitCost: Number(mat.unitCost || 0),
                sourceLocationId: mat.sourceLocationId,
            });
        }

        await this.regieRepository.updateCallStatus(input.callId, "IN_PROGRESS");

        return await this.regieRepository.getReportById(reportId) || report;
    }
}
