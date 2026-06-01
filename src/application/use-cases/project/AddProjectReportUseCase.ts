import { IProjectReportRepository } from "../../../domain/repositories/IProjectReportRepository";
import { IProjectRepository } from "../../../domain/repositories/IProjectRepository";
import { IMaterialRepository } from "../../../domain/repositories/IMaterialRepository";
import prisma from "../../../infrastructure/database/prisma.client";
import { nanoid } from "nanoid";

export interface ReportInput {
    projectId: string;
    employeeId: string;
    workDate: string;
    startedAt: string;
    endedAt: string;
    operationsDone: string;
    technicalNotes?: string;
}

const startOfDay = (date: Date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};

const endOfDay = (date: Date) => {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
};

const minutesBetween = (start: Date, end: Date) =>
    Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));

export class AddProjectReportUseCase {
    constructor(
        private reportRepository: IProjectReportRepository,
        private projectRepository: IProjectRepository,
        // Kept in the constructor to avoid route wiring churn; project reports no longer consume stock.
        private materialRepository: IMaterialRepository
    ) {}

    private async buildReportPayload(input: ReportInput) {
        const project: any = await this.projectRepository.findById(input.projectId);
        if (!project) throw new Error("Proje bulunamadı.");
        if (project.status === "ON_HOLD") throw new Error("Proje şu an beklemede. Rapor girilemez.");

        const workDate = startOfDay(new Date(input.workDate));
        const startedAt = new Date(input.startedAt);
        const endedAt = new Date(input.endedAt);
        if (Number.isNaN(workDate.getTime()) || Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
            throw new Error("Tarih, başlangıç ve bitiş saati zorunludur.");
        }
        if (endedAt <= startedAt) throw new Error("Bitiş saati başlangıç saatinden sonra olmalıdır.");
        if (!input.operationsDone?.trim()) throw new Error("Yapılan iş alanı zorunludur.");

        const dayStart = startOfDay(workDate);
        const dayEnd = endOfDay(workDate);
        const appointments = await (prisma as any).appointment.findMany({
            where: {
                projectId: input.projectId,
                status: "BOOKED",
                startTime: { gte: dayStart },
                endTime: { lte: dayEnd }
            }
        });

        const plannedMinutesForDay = appointments.reduce((sum: number, appointment: any) => {
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

    async execute(input: ReportInput) {
        const payload = await this.buildReportPayload(input);
        const existing = await (this.reportRepository as any).findByProjectAndWorkDate(input.projectId, payload.workDate);
        if (existing) throw new Error("Bu proje için aynı güne ait saha raporu zaten var. Lütfen mevcut raporu düzenleyin.");

        const report = await this.reportRepository.createReport({
            id: nanoid(10),
            ...payload
        });

        return {
            ...report,
            overtimeWarning: payload.overtimeMinutes > 0
                ? `%15 tolerans aşıldı. ${payload.overtimeMinutes} dk fazla çalışma için ek ücret hesaplandı.`
                : null
        };
    }

    async update(reportId: string, input: ReportInput) {
        const existingReport = await (this.reportRepository as any).findById(reportId);
        if (!existingReport) throw new Error("Saha raporu bulunamadı.");
        if (existingReport.projectId !== input.projectId) throw new Error("Saha raporu bu projeye ait değil.");
        if (existingReport.isSigned) throw new Error("İmzalanmış saha raporu düzenlenemez.");

        const payload = await this.buildReportPayload(input);
        const sameDayReport = await (this.reportRepository as any).findByProjectAndWorkDateExcept(input.projectId, payload.workDate, reportId);
        // if (sameDayReport) throw new Error("Bu proje için aynı güne ait başka bir saha raporu var. Bir günde yalnızca bir rapor olabilir.");

        const report = await (this.reportRepository as any).updateReport(reportId, payload);
        return {
            ...report,
            overtimeWarning: payload.overtimeMinutes > 0
                ? `%15 tolerans aşıldı. ${payload.overtimeMinutes} dk fazla çalışma için ek ücret hesaplandı.`
                : null
        };
    }
}
