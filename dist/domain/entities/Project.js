"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectExpense = exports.ReportMaterial = exports.ProjectReport = exports.Appointment = exports.ProjectPhase = exports.Project = void 0;
class Project {
    id;
    tenantId;
    customerId;
    projectName;
    status;
    plannedBudget;
    actualCost;
    createdAt;
    tenderId;
    managerId;
    startDate;
    endDate;
    bookingToken;
    overtimeHourlyRate;
    overtimeTolerancePercent;
    constructor(id, tenantId, customerId, projectName, status, plannedBudget, actualCost, createdAt, tenderId, managerId, startDate, endDate, bookingToken, overtimeHourlyRate, overtimeTolerancePercent) {
        this.id = id;
        this.tenantId = tenantId;
        this.customerId = customerId;
        this.projectName = projectName;
        this.status = status;
        this.plannedBudget = plannedBudget;
        this.actualCost = actualCost;
        this.createdAt = createdAt;
        this.tenderId = tenderId;
        this.managerId = managerId;
        this.startDate = startDate;
        this.endDate = endDate;
        this.bookingToken = bookingToken;
        this.overtimeHourlyRate = overtimeHourlyRate;
        this.overtimeTolerancePercent = overtimeTolerancePercent;
    }
}
exports.Project = Project;
class ProjectPhase {
    id;
    projectId;
    phaseName;
    progressPercentage;
    isCompleted;
    constructor(id, projectId, phaseName, progressPercentage, isCompleted) {
        this.id = id;
        this.projectId = projectId;
        this.phaseName = phaseName;
        this.progressPercentage = progressPercentage;
        this.isCompleted = isCompleted;
    }
}
exports.ProjectPhase = ProjectPhase;
class Appointment {
    id;
    tenantId;
    startTime;
    endTime;
    status;
    projectId;
    customerId;
    notes;
    constructor(id, tenantId, startTime, endTime, status, projectId, customerId, notes) {
        this.id = id;
        this.tenantId = tenantId;
        this.startTime = startTime;
        this.endTime = endTime;
        this.status = status;
        this.projectId = projectId;
        this.customerId = customerId;
        this.notes = notes;
    }
}
exports.Appointment = Appointment;
class ProjectReport {
    id;
    projectId;
    salesOrderId;
    appointmentId;
    employeeId;
    reportDate;
    reportType;
    workedMinutes;
    operationsDone;
    isSigned;
    workDate;
    startedAt;
    endedAt;
    plannedMinutesForDay;
    overtimeMinutes;
    overtimeHourlyRate;
    overtimeCost;
    technicalNotes;
    customerSignature;
    constructor(id, projectId, salesOrderId, appointmentId, employeeId, reportDate, reportType, workedMinutes, operationsDone, isSigned, workDate, startedAt, endedAt, plannedMinutesForDay, overtimeMinutes, overtimeHourlyRate, overtimeCost, technicalNotes, customerSignature) {
        this.id = id;
        this.projectId = projectId;
        this.salesOrderId = salesOrderId;
        this.appointmentId = appointmentId;
        this.employeeId = employeeId;
        this.reportDate = reportDate;
        this.reportType = reportType;
        this.workedMinutes = workedMinutes;
        this.operationsDone = operationsDone;
        this.isSigned = isSigned;
        this.workDate = workDate;
        this.startedAt = startedAt;
        this.endedAt = endedAt;
        this.plannedMinutesForDay = plannedMinutesForDay;
        this.overtimeMinutes = overtimeMinutes;
        this.overtimeHourlyRate = overtimeHourlyRate;
        this.overtimeCost = overtimeCost;
        this.technicalNotes = technicalNotes;
        this.customerSignature = customerSignature;
    }
}
exports.ProjectReport = ProjectReport;
class ReportMaterial {
    id;
    reportId;
    articleId;
    quantity;
    costAtTime;
    constructor(id, reportId, articleId, quantity, costAtTime) {
        this.id = id;
        this.reportId = reportId;
        this.articleId = articleId;
        this.quantity = quantity;
        this.costAtTime = costAtTime;
    }
}
exports.ReportMaterial = ReportMaterial;
class ProjectExpense {
    id;
    projectId;
    salesOrderId;
    appointmentId;
    expenseType;
    amount;
    expenseDate;
    description;
    constructor(id, projectId, salesOrderId, appointmentId, expenseType, amount, expenseDate, description) {
        this.id = id;
        this.projectId = projectId;
        this.salesOrderId = salesOrderId;
        this.appointmentId = appointmentId;
        this.expenseType = expenseType;
        this.amount = amount;
        this.expenseDate = expenseDate;
        this.description = description;
    }
}
exports.ProjectExpense = ProjectExpense;
//# sourceMappingURL=Project.js.map