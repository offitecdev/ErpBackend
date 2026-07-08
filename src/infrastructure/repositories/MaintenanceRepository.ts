
import prisma from "../database/prisma.client";
import { IMaintenanceRepository, TenantScope } from "../../domain/repositories/IMaintenanceRepository";
import {
    MaintenanceAppointmentOption,
    MaintenanceContract,
    MaintenanceExpense,
    MaintenanceMaterial,
    MaintenanceReport,
    MaintenanceTask,
    MaintenanceTaskAssignment,
    TaskStatus,
} from "../../domain/entities/Maintenance";
import { nanoid } from "nanoid";

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
    expenses: true,
};

const taskInclude = {
    technician: { select: technicianSelect },
    alternativeTechnician: { select: technicianSelect },
    assignments: {
        orderBy: { assignedAt: 'asc' as const },
        include: { technician: { select: technicianSelect } },
    },
    appointmentOptions: {
        orderBy: { startTime: 'asc' as const },
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
        orderBy: { assignedAt: 'asc' as const },
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
        orderBy: { assignedAt: 'asc' as const },
        include: { technician: { select: technicianSelect } },
    },
    contract: { include: { customer: { select: customerSelect } } },
};

export class MaintenanceRepository implements IMaintenanceRepository {
    async createContract(contract: Partial<MaintenanceContract>): Promise<MaintenanceContract> {
        const data = await prisma.maintenanceContract.create({
            data: contract as any
        });
        return data as unknown as MaintenanceContract;
    }

    async getNextContractCode(tenantId: string): Promise<string> {
        const rows = await prisma.maintenanceContract.findMany({
            where: { tenantId, contractCode: { startsWith: 'M-' } },
            select: { contractCode: true },
        });
        const max = rows.reduce((value, row) => {
            const match = /^M-(\d{3,})-\d{2}$/.exec(row.contractCode || '');
            return match ? Math.max(value, Number(match[1]) || 0) : value;
        }, 0);
        return `M-${String(max + 1).padStart(3, '0')}-01`;
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
        return data ? data as unknown as MaintenanceContract : null;
    }

    async listContracts(tenantId: TenantScope, customerId?: string): Promise<MaintenanceContract[]> {
        const where: any = { tenantId: tenantWhere(tenantId), deletedAt: null };
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
        return data as unknown as MaintenanceContract[];
    }

