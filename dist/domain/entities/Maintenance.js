"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaintenanceMaterial = exports.MaintenanceReport = exports.MaintenanceTask = exports.MaintenanceContract = void 0;
class MaintenanceContract {
    id;
    tenantId;
    customerId;
    title;
    period;
    startDate;
    endDate;
    equipmentInfo;
    serviceScope;
    siteName;
    reminderDaysBefore;
    notificationChannels;
    isActive;
    createdAt;
    updatedAt;
    constructor(id, tenantId, customerId, title, period, startDate, endDate, equipmentInfo, serviceScope, siteName, reminderDaysBefore = 7, notificationChannels, isActive = true, createdAt, updatedAt) {
        this.id = id;
        this.tenantId = tenantId;
        this.customerId = customerId;
        this.title = title;
        this.period = period;
        this.startDate = startDate;
        this.endDate = endDate;
        this.equipmentInfo = equipmentInfo;
        this.serviceScope = serviceScope;
        this.siteName = siteName;
        this.reminderDaysBefore = reminderDaysBefore;
        this.notificationChannels = notificationChannels;
        this.isActive = isActive;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }
}
exports.MaintenanceContract = MaintenanceContract;
class MaintenanceTask {
    id;
    contractId;
    plannedDate;
    status;
    assignedTechId;
    alternativeTechId;
    siteName;
    assignmentHistoryJson;
    createdAt;
    updatedAt;
    constructor(id, contractId, plannedDate, status, assignedTechId, alternativeTechId, siteName, assignmentHistoryJson, createdAt, updatedAt) {
        this.id = id;
        this.contractId = contractId;
        this.plannedDate = plannedDate;
        this.status = status;
        this.assignedTechId = assignedTechId;
        this.alternativeTechId = alternativeTechId;
        this.siteName = siteName;
        this.assignmentHistoryJson = assignmentHistoryJson;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }
}
exports.MaintenanceTask = MaintenanceTask;
class MaintenanceReport {
    id;
    taskId;
    techId;
    operationsDone;
    isSigned;
    checklistJson;
    observations;
    recommendations;
    riskNotes;
    beforePhotoUrls;
    afterPhotoUrls;
    fileUrls;
    customerSignature;
    signedAt;
    lockedAt;
    pdfUrl;
    emailSentAt;
    emailLogJson;
    createdAt;
    constructor(id, taskId, techId, operationsDone, isSigned, checklistJson, observations, recommendations, riskNotes, beforePhotoUrls, afterPhotoUrls, fileUrls, customerSignature, signedAt, lockedAt, pdfUrl, emailSentAt, emailLogJson, createdAt) {
        this.id = id;
        this.taskId = taskId;
        this.techId = techId;
        this.operationsDone = operationsDone;
        this.isSigned = isSigned;
        this.checklistJson = checklistJson;
        this.observations = observations;
        this.recommendations = recommendations;
        this.riskNotes = riskNotes;
        this.beforePhotoUrls = beforePhotoUrls;
        this.afterPhotoUrls = afterPhotoUrls;
        this.fileUrls = fileUrls;
        this.customerSignature = customerSignature;
        this.signedAt = signedAt;
        this.lockedAt = lockedAt;
        this.pdfUrl = pdfUrl;
        this.emailSentAt = emailSentAt;
        this.emailLogJson = emailLogJson;
        this.createdAt = createdAt;
    }
}
exports.MaintenanceReport = MaintenanceReport;
class MaintenanceMaterial {
    id;
    reportId;
    articleId;
    quantity;
    unitCost;
    sourceLocationId;
    constructor(id, reportId, articleId, quantity, unitCost, sourceLocationId) {
        this.id = id;
        this.reportId = reportId;
        this.articleId = articleId;
        this.quantity = quantity;
        this.unitCost = unitCost;
        this.sourceLocationId = sourceLocationId;
    }
}
exports.MaintenanceMaterial = MaintenanceMaterial;
//# sourceMappingURL=Maintenance.js.map