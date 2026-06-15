"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectReportRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
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
    async findById(id) {
        return await prisma_client_1.default.projectReport.findUnique({
            where: { id },
            include: {
                usedMaterials: {
                    include: { material: true }
                }
            }
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
                usedMaterials: { include: { article: true, material: true } }
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
                }
            }
        });
    }
}
exports.ProjectReportRepository = ProjectReportRepository;
//# sourceMappingURL=ProjectReportRepository.js.map