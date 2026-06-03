"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceMaterial = exports.ServiceReport = exports.ServiceCall = void 0;
class ServiceCall {
    id;
    tenantId;
    customerId;
    reportedIssue;
    status;
    callDate;
    assignedTechId;
    alternativeTechId;
    siteName;
    priority;
    assignmentHistoryJson;
    updatedAt;
    constructor(id, tenantId, customerId, reportedIssue, status, callDate, assignedTechId, alternativeTechId, siteName, priority, assignmentHistoryJson, updatedAt) {
        this.id = id;
        this.tenantId = tenantId;
        this.customerId = customerId;
        this.reportedIssue = reportedIssue;
        this.status = status;
        this.callDate = callDate;
        this.assignedTechId = assignedTechId;
        this.alternativeTechId = alternativeTechId;
        this.siteName = siteName;
        this.priority = priority;
        this.assignmentHistoryJson = assignmentHistoryJson;
        this.updatedAt = updatedAt;
    }
}
exports.ServiceCall = ServiceCall;
class ServiceReport {
    id;
    callId;
    techId;
    workDone;
    workingMinutes;
    gasAmount;
    isWarranty;
    isSigned;
    customerSignature;
    observations;
    recommendations;
    beforePhotoUrls;
    afterPhotoUrls;
    fileUrls;
    signedAt;
    lockedAt;
    linkedOrderId;
    createdAt;
    constructor(id, callId, techId, workDone, workingMinutes, gasAmount, isWarranty, isSigned, customerSignature, observations, recommendations, beforePhotoUrls, afterPhotoUrls, fileUrls, signedAt, lockedAt, linkedOrderId, createdAt) {
        this.id = id;
        this.callId = callId;
        this.techId = techId;
        this.workDone = workDone;
        this.workingMinutes = workingMinutes;
        this.gasAmount = gasAmount;
        this.isWarranty = isWarranty;
        this.isSigned = isSigned;
        this.customerSignature = customerSignature;
        this.observations = observations;
        this.recommendations = recommendations;
        this.beforePhotoUrls = beforePhotoUrls;
        this.afterPhotoUrls = afterPhotoUrls;
        this.fileUrls = fileUrls;
        this.signedAt = signedAt;
        this.lockedAt = lockedAt;
        this.linkedOrderId = linkedOrderId;
        this.createdAt = createdAt;
    }
}
exports.ServiceReport = ServiceReport;
class ServiceMaterial {
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
exports.ServiceMaterial = ServiceMaterial;
//# sourceMappingURL=Regie.js.map