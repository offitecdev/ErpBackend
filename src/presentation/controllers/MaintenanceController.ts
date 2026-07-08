import { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { CreateMaintenanceContractUseCase } from '../../application/use-cases/maintenance/CreateMaintenanceContract';
import { MaintenanceReportUseCase } from '../../application/use-cases/maintenance/MaintenanceReportUseCase';
import { IMaintenanceRepository } from '../../domain/repositories/IMaintenanceRepository';
import prisma from '../../infrastructure/database/prisma.client';
import { SmtpMailService } from '../../infrastructure/services/SmtpMailService';
import { getCustomerInServiceTenantScope, getServiceTenantScope, isTenantInServiceTenantScope } from './serviceTenantScope';

const smtp = new SmtpMailService();

const startOfDay = (date: Date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};

const endOfDay = (date: Date) => {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
};

const sameDay = (a: Date, b: Date) =>
    startOfDay(a).getTime() === startOfDay(b).getTime();

const normalizeIdList = (value: unknown) =>
    Array.isArray(value)
        ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
        : [];

type NotificationPayload = {
    type: string;
    title: string;
    message: string;
    linkUrl?: string | null;
    metadata?: unknown;
};

const defaultRange = () => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setMonth(end.getMonth() + 2);
    end.setDate(0);
    end.setHours(23, 59, 59, 999);

    return { start, end };
};

export class MaintenanceController {
    constructor(
        private createContractUseCase: CreateMaintenanceContractUseCase,
        private reportUseCase: MaintenanceReportUseCase,
        private maintenanceRepo: IMaintenanceRepository
    ) {}

    private async notify(input: {
        tenantId: string;
        recipientEmployeeId?: string | null;
        type: string;
        title: string;
        message: string;
        linkUrl?: string | null;
        metadata?: unknown;
    }) {
        await (prisma as any).notification.create({
            data: {
                id: nanoid(12),
                tenantId: input.tenantId,
                recipientEmployeeId: input.recipientEmployeeId || null,
                type: input.type,
                title: input.title,
                message: input.message,
                linkUrl: input.linkUrl || null,
                metadata: input.metadata as any,
            },
        });
    }

    private async notifyMany(tenantId: string, recipientEmployeeIds: string[], payload: NotificationPayload) {
        for (const recipientEmployeeId of [...new Set(recipientEmployeeIds.filter(Boolean))]) {
            await this.notify({ tenantId, recipientEmployeeId, ...payload });
        }
    }

    private async validateTechniciansInScope(technicianIds: string[], tenantId: string) {
        if (!technicianIds.length) return [];
        const tenantIds = await getServiceTenantScope(tenantId);
        const employees = await prisma.employee.findMany({
            where: { id: { in: technicianIds }, tenantId: { in: tenantIds }, isActive: true },
            select: { id: true },
        });
        const found = new Set(employees.map((employee) => employee.id));
        const missing = technicianIds.filter((id) => !found.has(id));
        if (missing.length) throw new Error("Secilen teknisyenlerden bazilari sirket kapsaminda bulunamadi.");
        return technicianIds;
    }

    private taskTechnicianIds(task: any) {
        return [...new Set([
            task.assignedTechId,
            task.alternativeTechId,
            ...((task.assignments || []).map((assignment: any) => assignment.technicianId)),
        ].filter(Boolean) as string[])];
    }

    private optionsOverlap(a: { startTime: Date; endTime: Date }, b: { startTime: Date; endTime: Date }) {
        return a.startTime < b.endTime && a.endTime > b.startTime;
    }

    private async getAppointmentUnavailableReason(task: any, option: { id?: string; startTime: Date; endTime: Date }) {
        const technicianIds = this.taskTechnicianIds(task);
        if (!technicianIds.length) return "Bu bakım görevi için teknisyen atanmamış.";

        const assignedConflict = await this.maintenanceRepo.findAssignmentConflict(
            technicianIds,
            option.startTime,
            option.endTime,
            task.id
        );
        if (assignedConflict) {
            return "Bu saat aralığında seçili teknisyenlerden biri başka bir bakım randevusuna atanmış.";
        }

        const optionConflict = await this.maintenanceRepo.findAppointmentOptionConflict(
            technicianIds,
            option.startTime,
            option.endTime,
            task.id,
            option.id
        );
        if (optionConflict) {
            return "Bu saat aralığı başka bir müşterinin bakım randevu seçeneğiyle çakışıyor.";
        }

        return null;
    }

