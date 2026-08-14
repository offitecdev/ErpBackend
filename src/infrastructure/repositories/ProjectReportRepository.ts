import prisma from "../database/prisma.client";
import { nanoid } from "nanoid";

// Saha raporu kaydetme yanıtı: editör/PDF'nin kullandığı alanlar. İmza blobu,
// tam Article/Material kayıtları ve diğer proje ilişkileri bilinçli olarak yoktur.
const reportSaveSelect = {
    id: true,
    projectId: true,
    salesOrderId: true,
    appointmentId: true,
    employeeId: true,
    reportDate: true,
    reportType: true,
    workDate: true,
    startedAt: true,
    endedAt: true,
    workedMinutes: true,
    plannedMinutesForDay: true,
    overtimeMinutes: true,
    overtimeHourlyRate: true,
    overtimeCost: true,
    operationsDone: true,
    technicalNotes: true,
    isSigned: true,
    signedAt: true,
    hoursApprovedAt: true,
    hoursApprovedById: true,
    autoApproved: true,
    employee: { select: { id: true, firstName: true, lastName: true } },
    usedMaterials: {
        select: {
            id: true,
            articleId: true,
            quantity: true,
            costAtTime: true,
            article: { select: { id: true, name: true } },
        },
    },
    images: {
        orderBy: { createdAt: "asc" as const },
        select: { id: true, imageData: true, caption: true, createdAt: true },
    },
} as const;

export class ProjectReportRepository {
    async createReport(reportData: any) {
        return await prisma.projectReport.create({
            data: reportData
        });
    }

    async addMaterialsToReport(reportId: string, materials: any[]) {
        await prisma.reportMaterial.createMany({
            data: materials
        });
    }

    // Replaces the full set of field-report images. `images` is a list of base64
    // data URLs; passing an empty array clears all images for the report.
    async replaceImages(reportId: string, images: string[], uploadedById?: string | null) {
        await (prisma as any).$transaction(async (tx: any) => {
            await tx.projectReportImage.deleteMany({ where: { reportId } });
            const rows = (images || [])
                .filter((data) => typeof data === "string" && data.trim().length > 0)
                .map((data) => ({
                    id: nanoid(10),
                    reportId,
                    imageData: data,
                    uploadedById: uploadedById || null,
                }));
            if (rows.length) {
                await tx.projectReportImage.createMany({ data: rows });
            }
        });
    }

    async findById(id: string) {
        return await prisma.projectReport.findUnique({
            where: { id },
            include: {
                usedMaterials: {
                    include: { article: true }
                },
                images: { orderBy: { createdAt: "asc" } }
            }
        });
    }

    async findSaveResultById(id: string) {
        return await (prisma as any).projectReport.findUnique({
            where: { id },
            select: reportSaveSelect,
        });
    }

    async updateReportLean(reportId: string, reportData: any) {
        return await (prisma as any).projectReport.update({
            where: { id: reportId },
            data: reportData,
            select: {
                id: true,
                projectId: true,
                salesOrderId: true,
                appointmentId: true,
                employeeId: true,
                reportDate: true,
                reportType: true,
                workDate: true,
                startedAt: true,
                endedAt: true,
                workedMinutes: true,
                plannedMinutesForDay: true,
                overtimeMinutes: true,
                overtimeHourlyRate: true,
                overtimeCost: true,
                operationsDone: true,
                technicalNotes: true,
                isSigned: true,
                signedAt: true,
                hoursApprovedAt: true,
                hoursApprovedById: true,
                autoApproved: true,
            },
        });
    }

    // A field report belongs to exactly one appointment once stamped. Used to
    // enforce one-report-per-appointment (instead of the legacy one-per-order-day)
    // and to reuse an appointment's own draft when it is later completed.
    async findByAppointmentId(appointmentId: string) {
        if (!appointmentId) return null;
        return await (prisma as any).projectReport.findFirst({
            where: { appointmentId }
        });
    }

    async findByProjectAndWorkDate(projectId: string, workDate: Date, salesOrderId?: string | null, includeUnscoped = false) {
        const dayStart = new Date(workDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(workDate);
        dayEnd.setHours(23, 59, 59, 999);

        return await (prisma as any).projectReport.findFirst({
            where: {
                projectId,
                ...(salesOrderId !== undefined
                    ? includeUnscoped
                        ? { OR: [{ salesOrderId }, { salesOrderId: null }] }
                        : { salesOrderId }
                    : {}),
                workDate: { gte: dayStart, lte: dayEnd }
            }
        });
    }

    async findByProjectAndWorkDateExcept(projectId: string, workDate: Date, reportId: string, salesOrderId?: string | null, includeUnscoped = false) {
        const dayStart = new Date(workDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(workDate);
        dayEnd.setHours(23, 59, 59, 999);

        return await (prisma as any).projectReport.findFirst({
            where: {
                projectId,
                ...(salesOrderId !== undefined
                    ? includeUnscoped
                        ? { OR: [{ salesOrderId }, { salesOrderId: null }] }
                        : { salesOrderId }
                    : {}),
                id: { not: reportId },
                workDate: { gte: dayStart, lte: dayEnd }
            }
        });
    }

    async updateReport(reportId: string, reportData: any) {
        return await prisma.projectReport.update({
            where: { id: reportId },
            data: reportData,
            include: {
                employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                usedMaterials: { include: { article: true } },
                images: { orderBy: { createdAt: "asc" } }
            }
        });
    }

    async signReport(reportId: string, signatureBase64: string) {
        await (prisma as any).projectReport.update({
            where: { id: reportId },
            data: {
                isSigned: true,
                customerSignature: signatureBase64,
                signedAt: new Date(),
            }
        });
    }

    async getReportsByProjectId(projectId: string): Promise<any[]> {
        return await prisma.projectReport.findMany({
            where: { projectId: projectId },
            include: {
                usedMaterials: {
                    include: { article: true }
                },
                images: { orderBy: { createdAt: "asc" } }
            }
        });
    }
}
