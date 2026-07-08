"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaintenanceRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const nanoid_1 = require("nanoid");
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
    expenses: true,
};
const taskInclude = {
    technician: { select: technicianSelect },
    alternativeTechnician: { select: technicianSelect },
    assignments: {
        orderBy: { assignedAt: 'asc' },
        include: { technician: { select: technicianSelect } },
    },
    appointmentOptions: {
        orderBy: { startTime: 'asc' },
    },
    expenses: true,
    report: { include: reportInclude },
    contract: {
        include: {
            customer: { select: customerSelect },
        }
    },
};
// Trimmed include for the calendar grid: enough to render a task block (title,
// technician names, contract code) without the report/material/appointment-option
// trees taskInclude carries. The popup fetches richer detail lazily on click.
const taskCalendarListInclude = {
    technician: { select: { id: true, firstName: true, lastName: true } },
    alternativeTechnician: { select: { id: true, firstName: true, lastName: true } },
    assignments: {
        orderBy: { assignedAt: 'asc' },
        select: { technician: { select: { id: true, firstName: true, lastName: true } } },
    },
    contract: { select: { id: true, title: true, contractCode: true, customer: { select: { id: true, companyName: true } } } },
};
// Single-task include for the calendar detail popup: participants with contacts
// and the full contract row (customer contacts, period, site) — but still no
// report/material/appointment-option trees.
const taskCalendarDetailInclude = {
    technician: { select: technicianSelect },
    alternativeTechnician: { select: technicianSelect },
    assignments: {
        orderBy: { assignedAt: 'asc' },
        include: { technician: { select: technicianSelect } },
    },
    contract: { include: { customer: { select: customerSelect } } },
};
class MaintenanceRepository {
    async createContract(contract) {
        const data = await prisma_client_1.default.maintenanceContract.create({
            data: contract
        });
        return data;
    }
    async getNextContractCode(tenantId) {
        const rows = await prisma_client_1.default.maintenanceContract.findMany({
            where: { tenantId, contractCode: { startsWith: 'M-' } },
            select: { contractCode: true },
        });
        const max = rows.reduce((value, row) => {
            const match = /^M-(\d{3,})-\d{2}$/.exec(row.contractCode || '');
            return match ? Math.max(value, Number(match[1]) || 0) : value;
        }, 0);
        return `M-${String(max + 1).padStart(3, '0')}-01`;
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
                        assignments: {
                            orderBy: { assignedAt: 'asc' },
                            include: { technician: { select: technicianSelect } },
                        },
                        appointmentOptions: { orderBy: { startTime: 'asc' } },
                        expenses: true,
                        report: { include: reportInclude },
                    }
                }
            }
        });
        return data ? data : null;
    }
    async listContracts(tenantId, customerId) {
        const where = { tenantId: tenantWhere(tenantId), deletedAt: null };
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
                        assignments: {
                            orderBy: { assignedAt: 'asc' },
                            include: { technician: { select: technicianSelect } },
                        },
                        appointmentOptions: { orderBy: { startTime: 'asc' } },
                        report: { select: { id: true, isSigned: true, createdAt: true, signedAt: true } },
                    }
                },
            },
        });
        return data;
    }
    async updateContract(id, patch) {
        const data = await prisma_client_1.default.maintenanceContract.update({
            where: { id },
            data: patch,
            include: {
                customer: { select: customerSelect },
                tasks: {
                    orderBy: { plannedDate: 'asc' },
                    include: {
                        technician: { select: technicianSelect },
                        alternativeTechnician: { select: technicianSelect },
                        assignments: {
                            orderBy: { assignedAt: 'asc' },
                            include: { technician: { select: technicianSelect } },
                        },
                        appointmentOptions: { orderBy: { startTime: 'asc' } },
                        report: { include: reportInclude },
                    },
                },
            },
        });
        return data;
    }
    async archiveContract(id) {
        const data = await prisma_client_1.default.maintenanceContract.update({
            where: { id },
            data: { deletedAt: new Date(), isActive: false },
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
    // Lazy detail for the calendar popup — the popup fields only, no report trees.
    async getTaskCalendarDetailById(id) {
        const data = await prisma_client_1.default.maintenanceTask.findUnique({
            where: { id },
            include: taskCalendarDetailInclude,
        });
        return data ? data : null;
    }
    async getTaskByBookingToken(token) {
        const data = await prisma_client_1.default.maintenanceTask.findUnique({
            where: { bookingToken: token },
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
    async getTasksByDateRange(tenantId, startDate, endDate, lite = false) {
        const data = await prisma_client_1.default.maintenanceTask.findMany({
            where: {
                contract: { tenantId: tenantWhere(tenantId) },
                plannedDate: { gte: startDate, lte: endDate }
            },
            orderBy: { plannedDate: 'asc' },
            include: lite ? taskCalendarListInclude : taskInclude,
        });
        return data;
    }
    async getTasksAssignedToTechnician(tenantId, technicianId, startDate, endDate, lite = false) {
        const data = await prisma_client_1.default.maintenanceTask.findMany({
            where: {
                contract: { tenantId: tenantWhere(tenantId), deletedAt: null },
                plannedDate: { gte: startDate, lte: endDate },
                managerApprovedAt: { not: null },
                OR: [
                    { assignedTechId: technicianId },
                    { alternativeTechId: technicianId },
                    { assignments: { some: { technicianId } } },
                ],
            },
            orderBy: [{ scheduledStartTime: 'asc' }, { plannedDate: 'asc' }],
            include: lite ? taskCalendarListInclude : taskInclude,
        });
        return data;
    }
    async replaceTaskAssignments(taskId, technicianIds, createdById) {
        const uniqueIds = [...new Set(technicianIds.filter(Boolean))];
        await prisma_client_1.default.$transaction(async (tx) => {
            await tx.maintenanceTaskAssignment.deleteMany({ where: { taskId } });
            if (uniqueIds.length) {
                await tx.maintenanceTaskAssignment.createMany({
                    data: uniqueIds.map((technicianId) => ({
                        id: (0, nanoid_1.nanoid)(12),
                        taskId,
                        technicianId,
                        createdById: createdById || null,
                    })),
                });
            }
            await tx.maintenanceTask.update({
                where: { id: taskId },
                data: {
                    assignedTechId: uniqueIds[0] || null,
                    alternativeTechId: uniqueIds[1] && uniqueIds[1] !== uniqueIds[0] ? uniqueIds[1] : null,
                },
            });
        });
        const data = await prisma_client_1.default.maintenanceTaskAssignment.findMany({
            where: { taskId },
            orderBy: { assignedAt: 'asc' },
            include: { technician: { select: technicianSelect } },
        });
        return data;
    }
    async findAssignmentConflict(technicianIds, startTime, endTime, excludeTaskId) {
        const uniqueIds = [...new Set(technicianIds.filter(Boolean))];
        if (!uniqueIds.length)
            return null;
        const data = await prisma_client_1.default.maintenanceTask.findFirst({
            where: {
                ...(excludeTaskId ? { id: { not: excludeTaskId } } : {}),
                status: { not: 'CANCELLED' },
                scheduledStartTime: { lt: endTime },
                scheduledEndTime: { gt: startTime },
                OR: [
                    { assignedTechId: { in: uniqueIds } },
                    { alternativeTechId: { in: uniqueIds } },
                    { assignments: { some: { technicianId: { in: uniqueIds } } } },
                ],
            },
            include: taskInclude,
        });
        return data ? data : null;
    }
    async findAppointmentOptionConflict(technicianIds, startTime, endTime, excludeTaskId, excludeOptionId) {
        const uniqueIds = [...new Set(technicianIds.filter(Boolean))];
        if (!uniqueIds.length)
            return null;
        const data = await prisma_client_1.default.maintenanceAppointmentOption.findFirst({
            where: {
                ...(excludeOptionId ? { id: { not: excludeOptionId } } : {}),
                ...(excludeTaskId ? { taskId: { not: excludeTaskId } } : {}),
                status: { in: ['PENDING', 'APPROVED'] },
                startTime: { lt: endTime },
                endTime: { gt: startTime },
                task: {
                    status: { not: 'CANCELLED' },
                    OR: [
                        { assignedTechId: { in: uniqueIds } },
                        { alternativeTechId: { in: uniqueIds } },
                        { assignments: { some: { technicianId: { in: uniqueIds } } } },
                    ],
                },
            },
            orderBy: { startTime: 'asc' },
            include: {
                task: {
                    include: {
                        contract: { include: { customer: { select: customerSelect } } },
                        technician: { select: technicianSelect },
                        alternativeTechnician: { select: technicianSelect },
                        assignments: {
                            orderBy: { assignedAt: 'asc' },
                            include: { technician: { select: technicianSelect } },
                        },
                    },
                },
            },
        });
        return data ? data : null;
    }
    async createAppointmentOptions(taskId, options) {
        await prisma_client_1.default.$transaction(async (tx) => {
            await tx.maintenanceAppointmentOption.updateMany({
                where: { taskId, status: 'PENDING' },
                data: { status: 'EXPIRED' },
            });
            if (options.length) {
                await tx.maintenanceAppointmentOption.createMany({
                    data: options.map((option) => ({
                        id: option.id || (0, nanoid_1.nanoid)(12),
                        taskId,
                        token: option.token || (0, nanoid_1.nanoid)(32),
                        startTime: option.startTime,
                        endTime: option.endTime,
                        status: option.status || 'PENDING',
                        sentAt: option.sentAt || new Date(),
                        emailLogJson: option.emailLogJson,
                    })),
                });
            }
        });
        const data = await prisma_client_1.default.maintenanceAppointmentOption.findMany({
            where: { taskId, status: 'PENDING' },
            orderBy: { startTime: 'asc' },
        });
        return data;
    }
    async listAppointmentOptionsByToken(token) {
        const task = await prisma_client_1.default.maintenanceTask.findUnique({
            where: { bookingToken: token },
            include: { appointmentOptions: { where: { status: 'PENDING' }, orderBy: { startTime: 'asc' } } },
        });
        return (task?.appointmentOptions || []);
    }
    async confirmAppointmentOption(taskToken, optionId) {
        const task = await prisma_client_1.default.$transaction(async (tx) => {
            const current = await tx.maintenanceTask.findUnique({
                where: { bookingToken: taskToken },
                include: { appointmentOptions: true },
            });
            if (!current)
                throw new Error("Randevu linki bulunamadi.");
            const selected = current.appointmentOptions.find((option) => option.id === optionId);
            if (!selected || selected.status !== 'PENDING') {
                throw new Error("Secilen randevu artik uygun degil.");
            }
            await tx.maintenanceAppointmentOption.updateMany({
                where: { taskId: current.id, status: 'PENDING', id: { not: optionId } },
                data: { status: 'DECLINED', respondedAt: new Date() },
            });
            await tx.maintenanceAppointmentOption.update({
                where: { id: optionId },
                data: { status: 'APPROVED', respondedAt: new Date() },
            });
            return await tx.maintenanceTask.update({
                where: { id: current.id },
                data: {
                    plannedDate: selected.startTime,
                    scheduledStartTime: selected.startTime,
                    scheduledEndTime: selected.endTime,
                    managerApprovedAt: new Date(),
                    managerApprovedById: null,
                },
                include: taskInclude,
            });
        });
        return task;
    }
    async disapproveAppointmentOptions(taskToken) {
        const task = await prisma_client_1.default.$transaction(async (tx) => {
            const current = await tx.maintenanceTask.findUnique({
                where: { bookingToken: taskToken },
                include: { appointmentOptions: true },
            });
            if (!current)
                throw new Error("Randevu linki bulunamadi.");
            await tx.maintenanceAppointmentOption.updateMany({
                where: { taskId: current.id, status: 'PENDING' },
                data: { status: 'DECLINED', respondedAt: new Date() },
            });
            return await tx.maintenanceTask.update({
                where: { id: current.id },
                data: { managerApprovedAt: null, managerApprovedById: null },
                include: taskInclude,
            });
        });
        return task;
    }
    async approveAppointmentOptionForTask(taskId, optionId, managerId) {
        const task = await prisma_client_1.default.$transaction(async (tx) => {
            const current = await tx.maintenanceTask.findUnique({
                where: { id: taskId },
                include: { appointmentOptions: true },
            });
            if (!current)
                throw new Error("Gorev bulunamadi.");
            const selected = current.appointmentOptions.find((option) => option.id === optionId);
            if (!selected || !['PENDING', 'APPROVED'].includes(selected.status)) {
                throw new Error("Secilen randevu artik uygun degil.");
            }
            await tx.maintenanceAppointmentOption.updateMany({
                where: { taskId: current.id, status: 'PENDING', id: { not: optionId } },
                data: { status: 'DECLINED', respondedAt: new Date() },
            });
            await tx.maintenanceAppointmentOption.update({
                where: { id: optionId },
                data: { status: 'APPROVED', respondedAt: selected.respondedAt || new Date() },
            });
            return await tx.maintenanceTask.update({
                where: { id: current.id },
                data: {
                    plannedDate: selected.startTime,
                    scheduledStartTime: selected.startTime,
                    scheduledEndTime: selected.endTime,
                    managerApprovedAt: new Date(),
                    managerApprovedById: managerId,
                },
                include: taskInclude,
            });
        });
        return task;
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
    async updateReport(reportId, patch) {
        const data = await prisma_client_1.default.maintenanceReport.update({
            where: { id: reportId },
            data: patch,
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
    async addExpense(expense) {
        const data = await prisma_client_1.default.maintenanceExpense.create({
            data: expense,
        });
        return data;
    }
}
exports.MaintenanceRepository = MaintenanceRepository;
//# sourceMappingURL=MaintenanceRepository.js.map