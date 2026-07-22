import { IProjectReportRepository } from "../../../domain/repositories/IProjectReportRepository";
import { IProjectRepository } from "../../../domain/repositories/IProjectRepository";
import { IMaterialRepository } from "../../../domain/repositories/IMaterialRepository";
import prisma from "../../../infrastructure/database/prisma.client";
import { nanoid } from "nanoid";

export interface ReportInput {
    projectId: string;
    salesOrderId?: string | null;
    appointmentId?: string | null;
    employeeId: string;
    workDate: string;
    startedAt: string;
    endedAt: string;
    operationsDone: string;
    technicalNotes?: string;
    // Optional field-report photos as base64 data URLs. Replaces the existing set
    // when provided; left untouched when undefined.
    images?: string[];
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

// The work day is a CALENDAR date, not an instant. Anchoring it at 12:00 UTC keeps
// it on the same calendar day in every timezone; the previous local-midnight anchor
// shifted the report onto the neighbouring day whenever the server's timezone
// differed from the user's (a report filed "today" was stored as yesterday).
const resolveWorkDate = (raw: string) => {
    const match = DATE_ONLY.exec(String(raw ?? "").trim());
    if (match) {
        return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0));
    }
    // Legacy full-ISO input: keep the calendar day it resolves to on this server.
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return parsed;
    return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12, 0, 0, 0));
};

// UTC bounds of the calendar day a (noon-anchored) work date falls on.
const utcDayStart = (date: Date) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));

const utcDayEnd = (date: Date) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));

const minutesBetween = (start: Date, end: Date) =>
    Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));

const isPrimarySalesOrder = (project: any, salesOrderId?: string | null) => {
    if (!salesOrderId) return false;
    const orders = [...(project.salesOrders || [])].sort((a: any, b: any) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    return orders[0]?.id === salesOrderId;
};

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
        const includeUnscoped = isPrimarySalesOrder(project, input.salesOrderId);
        if (input.salesOrderId) {
            const belongsToProject = (project.salesOrders || []).some((order: any) => order.id === input.salesOrderId);
            if (!belongsToProject) throw new Error("Sipariş bu projeye ait değil.");
        }

        const workDate = resolveWorkDate(input.workDate);
        const startedAt = new Date(input.startedAt);
        const endedAt = new Date(input.endedAt);
        if (Number.isNaN(workDate.getTime()) || Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
            throw new Error("Tarih, başlangıç ve bitiş saati zorunludur.");
        }
        if (endedAt <= startedAt) throw new Error("Bitiş saati başlangıç saatinden sonra olmalıdır.");
        if (!input.operationsDone?.trim()) throw new Error("Yapılan iş alanı zorunludur.");

        const dayStart = utcDayStart(workDate);
        const dayEnd = utcDayEnd(workDate);
        const appointments = await (prisma as any).appointment.findMany({
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

        // The report's own appointment always counts towards the planned minutes, even
        // if it sits just outside the UTC day window (early-morning / late-night slots
        // in a far-offset timezone) — otherwise its own day would look unplanned.
        if (input.appointmentId && !appointments.some((appointment: any) => appointment.id === input.appointmentId)) {
            const own: any = await (prisma as any).appointment.findFirst({
                where: { id: input.appointmentId, projectId: input.projectId },
            });
            if (own) appointments.push(own);
        }

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

    async execute(input: ReportInput) {
        const payload = await this.buildReportPayload(input);
        const project: any = await this.projectRepository.findById(input.projectId);
        // A report stamped with an appointmentId is scoped to that appointment only, so
        // uniqueness is per-appointment — a sibling appointment on the same order/day may
        // still carry its own report. Reports without an appointmentId keep the legacy
        // one-per-order-day rule.
        const existing = input.appointmentId
            ? await (this.reportRepository as any).findByAppointmentId(input.appointmentId)
            : await (this.reportRepository as any).findByProjectAndWorkDate(input.projectId, payload.workDate, input.salesOrderId || null, isPrimarySalesOrder(project, input.salesOrderId));
        if (existing) throw new Error("Bu proje için aynı güne ait saha raporu zaten var. Lütfen mevcut raporu düzenleyin.");

        const report = await this.reportRepository.createReport({
            id: nanoid(10),
            ...payload
        });

        if (input.images !== undefined) {
            await this.reportRepository.replaceImages((report as any).id, input.images || [], input.employeeId);
        }
        const withImages = await (this.reportRepository as any).findById((report as any).id);

        return {
            ...(withImages || report),
            overtimeWarning: payload.overtimeMinutes > 0
                ? `%15 tolerans aşıldı. ${payload.overtimeMinutes} dk fazla çalışma için ek ücret hesaplandı.`
                : null
        };
    }

    async update(reportId: string, input: ReportInput) {
        const existingReport = await (this.reportRepository as any).findById(reportId);
        if (!existingReport) throw new Error("Saha raporu bulunamadı.");
        if (existingReport.projectId !== input.projectId) throw new Error("Saha raporu bu projeye ait değil.");
        input.salesOrderId = input.salesOrderId ?? existingReport.salesOrderId ?? null;
        input.appointmentId = input.appointmentId ?? existingReport.appointmentId ?? null;
        const payload = await this.buildReportPayload(input);
        const project: any = await this.projectRepository.findById(input.projectId);
        const sameDayReport = await (this.reportRepository as any).findByProjectAndWorkDateExcept(input.projectId, payload.workDate, reportId, input.salesOrderId || null, isPrimarySalesOrder(project, input.salesOrderId));
        // if (sameDayReport) throw new Error("Bu proje için aynı güne ait başka bir saha raporu var. Bir günde yalnızca bir rapor olabilir.");

        let report = await (this.reportRepository as any).updateReport(reportId, payload);
        if (input.images !== undefined) {
            await this.reportRepository.replaceImages(reportId, input.images || [], input.employeeId);
            report = await (this.reportRepository as any).findById(reportId) || report;
        }
        return {
            ...report,
            overtimeWarning: payload.overtimeMinutes > 0
                ? `%15 tolerans aşıldı. ${payload.overtimeMinutes} dk fazla çalışma için ek ücret hesaplandı.`
                : null
        };
    }
}