    async listOptionCustomers(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const tenantIds = await getServiceTenantScope(tenantId);
            const customers = await prisma.customer.findMany({
                where: { tenantId: { in: tenantIds }, isActive: true },
                orderBy: { companyName: 'asc' },
                select: {
                    id: true,
                    tenantId: true,
                    companyName: true,
                    address: true,
                    mainEmail: true,
                    mainPhone: true,
                    isActive: true,
                },
            });
            res.status(200).json(customers);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listTechnicians(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const tenantIds = await getServiceTenantScope(tenantId);
            const technicians = await prisma.employee.findMany({
                where: {
                    tenantId: { in: tenantIds },
                    isActive: true,
                    OR: [
                        { roleName: { contains: 'Teknisyen' } },
                        { title: { contains: 'Teknisyen' } },
                        { employeeRoles: { some: { role: { roleName: { contains: 'Teknisyen' } } } } },
                    ],
                },
                orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
                select: {
                    id: true,
                    tenantId: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    phone: true,
                    title: true,
                    isActive: true,
                    roleName: true,
                    employeeRoles: {
                        select: { role: { select: { roleName: true } } },
                    },
                },
            });

            res.status(200).json(technicians.map((employee) => ({
                id: employee.id,
                tenantId: employee.tenantId,
                firstName: employee.firstName,
                lastName: employee.lastName,
                email: employee.email,
                phone: employee.phone,
                title: employee.title,
                isActive: employee.isActive,
                roleName: employee.employeeRoles.find((employeeRole) =>
                    employeeRole.role.roleName.includes('Teknisyen')
                )?.role.roleName || employee.roleName || employee.title,
            })));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createContract(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const customer = await getCustomerInServiceTenantScope(req.body.customerId, tenantId);
            if (!customer) {
                res.status(400).json({ error: "Secili musteri bu sirket kapsaminda bulunamadi." });
                return;
            }

            const technicianIds = await this.validateTechniciansInScope(
                normalizeIdList(req.body.technicianIds),
                tenantId
            );
            const result = await this.createContractUseCase.execute({ ...req.body, technicianIds, tenantId: customer.tenantId });
            res.status(201).json({ message: "Bakim sozlesmesi olusturuldu.", contract: result });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listContracts(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const tenantIds = await getServiceTenantScope(tenantId);
            const customerId = req.query.customerId as string;
            const contracts = await this.maintenanceRepo.listContracts(tenantIds, customerId);
            res.status(200).json(contracts);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateContract(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const contractId = String(req.params.contractId || "");
            const current = await this.maintenanceRepo.getContractById(contractId);
            if (!current) {
                res.status(404).json({ error: "Sozlesme bulunamadi." });
                return;
            }
            if (!(await isTenantInServiceTenantScope((current as any).tenantId, tenantId))) {
                res.status(403).json({ error: "Bu sozlesme icin yetkiniz yok." });
                return;
            }

            const patch: any = {};
            ["title", "equipmentInfo", "serviceScope", "siteName"].forEach((field) => {
                if (req.body[field] !== undefined) patch[field] = req.body[field] || null;
            });
            if (req.body.period !== undefined) patch.period = req.body.period;
            if (req.body.startDate !== undefined) patch.startDate = new Date(req.body.startDate);
            if (req.body.endDate !== undefined) patch.endDate = new Date(req.body.endDate);
            if (req.body.reminderDaysBefore !== undefined) patch.reminderDaysBefore = Number(req.body.reminderDaysBefore || 0);
            if (req.body.notificationChannels !== undefined) patch.notificationChannels = req.body.notificationChannels;
            if (req.body.overtimeHourlyRate !== undefined) patch.overtimeHourlyRate = Math.max(0, Number(req.body.overtimeHourlyRate || 0));

            if (patch.startDate && Number.isNaN(patch.startDate.getTime())) throw new Error("Baslangic tarihi gecersiz.");
            if (patch.endDate && Number.isNaN(patch.endDate.getTime())) throw new Error("Bitis tarihi gecersiz.");

            const updated = await this.maintenanceRepo.updateContract(contractId, patch);
            const technicianIds = await this.validateTechniciansInScope(normalizeIdList(req.body.technicianIds), tenantId);
            if (req.body.technicianIds !== undefined) {
                for (const task of ((updated as any).tasks || [])) {
                    await this.maintenanceRepo.replaceTaskAssignments(task.id, technicianIds, (req as any).user!.id);
                }
            }
            res.status(200).json(await this.maintenanceRepo.getContractById(contractId));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async archiveContract(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const contractId = String(req.params.contractId || "");
            const current = await this.maintenanceRepo.getContractById(contractId);
            if (!current) {
                res.status(404).json({ error: "Sozlesme bulunamadi." });
                return;
            }
            if (!(await isTenantInServiceTenantScope((current as any).tenantId, tenantId))) {
                res.status(403).json({ error: "Bu sozlesme icin yetkiniz yok." });
                return;
            }
            const archived = await this.maintenanceRepo.archiveContract(contractId);
            res.status(200).json({ message: "Sozlesme arsivlendi.", contract: archived });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listTasks(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const fallback = defaultRange();
            const rawStart = req.query.start ? new Date(req.query.start as string) : fallback.start;
            const rawEnd = req.query.end ? new Date(req.query.end as string) : fallback.end;
            const tenantIds = await getServiceTenantScope(tenantId);

            if (Number.isNaN(rawStart.getTime()) || Number.isNaN(rawEnd.getTime())) {
                res.status(400).json({ error: "Tarih araligi gecersiz." });
                return;
            }
            // Date-only params parse to midnight; widen to the full first/last day
            // so single-day (day view) ranges are not empty.
            const start = startOfDay(rawStart);
            const end = endOfDay(rawEnd);

            const lite = String(req.query.view || "") === "calendar";
            const tasks = await this.maintenanceRepo.getTasksByDateRange(tenantIds, start, end, lite);
            res.status(200).json(tasks);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getTask(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const taskId = String(req.params.taskId || "");
            const task = await this.maintenanceRepo.getTaskById(taskId);
            if (!task || !(await isTenantInServiceTenantScope((task as any).contract?.tenantId, tenantId))) {
                res.status(404).json({ error: "Gorev bulunamadi." });
                return;
            }
            res.status(200).json(task);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listMyTasks(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const fallback = defaultRange();
            const rawStart = req.query.start ? new Date(req.query.start as string) : fallback.start;
            const rawEnd = req.query.end ? new Date(req.query.end as string) : fallback.end;
            const tenantIds = await getServiceTenantScope(tenantId);

            if (Number.isNaN(rawStart.getTime()) || Number.isNaN(rawEnd.getTime())) {
                res.status(400).json({ error: "Tarih araligi gecersiz." });
                return;
            }
            // Date-only params parse to midnight; widen to the full first/last day
            // so single-day (day view) ranges are not empty.
            const start = startOfDay(rawStart);
            const end = endOfDay(rawEnd);

            const lite = String(req.query.view || "") === "calendar";
            const tasks = await this.maintenanceRepo.getTasksAssignedToTechnician(tenantIds, employeeId, start, end, lite);
            const approvedTasks = (tasks as any[]).filter(t => t.managerApprovedAt);
            res.status(200).json(approvedTasks);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getMyTask(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const taskId = String(req.params.taskId || "");
            const task = await this.maintenanceRepo.getTaskById(taskId);
            if (!task || !(await isTenantInServiceTenantScope((task as any).contract?.tenantId, tenantId))) {
                res.status(404).json({ error: "Gorev bulunamadi." });
                return;
            }
            if (!(task as any).managerApprovedAt) {
                res.status(403).json({ error: "Bu bakım görevi henüz yönetici tarafından onaylanmadı." });
                return;
            }
            const technicianIds = this.taskTechnicianIds(task as any);
            if (technicianIds.length && !technicianIds.includes(employeeId)) {
                res.status(403).json({ error: "Bu bakim gorevi size atanmamis." });
                return;
            }
            res.status(200).json(task);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Manager-facing lazy detail for the calendar popup (light include).
    async getTaskCalendarDetail(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const taskId = String(req.params.taskId || "");
            const task = await this.maintenanceRepo.getTaskCalendarDetailById(taskId);
            if (!task || !(await isTenantInServiceTenantScope((task as any).contract?.tenantId, tenantId))) {
                res.status(404).json({ error: "Gorev bulunamadi." });
                return;
            }
            res.status(200).json(task);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Technician-facing lazy detail for the calendar popup: scoped to approved
    // tasks the technician is assigned to (mirrors getMyTask).
    async getMyTaskCalendarDetail(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const taskId = String(req.params.taskId || "");
            const task = await this.maintenanceRepo.getTaskCalendarDetailById(taskId);
            if (!task || !(await isTenantInServiceTenantScope((task as any).contract?.tenantId, tenantId))) {
                res.status(404).json({ error: "Gorev bulunamadi." });
                return;
            }
            if (!(task as any).managerApprovedAt) {
                res.status(403).json({ error: "Bu bakım görevi henüz yönetici tarafından onaylanmadı." });
                return;
            }
            const technicianIds = this.taskTechnicianIds(task as any);
            if (technicianIds.length && !technicianIds.includes(employeeId)) {
                res.status(403).json({ error: "Bu bakim gorevi size atanmamis." });
                return;
            }
            res.status(200).json(task);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateTask(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const taskId = String(req.params.taskId || "");
            if (!taskId) {
                res.status(400).json({ error: "Gorev ID zorunludur." });
                return;
            }
            const current = await this.maintenanceRepo.getTaskById(taskId);
            if (!current) {
                res.status(404).json({ error: "Gorev bulunamadi." });
                return;
            }
            if (!(await isTenantInServiceTenantScope((current as any).contract?.tenantId, tenantId))) {
                res.status(403).json({ error: "Bu gorev icin yetkiniz yok." });
                return;
            }

            const nextPlannedDate = req.body.plannedDate ? new Date(req.body.plannedDate) : new Date((current as any).plannedDate);
            if (Number.isNaN(nextPlannedDate.getTime())) {
                res.status(400).json({ error: "Planlanan tarih gecersiz." });
                return;
            }

            const contractTasks = ((current as any).contract?.tasks || []) as any[];
            const contractId = (current as any).contractId;
            const plannedDayAllowed = contractTasks.length
                ? contractTasks.some((task) => task.id === taskId || task.contractId === contractId)
                : true;
            const tenantIds = await getServiceTenantScope(tenantId);
            const planDayTasks = await this.maintenanceRepo.getTasksByDateRange(tenantIds, startOfDay(nextPlannedDate), endOfDay(nextPlannedDate));
            const dayBelongsToContract = planDayTasks.some((task: any) => task.contractId === contractId);
            if (!plannedDayAllowed || !dayBelongsToContract) {
                res.status(400).json({ error: "Randevu tarihi yalnizca sozlesme planindaki gunlere verilebilir." });
                return;
            }

            const technicianIds = req.body.technicianIds !== undefined
                ? await this.validateTechniciansInScope(normalizeIdList(req.body.technicianIds), tenantId)
                : (req.body.assignedTechId !== undefined || req.body.alternativeTechId !== undefined)
                    ? await this.validateTechniciansInScope([
                        req.body.assignedTechId || "",
                        req.body.alternativeTechId || "",
                    ].map(String).filter(Boolean), tenantId)
                    : this.taskTechnicianIds(current as any);
            const assignedTechId = technicianIds[0] || null;
            const normalizedAlternativeTechId = technicianIds[1] && technicianIds[1] !== assignedTechId ? technicianIds[1] : null;

            const startTime = req.body.startTime ? new Date(req.body.startTime) : (req.body.scheduledStartTime ? new Date(req.body.scheduledStartTime) : null);
            const endTime = req.body.endTime ? new Date(req.body.endTime) : (req.body.scheduledEndTime ? new Date(req.body.scheduledEndTime) : null);
            const scheduledStartTime = startTime || ((current as any).scheduledStartTime ? new Date((current as any).scheduledStartTime) : null);
            const scheduledEndTime = endTime || ((current as any).scheduledEndTime ? new Date((current as any).scheduledEndTime) : null);

            if (scheduledStartTime && Number.isNaN(scheduledStartTime.getTime())) throw new Error("Baslangic saati gecersiz.");
            if (scheduledEndTime && Number.isNaN(scheduledEndTime.getTime())) throw new Error("Bitis saati gecersiz.");
            if (scheduledStartTime && scheduledEndTime && scheduledEndTime <= scheduledStartTime) throw new Error("Bitis saati baslangictan sonra olmalidir.");
            if (scheduledStartTime && !sameDay(scheduledStartTime, nextPlannedDate)) {
                throw new Error("Randevu saati planlanan bakim gununde olmalidir.");
            }

            if (scheduledStartTime && scheduledEndTime && technicianIds.length) {
                const conflict = await this.maintenanceRepo.findAssignmentConflict(technicianIds, scheduledStartTime, scheduledEndTime, taskId);
                if (conflict) {
                    res.status(409).json({ error: "Secilen teknisyenlerden biri bu saat araliginda baska goreve atanmis.", conflict });
                    return;
                }
                const optionConflict = await this.maintenanceRepo.findAppointmentOptionConflict(technicianIds, scheduledStartTime, scheduledEndTime, taskId);
                if (optionConflict) {
                    res.status(409).json({ error: "Secilen saat baska bir musterinin bekleyen bakim randevu secenegiyle cakisir.", conflict: optionConflict });
                    return;
                }
            }

            const assignmentHistory = Array.isArray((current as any).assignmentHistoryJson)
                ? [...(current as any).assignmentHistoryJson]
                : [];

            if (
                req.body.technicianIds !== undefined ||
                req.body.assignedTechId !== undefined ||
                req.body.alternativeTechId !== undefined ||
                req.body.plannedDate !== undefined ||
                req.body.startTime !== undefined ||
                req.body.endTime !== undefined
            ) {
                assignmentHistory.push({
                    assignedTechId,
                    alternativeTechId: normalizedAlternativeTechId,
                    technicianIds,
                    plannedDate: nextPlannedDate.toISOString(),
                    scheduledStartTime: scheduledStartTime?.toISOString() || null,
                    scheduledEndTime: scheduledEndTime?.toISOString() || null,
                    at: new Date().toISOString(),
                    action: "TASK_UPDATED",
                    byEmployeeId: (req as any).user!.id,
                });
            }

            const patch: any = {
                plannedDate: nextPlannedDate,
                assignedTechId,
                alternativeTechId: normalizedAlternativeTechId,
                scheduledStartTime,
                scheduledEndTime,
                assignmentHistoryJson: assignmentHistory,
            };

            if (req.body.siteName !== undefined) patch.siteName = req.body.siteName || null;
            if (req.body.status !== undefined) patch.status = req.body.status;

            const updated = await this.maintenanceRepo.updateTask(taskId, patch);
            if (req.body.technicianIds !== undefined || req.body.assignedTechId !== undefined || req.body.alternativeTechId !== undefined) {
                await this.maintenanceRepo.replaceTaskAssignments(taskId, technicianIds, (req as any).user!.id);
            }
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async saveAppointmentOptionsDraft(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const taskId = String(req.params.taskId || "");
            const task = await this.maintenanceRepo.getTaskById(taskId);
            if (!task || !(await isTenantInServiceTenantScope((task as any).contract?.tenantId, tenantId))) {
                res.status(404).json({ error: "Gorev bulunamadi." });
                return;
            }
            const rawOptions: any[] = Array.isArray(req.body.options) ? req.body.options : [];
            if (!rawOptions.length) {
                res.status(400).json({ error: "En az bir randevu onerisi ekleyin." });
                return;
            }

            const technicianIds = this.taskTechnicianIds(task as any);
            if (!technicianIds.length) {
                res.status(400).json({ error: "Randevu onerisi kaydetmeden once en az bir teknisyen atayin." });
                return;
            }
            const options: Array<{ startTime: Date; endTime: Date }> = rawOptions.map((option: any) => ({
                startTime: new Date(option.startTime),
                endTime: new Date(option.endTime),
            }));

            for (let index = 0; index < options.length; index += 1) {
                const option = options[index]!;
                if (Number.isNaN(option.startTime.getTime()) || Number.isNaN(option.endTime.getTime()) || option.endTime <= option.startTime) {
                    throw new Error("Randevu onerisi saatleri gecersiz.");
                }
                if (options.some((other, otherIndex) => otherIndex !== index && this.optionsOverlap(option, other))) {
                    throw new Error("Randevu onerileri birbiriyle cakismamalidir.");
                }
                const conflict = await this.maintenanceRepo.findAssignmentConflict(technicianIds, option.startTime, option.endTime, taskId);
                if (conflict) {
                    res.status(409).json({ error: "Secilen teknisyenlerden biri onerilen saatlerden birinde musait degil.", conflictType: "TECHNICIAN_BUSY", conflict });
                    return;
                }
                const optionConflict = await this.maintenanceRepo.findAppointmentOptionConflict(technicianIds, option.startTime, option.endTime, taskId);
                if (optionConflict) {
                    res.status(409).json({ error: "Bu saat araligi baska bir musterinin bekleyen bakim randevu secenegiyle cakisir.", conflictType: "APPOINTMENT_OPTION_BUSY", conflict: optionConflict });
                    return;
                }
            }

            let bookingToken = (task as any).bookingToken;
            if (!bookingToken) {
                bookingToken = nanoid(32);
                await this.maintenanceRepo.updateTask(taskId, { bookingToken } as any);
            }

            const createdOptions = await this.maintenanceRepo.createAppointmentOptions(taskId, options.map((option) => ({
                id: nanoid(12),
                taskId,
                token: nanoid(32),
                startTime: option.startTime,
                endTime: option.endTime,
                sentAt: new Date(),
            })));
            await this.maintenanceRepo.updateTask(taskId, { managerApprovedAt: null, managerApprovedById: null } as any);

            res.status(200).json({
                message: "Randevu onerileri kaydedildi.",
                options: createdOptions,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async sendAppointmentOptions(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const taskId = String(req.params.taskId || "");
            const task = await this.maintenanceRepo.getTaskById(taskId);
            if (!task || !(await isTenantInServiceTenantScope((task as any).contract?.tenantId, tenantId))) {
                res.status(404).json({ error: "Gorev bulunamadi." });
                return;
            }
            const rawOptions: any[] = Array.isArray(req.body.options) ? req.body.options : [];
            if (!rawOptions.length) {
                res.status(400).json({ error: "En az bir randevu onerisi ekleyin." });
                return;
            }

            const technicianIds = this.taskTechnicianIds(task as any);
            if (!technicianIds.length) {
                res.status(400).json({ error: "Randevu onerisi gondermeden once en az bir teknisyen atayin." });
                return;
            }
            const options: Array<{ startTime: Date; endTime: Date }> = rawOptions.map((option: any) => ({
                startTime: new Date(option.startTime),
                endTime: new Date(option.endTime),
            }));

            for (let index = 0; index < options.length; index += 1) {
                const option = options[index]!;
                if (Number.isNaN(option.startTime.getTime()) || Number.isNaN(option.endTime.getTime()) || option.endTime <= option.startTime) {
                    throw new Error("Randevu onerisi saatleri gecersiz.");
                }
                if (options.some((other, otherIndex) => otherIndex !== index && this.optionsOverlap(option, other))) {
                    throw new Error("Randevu onerileri birbiriyle cakismamalidir.");
                }
                const conflict = await this.maintenanceRepo.findAssignmentConflict(technicianIds, option.startTime, option.endTime, taskId);
                if (conflict) {
                    res.status(409).json({ error: "Secilen teknisyenlerden biri onerilen saatlerden birinde musait degil.", conflictType: "TECHNICIAN_BUSY", conflict });
                    return;
                }
                const optionConflict = await this.maintenanceRepo.findAppointmentOptionConflict(technicianIds, option.startTime, option.endTime, taskId);
                if (optionConflict) {
                    res.status(409).json({ error: "Bu saat araligi baska bir musterinin bekleyen bakim randevu secenegiyle cakisir.", conflictType: "APPOINTMENT_OPTION_BUSY", conflict: optionConflict });
                    return;
                }
            }

            let bookingToken = (task as any).bookingToken;
            if (!bookingToken) {
                bookingToken = nanoid(32);
                await this.maintenanceRepo.updateTask(taskId, { bookingToken } as any);
            }

            const createdOptions = await this.maintenanceRepo.createAppointmentOptions(taskId, options.map((option) => ({
                id: nanoid(12),
                taskId,
                token: nanoid(32),
                startTime: option.startTime,
                endTime: option.endTime,
                sentAt: new Date(),
            })));
            await this.maintenanceRepo.updateTask(taskId, { managerApprovedAt: null, managerApprovedById: null } as any);

            const settings = await prisma.mailSetting.findUnique({ where: { tenantId: (task as any).contract.tenantId } });
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || "http://localhost:5173";
            const bookingLink = `${frontendUrl}/maintenance-booking/${bookingToken}`;
            const customerEmail = (task as any).contract?.customer?.mainEmail || "";
            const to = String(req.body.to || customerEmail || "").trim();
            const fromEmail = String(req.body.fromEmail || settings?.fromEmail || (req as any).user!.email || "").trim();
            const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
            const subject = String(req.body.subject || `${(task as any).contract?.contractCode || ""} Bakim randevusu`).trim();
            const message = String(req.body.message || "Lutfen size uygun bakim randevusunu secin.").trim();

            if (!to) return res.status(400).json({ error: "Alici e-posta adresi zorunludur." });
            if (!fromEmail) return res.status(400).json({ error: "Gonderici e-posta adresi zorunludur." });

            const optionList = createdOptions.map((option: any) =>
                `<li>${option.startTime.toLocaleString("tr-TR")} - ${option.endTime.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}</li>`
            ).join("");
            const html = `
                <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
                    <p>${message}</p>
                    <ul>${optionList}</ul>
                    <p><a href="${bookingLink}" style="display:inline-block;background:#1d4ed8;color:white;padding:10px 14px;border-radius:6px;text-decoration:none">Randevu sec</a></p>
                    <p style="font-size:12px;color:#64748b">${bookingLink}</p>
                </div>
            `;
            const result = await smtp.send(settings || {}, {
                fromEmail,
                fromName,
                to,
                subject,
                text: `${message}\n\n${bookingLink}`,
                html,
                replyTo: req.body.replyTo || settings?.replyTo || null,
            });

            await this.notify({
                tenantId: (task as any).contract.tenantId,
                type: "MAINTENANCE_APPOINTMENT_SENT",
                title: "Randevu önerisi gönderildi",
                message: `${(task as any).contract?.customer?.companyName || "Müşteri"} için ${createdOptions.length} öneri gönderildi.`,
                linkUrl: "/maintenance/tasks",
                metadata: { taskId },
            });

            res.status(200).json({
                message: result.preview ? "SMTP ayari olmadigi icin randevu maili onizleme olarak hazirlandi." : "Randevu onerileri gonderildi.",
                bookingLink,
                options: createdOptions,
                ...result,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getPublicAppointmentOptions(req: Request, res: Response) {
        try {
            const token = String(req.params.token || "");
            const task = await this.maintenanceRepo.getTaskByBookingToken(token);
            if (!task) {
                res.status(404).json({ error: "Randevu linki bulunamadi." });
                return;
            }
            const options = await this.maintenanceRepo.listAppointmentOptionsByToken(token);
            const annotatedOptions = await Promise.all(options.map(async (option: any) => {
                const unavailableReason = await this.getAppointmentUnavailableReason(task as any, {
                    id: option.id,
                    startTime: new Date(option.startTime),
                    endTime: new Date(option.endTime),
                });
                return {
                    ...option,
                    isAvailable: !unavailableReason,
                    unavailableReason,
                };
            }));
            const availableOptions = annotatedOptions.filter((option: any) => option.isAvailable);
            res.status(200).json({
                contractCode: (task as any).contract?.contractCode,
                title: (task as any).contract?.title,
                customerName: (task as any).contract?.customer?.companyName,
                plannedDate: (task as any).plannedDate,
                options: availableOptions,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async confirmPublicAppointment(req: Request, res: Response) {
        try {
            const token = String(req.params.token || "");
            const optionId = String(req.body.optionId || "");
            if (!token || !optionId) {
                res.status(400).json({ error: "Token ve randevu secimi zorunludur." });
                return;
            }
            const task = await this.maintenanceRepo.getTaskByBookingToken(token);
            if (!task) {
                res.status(404).json({ error: "Randevu linki bulunamadi." });
                return;
            }
            const options = await this.maintenanceRepo.listAppointmentOptionsByToken(token);
            const selected = options.find((option: any) => option.id === optionId);
            if (!selected) {
                res.status(409).json({ error: "Secilen randevu artik uygun degil." });
                return;
            }
            const unavailableReason = await this.getAppointmentUnavailableReason(task as any, {
                id: (selected as any).id,
                startTime: new Date((selected as any).startTime),
                endTime: new Date((selected as any).endTime),
            });
            if (unavailableReason) {
                res.status(409).json({ error: unavailableReason });
                return;
            }
            const updated = await this.maintenanceRepo.confirmAppointmentOption(token, optionId);
            const technicianIds = this.taskTechnicianIds(updated as any);
            await this.notify({
                tenantId: (updated as any).contract?.tenantId,
                type: "MAINTENANCE_APPOINTMENT_APPROVED",
                title: "Bakım randevusu onaylandı",
                message: `${(updated as any).contract?.customer?.companyName || "Müşteri"} randevu önerisini seçti ve randevu otomatik onaylandı.`,
                linkUrl: `/maintenance/tasks/${updated.id}?tab=appointment`,
                metadata: { taskId: updated.id, optionId },
            });
            await this.notifyMany((updated as any).contract?.tenantId, technicianIds, {
                type: "MAINTENANCE_APPOINTMENT_APPROVED",
                title: "Bakım randevunuz onaylandı",
                message: `${(updated as any).contract?.contractCode || ""} randevusu müşteri tarafından onaylandı.`,
                linkUrl: "/maintenance/technician",
                metadata: { taskId: updated.id, optionId },
            });
            res.status(200).json({ message: "Randevunuz onaylandi.", task: updated });
        } catch (error: any) {
            res.status(409).json({ error: error.message });
        }
    }

    async disapprovePublicAppointment(req: Request, res: Response) {
        try {
            const token = String(req.params.token || "");
            if (!token) {
                res.status(400).json({ error: "Randevu linki zorunludur." });
                return;
            }
            const task = await this.maintenanceRepo.getTaskByBookingToken(token);
            if (!task) {
                res.status(404).json({ error: "Randevu linki bulunamadi." });
                return;
            }
            const reason = String(req.body.reason || "").trim().slice(0, 500);
            const updated = await this.maintenanceRepo.disapproveAppointmentOptions(token);
            const customerName = (updated as any).contract?.customer?.companyName || "Müşteri";
            await this.notify({
                tenantId: (updated as any).contract?.tenantId,
                type: "MAINTENANCE_APPOINTMENT_DISAPPROVED",
                title: "Müşteri randevu önerilerini reddetti",
                message: reason
                    ? `${customerName} önerilen bakım randevularını uygun bulmadı: "${reason}". Lütfen yeni randevu önerileri oluşturun.`
                    : `${customerName} önerilen bakım randevularını uygun bulmadı. Lütfen yeni randevu önerileri oluşturun.`,
                linkUrl: `/maintenance/tasks/${updated.id}?tab=appointment`,
                metadata: { taskId: updated.id, reason: reason || null },
            });
            res.status(200).json({
                message: "Geri bildiriminiz alindi. Bakim ekibi yeni randevu onerileri hazirlayacak.",
                task: updated,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async approveAppointmentOption(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const managerId = (req as any).user!.id;
            const taskId = String(req.params.taskId || "");
            const optionId = String(req.params.optionId || req.body.optionId || "");
            if (!taskId || !optionId) {
                res.status(400).json({ error: "Gorev ve randevu secimi zorunludur." });
                return;
            }

            const task = await this.maintenanceRepo.getTaskById(taskId);
            if (!task || !(await isTenantInServiceTenantScope((task as any).contract?.tenantId, tenantId))) {
                res.status(404).json({ error: "Gorev bulunamadi." });
                return;
            }
            const selected = ((task as any).appointmentOptions || []).find((option: any) => option.id === optionId);
            if (!selected) {
                res.status(404).json({ error: "Randevu opsiyonu bulunamadi." });
                return;
            }
            const unavailableReason = await this.getAppointmentUnavailableReason(task as any, {
                id: selected.id,
                startTime: new Date(selected.startTime),
                endTime: new Date(selected.endTime),
            });
            if (unavailableReason) {
                res.status(409).json({ error: unavailableReason, conflictType: "APPOINTMENT_APPROVAL_CONFLICT" });
                return;
            }

            const updated = await this.maintenanceRepo.approveAppointmentOptionForTask(taskId, optionId, managerId);
            const technicianIds = this.taskTechnicianIds(updated as any);
            await this.notifyMany((updated as any).contract?.tenantId, technicianIds, {
                type: "MAINTENANCE_APPOINTMENT_MANAGER_APPROVED",
                title: "Bakım randevunuz onaylandı",
                message: `${(updated as any).contract?.contractCode || ""} randevusu yönetici tarafından onaylandı.`,
                linkUrl: "/maintenance/technician",
                metadata: { taskId: updated.id, optionId },
            });
            res.status(200).json({ message: "Randevu yonetici tarafindan onaylandi.", task: updated });
        } catch (error: any) {
            res.status(409).json({ error: error.message });
        }
    }

    async listReports(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const tenantIds = await getServiceTenantScope(tenantId);
            const reports = await this.maintenanceRepo.listReports(tenantIds);
            res.status(200).json(reports);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async submitReport(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const techId = (req as any).user!.id;
            const task = await this.maintenanceRepo.getTaskById(req.body.taskId);
            if (!task || !(await isTenantInServiceTenantScope((task as any).contract?.tenantId, tenantId))) {
                res.status(403).json({ error: "Bu gorev icin yetkiniz yok." });
                return;
            }
            if (!(task as any).managerApprovedAt) {
                res.status(403).json({ error: "Bu bakım görevi henüz yönetici tarafından onaylanmadı." });
                return;
            }

            const report = await this.reportUseCase.submitReport({ ...req.body, tenantId: (task as any).contract.tenantId, techId });
            res.status(201).json({ message: "Bakim raporu kaydedildi. Imza bekleniyor.", report });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateReport(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const reportId = String(req.params.reportId || "");
            if (!reportId) {
                res.status(400).json({ error: "Rapor ID zorunludur." });
                return;
            }
            const report = await this.maintenanceRepo.getReportById(reportId);
            if (!report || !(await isTenantInServiceTenantScope((report as any).task?.contract?.tenantId, tenantId))) {
                res.status(404).json({ error: "Rapor bulunamadi." });
                return;
            }

            const updated = await this.reportUseCase.updateReport({
                reportId,
                operationsDone: req.body.operationsDone,
                observations: req.body.observations,
                recommendations: req.body.recommendations,
                riskNotes: req.body.riskNotes,
                checklistJson: req.body.checklistJson,
            });
            res.status(200).json({ message: "Bakim raporu guncellendi.", report: updated });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async requestReportSignature(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const reportId = String(req.params.reportId || "");
            const channel = String(req.body.channel || "technician");
            const report = await this.maintenanceRepo.getReportById(reportId);
            if (!report || !(await isTenantInServiceTenantScope((report as any).task?.contract?.tenantId, tenantId))) {
                res.status(404).json({ error: "Rapor bulunamadi." });
                return;
            }
            const reportTenantId = (report as any).task?.contract?.tenantId;
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || "http://localhost:5173";
            const reportLink = `${frontendUrl}/maintenance/tasks/${(report as any).taskId}?tab=signature`;
            const sent: string[] = [];

            if ((channel === "technician" || channel === "both") && (report as any).techId) {
                await this.notify({
                    tenantId: reportTenantId,
                    recipientEmployeeId: (report as any).techId,
                    type: "MAINTENANCE_REPORT_SIGNATURE_REQUEST",
                    title: "Müşteri imzası isteniyor",
                    message: `${(report as any).task?.contract?.customer?.companyName || "Müşteri"} bakım raporu için imza alınması gerekiyor.`,
                    linkUrl: "/maintenance/technician/tasks",
                    metadata: { taskId: (report as any).taskId, reportId },
                });
                sent.push("technician");
            }

            if (channel === "mail" || channel === "both") {
                const settings = await prisma.mailSetting.findUnique({ where: { tenantId: reportTenantId } });
                const to = String(req.body.to || (report as any).task?.contract?.customer?.mainEmail || "").trim();
                const fromEmail = String(req.body.fromEmail || settings?.fromEmail || (req as any).user!.email || "").trim();
                const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
                const subject = String(req.body.subject || `${(report as any).task?.contract?.contractCode || "Bakim"} - bakim raporu imzasi`).trim();
                const message = String(req.body.message || "Bakim raporunuz imza icin hazir. Lutfen Offitec ekibiyle birlikte raporu kontrol edip imzalayin.").trim();
                if (!to) { res.status(400).json({ error: "Musteri e-posta adresi bulunamadi." }); return; }
                if (!fromEmail) { res.status(400).json({ error: "Gonderici e-posta adresi zorunludur." }); return; }
                await smtp.send(settings || {}, {
                    fromEmail,
                    fromName,
                    to,
                    subject,
                    text: `${message}\n\n${reportLink}`,
                    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6"><p>${message}</p><p><a href="${reportLink}" style="display:inline-block;background:#1d4ed8;color:white;padding:10px 14px;border-radius:6px;text-decoration:none">Raporu goruntule</a></p><p style="font-size:12px;color:#64748b">${reportLink}</p></div>`,
                    replyTo: req.body.replyTo || settings?.replyTo || null,
                });
                sent.push("mail");
            }

            res.status(200).json({ message: "Imza istegi gonderildi.", sent });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async sendReportToManager(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const reportId = String(req.params.reportId || "");
            const report = await this.maintenanceRepo.getReportById(reportId);
            if (!report || !(await isTenantInServiceTenantScope((report as any).task?.contract?.tenantId, tenantId))) {
                res.status(404).json({ error: "Rapor bulunamadi." });
                return;
            }
            const reportTenantId = (report as any).task?.contract?.tenantId;
            const signatureBase64 = typeof req.body.signatureBase64 === "string" ? req.body.signatureBase64 : "";

            let finalReport: any = report;
            if (signatureBase64) {
                finalReport = await this.reportUseCase.signReport(reportId, signatureBase64);
            }

            const customerName = (report as any).task?.contract?.customer?.companyName || "Müşteri";
            await this.notify({
                tenantId: reportTenantId,
                type: signatureBase64 ? "MAINTENANCE_REPORT_SIGNED" : "MAINTENANCE_REPORT_UNSIGNED",
                title: signatureBase64 ? "Bakım raporu imzalı geldi" : "Bakım raporu imzasız geldi",
                message: signatureBase64
                    ? `${customerName} bakım raporu teknisyen tarafından imzalı olarak gönderildi.`
                    : `${customerName} bakım raporu teknisyen tarafından imzasız gönderildi.`,
                linkUrl: `/maintenance/tasks/${(report as any).taskId}?tab=signature`,
                metadata: { taskId: (report as any).taskId, reportId },
            });

            res.status(200).json({
                message: signatureBase64 ? "Rapor imzalandi ve yoneticiye gonderildi." : "Rapor imzasiz olarak yoneticiye gonderildi.",
                report: finalReport,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async signReport(req: Request, res: Response) {
        try {
            const reportId = String(req.params.reportId || "");
            const { signatureBase64 } = req.body as { signatureBase64?: string };

            if (typeof reportId !== "string" || !reportId) {
                res.status(400).json({ error: "Rapor ID zorunludur." });
                return;
            }

            if (typeof signatureBase64 !== "string" || !signatureBase64) {
                res.status(400).json({ error: "Imza zorunludur." });
                return;
            }

            const signedReport = await this.reportUseCase.signReport(reportId, signatureBase64);
            res.status(200).json({ message: "Rapor imzalandi ve kilitlendi.", report: signedReport });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
