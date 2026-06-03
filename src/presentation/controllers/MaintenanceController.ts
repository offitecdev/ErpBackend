import { Request, Response } from 'express';
import { CreateMaintenanceContractUseCase } from '../../application/use-cases/maintenance/CreateMaintenanceContract';
import { MaintenanceReportUseCase } from '../../application/use-cases/maintenance/MaintenanceReportUseCase';
import { IMaintenanceRepository } from '../../domain/repositories/IMaintenanceRepository';
import prisma from '../../infrastructure/database/prisma.client';
import { getCustomerInServiceTenantScope, getServiceTenantScope, isTenantInServiceTenantScope } from './serviceTenantScope';

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

            const result = await this.createContractUseCase.execute({ ...req.body, tenantId: customer.tenantId });
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

    async listTasks(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const fallback = defaultRange();
            const start = req.query.start ? new Date(req.query.start as string) : fallback.start;
            const end = req.query.end ? new Date(req.query.end as string) : fallback.end;
            const tenantIds = await getServiceTenantScope(tenantId);

            if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
                res.status(400).json({ error: "Tarih araligi gecersiz." });
                return;
            }

            const tasks = await this.maintenanceRepo.getTasksByDateRange(tenantIds, start, end);
            res.status(200).json(tasks);
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

            const assignedTechId = req.body.assignedTechId === undefined
                ? (current as any).assignedTechId
                : (req.body.assignedTechId || null);
            const alternativeTechId = req.body.alternativeTechId === undefined
                ? (current as any).alternativeTechId || null
                : (req.body.alternativeTechId || null);
            const normalizedAlternativeTechId = alternativeTechId && alternativeTechId !== assignedTechId
                ? alternativeTechId
                : null;

            if (assignedTechId) {
                const tenantIds = await getServiceTenantScope(tenantId);
                const sameDayTasks = await this.maintenanceRepo.getTasksByDateRange(tenantIds, startOfDay(nextPlannedDate), endOfDay(nextPlannedDate));
                const conflict = sameDayTasks.find((task: any) =>
                    task.id !== taskId &&
                    task.assignedTechId === assignedTechId &&
                    task.status !== "CANCELLED"
                );

                if (conflict) {
                    res.status(409).json({ error: "Teknisyen icin ayni gunde aktif bir bakim gorevi bulunuyor.", conflict });
                    return;
                }
            }

            const assignmentHistory = Array.isArray((current as any).assignmentHistoryJson)
                ? [...(current as any).assignmentHistoryJson]
                : [];

            if (
                req.body.assignedTechId !== undefined ||
                req.body.alternativeTechId !== undefined ||
                req.body.plannedDate !== undefined
            ) {
                assignmentHistory.push({
                    assignedTechId,
                    alternativeTechId: normalizedAlternativeTechId,
                    plannedDate: nextPlannedDate.toISOString(),
                    at: new Date().toISOString(),
                    action: "TASK_UPDATED",
                    byEmployeeId: (req as any).user!.id,
                });
            }

            const patch: any = {
                plannedDate: nextPlannedDate,
                assignedTechId,
                assignmentHistoryJson: assignmentHistory,
            };

            if (req.body.alternativeTechId !== undefined) patch.alternativeTechId = normalizedAlternativeTechId;
            if (req.body.siteName !== undefined) patch.siteName = req.body.siteName || null;
            if (req.body.status !== undefined) patch.status = req.body.status;

            const updated = await this.maintenanceRepo.updateTask(taskId, patch);
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
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

            const report = await this.reportUseCase.submitReport({ ...req.body, tenantId: (task as any).contract.tenantId, techId });
            res.status(201).json({ message: "Bakim raporu kaydedildi. Imza bekleniyor.", report });
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
