"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaintenanceReportUseCase = void 0;
const nanoid_1 = require("nanoid");
class MaintenanceReportUseCase {
    maintenanceRepository;
    inventoryRepository;
    constructor(maintenanceRepository, inventoryRepository) {
        this.maintenanceRepository = maintenanceRepository;
        this.inventoryRepository = inventoryRepository;
    }
    async submitReport(data) {
        if (!data.taskId)
            throw new Error("Bakim gorevi zorunludur.");
        if (!data.operationsDone?.trim())
            throw new Error("Yapilan islemler zorunludur.");
        const task = await this.maintenanceRepository.getTaskById(data.taskId);
        if (!task)
            throw new Error("Bakim gorevi bulunamadi.");
        if (task.contract?.tenantId !== data.tenantId)
            throw new Error("Bu gorev icin yetkiniz yok.");
        const existingReport = await this.maintenanceRepository.getReportByTaskId(data.taskId);
        if (existingReport?.isSigned)
            throw new Error("Imzalanmis rapor kilitlidir.");
        if (existingReport)
            throw new Error("Bu gorev icin zaten rapor olusturulmus.");
        const reportId = (0, nanoid_1.nanoid)(10);
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
                if (!mat.sourceLocationId)
                    throw new Error("Ekstra malzemeler icin depo secimi zorunludur.");
                if (!mat.articleId || Number(mat.quantity) <= 0)
                    throw new Error("Malzeme ve miktar zorunludur.");
                await this.inventoryRepository.processMovement({
                    tenantId: data.tenantId,
                    movementType: "OUT",
                    employeeId: data.techId,
                    referenceId: data.taskId,
                    description: `Bakim ek malzeme (Task ID: ${data.taskId})`,
                }, mat.articleId, mat.sourceLocationId, null, Number(mat.quantity));
                await this.maintenanceRepository.addMaterialToReport({
                    id: (0, nanoid_1.nanoid)(12),
                    reportId,
                    articleId: mat.articleId,
                    quantity: Number(mat.quantity),
                    unitCost: Number(mat.unitCost || 0),
                    sourceLocationId: mat.sourceLocationId,
                });
            }
        }
        await this.maintenanceRepository.updateTaskStatus(data.taskId, "IN_PROGRESS");
        return await this.maintenanceRepository.getReportById(reportId) || report;
    }
    async signReport(reportId, signatureBase64) {
        const report = await this.maintenanceRepository.getReportById(reportId);
        if (!report)
            throw new Error("Rapor bulunamadi.");
        if (report.isSigned)
            return report;
        const signedReport = await this.maintenanceRepository.signReport(reportId, signatureBase64);
        await this.maintenanceRepository.updateTaskStatus(signedReport.taskId, "COMPLETED");
        return await this.maintenanceRepository.getReportById(reportId) || signedReport;
    }
}
exports.MaintenanceReportUseCase = MaintenanceReportUseCase;
//# sourceMappingURL=MaintenanceReportUseCase.js.map