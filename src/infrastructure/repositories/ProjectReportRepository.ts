import prisma from "../database/prisma.client";
import { nanoid } from "nanoid";

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
                    include: { material: true }
                },
                images: { orderBy: { createdAt: "asc" } }
            }
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
                usedMaterials: { include: { article: true, material: true } },
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
                    include: { material: true }
                },
                images: { orderBy: { createdAt: "asc" } }
            }
        });
    }
}
