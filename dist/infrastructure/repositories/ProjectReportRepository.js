"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectReportRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const nanoid_1 = require("nanoid");
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
        orderBy: { createdAt: "asc" },
        select: { id: true, imageData: true, caption: true, createdAt: true },
    },
};
class ProjectReportRepository {
    async createReport(reportData) {
        return await prisma_client_1.default.projectReport.create({
            data: reportData
        });
    }
    async addMaterialsToReport(reportId, materials) {
        await prisma_client_1.default.reportMaterial.createMany({
            data: materials
        });
    }
    // Replaces the full set of field-report images. `images` is a list of base64
    // data URLs; passing an empty array clears all images for the report.
    async replaceImages(reportId, images, uploadedById) {
        await prisma_client_1.default.$transaction(async (tx) => {
            await tx.projectReportImage.deleteMany({ where: { reportId } });
            const rows = (images || [])
                .filter((data) => typeof data === "string" && data.trim().length > 0)
                .map((data) => ({
                id: (0, nanoid_1.nanoid)(10),
                reportId,
                imageData: data,
                uploadedById: uploadedById || null,
            }));
            if (rows.length) {
                await tx.projectReportImage.createMany({ data: rows });
            }
        });
    }
    async findById(id) {
        return await prisma_client_1.default.projectReport.findUnique({
            where: { id },
            include: {
                usedMaterials: {
                    include: { article: true }
                },
                images: { orderBy: { createdAt: "asc" } }
            }
        });
    }
    async findSaveResultById(id) {
        return await prisma_client_1.default.projectReport.findUnique({
            where: { id },
            select: reportSaveSelect,
        });
    }
    async updateReportLean(reportId, reportData) {
        return await prisma_client_1.default.projectReport.update({
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
    async findByAppointmentId(appointmentId) {
        if (!appointmentId)
            return null;
        return await prisma_client_1.default.projectReport.findFirst({
            where: { appointmentId }
        });
    }
    async findByProjectAndWorkDate(projectId, workDate, salesOrderId, includeUnscoped = false) {
        const dayStart = new Date(workDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(workDate);
        dayEnd.setHours(23, 59, 59, 999);
        return await prisma_client_1.default.projectReport.findFirst({
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
    async findByProjectAndWorkDateExcept(projectId, workDate, reportId, salesOrderId, includeUnscoped = false) {
        const dayStart = new Date(workDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(workDate);
        dayEnd.setHours(23, 59, 59, 999);
        return await prisma_client_1.default.projectReport.findFirst({
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
    async updateReport(reportId, reportData) {
        return await prisma_client_1.default.projectReport.update({
            where: { id: reportId },
            data: reportData,
            include: {
                employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                usedMaterials: { include: { article: true } },
                images: { orderBy: { createdAt: "asc" } }
            }
        });
    }
    async signReport(reportId, signatureBase64) {
        await prisma_client_1.default.projectReport.update({
            where: { id: reportId },
            data: {
                isSigned: true,
                customerSignature: signatureBase64,
                signedAt: new Date(),
            }
        });
    }
    async getReportsByProjectId(projectId) {
        return await prisma_client_1.default.projectReport.findMany({
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
exports.ProjectReportRepository = ProjectReportRepository;
//# sourceMappingURL=ProjectReportRepository.js.map