"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectReportRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const nanoid_1 = require("nanoid");
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
                    include: { material: true }
                },
                images: { orderBy: { createdAt: "asc" } }
            }
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
                usedMaterials: { include: { article: true, material: true } },
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
                    include: { material: true }
                },
                images: { orderBy: { createdAt: "asc" } }
            }
        });
    }
}
exports.ProjectReportRepository = ProjectReportRepository;
//# sourceMappingURL=ProjectReportRepository.js.map