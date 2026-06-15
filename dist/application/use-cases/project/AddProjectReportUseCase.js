"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddProjectReportUseCase = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const nanoid_1 = require("nanoid");
const startOfDay = (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};
const endOfDay = (date) => {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
};
const minutesBetween = (start, end) => Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
const isPrimarySalesOrder = (project, salesOrderId) => {
    if (!salesOrderId)
        return false;
    const orders = [...(project.salesOrders || [])].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return orders[0]?.id === salesOrderId;
};
class AddProjectReportUseCase {
    reportRepository;
    projectRepository;
    materialRepository;
    constructor(reportRepository, projectRepository, 
    // Kept in the constructor to avoid route wiring churn; project reports no longer consume stock.
    materialRepository) {
        this.reportRepository = reportRepository;
        this.projectRepository = projectRepository;
        this.materialRepository = materialRepository;
    }
    async buildReportPayload(input) {
        const project = await this.projectRepository.findById(input.projectId);
        if (!project)
            throw new Error("Proje bulunamadı.");
        if (project.status === "ON_HOLD")
            throw new Error("Proje şu an beklemede. Rapor girilemez.");
        const includeUnscoped = isPrimarySalesOrder(project, input.salesOrderId);
        if (input.salesOrderId) {
            const belongsToProject = (project.salesOrders || []).some((order) => order.id === input.salesOrderId);
            if (!belongsToProject)
                throw new Error("Sipariş bu projeye ait değil.");
        }
        const workDate = startOfDay(new Date(input.workDate));
        const startedAt = new Date(input.startedAt);
        const endedAt = new Date(input.endedAt);
        if (Number.isNaN(workDate.getTime()) || Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
            throw new Error("Tarih, başlangıç ve bitiş saati zorunludur.");
        }
        if (endedAt <= startedAt)
            throw new Error("Bitiş saati başlangıç saatinden sonra olmalıdır.");
        if (!input.operationsDone?.trim())
            throw new Error("Yapılan iş alanı zorunludur.");
        const dayStart = startOfDay(workDate);
        const dayEnd = endOfDay(workDate);
        const appointments = await prisma_client_1.default.appointment.findMany({
            where: {
                projectId: input.projectId,
                ...(input.salesOrderId
                    ? includeUnscoped
                        ? { OR: [{ salesOrderId: input.salesOrderId }, { salesOrderId: null }] }
                        : { salesOrderId: input.salesOrderId }
                    : {}),
                status: { in: ["BOOKED", "COMPLETED"] },
                startTime: { gte: dayStart },
                endTime: { lte: dayEnd }
            }
        });
        const plannedMinutesForDay = appointments.reduce((sum, appointment) => {
            return sum + minutesBetween(new Date(appointment.startTime), new Date(appointment.endTime));
        }, 0);
        if (plannedMinutesForDay <= 0) {
            throw new Error("Bu gün için onaylanmış randevu/saat planı yok. Saha raporu yazmak için randevu manuel olarak onaylanmış olmalıdır.");
        }
        const workedMinutes = minutesBetween(startedAt, endedAt);
        const tolerancePercent = Number(project.overtimeTolerancePercent ?? 15);
        const overtimeThreshold = plannedMinutesForDay * (1 + tolerancePercent / 100);
        const overtimeMinutes = Math.max(0, Math.ceil(workedMinutes - overtimeThreshold));
        const overtimeHourlyRate = Number(project.overtimeHourlyRate || 0);
        const overtimeCost = overtimeMinutes > 0 ? (overtimeMinutes / 60) * overtimeHourlyRate : 0;
        return {
            projectId: input.projectId,
            salesOrderId: input.salesOrderId || null,
            appointmentId: input.appointmentId || null,
            employeeId: input.employeeId,
            reportDate: new Date(),
            workDate,
            startedAt,
            endedAt,
            reportType: "Project",
            workedMinutes,
            plannedMinutesForDay,
            overtimeMinutes,
            overtimeHourlyRate,
            overtimeCost,
            operationsDone: input.operationsDone.trim(),
            technicalNotes: input.technicalNotes?.trim() || null
        };
    }
    async execute(input) {
        const payload = await this.buildReportPayload(input);
        const project = await this.projectRepository.findById(input.projectId);
        const existing = await this.reportRepository.findByProjectAndWorkDate(input.projectId, payload.workDate, input.salesOrderId || null, isPrimarySalesOrder(project, input.salesOrderId));
        if (existing)
            throw new Error("Bu proje için aynı güne ait saha raporu zaten var. Lütfen mevcut raporu düzenleyin.");
        const report = await this.reportRepository.createReport({
            id: (0, nanoid_1.nanoid)(10),
            ...payload
        });
        return {
            ...report,
            overtimeWarning: payload.overtimeMinutes > 0
                ? `%15 tolerans aşıldı. ${payload.overtimeMinutes} dk fazla çalışma için ek ücret hesaplandı.`
                : null
        };
    }
    async update(reportId, input) {
        const existingReport = await this.reportRepository.findById(reportId);
        if (!existingReport)
            throw new Error("Saha raporu bulunamadı.");
        if (existingReport.projectId !== input.projectId)
            throw new Error("Saha raporu bu projeye ait değil.");
        input.salesOrderId = input.salesOrderId ?? existingReport.salesOrderId ?? null;
        input.appointmentId = input.appointmentId ?? existingReport.appointmentId ?? null;
        const payload = await this.buildReportPayload(input);
        const project = await this.projectRepository.findById(input.projectId);
        const sameDayReport = await this.reportRepository.findByProjectAndWorkDateExcept(input.projectId, payload.workDate, reportId, input.salesOrderId || null, isPrimarySalesOrder(project, input.salesOrderId));
        // if (sameDayReport) throw new Error("Bu proje için aynı güne ait başka bir saha raporu var. Bir günde yalnızca bir rapor olabilir.");
        const report = await this.reportRepository.updateReport(reportId, payload);
        return {
            ...report,
            overtimeWarning: payload.overtimeMinutes > 0
                ? `%15 tolerans aşıldı. ${payload.overtimeMinutes} dk fazla çalışma için ek ücret hesaplandı.`
                : null
        };
    }
}
exports.AddProjectReportUseCase = AddProjectReportUseCase;
//# sourceMappingURL=AddProjectReportUseCase.js.map