    async updateContract(id: string, patch: Partial<MaintenanceContract>): Promise<MaintenanceContract> {
        const data = await prisma.maintenanceContract.update({
            where: { id },
            data: patch as any,
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
        return data as unknown as MaintenanceContract;
    }

    async archiveContract(id: string): Promise<MaintenanceContract> {
        const data = await prisma.maintenanceContract.update({
            where: { id },
            data: { deletedAt: new Date(), isActive: false },
        });
        return data as unknown as MaintenanceContract;
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

    // Lazy detail for the calendar popup — the popup fields only, no report trees.
    async getTaskCalendarDetailById(id: string): Promise<MaintenanceTask | null> {
        const data = await prisma.maintenanceTask.findUnique({
            where: { id },
            include: taskCalendarDetailInclude,
        });
        return data ? data as unknown as MaintenanceTask : null;
    }

    async getTaskByBookingToken(token: string): Promise<MaintenanceTask | null> {
        const data = await prisma.maintenanceTask.findUnique({
            where: { bookingToken: token },
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

    async getTasksByDateRange(tenantId: TenantScope, startDate: Date, endDate: Date, lite = false): Promise<MaintenanceTask[]> {
        const data = await prisma.maintenanceTask.findMany({
            where: {
                contract: { tenantId: tenantWhere(tenantId) },
                plannedDate: { gte: startDate, lte: endDate }
            },
            orderBy: { plannedDate: 'asc' },
            include: lite ? taskCalendarListInclude : taskInclude,
        });
        return data as unknown as MaintenanceTask[];
    }

    async getTasksAssignedToTechnician(tenantId: TenantScope, technicianId: string, startDate: Date, endDate: Date, lite = false): Promise<MaintenanceTask[]> {
        const data = await prisma.maintenanceTask.findMany({
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
        return data as unknown as MaintenanceTask[];
    }

    async replaceTaskAssignments(taskId: string, technicianIds: string[], createdById?: string): Promise<MaintenanceTaskAssignment[]> {
        const uniqueIds = [...new Set(technicianIds.filter(Boolean))];
        await prisma.$transaction(async (tx) => {
            await tx.maintenanceTaskAssignment.deleteMany({ where: { taskId } });
            if (uniqueIds.length) {
                await tx.maintenanceTaskAssignment.createMany({
                    data: uniqueIds.map((technicianId) => ({
                        id: nanoid(12),
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

        const data = await prisma.maintenanceTaskAssignment.findMany({
            where: { taskId },
            orderBy: { assignedAt: 'asc' },
            include: { technician: { select: technicianSelect } },
        });
        return data as unknown as MaintenanceTaskAssignment[];
    }

    async findAssignmentConflict(technicianIds: string[], startTime: Date, endTime: Date, excludeTaskId?: string): Promise<MaintenanceTask | null> {
        const uniqueIds = [...new Set(technicianIds.filter(Boolean))];
        if (!uniqueIds.length) return null;
        const data = await prisma.maintenanceTask.findFirst({
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
        return data ? data as unknown as MaintenanceTask : null;
    }

    async findAppointmentOptionConflict(
        technicianIds: string[],
        startTime: Date,
        endTime: Date,
        excludeTaskId?: string,
        excludeOptionId?: string
    ): Promise<MaintenanceAppointmentOption | null> {
        const uniqueIds = [...new Set(technicianIds.filter(Boolean))];
        if (!uniqueIds.length) return null;
        const data = await prisma.maintenanceAppointmentOption.findFirst({
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
        return data ? data as unknown as MaintenanceAppointmentOption : null;
    }

    async createAppointmentOptions(taskId: string, options: Partial<MaintenanceAppointmentOption>[]): Promise<MaintenanceAppointmentOption[]> {
        await prisma.$transaction(async (tx) => {
            await tx.maintenanceAppointmentOption.updateMany({
                where: { taskId, status: 'PENDING' },
                data: { status: 'EXPIRED' },
            });
            if (options.length) {
                await tx.maintenanceAppointmentOption.createMany({
                    data: options.map((option) => ({
                        id: option.id || nanoid(12),
                        taskId,
                        token: option.token || nanoid(32),
                        startTime: option.startTime!,
                        endTime: option.endTime!,
                        status: option.status || 'PENDING',
                        sentAt: option.sentAt || new Date(),
                        emailLogJson: option.emailLogJson as any,
                    })),
                });
            }
        });

        const data = await prisma.maintenanceAppointmentOption.findMany({
            where: { taskId, status: 'PENDING' },
            orderBy: { startTime: 'asc' },
        });
        return data as unknown as MaintenanceAppointmentOption[];
    }

    async listAppointmentOptionsByToken(token: string): Promise<MaintenanceAppointmentOption[]> {
        const task = await prisma.maintenanceTask.findUnique({
            where: { bookingToken: token },
            include: { appointmentOptions: { where: { status: 'PENDING' }, orderBy: { startTime: 'asc' } } },
        });
        return (task?.appointmentOptions || []) as unknown as MaintenanceAppointmentOption[];
    }

    async confirmAppointmentOption(taskToken: string, optionId: string): Promise<MaintenanceTask> {
        const task = await prisma.$transaction(async (tx) => {
            const current = await tx.maintenanceTask.findUnique({
                where: { bookingToken: taskToken },
                include: { appointmentOptions: true },
            });
            if (!current) throw new Error("Randevu linki bulunamadi.");
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
        return task as unknown as MaintenanceTask;
    }

    async disapproveAppointmentOptions(taskToken: string): Promise<MaintenanceTask> {
        const task = await prisma.$transaction(async (tx) => {
            const current = await tx.maintenanceTask.findUnique({
                where: { bookingToken: taskToken },
                include: { appointmentOptions: true },
            });
            if (!current) throw new Error("Randevu linki bulunamadi.");

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
        return task as unknown as MaintenanceTask;
    }

    async approveAppointmentOptionForTask(taskId: string, optionId: string, managerId: string): Promise<MaintenanceTask> {
        const task = await prisma.$transaction(async (tx) => {
            const current = await tx.maintenanceTask.findUnique({
                where: { id: taskId },
                include: { appointmentOptions: true },
            });
            if (!current) throw new Error("Gorev bulunamadi.");
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
        return task as unknown as MaintenanceTask;
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

    async updateReport(reportId: string, patch: Partial<MaintenanceReport>): Promise<MaintenanceReport> {
        const data = await prisma.maintenanceReport.update({
            where: { id: reportId },
            data: patch as any,
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
        return data as unknown as MaintenanceReport;
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

    async addExpense(expense: Partial<MaintenanceExpense>): Promise<MaintenanceExpense> {
        const data = await prisma.maintenanceExpense.create({
            data: expense as any,
        });
        return data as unknown as MaintenanceExpense;
    }
}
