import { IMaintenanceRepository } from "../../../domain/repositories/IMaintenanceRepository";
import { IInventoryRepository } from "../../../domain/repositories/IInventoryRepository";
import { nanoid } from "nanoid";

export class MaintenanceReportUseCase {
    constructor(
        private maintenanceRepository: IMaintenanceRepository,
        private inventoryRepository: IInventoryRepository
    ) {}

    async submitReport(data: {
        tenantId: string;
        taskId: string;
        techId: string;
        operationsDone: string;
        observations?: string;
        recommendations?: string;
        riskNotes?: string;
        checklistJson?: unknown;
        beforePhotoUrls?: unknown;
        afterPhotoUrls?: unknown;
        fileUrls?: unknown;
        extraMaterials?: { articleId: string; quantity: number; unitCost: number; sourceLocationId: string }[];
        expenses?: { expenseType: string; amount: number; description?: string }[];
    }) {
        if (!data.taskId) throw new Error("Bakim gorevi zorunludur.");
        if (!data.operationsDone?.trim()) throw new Error("Yapilan islemler zorunludur.");

        const task = await this.maintenanceRepository.getTaskById(data.taskId);
        if (!task) throw new Error("Bakim gorevi bulunamadi.");
        if ((task as any).contract?.tenantId !== data.tenantId) throw new Error("Bu gorev icin yetkiniz yok.");
        const assignedIds = [
            (task as any).assignedTechId,
            (task as any).alternativeTechId,
            ...(((task as any).assignments || []).map((assignment: any) => assignment.technicianId)),
        ].filter(Boolean);
        if (assignedIds.length && !assignedIds.includes(data.techId)) {
            throw new Error("Bu bakim gorevi size atanmamis.");
        }

        const existingReport = await this.maintenanceRepository.getReportByTaskId(data.taskId);
        if (existingReport?.isSigned) throw new Error("Imzalanmis rapor kilitlidir.");
        if (existingReport) throw new Error("Bu gorev icin zaten rapor olusturulmus.");

        const reportId = nanoid(10);

        const report = await this.maintenanceRepository.createReport({
            id: reportId,
            taskId: data.taskId,
            techId: data.techId,
            operationsDone: data.operationsDone,
            observations: data.observations,
            recommendations: data.recommendations,
            riskNotes: data.riskNotes,
            checklistJson: data.checklistJson,
            beforePhotoUrls: data.beforePhotoUrls,
            afterPhotoUrls: data.afterPhotoUrls,
            fileUrls: data.fileUrls,
            isSigned: false,
        });

        if (data.extraMaterials && data.extraMaterials.length > 0) {
            for (const mat of data.extraMaterials) {
                if (!mat.sourceLocationId) throw new Error("Ekstra malzemeler icin depo secimi zorunludur.");
                if (!mat.articleId || Number(mat.quantity) <= 0) throw new Error("Malzeme ve miktar zorunludur.");

                await this.inventoryRepository.processMovement(
                    {
                        tenantId: data.tenantId,
                        movementType: "OUT",
                        employeeId: data.techId,
                        referenceId: data.taskId,
                        description: `Bakim ek malzeme (Task ID: ${data.taskId})`,
                    },
                    mat.articleId,
                    mat.sourceLocationId,
                    null,
                    Number(mat.quantity)
                );

                await this.maintenanceRepository.addMaterialToReport({
                    id: nanoid(12),
                    reportId,
                    articleId: mat.articleId,
                    quantity: Number(mat.quantity),
                    unitCost: Number(mat.unitCost || 0),
                    sourceLocationId: mat.sourceLocationId,
                });
            }
        }

        if (data.expenses && data.expenses.length > 0) {
            for (const expense of data.expenses) {
                if (!expense.expenseType?.trim()) throw new Error("Gider tipi zorunludur.");
                if (Number(expense.amount) < 0) throw new Error("Gider tutari negatif olamaz.");
                await this.maintenanceRepository.addExpense({
                    id: nanoid(12),
                    taskId: data.taskId,
                    reportId,
                    expenseType: expense.expenseType.trim(),
                    amount: Number(expense.amount || 0),
                    description: expense.description?.trim() || null,
                });
            }
        }

        await this.maintenanceRepository.updateTaskStatus(data.taskId, "IN_PROGRESS");
        return await this.maintenanceRepository.getReportById(reportId) || report;
    }

    async updateReport(data: {
        reportId: string;
        operationsDone?: string;
        observations?: string | null;
        recommendations?: string | null;
        riskNotes?: string | null;
        checklistJson?: unknown;
    }) {
        const report = await this.maintenanceRepository.getReportById(data.reportId);
        if (!report) throw new Error("Rapor bulunamadi.");
        if (report.isSigned || (report as any).lockedAt) throw new Error("Imzalanmis rapor kilitlidir ve duzenlenemez.");

        const patch: any = {};
        if (data.operationsDone !== undefined) {
            if (!data.operationsDone.trim()) throw new Error("Yapilan islemler zorunludur.");
            patch.operationsDone = data.operationsDone.trim();
        }
        if (data.observations !== undefined) patch.observations = data.observations?.trim() || null;
        if (data.recommendations !== undefined) patch.recommendations = data.recommendations?.trim() || null;
        if (data.riskNotes !== undefined) patch.riskNotes = data.riskNotes?.trim() || null;
        if (data.checklistJson !== undefined) patch.checklistJson = data.checklistJson;

        if (!Object.keys(patch).length) return report;
        return await this.maintenanceRepository.updateReport(data.reportId, patch);
    }

    async signReport(reportId: string, signatureBase64: string) {
        const report = await this.maintenanceRepository.getReportById(reportId);
        if (!report) throw new Error("Rapor bulunamadi.");
        if (report.isSigned) return report;

        const signedReport = await this.maintenanceRepository.signReport(reportId, signatureBase64);
        await this.maintenanceRepository.updateTaskStatus((signedReport as any).taskId, "COMPLETED");

        return await this.maintenanceRepository.getReportById(reportId) || signedReport;
    }
}
