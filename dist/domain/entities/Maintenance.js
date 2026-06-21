"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaintenanceMaterial = exports.MaintenanceExpense = exports.MaintenanceAppointmentOption = exports.MaintenanceTaskAssignment = exports.MaintenanceReport = exports.MaintenanceTask = exports.MaintenanceContract = void 0;
class MaintenanceContract {
    id;
    tenantId;
    customerId;
    title;
    period;
    startDate;
    endDate;
    contractCode;
    equipmentInfo;
    serviceScope;
    siteName;
    reminderDaysBefore;
    notificationChannels;
    overtimeHourlyRate;
    isActive;
    deletedAt;
    createdAt;
    updatedAt;
    constructor(id, tenantId, customerId, title, period, startDate, endDate, contractCode, equipmentInfo, serviceScope, siteName, reminderDaysBefore = 7, notificationChannels, overtimeHourlyRate = 0, isActive = true, deletedAt, createdAt, updatedAt) {
        this.id = id;
        this.tenantId = tenantId;
        this.customerId = customerId;
        this.title = title;
        this.period = period;
        this.startDate = startDate;
        this.endDate = endDate;
        this.contractCode = contractCode;
        this.equipmentInfo = equipmentInfo;
        this.serviceScope = serviceScope;
        this.siteName = siteName;
        this.reminderDaysBefore = reminderDaysBefore;
        this.notificationChannels = notificationChannels;
        this.overtimeHourlyRate = overtimeHourlyRate;
        this.isActive = isActive;
        this.deletedAt = deletedAt;
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
    scheduledStartTime;
    scheduledEndTime;
    bookingToken;
    reminderSentAt;
    managerApprovedAt;
    managerApprovedById;
    assignmentHistoryJson;
    createdAt;
    updatedAt;
    constructor(id, contractId, plannedDate, status, assignedTechId, alternativeTechId, siteName, scheduledStartTime, scheduledEndTime, bookingToken, reminderSentAt, managerApprovedAt, managerApprovedById, assignmentHistoryJson, createdAt, updatedAt) {
        this.id = id;
        this.contractId = contractId;
        this.plannedDate = plannedDate;
        this.status = status;
        this.assignedTechId = assignedTechId;
        this.alternativeTechId = alternativeTechId;
        this.siteName = siteName;
        this.scheduledStartTime = scheduledStartTime;
        this.scheduledEndTime = scheduledEndTime;
        this.bookingToken = bookingToken;
        this.reminderSentAt = reminderSentAt;
        this.managerApprovedAt = managerApprovedAt;
        this.managerApprovedById = managerApprovedById;
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
class MaintenanceTaskAssignment {
    id;
    taskId;
    technicianId;
    assignedAt;
    createdById;
    constructor(id, taskId, technicianId, assignedAt, createdById) {
        this.id = id;
        this.taskId = taskId;
        this.technicianId = technicianId;
        this.assignedAt = assignedAt;
        this.createdById = createdById;
    }
}
exports.MaintenanceTaskAssignment = MaintenanceTaskAssignment;
class MaintenanceAppointmentOption {
    id;
    taskId;
    token;
    startTime;
    endTime;
    status;
    sentAt;
    respondedAt;
    emailLogJson;
    createdAt;
    isAvailable;
    unavailableReason;
    constructor(id, taskId, token, startTime, endTime, status, sentAt, respondedAt, emailLogJson, createdAt, isAvailable, unavailableReason) {
        this.id = id;
        this.taskId = taskId;
        this.token = token;
        this.startTime = startTime;
        this.endTime = endTime;
        this.status = status;
        this.sentAt = sentAt;
        this.respondedAt = respondedAt;
        this.emailLogJson = emailLogJson;
        this.createdAt = createdAt;
        this.isAvailable = isAvailable;
        this.unavailableReason = unavailableReason;
    }
}
exports.MaintenanceAppointmentOption = MaintenanceAppointmentOption;
class MaintenanceExpense {
    id;
    taskId;
    expenseType;
    amount;
    reportId;
    description;
    createdAt;
    constructor(id, taskId, expenseType, amount, reportId, description, createdAt) {
        this.id = id;
        this.taskId = taskId;
        this.expenseType = expenseType;
        this.amount = amount;
        this.reportId = reportId;
        this.description = description;
        this.createdAt = createdAt;
    }
}
exports.MaintenanceExpense = MaintenanceExpense;
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