
import prisma from "../database/prisma.client";
import { IMaintenanceRepository, TenantScope } from "../../domain/repositories/IMaintenanceRepository";
import { MaintenanceContract, MaintenanceTask, MaintenanceReport, MaintenanceMaterial, TaskStatus } from "../../domain/entities/Maintenance";

const tenantWhere = (tenantId: TenantScope) => Array.isArray(tenantId) ? { in: tenantId } : tenantId;

const technicianSelect = {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
};

const customerSelect = {
    id: true,
    companyName: true,
    address: true,
    mainEmail: true,
    mainPhone: true,
};

const materialInclude = {
    article: {
        select: {
            id: true,
            articleCode: true,
            name: true,
            unit: true,
            baseCost: true,
            imageUrl: true,
        }
    }
};

const reportInclude = {
    technician: { select: technicianSelect },
    usedMaterials: { include: materialInclude },
};

const taskInclude = {
    technician: { select: technicianSelect },
    alternativeTechnician: { select: technicianSelect },
    report: { include: reportInclude },
    contract: {
        include: {
            customer: { select: customerSelect },
        }
    },
};

export class MaintenanceRepository implements IMaintenanceRepository {
    async createContract(contract: Partial<MaintenanceContract>): Promise<MaintenanceContract> {
        const data = await prisma.maintenanceContract.create({
            data: contract as any
        });
        return data as unknown as MaintenanceContract;
    }

    async getContractById(id: string): Promise<MaintenanceContract | null> {
        const data = await prisma.maintenanceContract.findUnique({
            where: { id },
            include: {
                customer: { select: customerSelect },
                tasks: {
                    orderBy: { plannedDate: 'asc' },
                    include: {
                        technician: { select: technicianSelect },
                        alternativeTechnician: { select: technicianSelect },
                        report: { include: reportInclude },
                    }
                }
            }
        });
        return data ? data as unknown as MaintenanceContract : null;
    }

    async listContracts(tenantId: TenantScope, customerId?: string): Promise<MaintenanceContract[]> {
        const where: any = { tenantId: tenantWhere(tenantId) };
        if (customerId) where.customerId = customerId;
        const data = await prisma.maintenanceContract.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                customer: { select: customerSelect },
                tasks: {
                    orderBy: { plannedDate: 'asc' },
                    include: {
                        technician: { select: technicianSelect },
                        alternativeTechnician: { select: technicianSelect },
                        report: { select: { id: true, isSigned: true, createdAt: true, signedAt: true } },
                    }
                },
            },
        });
        return data as unknown as MaintenanceContract[];
    }

    async createTask(task: Partial<MaintenanceTask>): Promise<MaintenanceTask> {
        const data = await prisma.maintenanceTask.create({ data: task as any });
        return data as unknown as MaintenanceTask;
    }

    async getTaskById(id: string): Promise<MaintenanceTask | null> {
        const data = await prisma.maintenanceTask.findUnique({
            where: { id },
            include: taskInclude,
        });
        return data ? data as unknown as MaintenanceTask : null;
    }

    async updateTask(id: string, patch: Partial<MaintenanceTask>): Promise<MaintenanceTask> {
        const data = await prisma.maintenanceTask.update({
            where: { id },
            data: patch as any,
            include: taskInclude,
        });
        return data as unknown as MaintenanceTask;
    }

    async updateTaskStatus(id: string, status: TaskStatus): Promise<MaintenanceTask> {
        const data = await prisma.maintenanceTask.update({
            where: { id },
            data: { status },
            include: taskInclude,
        });
        return data as unknown as MaintenanceTask;
    }

    async getTasksByDateRange(tenantId: TenantScope, startDate: Date, endDate: Date): Promise<MaintenanceTask[]> {
        const data = await prisma.maintenanceTask.findMany({
            where: {
                contract: { tenantId: tenantWhere(tenantId) },
                plannedDate: { gte: startDate, lte: endDate }
            },
            orderBy: { plannedDate: 'asc' },
            include: taskInclude,
        });
        return data as unknown as MaintenanceTask[];
    }

    async createReport(report: Partial<MaintenanceReport>): Promise<MaintenanceReport> {
        const data = await prisma.maintenanceReport.create({
            data: report as any,
            include: reportInclude,
        });
        return data as unknown as MaintenanceReport;
    }

    async getReportByTaskId(taskId: string): Promise<MaintenanceReport | null> {
        const data = await prisma.maintenanceReport.findUnique({
            where: { taskId },
            include: {
                ...reportInclude,
                task: {
                    include: {
                        contract: { include: { customer: { select: customerSelect } } },
                    },
                },
            },
        });
        return data ? data as unknown as MaintenanceReport : null;
    }

    async getReportById(reportId: string): Promise<MaintenanceReport | null> {
        const data = await prisma.maintenanceReport.findUnique({
            where: { id: reportId },
            include: {
                ...reportInclude,
                task: {
                    include: {
                        technician: { select: technicianSelect },
                        alternativeTechnician: { select: technicianSelect },
                        contract: { include: { customer: { select: customerSelect } } },
                    },
                },
            },
        });
        return data ? data as unknown as MaintenanceReport : null;
    }

    async listReports(tenantId: TenantScope): Promise<MaintenanceReport[]> {
        const data = await prisma.maintenanceReport.findMany({
            where: { task: { contract: { tenantId: tenantWhere(tenantId) } } },
            orderBy: { createdAt: 'desc' },
            include: {
                ...reportInclude,
                task: {
                    include: {
                        technician: { select: technicianSelect },
                        alternativeTechnician: { select: technicianSelect },
                        contract: { include: { customer: { select: customerSelect } } },
                    },
                },
            },
        });
        return data as unknown as MaintenanceReport[];
    }

    async signReport(reportId: string, signatureBase64: string): Promise<MaintenanceReport> {
        const data = await prisma.maintenanceReport.update({
            where: { id: reportId },
            data: {
                isSigned: true,
                customerSignature: signatureBase64,
                signedAt: new Date(),
                lockedAt: new Date(),
                pdfUrl: `/maintenance/reports/${reportId}/pdf`,
                emailLogJson: {
                    status: 'queued',
                    channel: 'email',
                    createdAt: new Date().toISOString(),
                },
            },
            include: {
                ...reportInclude,
                task: {
                    include: {
                        contract: { include: { customer: { select: customerSelect } } },
                    },
                },
            },
        });
        return data as unknown as MaintenanceReport;
    }

    async addMaterialToReport(material: Partial<MaintenanceMaterial>): Promise<MaintenanceMaterial> {
        const data = await prisma.maintenanceMaterial.create({
            data: material as any,
            include: materialInclude,
        });
        return data as unknown as MaintenanceMaterial;
    }
}
