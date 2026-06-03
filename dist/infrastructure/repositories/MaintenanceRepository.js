"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaintenanceRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const tenantWhere = (tenantId) => Array.isArray(tenantId) ? { in: tenantId } : tenantId;
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
class MaintenanceRepository {
    async createContract(contract) {
        const data = await prisma_client_1.default.maintenanceContract.create({
            data: contract
        });
        return data;
    }
    async getContractById(id) {
        const data = await prisma_client_1.default.maintenanceContract.findUnique({
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
        return data ? data : null;
    }
    async listContracts(tenantId, customerId) {
        const where = { tenantId: tenantWhere(tenantId) };
        if (customerId)
            where.customerId = customerId;
        const data = await prisma_client_1.default.maintenanceContract.findMany({
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
        return data;
    }
    async createTask(task) {
        const data = await prisma_client_1.default.maintenanceTask.create({ data: task });
        return data;
    }
    async getTaskById(id) {
        const data = await prisma_client_1.default.maintenanceTask.findUnique({
            where: { id },
            include: taskInclude,
        });
        return data ? data : null;
    }
    async updateTask(id, patch) {
        const data = await prisma_client_1.default.maintenanceTask.update({
            where: { id },
            data: patch,
            include: taskInclude,
        });
        return data;
    }
    async updateTaskStatus(id, status) {
        const data = await prisma_client_1.default.maintenanceTask.update({
            where: { id },
            data: { status },
            include: taskInclude,
        });
        return data;
    }
    async getTasksByDateRange(tenantId, startDate, endDate) {
        const data = await prisma_client_1.default.maintenanceTask.findMany({
            where: {
                contract: { tenantId: tenantWhere(tenantId) },
                plannedDate: { gte: startDate, lte: endDate }
            },
            orderBy: { plannedDate: 'asc' },
            include: taskInclude,
        });
        return data;
    }
    async createReport(report) {
        const data = await prisma_client_1.default.maintenanceReport.create({
            data: report,
            include: reportInclude,
        });
        return data;
    }
    async getReportByTaskId(taskId) {
        const data = await prisma_client_1.default.maintenanceReport.findUnique({
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
        return data ? data : null;
    }
    async getReportById(reportId) {
        const data = await prisma_client_1.default.maintenanceReport.findUnique({
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
        return data ? data : null;
    }
    async listReports(tenantId) {
        const data = await prisma_client_1.default.maintenanceReport.findMany({
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
        return data;
    }
    async signReport(reportId, signatureBase64) {
        const data = await prisma_client_1.default.maintenanceReport.update({
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
        return data;
    }
    async addMaterialToReport(material) {
        const data = await prisma_client_1.default.maintenanceMaterial.create({
            data: material,
            include: materialInclude,
        });
        return data;
    }
}
exports.MaintenanceRepository = MaintenanceRepository;
//# sourceMappingURL=MaintenanceRepository.js.map