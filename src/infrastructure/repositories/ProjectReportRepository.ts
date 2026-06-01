import prisma from "../database/prisma.client";

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

    async findById(id: string) {
        return await prisma.projectReport.findUnique({
            where: { id },
            include: {
                usedMaterials: {
                    include: { material: true }
                }
            }
        });
    }

    async findByProjectAndWorkDate(projectId: string, workDate: Date) {
        const dayStart = new Date(workDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(workDate);
        dayEnd.setHours(23, 59, 59, 999);

        return await (prisma as any).projectReport.findFirst({
            where: {
                projectId,
                workDate: { gte: dayStart, lte: dayEnd }
            }
        });
    }

    async findByProjectAndWorkDateExcept(projectId: string, workDate: Date, reportId: string) {
        const dayStart = new Date(workDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(workDate);
        dayEnd.setHours(23, 59, 59, 999);

        return await (prisma as any).projectReport.findFirst({
            where: {
                projectId,
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
                usedMaterials: { include: { article: true, material: true } }
            }
        });
    }

    async signReport(reportId: string, signatureBase64: string) {
        await prisma.projectReport.update({
            where: { id: reportId },
            data: {
                isSigned: true,
                customerSignature: signatureBase64
            }
        });
    }

    async getReportsByProjectId(projectId: string): Promise<any[]> {
        return await prisma.projectReport.findMany({
            where: { projectId: projectId },
            include: {
                usedMaterials: {
                    include: { material: true }
                }
            }
        });
    }
}
