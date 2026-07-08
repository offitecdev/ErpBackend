import { Request, Response } from 'express';
import { CreateProjectFromTenderUseCase } from '../../application/use-cases/project/CreateProjectFromTenderUseCase';
import { AddProjectReportUseCase, ReportInput } from '../../application/use-cases/project/AddProjectReportUseCase';
import { RequestExtraMaterialUseCase } from '../../application/use-cases/project/RequestExtraMaterialUseCase';
import { ApproveVariationUseCase } from '../../application/use-cases/project/ApproveVariationUseCase';
import { AddProjectExpenseUseCase } from '../../application/use-cases/project/AddProjectExpenseUseCase';
import { ProjectRepository } from '../../infrastructure/repositories/ProjectRepository';
import { ProjectReportRepository } from '../../infrastructure/repositories/ProjectReportRepository';
import { MaterialRepository } from '../../infrastructure/repositories/MaterialRepository';
import prisma from '../../infrastructure/database/prisma.client';
import { SmtpMailService } from '../../infrastructure/services/SmtpMailService';
import { getServiceTenantScope } from './serviceTenantScope';
import { findTechnicianScheduleConflict, validateTechnicians, listTechnicianOptions } from './technicianSchedule';
import { nanoid } from 'nanoid';

const smtp = new SmtpMailService();

type NotificationPayload = {
    type: string;
    title: string;
    message: string;
    linkUrl?: string | null;
    metadata?: unknown;
};

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

const normalizeIdList = (value: unknown) =>
    Array.isArray(value)
        ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
        : [];

const PROJECT_EXPENSE_TYPES = ["Nakliye", "Ekipman Kiralama", "Dış hizmetler", "Taşeron", "Diğer"];

export class ProjectController {
    constructor(
        private createProjectUseCase: CreateProjectFromTenderUseCase,
        private addReportUseCase: AddProjectReportUseCase,
        private requestVariationUseCase: RequestExtraMaterialUseCase,
        private approveVariationUseCase: ApproveVariationUseCase,
        private addExpenseUseCase: AddProjectExpenseUseCase,
        private projectRepository: ProjectRepository,
        private reportRepository: ProjectReportRepository,
        private materialRepository: MaterialRepository
    ) {}

    private async resolveProjectSalesOrderId(projectId: string, tenantId: string, rawSalesOrderId?: any): Promise<string | null> {
        const salesOrderId = String(rawSalesOrderId || '').trim();
        if (!salesOrderId) return null;

        const salesOrder = await (prisma as any).salesOrder.findFirst({
            where: { id: salesOrderId, projectId, tenantId },
            select: { id: true },
        });
        if (!salesOrder) throw new Error("Sipariş bu projeye ait değil.");
        return salesOrder.id;
    }

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

    private async validateProjectTechnician(technicianId: string | null | undefined, tenantId: string) {
        const id = String(technicianId || "").trim();
        if (!id) return null;
        const tenantIds = await getServiceTenantScope(tenantId);
        const employee = await (prisma as any).employee.findFirst({
            where: {
                id,
                tenantId: { in: tenantIds },
                isActive: true,
                OR: [
                    { roleName: "Teknisyen" },
                    { employeeRoles: { some: { role: { roleName: "Teknisyen" } } } },
                ],
            },
            select: {
                id: true,
                tenantId: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                roleName: true,
                title: true,
                employeeRoles: {
                    select: { role: { select: { roleName: true } } },
                },
            },
        });
        if (!employee) throw new Error("Seçilen teknisyen bulunamadı.");
        return employee;
    }

    private async validateProjectTechnicians(technicianIds: string[], tenantId: string) {
        return validateTechnicians(technicianIds, tenantId);
    }

    private async projectManagerRecipients(project: any) {
        const ids = [project.managerId].filter(Boolean) as string[];
        if (ids.length) return ids;
        const managers = await (prisma as any).employee.findMany({
            where: {
                tenantId: project.tenantId,
                isActive: true,
                employeeRoles: {
                    some: {
                        role: {
                            permissions: {
                                some: { permission: { permissionName: "projects.manage" } },
                            },
                        },
                    },
                },
            },
            take: 20,
            select: { id: true },
        });
        return managers.map((employee: any) => employee.id);
    }

    private async notifyProjectManagers(project: any, payload: NotificationPayload) {
        const recipientIds = await this.projectManagerRecipients(project);
        if (recipientIds.length) {
            await this.notifyMany(project.tenantId, recipientIds, payload);
        } else {
            await this.notify({ tenantId: project.tenantId, ...payload });
        }
    }

    // The business date an addon order should carry: the original appointment date the
    // billed extra work belongs to. Extra-work rows (expenses/materials/reports) carry
    // an appointmentId, so we take the latest such appointment's startTime — even when
    // the entry itself was made days later. Falls back to the rows' own dates, then now.
    private async resolveAddonOrderDate(
        tenantId: string,
        slice: { expenses?: any[]; extraMaterials?: any[]; reports?: any[] },
    ): Promise<Date> {
        const appointmentIds = Array.from(new Set(
            [...(slice.expenses || []), ...(slice.extraMaterials || []), ...(slice.reports || [])]
                .map((row) => row?.appointmentId)
                .filter((id): id is string => Boolean(id)),
        ));
        if (appointmentIds.length) {
            const appointments: any[] = await (prisma as any).appointment.findMany({
                where: { id: { in: appointmentIds }, tenantId },
                select: { startTime: true },
            });
            const times = appointments
                .map((appointment) => new Date(appointment.startTime).getTime())
                .filter((time) => !Number.isNaN(time));
            if (times.length) return new Date(Math.max(...times));
        }
        // No appointment link (legacy rows): use the most recent row date in the slice.
        const rowTimes = [
            ...(slice.reports || []).map((row) => row?.workDate || row?.reportDate),
            ...(slice.expenses || []).map((row) => row?.expenseDate),
            ...(slice.extraMaterials || []).map((row) => row?.addedAt),
        ]
            .map((value) => (value ? new Date(value).getTime() : NaN))
            .filter((time) => !Number.isNaN(time));
        return rowTimes.length ? new Date(Math.max(...rowTimes)) : new Date();
    }

    private async createAddonOrderForParent(project: any, parentSalesOrderId: string, employeeId: string, orderDate?: Date | null) {
        const tenantId = project.tenantId;
        const parentOrder: any = await (prisma as any).salesOrder.findFirst({ where: { id: parentSalesOrderId, projectId: project.id, tenantId } });
        if (!parentOrder) return null;

        const addons: any[] = await (prisma as any).salesOrder.findMany({
            where: { parentSalesOrderId, projectId: project.id, tenantId },
            orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }],
        });
        const previousAddon = addons[0] || null;
        const nextRevision = Math.max(0, ...addons.map((order) => Number(order.revisionNumber || 0))) + 1;
        const createdAtFilter = previousAddon?.createdAt ? { gt: previousAddon.createdAt } : undefined;

        const [expenses, extraMaterials, reports] = await Promise.all([
            (prisma as any).projectExpense.findMany({
                where: {
                    projectId: project.id,
                    salesOrderId: parentSalesOrderId,
                    ...(createdAtFilter ? { expenseDate: createdAtFilter } : {}),
                },
            }),
            (prisma as any).projectExtraMaterial.findMany({
                where: {
                    projectId: project.id,
                    salesOrderId: parentSalesOrderId,
                    ...(createdAtFilter ? { addedAt: createdAtFilter } : {}),
                },
            }),
            (prisma as any).projectReport.findMany({
                where: {
                    projectId: project.id,
                    salesOrderId: parentSalesOrderId,
                    ...(createdAtFilter ? { reportDate: createdAtFilter } : {}),
                },
            }),
        ]);

        const expenseTotal = expenses.reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0);
        const materialTotal = extraMaterials.reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
        const overtimeTotal = reports.reduce((sum: number, item: any) => sum + Number(item.overtimeCost || 0), 0);
        const totalAmount = expenseTotal + materialTotal + overtimeTotal;
        if (totalAmount <= 0) return null;

        // Date the addon to the appointment the extra work belongs to (never the
        // possibly-later entry time). createdAt still bounds the next slice.
        const resolvedOrderDate = orderDate ?? await this.resolveAddonOrderDate(tenantId, { expenses, extraMaterials, reports });

        const orderNumber = `${parentOrder.orderNumber}-N${nextRevision}`;
        const addonOrder = await (prisma as any).salesOrder.create({
            data: {
                id: nanoid(10),
                tenantId,
                customerId: parentOrder.customerId || project.customerId,
                tenderId: null,
                projectId: project.id,
                parentSalesOrderId,
                revisionNumber: nextRevision,
                orderNumber,
                orderType: "PROJECT_ADDON",
                status: "ORDERED",
                totalAmount,
                orderDate: resolvedOrderDate,
                createdByEmployeeId: employeeId,
            },
            include: {
                customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
                tender: { select: { id: true, tenderNumber: true, status: true, projectId: true } },
                createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
            },
        });

        return {
            salesOrder: addonOrder,
            totals: { expenses: expenseTotal, extraMaterials: materialTotal, overtime: overtimeTotal, total: totalAmount },
        };
    }

    // Pending extra work accrued on `parentSalesOrderId` since its last addon —
    // the same slice createAddonOrderForParent would bill. Shared by the addon
    // request flow so the manager sees the totals a technician is flagging.
    private async computePendingAddonTotals(project: any, parentSalesOrderId: string) {
        const tenantId = project.tenantId;
        const addons: any[] = await (prisma as any).salesOrder.findMany({
            where: { parentSalesOrderId, projectId: project.id, tenantId },
            orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }],
        });
        const previousAddon = addons[0] || null;
        const createdAtFilter = previousAddon?.createdAt ? { gt: previousAddon.createdAt } : undefined;

        const [expenses, extraMaterials, reports] = await Promise.all([
            (prisma as any).projectExpense.findMany({
                where: { projectId: project.id, salesOrderId: parentSalesOrderId, ...(createdAtFilter ? { expenseDate: createdAtFilter } : {}) },
            }),
            (prisma as any).projectExtraMaterial.findMany({
                where: { projectId: project.id, salesOrderId: parentSalesOrderId, ...(createdAtFilter ? { addedAt: createdAtFilter } : {}) },
            }),
            (prisma as any).projectReport.findMany({
                where: { projectId: project.id, salesOrderId: parentSalesOrderId, ...(createdAtFilter ? { reportDate: createdAtFilter } : {}) },
            }),
        ]);

        const expenseTotal = expenses.reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0);
        const materialTotal = extraMaterials.reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
        const overtimeTotal = reports.reduce((sum: number, item: any) => sum + Number(item.overtimeCost || 0), 0);
        return { expenseTotal, materialTotal, overtimeTotal, total: expenseTotal + materialTotal + overtimeTotal };
    }

    // Records (or refreshes) a PENDING addon-order request for the parent order and
    // notifies the project managers. Returns null when there is nothing to bill.
    private async createAddonRequestForParent(project: any, parentSalesOrderId: string, requesterId: string, appointmentId?: string | null, note?: string | null) {
        const totals = await this.computePendingAddonTotals(project, parentSalesOrderId);
        if (totals.total <= 0) return null;

        const requester: any = await (prisma as any).employee.findUnique({ where: { id: requesterId }, select: { firstName: true, lastName: true } });
        const requestedByName = [requester?.firstName, requester?.lastName].filter(Boolean).join(" ").trim() || null;
        const existing: any = await (prisma as any).projectAddonRequest.findFirst({
            where: { projectId: project.id, tenantId: project.tenantId, salesOrderId: parentSalesOrderId, status: "PENDING" },
        });

        const data = {
            salesOrderId: parentSalesOrderId,
            appointmentId: appointmentId || null,
            requestedById: requesterId,
            requestedByName,
            note: note ? String(note).trim() : null,
            expenseTotal: totals.expenseTotal,
            materialTotal: totals.materialTotal,
            overtimeTotal: totals.overtimeTotal,
            total: totals.total,
        };

        // One open request per parent order: refresh the existing one instead of
        // stacking duplicates each time a technician finishes another montaj.
        const request = existing
            ? await (prisma as any).projectAddonRequest.update({ where: { id: existing.id }, data: { ...data, createdAt: new Date() } })
            : await (prisma as any).projectAddonRequest.create({ data: { id: nanoid(12), tenantId: project.tenantId, projectId: project.id, ...data } });

        await this.notifyProjectManagers(project, {
            type: "PROJECT_ADDON_ORDER_REQUESTED",
            title: "Ek sipariş talebi",
            message: `${requestedByName || "Teknisyen"}, ${project.projectName} projesi için ek sipariş talep etti.`,
            linkUrl: `/projects/${project.id}`,
            metadata: { projectId: project.id, salesOrderId: parentSalesOrderId, addonRequestId: request.id, total: totals.total },
        });

        return { request, totals };
    }

    async list(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const filter: any = { tenantId };
            if (req.query.status) filter.status = req.query.status;
            if (req.query.managerId) filter.managerId = req.query.managerId;
            if (req.query.search) filter.search = req.query.search;
            const projects = await this.projectRepository.findAll(filter);
            res.status(200).json(projects);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listTechnicians(req: Request, res: Response) {
        try {
            res.status(200).json(await listTechnicianOptions(req.user!.tenantId));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    private tenderMaterialInclude() {
        return {
            select: {
                id: true,
                tenderNumber: true,
                status: true,
                projectId: true,
                usedMaterials: {
                    orderBy: { createdAt: "desc" as const },
                    include: { material: true },
                },
                positions: {
                    select: {
                        id: true,
                        positionNumber: true,
                        shortDescription: true,
                        materialMappings: {
                            select: {
                                id: true,
                                materialId: true,
                                quantityMultiplier: true,
                                discount: true,
                                material: {
                                    select: {
                                        id: true,
                                        serialId: true,
                                        name: true,
                                        stockQuantity: true,
                                        unitCost: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        };
    }

    private projectInstallationInclude() {
        return {
            assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
            technicianAssignments: { orderBy: { assignedAt: "asc" as const }, include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } } },
            salesOrder: { select: { id: true, orderNumber: true, totalAmount: true, parentSalesOrderId: true, revisionNumber: true, tenderId: true, tender: this.tenderMaterialInclude() } },
            project: {
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true } },
                    manager: { select: { id: true, firstName: true, lastName: true, email: true } },
                    tender: this.tenderMaterialInclude(),
                    salesOrders: {
                        orderBy: { createdAt: "asc" as const },
                        select: { id: true, orderNumber: true, totalAmount: true, parentSalesOrderId: true, revisionNumber: true, createdAt: true, orderDate: true },
                    },
                    reports: {
                        orderBy: { reportDate: "desc" as const },
                        include: {
                            employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                            images: { orderBy: { createdAt: "asc" as const } },
                        },
                    },
                    expenses: { orderBy: { expenseDate: "desc" as const } },
                    extraMaterials: { orderBy: { addedAt: "desc" as const }, include: { material: true } },
                },
            },
        };
    }

    // Trimmed include for the calendar grid: only the fields the month/week/day
    // blocks render (title, technician names, order number, navigation ids). It
    // deliberately drops the tender material trees, project reports/images,
    // expenses and extra materials that projectInstallationInclude carries so the
    // range query stays cheap even with many appointments. The popup fetches the
    // richer detail on click via projectCalendarDetailInclude.
    private projectCalendarListInclude() {
        return {
            assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
            technicianAssignments: {
                orderBy: { assignedAt: "asc" as const },
                select: { technician: { select: { id: true, firstName: true, lastName: true } } },
            },
            salesOrder: { select: { id: true, orderNumber: true } },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    customer: { select: { id: true, companyName: true } },
                },
            },
        };
    }

    // Single-appointment include for the calendar detail popup: customer contacts,
    // participants with contact details, order/tender numbers and the manager —
    // everything the popup shows, and nothing more (still no material/report trees).
    private projectCalendarDetailInclude() {
        return {
            assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
            technicianAssignments: {
                orderBy: { assignedAt: "asc" as const },
                include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } },
            },
            salesOrder: { select: { id: true, orderNumber: true, totalAmount: true, tender: { select: { id: true, tenderNumber: true } } } },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true } },
                    manager: { select: { id: true, firstName: true, lastName: true, email: true } },
                    tender: { select: { id: true, tenderNumber: true } },
                },
            },
        };
    }

    async listMyInstallations(req: Request, res: Response) {
        try {
            const now = new Date();
            const rawStart = req.query.start ? new Date(String(req.query.start)) : new Date(now.getFullYear(), now.getMonth(), 1);
            const rawEnd = req.query.end ? new Date(String(req.query.end)) : new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
            if (Number.isNaN(rawStart.getTime()) || Number.isNaN(rawEnd.getTime())) {
                return res.status(400).json({ error: "Geçerli tarih aralığı girin." });
            }
            // Date-only params (e.g. "2026-06-17") parse to midnight; widen to cover
            // the full first/last day so single-day (day view) ranges are not empty.
            const start = startOfDay(rawStart);
            const end = endOfDay(rawEnd);

            const appointments = await (prisma as any).appointment.findMany({
                where: {
                    tenantId: req.user!.tenantId,
                    OR: [
                        { assignedTechId: req.user!.id },
                        { technicianAssignments: { some: { technicianId: req.user!.id } } },
                    ],
                    projectId: { not: null },
                    status: { in: ["BOOKED", "COMPLETED"] },
                    startTime: { gte: start },
                    endTime: { lte: end },
                },
                orderBy: { startTime: "asc" },
                // The calendar asks for the trimmed grid include; the installation
                // screens (which derive their detail from this list) keep the full one.
                include: String(req.query.view || "") === "calendar"
                    ? this.projectCalendarListInclude()
                    : this.projectInstallationInclude(),
            });
            res.status(200).json(appointments);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Manager-facing list of every order appointment in the tenant for the range
    // (technicians use listMyInstallations, which scopes to their own assignments).
    async listAppointments(req: Request, res: Response) {
        try {
            const now = new Date();
            const rawStart = req.query.start ? new Date(String(req.query.start)) : new Date(now.getFullYear(), now.getMonth(), 1);
            const rawEnd = req.query.end ? new Date(String(req.query.end)) : new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
            if (Number.isNaN(rawStart.getTime()) || Number.isNaN(rawEnd.getTime())) {
                return res.status(400).json({ error: "Geçerli tarih aralığı girin." });
            }
            // Date-only params (e.g. "2026-06-17") parse to midnight; widen to cover
            // the full first/last day so single-day (day view) ranges are not empty.
            const start = startOfDay(rawStart);
            const end = endOfDay(rawEnd);

            const appointments = await (prisma as any).appointment.findMany({
                where: {
                    tenantId: req.user!.tenantId,
                    projectId: { not: null },
                    status: { in: ["BOOKED", "COMPLETED"] },
                    startTime: { gte: start },
                    endTime: { lte: end },
                },
                orderBy: { startTime: "asc" },
                include: String(req.query.view || "") === "calendar"
                    ? this.projectCalendarListInclude()
                    : this.projectInstallationInclude(),
            });
            res.status(200).json(appointments);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getMyInstallation(req: Request, res: Response) {
        try {
            const appointment = await (prisma as any).appointment.findFirst({
                where: {
                    id: String(req.params.appointmentId || ""),
                    tenantId: req.user!.tenantId,
                    OR: [
                        { assignedTechId: req.user!.id },
                        { technicianAssignments: { some: { technicianId: req.user!.id } } },
                    ],
                    projectId: { not: null },
                },
                include: this.projectInstallationInclude(),
            });
            if (!appointment) return res.status(404).json({ error: "Montaj randevusu bulunamadı." });
            res.status(200).json(appointment);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Detail for the calendar popup, fetched lazily when an appointment block is
    // clicked. `technicianScope` mirrors the two list endpoints: managers may open
    // any appointment in the tenant, technicians only their own assignments.
    async getAppointmentDetail(req: Request, res: Response, opts: { technicianScope?: boolean } = {}) {
        try {
            const where: any = {
                id: String(req.params.appointmentId || ""),
                tenantId: req.user!.tenantId,
                projectId: { not: null },
            };
            if (opts.technicianScope) {
                where.OR = [
                    { assignedTechId: req.user!.id },
                    { technicianAssignments: { some: { technicianId: req.user!.id } } },
                ];
            }
            const appointment = await (prisma as any).appointment.findFirst({
                where,
                include: this.projectCalendarDetailInclude(),
            });
            if (!appointment) return res.status(404).json({ error: "Randevu bulunamadı." });
            res.status(200).json(appointment);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getById(req: Request, res: Response) {
        try {
            const project = await this.projectRepository.findById(req.params.id as string, req.user!.tenantId);
            if (!project) {
                return res.status(404).json({ error: "Proje bulunamadı veya seçili şirkette değil." });
            }
            // Attached separately (not via the shared findById include) so the
            // project keeps loading even if the addon-request table is absent.
            let addonRequests: any[] = [];
            try {
                addonRequests = await (prisma as any).projectAddonRequest.findMany({
                    where: { projectId: (project as any).id, tenantId: req.user!.tenantId },
                    orderBy: { createdAt: "desc" },
                });
            } catch (addonError: any) {
                console.error("[getById] could not load addon requests:", addonError?.message || addonError);
            }
            res.status(200).json({ ...(project as any), addonRequests });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async update(req: Request, res: Response) {
        try {
            const project = await this.projectRepository.findById(req.params.id as string);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }

            const allowed = ['projectName', 'managerId', 'status', 'startDate', 'endDate', 'plannedBudget', 'overtimeHourlyRate'];
            const patch: any = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined) patch[key] = req.body[key];
            }
            if (patch.startDate) patch.startDate = new Date(patch.startDate);
            if (patch.endDate) patch.endDate = new Date(patch.endDate);
            if (patch.plannedBudget !== undefined) patch.plannedBudget = Number(patch.plannedBudget);
            if (patch.overtimeHourlyRate !== undefined) patch.overtimeHourlyRate = Number(patch.overtimeHourlyRate);

            const updated = await this.projectRepository.updateProject(project.id, patch);
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async activate(req: Request, res: Response) {
        try {
            const project = await this.projectRepository.findById(req.params.id as string);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            if (project.status !== 'AWAITING_APPROVAL') {
                return res.status(400).json({ error: "Sadece onay bekleyen projeler aktiflestirilebilir." });
            }
            const updated = await this.projectRepository.updateProject(project.id, {
                status: 'ACTIVE',
                startDate: req.body.startDate ? new Date(req.body.startDate) : new Date()
            });
            res.status(200).json({ message: "Proje aktiflestirildi.", project: updated });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Flat list of every field report in the tenant, for the Services > Reports module.
    async listAllReports(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const search = String(req.query.search || "").trim();
            const startRaw = req.query.start ? new Date(String(req.query.start)) : null;
            const endRaw = req.query.end ? new Date(String(req.query.end)) : null;

            const where: any = { project: { tenantId } };
            if (startRaw && !Number.isNaN(startRaw.getTime())) {
                where.workDate = { ...(where.workDate || {}), gte: startOfDay(startRaw) };
            }
            if (endRaw && !Number.isNaN(endRaw.getTime())) {
                where.workDate = { ...(where.workDate || {}), lte: endOfDay(endRaw) };
            }
            if (search) {
                where.OR = [
                    { project: { is: { projectName: { contains: search } } } },
                    { project: { is: { customer: { is: { companyName: { contains: search } } } } } },
                    { operationsDone: { contains: search } },
                ];
            }

            const reports = await (prisma as any).projectReport.findMany({
                where,
                orderBy: { reportDate: "desc" },
                take: 500,
                include: {
                    project: { select: { id: true, projectName: true, customer: { select: { id: true, companyName: true } } } },
                    salesOrder: { select: { id: true, orderNumber: true } },
                    appointment: { select: { id: true, startTime: true, endTime: true } },
                    employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                    usedMaterials: { include: { material: true } },
                    images: { select: { id: true } },
                },
            });
            res.status(200).json(reports);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listMaterials(req: Request, res: Response) {
        try {
            const materials = await this.materialRepository.list(req.user!.tenantId);
            res.status(200).json(materials);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createMaterial(req: Request, res: Response) {
        try {
            const name = String(req.body.name || '').trim();
            const serialId = String(req.body.serialId || '').trim();
            const unitCost = Number(req.body.unitCost || 0);
            const stockQuantity = Number(req.body.stockQuantity || 0);
            const imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : null;

            if (!name) return res.status(400).json({ error: "Malzeme adi zorunludur." });
            if (!serialId) return res.status(400).json({ error: "Seri kodu zorunludur." });
            if (unitCost < 0 || stockQuantity < 0) return res.status(400).json({ error: "Fiyat ve stok negatif olamaz." });

            const material = await this.materialRepository.createMaterial(req.user!.tenantId, name, serialId, unitCost, stockQuantity, imageUrl);
            res.status(201).json(material);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateMaterial(req: Request, res: Response) {
        try {
            const material = await this.materialRepository.findById(req.params.materialId as string);
            if (!material || (material as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Malzeme bulunamadı." });
            }

            const patch: any = {};
            if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
            if (req.body.serialId !== undefined) patch.serialId = String(req.body.serialId).trim();
            if (req.body.unitCost !== undefined) patch.unitCost = Number(req.body.unitCost);
            if (req.body.stockQuantity !== undefined) patch.stockQuantity = Number(req.body.stockQuantity);
            if (req.body.imageUrl !== undefined) patch.imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : null;
            if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);

            if (patch.name === '') return res.status(400).json({ error: "Malzeme adi zorunludur." });
            if (patch.serialId === '') return res.status(400).json({ error: "Seri kodu zorunludur." });
            if (patch.unitCost < 0 || patch.stockQuantity < 0) return res.status(400).json({ error: "Fiyat ve stok negatif olamaz." });

            const updated = await this.materialRepository.updateMaterial(material.id, patch);
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteMaterial(req: Request, res: Response) {
        try {
            const material = await this.materialRepository.findById(req.params.materialId as string);
            if (!material || (material as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Malzeme bulunamadı." });
            }

            await this.materialRepository.softDeleteMaterial(material.id);
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createFromTender(req: Request, res: Response) {
        try {
            const { tenderId, managerId, overtimeHourlyRate } = req.body;
            const employeeId = (req as any).user!.id;
            
            const project = await this.createProjectUseCase.execute(tenderId, employeeId, managerId, req.user!.tenantId, Number(overtimeHourlyRate || 0));
            

            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || 'http://localhost:5173';
            const bookingLink = `${frontendUrl}/booking/${project.bookingToken}`;
            
            res.status(201).json({ 
                message: "Sipariş/proje oluşturuldu. Teklif mailindeki saat planları projeye kilitli randevu olarak aktarıldı.", 
                project,
                bookingLink 
            });
        } catch (error: any) {
            res.status(403).json({ error: error.message }); 
        }
    }

    async sendBookingMail(req: Request, res: Response) {
        try {
            const project = await this.projectRepository.findById(req.params.id as string);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            if (!project.bookingToken) {
                return res.status(400).json({ error: "Bu proje için randevu tokeni yok." });
            }

            const settings = await prisma.mailSetting.findUnique({ where: { tenantId: req.user!.tenantId } });
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || 'http://localhost:5173';
            const bookingLink = `${frontendUrl}/booking/${project.bookingToken}`;
            const customerEmail = (project as any).customer?.mainEmail || "";
            const to = String(req.body.to || customerEmail || "").trim();
            const fromEmail = String(req.body.fromEmail || settings?.fromEmail || req.user!.email || "").trim();
            const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
            const subject = String(req.body.subject || `${project.projectName} - Montaj randevusu`).trim();
            const message = req.body.message || "Lütfen size uygun montaj saatini seçin.";

            if (!to) return res.status(400).json({ error: "Alıcı e-posta adresi zorunludur." });
            if (!fromEmail) return res.status(400).json({ error: "Gönderici e-posta adresi zorunludur." });

            const html = `
                <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
                    <p>${message}</p>
                    <p><a href="${bookingLink}" style="display:inline-block;background:#1d4ed8;color:white;padding:10px 14px;border-radius:6px;text-decoration:none">Randevu saatini seç</a></p>
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
                replyTo: req.body.replyTo || settings?.replyTo || null
            });

            res.status(200).json({
                message: result.preview
                    ? "SMTP ayarı olmadığı için randevu maili önizleme olarak hazırlandı."
                    : "Randevu maili gönderildi.",
                bookingLink,
                ...result
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async addReport(req: Request, res: Response) {
        try {
            const salesOrderId = await this.resolveProjectSalesOrderId(req.params.id as string, req.user!.tenantId, req.body.salesOrderId);
            // Tie the report to a specific appointment when one is supplied so it never
            // leaks onto sibling appointments sharing the sales order. Validate it belongs
            // to this project/tenant before trusting it.
            let appointmentId: string | null = null;
            if (req.body.appointmentId) {
                const appointment: any = await (prisma as any).appointment.findFirst({
                    where: { id: String(req.body.appointmentId), tenantId: req.user!.tenantId, projectId: req.params.id as string },
                    select: { id: true },
                });
                if (!appointment) return res.status(400).json({ error: "Randevu bu projeye ait değil." });
                appointmentId = appointment.id;
            }
            const input: ReportInput = {
                projectId: req.params.id as string,
                salesOrderId,
                appointmentId,
                employeeId: (req as any).user!.id,
                workDate: req.body.workDate,
                startedAt: req.body.startedAt,
                endedAt: req.body.endedAt,
                operationsDone: req.body.operationsDone,
                technicalNotes: req.body.technicalNotes,
                images: Array.isArray(req.body.images) ? req.body.images.map(String) : undefined
            };

            const report = await this.addReportUseCase.execute(input);
            res.status(201).json({ message: "Saha raporu kaydedildi.", report });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateReport(req: Request, res: Response) {
        try {
            const report = await this.reportRepository.findById(req.params.reportId as string);
            if (!report) return res.status(404).json({ error: "Saha raporu bulunamadı." });

            const project = await this.projectRepository.findById((report as any).projectId);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }

            const input: ReportInput = {
                projectId: (report as any).projectId,
                salesOrderId: await this.resolveProjectSalesOrderId((report as any).projectId, req.user!.tenantId, req.body.salesOrderId || (report as any).salesOrderId),
                employeeId: (req as any).user!.id,
                workDate: req.body.workDate,
                startedAt: req.body.startedAt,
                endedAt: req.body.endedAt,
                operationsDone: req.body.operationsDone,
                technicalNotes: req.body.technicalNotes,
                images: Array.isArray(req.body.images) ? req.body.images.map(String) : undefined
            };

            const updated = await (this.addReportUseCase as any).update(req.params.reportId as string, input);
            res.status(200).json({ message: "Saha raporu güncellendi.", report: updated });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Append used materials (reportMaterial rows) to an existing field report — used by the inline
    // "Saha" editor when adding used materials to a report that already exists.
    async addReportMaterials(req: Request, res: Response) {
        try {
            const reportId = req.params.reportId as string;
            const report: any = await (prisma as any).projectReport.findFirst({
                where: { id: reportId, project: { tenantId: req.user!.tenantId } },
                select: { id: true },
            });
            if (!report) return res.status(404).json({ error: "Saha raporu bulunamadı." });

            const items = Array.isArray(req.body.materials) ? req.body.materials : [];
            const rows: any[] = [];
            for (const item of items) {
                const quantity = Number(item.quantity || 0);
                if (!item.materialId || quantity <= 0) continue;
                const material: any = await this.materialRepository.findById(String(item.materialId));
                if (!material || material.tenantId !== req.user!.tenantId) continue;
                rows.push({
                    id: nanoid(10),
                    reportId: report.id,
                    materialId: material.id,
                    quantity,
                    costAtTime: Number(material.unitCost || 0),
                });
            }
            if (rows.length) {
                await (prisma as any).reportMaterial.createMany({ data: rows });
            }
            res.status(201).json({ message: "Kullanılan malzemeler eklendi.", count: rows.length });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async signReport(req: Request, res: Response) {
        try {
            const reportId = req.params.reportId as string;
            const { signatureBase64 } = req.body;
            await this.reportRepository.signReport(reportId, signatureBase64);
            res.status(200).json({ message: "Rapor müşteri tarafından imzalandı." });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async requestReportSignature(req: Request, res: Response) {
        try {
            const reportId = req.params.reportId as string;
            const channel = String(req.body.channel || "technician");
            const report: any = await (prisma as any).projectReport.findFirst({
                where: { id: reportId, project: { tenantId: req.user!.tenantId } },
                include: {
                    employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                    project: { include: { customer: true } },
                    salesOrder: { select: { orderNumber: true } },
                },
            });
            if (!report) return res.status(404).json({ error: "Saha raporu bulunamadı." });

            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || "http://localhost:5173";
            const reportLink = `${frontendUrl}/projects/${report.projectId}`;
            const sent: string[] = [];

            if ((channel === "technician" || channel === "both") && report.employeeId) {
                await this.notify({
                    tenantId: req.user!.tenantId,
                    recipientEmployeeId: report.employeeId,
                    type: "PROJECT_REPORT_SIGNATURE_REQUEST",
                    title: "Müşteri imzası tekrar istendi",
                    message: `${report.project?.projectName || "Proje"} saha raporu için imza alınması gerekiyor.`,
                    linkUrl: "/projects/installation/tasks",
                    metadata: { projectId: report.projectId, reportId },
                });
                sent.push("technician");
            }

            if (channel === "mail" || channel === "both") {
                const settings = await prisma.mailSetting.findUnique({ where: { tenantId: req.user!.tenantId } });
                const to = String(req.body.to || report.project?.customer?.mainEmail || "").trim();
                const fromEmail = String(req.body.fromEmail || settings?.fromEmail || req.user!.email || "").trim();
                const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
                const subject = String(req.body.subject || `${report.project?.projectName || "Proje"} - saha raporu imzası`).trim();
                const message = String(req.body.message || "Saha raporunuz imza için hazır. Lütfen Offitec ekibiyle birlikte raporu kontrol edip imzalayın.").trim();
                if (!to) return res.status(400).json({ error: "Müşteri e-posta adresi bulunamadı." });
                if (!fromEmail) return res.status(400).json({ error: "Gönderici e-posta adresi zorunludur." });
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

            res.status(200).json({ message: "İmza isteği gönderildi.", sent });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async completeInstallation(req: Request, res: Response, options: { allowManagerComplete?: boolean } = {}) {
        try {
            const appointmentId = String(req.params.appointmentId || req.body.appointmentId || "");
            const isManagerCompletion = Boolean(options.allowManagerComplete);
            const appointment: any = await (prisma as any).appointment.findFirst({
                where: {
                    id: appointmentId,
                    tenantId: req.user!.tenantId,
                    ...(isManagerCompletion ? {} : {
                        OR: [
                            { assignedTechId: req.user!.id },
                            { technicianAssignments: { some: { technicianId: req.user!.id } } },
                        ],
                    }),
                    projectId: { not: null },
                },
                include: {
                    salesOrder: true,
                    project: { include: { salesOrders: { orderBy: { createdAt: "asc" } }, customer: true, manager: true } },
                },
            });
            if (!appointment?.project) return res.status(404).json({ error: "Montaj randevusu bulunamadı." });
            if (startOfDay(new Date(appointment.startTime)).getTime() > startOfDay(new Date()).getTime()) {
                return res.status(400).json({ error: "Montaj gunu gelmeden rapor kapatilamaz." });
            }

            const operationItems = Array.isArray(req.body.operationsDoneItems)
                ? req.body.operationsDoneItems.map(String).map((item: string) => item.trim()).filter(Boolean)
                : [];
            const operationsDone = operationItems.length
                ? operationItems.map((item: string) => `- ${item}`).join("\n")
                : String(req.body.operationsDone || "").trim()
                    // Managers can finish directly without filling anything in; record a standard note.
                    || (isManagerCompletion ? "Saha çalışması yönetici tarafından tamamlandı." : "");
            if (!operationsDone) return res.status(400).json({ error: "Yapilan isler zorunludur." });

            const salesOrderId = await this.resolveProjectSalesOrderId(appointment.projectId, req.user!.tenantId, appointment.salesOrderId);
            // Field work belongs to its day: the report may end at the latest by midnight of the appointment day.
            const dayEnd = endOfDay(new Date(appointment.startTime));
            let endedAt = req.body.endedAt ? new Date(req.body.endedAt) : new Date();
            const startedAt = req.body.startedAt ? new Date(req.body.startedAt) : new Date(appointment.startTime);
            if (Number.isNaN(endedAt.getTime()) || Number.isNaN(startedAt.getTime())) {
                return res.status(400).json({ error: "Geçerli başlangıç ve bitiş zamanı girin." });
            }
            if (endedAt > dayEnd) endedAt = dayEnd;

            const reportEmployeeId = isManagerCompletion ? (appointment.assignedTechId || req.user!.id) : req.user!.id;
            const workDate = startOfDay(new Date(appointment.startTime));
            // A day can only hold one field report per order. If one already exists, reuse it and just
            // close the appointment instead of failing with "a report already exists".
            const isPrimaryOrder = (appointment.project.salesOrders?.[0]?.id || null) === (salesOrderId || null);
            // Prefer this appointment's own report (e.g. a manager-drafted one) so completing
            // it reuses that report. Only fall back to the legacy order/day lookup for reports
            // that carry NO appointmentId — a report already stamped to a sibling appointment
            // must never be stolen/re-stamped, so this appointment gets its own report instead.
            const ownReport: any = await (this.reportRepository as any).findByAppointmentId(appointment.id);
            const legacyDayReport: any = ownReport
                ? null
                : await this.reportRepository.findByProjectAndWorkDate(
                    appointment.projectId,
                    workDate,
                    salesOrderId ?? undefined,
                    isPrimaryOrder
                );
            const existingReport: any = ownReport || (legacyDayReport && !legacyDayReport.appointmentId ? legacyDayReport : null);
            const reportPayload = {
                projectId: appointment.projectId,
                salesOrderId,
                appointmentId: appointment.id,
                employeeId: reportEmployeeId,
                workDate: workDate.toISOString(),
                startedAt: startedAt.toISOString(),
                endedAt: endedAt.toISOString(),
                operationsDone,
                technicalNotes: req.body.technicalNotes,
                images: Array.isArray(req.body.images) ? req.body.images.map(String) : undefined,
            };
            // When a report already exists (e.g. a manager-drafted one), a technician
            // finishing the montaj applies their own field-report content to it — the
            // technician did the work, so their entry is the record of truth. A manager
            // just marking the job done reuses the report untouched, so their explicit
            // "Finish" never overwrites the report body with a default note.
            const reportResult: any = existingReport
                ? (isManagerCompletion
                    ? (await this.reportRepository.findById(existingReport.id) || existingReport)
                    : await this.addReportUseCase.update(existingReport.id, reportPayload))
                : await this.addReportUseCase.execute(reportPayload);

            const cleanUsedMaterials = Array.isArray(req.body.usedMaterials) ? req.body.usedMaterials : [];
            const usedMaterialRows: any[] = [];
            for (const material of cleanUsedMaterials) {
                const quantity = Number(material.quantity || 0);
                if (!material.materialId || quantity <= 0) continue;
                const materialRecord: any = await this.materialRepository.findById(String(material.materialId));
                if (!materialRecord || materialRecord.tenantId !== req.user!.tenantId) continue;
                usedMaterialRows.push({
                    id: nanoid(10),
                    reportId: reportResult.id,
                    materialId: materialRecord.id,
                    quantity,
                    costAtTime: Number(materialRecord.unitCost || 0),
                });
            }
            if (usedMaterialRows.length) {
                await (prisma as any).reportMaterial.createMany({ data: usedMaterialRows });
            }

            const cleanExpenses = Array.isArray(req.body.expenses) ? req.body.expenses : [];
            for (const expense of cleanExpenses) {
                const amount = Number(expense.amount || 0);
                if (!expense.expenseType || amount <= 0) continue;
                await this.addExpenseUseCase.execute(
                    appointment.projectId,
                    String(expense.expenseType).trim(),
                    amount,
                    expense.description ? String(expense.description).trim() : "",
                    salesOrderId,
                    appointment.id
                );
            }

            const cleanMaterials = Array.isArray(req.body.materials) ? req.body.materials : [];
            for (const material of cleanMaterials) {
                const quantity = Number(material.quantity || 0);
                if (!material.materialId || quantity <= 0) continue;
                await this.requestVariationUseCase.execute(
                    appointment.projectId,
                    req.user!.id,
                    String(material.materialId),
                    quantity,
                    material.description ? String(material.description).trim() : "",
                    salesOrderId,
                    appointment.id
                );
            }

            let report = reportResult;
            const signatureBase64 = typeof req.body.signatureBase64 === "string" ? req.body.signatureBase64 : "";
            if (signatureBase64) {
                await this.reportRepository.signReport(reportResult.id, signatureBase64);
                report = await this.reportRepository.findById(reportResult.id) || reportResult;
            }

            await (prisma as any).appointment.update({
                where: { id: appointment.id },
                data: { status: "COMPLETED" },
            });

            // Finishing as administrator also approves the report's worked-hours / overtime.
            if (isManagerCompletion) {
                await (prisma as any).projectReport.update({
                    where: { id: reportResult.id },
                    data: { hoursApprovedAt: new Date(), hoursApprovedById: req.user!.id, autoApproved: false },
                });
            }

            const parentSalesOrderId = appointment.salesOrder?.parentSalesOrderId || salesOrderId || appointment.project.salesOrders?.[0]?.id || null;
            // Addon order/request + manager notification are best-effort side-effects:
            // the montaj report is already saved, so a failure here (e.g. missing
            // migration) must never abort the completion the technician just performed.
            let addon: Awaited<ReturnType<ProjectController["createAddonOrderForParent"]>> = null;
            let addonRequest: Awaited<ReturnType<ProjectController["createAddonRequestForParent"]>> = null;
            try {
                // Managers may finalize the addon order directly; a technician finishing
                // the montaj only raises a request that the manager acts on.
                if (parentSalesOrderId && isManagerCompletion) {
                    addon = await this.createAddonOrderForParent(appointment.project, parentSalesOrderId, req.user!.id, new Date(appointment.startTime));
                } else if (parentSalesOrderId && !isManagerCompletion) {
                    addonRequest = await this.createAddonRequestForParent(appointment.project, parentSalesOrderId, req.user!.id, appointment.id);
                }

                await this.notifyProjectManagers(appointment.project, {
                    type: isManagerCompletion ? "PROJECT_INSTALLATION_MANAGER_COMPLETED" : signatureBase64 ? "PROJECT_INSTALLATION_COMPLETED" : "PROJECT_INSTALLATION_UNSIGNED",
                    title: isManagerCompletion ? "Montaj yönetici tarafından bitirildi" : signatureBase64 ? "Montaj tamamlandı" : "Montaj imzasız geldi",
                    message: isManagerCompletion
                        ? `${appointment.project.projectName} montajı yönetici tarafından bitirildi.`
                        : `${appointment.project.projectName} montajı teknisyen tarafından bitirildi${signatureBase64 ? "." : ", müşteri imzası yok."}`,
                    linkUrl: `/projects/${appointment.projectId}`,
                    metadata: { projectId: appointment.projectId, appointmentId: appointment.id, reportId: reportResult.id, addonSalesOrderId: addon?.salesOrder?.id || null, addonRequestId: addonRequest?.request?.id || null },
                });
            } catch (sideEffectError: any) {
                console.error("[completeInstallation] addon/notify side-effect failed:", sideEffectError?.message || sideEffectError);
            }

            res.status(201).json({
                message: isManagerCompletion ? "Montaj yönetici tarafından bitirildi." : signatureBase64 ? "Montaj tamamlandı ve imza alındı." : "Montaj imzasız tamamlandı.",
                report,
                addonOrder: addon?.salesOrder || null,
                addonTotals: addon?.totals || null,
                addonRequest: addonRequest?.request || null,
                overtimeWarning: reportResult.overtimeWarning || null,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async requestExtraMaterial(req: Request, res: Response) {
        try {
            const projectId = req.params.id as string;
            const employeeId = (req as any).user!.id;
            const { materialId, quantity, description } = req.body;
            const salesOrderId = await this.resolveProjectSalesOrderId(projectId, req.user!.tenantId, req.body.salesOrderId);
            const appointmentId = req.body.appointmentId ? String(req.body.appointmentId) : null;

            const extraMaterial = await this.requestVariationUseCase.execute(projectId, employeeId, materialId, quantity, description, salesOrderId, appointmentId);
            res.status(201).json({ message: "Ek malzeme projeye eklendi.", extraMaterial });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async approveVariation(req: Request, res: Response) {
        try {
            const variationId = req.params.variationId as string;
            const managerId = (req as any).user!.id;
            const { isApproved } = req.body;

            const result = await this.approveVariationUseCase.execute(variationId, managerId, isApproved);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async addExpense(req: Request, res: Response) {
        try {
            const projectId = req.params.id as string;
            const { expenseType, amount, description } = req.body;
            const salesOrderId = await this.resolveProjectSalesOrderId(projectId, req.user!.tenantId, req.body.salesOrderId);
            const appointmentId = req.body.appointmentId ? String(req.body.appointmentId) : null;

            const expense = await this.addExpenseUseCase.execute(projectId, expenseType, amount, description, salesOrderId, appointmentId);
            res.status(201).json({ message: "Harici gider eklendi.", expense });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateExpense(req: Request, res: Response) {
        try {
            const expense: any = await (prisma as any).projectExpense.findUnique({
                where: { id: req.params.expenseId as string },
                include: { project: true },
            });
            if (!expense?.project || expense.project.tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Harici gider bulunamadı." });
            }

            const patch: any = {};
            if (req.body.expenseType !== undefined) {
                const expenseType = String(req.body.expenseType || "").trim();
                if (!PROJECT_EXPENSE_TYPES.includes(expenseType)) {
                    return res.status(400).json({ error: "Geçersiz harici gider türü." });
                }
                patch.expenseType = expenseType;
            }
            if (req.body.amount !== undefined) {
                const amount = Number(req.body.amount || 0);
                if (amount <= 0) return res.status(400).json({ error: "Tutar sıfırdan büyük olmalıdır." });
                patch.amount = amount;
            }
            if (req.body.description !== undefined) {
                patch.description = String(req.body.description || "").trim() || null;
            }
            if (req.body.salesOrderId !== undefined) {
                patch.salesOrderId = await this.resolveProjectSalesOrderId(expense.projectId, req.user!.tenantId, req.body.salesOrderId);
            }

            const updated = await (prisma as any).projectExpense.update({
                where: { id: expense.id },
                data: patch,
            });
            res.status(200).json({ message: "Harici gider güncellendi.", expense: updated });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteExpense(req: Request, res: Response) {
        try {
            const expense: any = await (prisma as any).projectExpense.findUnique({
                where: { id: req.params.expenseId as string },
                include: { project: true },
            });
            if (!expense?.project || expense.project.tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Harici gider bulunamadı." });
            }

            await (prisma as any).projectExpense.delete({ where: { id: expense.id } });
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateExtraMaterial(req: Request, res: Response) {
        try {
            const existing: any = await (prisma as any).projectExtraMaterial.findUnique({
                where: { id: req.params.extraMaterialId as string },
                include: { project: true, material: true },
            });
            if (!existing?.project || existing.project.tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Ek malzeme bulunamadı." });
            }

            const materialId = req.body.materialId !== undefined
                ? String(req.body.materialId || "").trim()
                : existing.materialId;
            if (!materialId) return res.status(400).json({ error: "Malzeme seçimi zorunludur." });

            const quantity = req.body.quantity !== undefined ? Number(req.body.quantity || 0) : Number(existing.quantity || 0);
            if (quantity <= 0) return res.status(400).json({ error: "Miktar sıfırdan büyük olmalıdır." });

            const material: any = await this.materialRepository.findById(materialId);
            if (!material || material.tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Malzeme bulunamadı." });
            }

            const availableQuantity = Number(material.stockQuantity || 0) + (material.id === existing.materialId ? Number(existing.quantity || 0) : 0);
            if (availableQuantity < quantity) {
                return res.status(400).json({ error: `[Stok uyarısı] ${material.name} için kayıtlı miktar yetersiz.` });
            }

            const salesOrderId = req.body.salesOrderId !== undefined
                ? await this.resolveProjectSalesOrderId(existing.projectId, req.user!.tenantId, req.body.salesOrderId)
                : existing.salesOrderId;
            const unitPrice = req.body.unitPrice !== undefined
                ? Number(req.body.unitPrice || 0)
                : material.id === existing.materialId
                    ? Number(existing.unitPrice || 0)
                    : Number(material.unitCost || 0);
            if (unitPrice < 0) return res.status(400).json({ error: "Birim fiyat negatif olamaz." });
            const description = req.body.description !== undefined
                ? String(req.body.description || "").trim() || null
                : existing.description;

            const updated = await (prisma as any).$transaction(async (tx: any) => {
                const previousQuantity = Number(existing.quantity || 0);
                if (existing.materialId !== material.id) {
                    await tx.material.update({
                        where: { id: existing.materialId },
                        data: { stockQuantity: { increment: previousQuantity } },
                    });
                    await tx.material.update({
                        where: { id: material.id },
                        data: { stockQuantity: { decrement: quantity } },
                    });
                } else {
                    const diff = quantity - previousQuantity;
                    if (diff > 0) {
                        await tx.material.update({ where: { id: material.id }, data: { stockQuantity: { decrement: diff } } });
                    } else if (diff < 0) {
                        await tx.material.update({ where: { id: material.id }, data: { stockQuantity: { increment: Math.abs(diff) } } });
                    }
                }

                return await tx.projectExtraMaterial.update({
                    where: { id: existing.id },
                    data: {
                        materialId: material.id,
                        salesOrderId,
                        quantity,
                        unitPrice,
                        description,
                    },
                    include: { material: true },
                });
            });

            res.status(200).json({ message: "Ek malzeme güncellendi.", extraMaterial: updated });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteExtraMaterial(req: Request, res: Response) {
        try {
            const existing: any = await (prisma as any).projectExtraMaterial.findUnique({
                where: { id: req.params.extraMaterialId as string },
                include: { project: true },
            });
            if (!existing?.project || existing.project.tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Ek malzeme bulunamadı." });
            }

            await (prisma as any).$transaction(async (tx: any) => {
                await tx.material.update({
                    where: { id: existing.materialId },
                    data: { stockQuantity: { increment: Number(existing.quantity || 0) } },
                });
                await tx.projectExtraMaterial.delete({ where: { id: existing.id } });
            });
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Admin/manager-facing: delete a project sales order. Addon (Zusatzauftrag)
    // orders are billing snapshots that own no records, so they just drop the row.
    // A main order underpins its addons and scoped records, so it is guarded: it is
    // rejected while it still has addons, and any order that has been invoiced is
    // rejected outright. When a main order is removed its own scoped reports /
    // expenses / extra materials (restocked) / appointments are cleaned up too.
    async deleteSalesOrder(req: Request, res: Response) {
        try {
            const projectId = req.params.id as string;
            const salesOrderId = req.params.salesOrderId as string;
            const tenantId = req.user!.tenantId;

            const order: any = await (prisma as any).salesOrder.findFirst({
                where: { id: salesOrderId, projectId, tenantId },
            });
            if (!order) return res.status(404).json({ error: "Sipariş bu projeye ait değil." });

            // No order may be deleted once it has been billed.
            const invoiceCount = await (prisma as any).invoice.count({ where: { salesOrderId: order.id } });
            if (invoiceCount > 0) {
                return res.status(400).json({ error: "Faturalandırılmış bir sipariş silinemez." });
            }

            const isAddon = Boolean(order.parentSalesOrderId);

            if (!isAddon) {
                const addonCount = await (prisma as any).salesOrder.count({
                    where: { parentSalesOrderId: order.id, projectId, tenantId },
                });
                if (addonCount > 0) {
                    return res.status(400).json({ error: "Ek siparişleri olan bir ana sipariş silinemez. Önce ek siparişleri silin." });
                }
            }

            await (prisma as any).$transaction(async (tx: any) => {
                if (!isAddon) {
                    // Reports own their materials/images via onDelete: Cascade.
                    const reports: any[] = await tx.projectReport.findMany({
                        where: { projectId, salesOrderId: order.id },
                        select: { id: true },
                    });
                    if (reports.length) {
                        await tx.projectReport.deleteMany({ where: { id: { in: reports.map((r) => r.id) } } });
                    }

                    // Restock every extra material before removing it.
                    const extraMaterials: any[] = await tx.projectExtraMaterial.findMany({
                        where: { projectId, salesOrderId: order.id },
                        select: { id: true, materialId: true, quantity: true },
                    });
                    for (const row of extraMaterials) {
                        await tx.material.update({
                            where: { id: row.materialId },
                            data: { stockQuantity: { increment: Number(row.quantity || 0) } },
                        });
                    }
                    if (extraMaterials.length) {
                        await tx.projectExtraMaterial.deleteMany({ where: { id: { in: extraMaterials.map((r) => r.id) } } });
                    }

                    await tx.projectExpense.deleteMany({ where: { projectId, salesOrderId: order.id } });

                    // Appointment assignments cascade on Appointment delete.
                    await tx.appointment.deleteMany({ where: { projectId, salesOrderId: order.id } });
                }

                await tx.salesOrder.delete({ where: { id: order.id } });
            });

            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createAddonOrder(req: Request, res: Response) {
        try {
            const projectId = req.params.id as string;
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const rawParentSalesOrderId = String(req.body.parentSalesOrderId || req.body.salesOrderId || "").trim();
            if (!rawParentSalesOrderId) return res.status(400).json({ error: "Bağlı sipariş seçimi zorunludur." });

            const project: any = await this.projectRepository.findById(projectId);
            if (!project || project.tenantId !== tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }

            const selectedOrder: any = await (prisma as any).salesOrder.findFirst({
                where: { id: rawParentSalesOrderId, projectId, tenantId },
            });
            if (!selectedOrder) return res.status(404).json({ error: "Sipariş bu projeye ait değil." });

            const parentSalesOrderId = selectedOrder.parentSalesOrderId || selectedOrder.id;
            const parentOrder: any = selectedOrder.parentSalesOrderId
                ? await (prisma as any).salesOrder.findFirst({ where: { id: parentSalesOrderId, projectId, tenantId } })
                : selectedOrder;
            if (!parentOrder) return res.status(404).json({ error: "Ana sipariş bulunamadı." });

            const addons: any[] = await (prisma as any).salesOrder.findMany({
                where: { parentSalesOrderId, projectId, tenantId },
                orderBy: [{ revisionNumber: 'desc' }, { createdAt: 'desc' }],
            });
            const previousAddon = addons[0] || null;
            const nextRevision = Math.max(0, ...addons.map((order) => Number(order.revisionNumber || 0))) + 1;
            const previousCreatedAt = previousAddon?.createdAt || null;
            const createdAtFilter = previousCreatedAt ? { gt: previousCreatedAt } : undefined;

            const [expenses, extraMaterials, reports] = await Promise.all([
                (prisma as any).projectExpense.findMany({
                    where: {
                        projectId,
                        salesOrderId: parentSalesOrderId,
                        ...(createdAtFilter ? { expenseDate: createdAtFilter } : {}),
                    },
                }),
                (prisma as any).projectExtraMaterial.findMany({
                    where: {
                        projectId,
                        salesOrderId: parentSalesOrderId,
                        ...(createdAtFilter ? { addedAt: createdAtFilter } : {}),
                    },
                }),
                (prisma as any).projectReport.findMany({
                    where: {
                        projectId,
                        salesOrderId: parentSalesOrderId,
                        ...(createdAtFilter ? { reportDate: createdAtFilter } : {}),
                    },
                }),
            ]);

            const expenseTotal = expenses.reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0);
            const materialTotal = extraMaterials.reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
            const overtimeTotal = reports.reduce((sum: number, item: any) => sum + Number(item.overtimeCost || 0), 0);
            const totalAmount = expenseTotal + materialTotal + overtimeTotal;
            if (totalAmount <= 0) {
                return res.status(400).json({ error: "Ek sipariş oluşturmak için son ek siparişten sonra harici gider, ek malzeme veya ek işçilik maliyeti bulunamadı." });
            }

            // Date the addon to the appointment its billed extra work belongs to, even
            // when the manager creates it days later. createdAt still bounds the next slice.
            const resolvedOrderDate = await this.resolveAddonOrderDate(tenantId, { expenses, extraMaterials, reports });

            const orderNumber = `${parentOrder.orderNumber}-N${nextRevision}`;
            const addonOrder = await (prisma as any).salesOrder.create({
                data: {
                    id: nanoid(10),
                    tenantId,
                    customerId: parentOrder.customerId || project.customerId,
                    tenderId: null,
                    projectId,
                    parentSalesOrderId,
                    revisionNumber: nextRevision,
                    orderNumber,
                    orderType: 'PROJECT_ADDON',
                    status: 'ORDERED',
                    totalAmount,
                    orderDate: resolvedOrderDate,
                    createdByEmployeeId: employeeId,
                },
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
                    tender: { select: { id: true, tenderNumber: true, status: true, projectId: true } },
                    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
            });

            // Any open technician requests for this parent are now fulfilled (best-effort).
            try {
                await (prisma as any).projectAddonRequest.updateMany({
                    where: { projectId, tenantId, salesOrderId: parentSalesOrderId, status: "PENDING" },
                    data: { status: "HANDLED", resolvedById: employeeId, resolvedAt: new Date() },
                });
            } catch (markError: any) {
                console.error("[createAddonOrder] could not mark addon requests handled:", markError?.message || markError);
            }

            res.status(201).json({
                message: `${orderNumber} ek siparişi oluşturuldu.`,
                salesOrder: addonOrder,
                totals: { expenses: expenseTotal, extraMaterials: materialTotal, overtime: overtimeTotal, total: totalAmount },
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Technician-facing: raise a request that the manager create an addon order
    // from the extra work accrued on a parent order. Does not create the order.
    async requestAddonOrder(req: Request, res: Response) {
        try {
            const projectId = req.params.id as string;
            const tenantId = req.user!.tenantId;

            const project: any = await this.projectRepository.findById(projectId, tenantId);
            if (!project) return res.status(404).json({ error: "Proje bulunamadı." });

            const rawSalesOrderId = String(req.body.salesOrderId || req.body.parentSalesOrderId || "").trim();
            let parentSalesOrderId = rawSalesOrderId || null;
            if (parentSalesOrderId) {
                const order: any = await (prisma as any).salesOrder.findFirst({ where: { id: parentSalesOrderId, projectId, tenantId } });
                if (!order) return res.status(404).json({ error: "Sipariş bu projeye ait değil." });
                parentSalesOrderId = order.parentSalesOrderId || order.id;
            } else {
                parentSalesOrderId = project.salesOrders?.find((o: any) => !o.parentSalesOrderId)?.id || project.salesOrders?.[0]?.id || null;
            }
            if (!parentSalesOrderId) return res.status(400).json({ error: "Ek sipariş talebi için bağlı bir sipariş bulunamadı." });

            const result = await this.createAddonRequestForParent(project, parentSalesOrderId, req.user!.id, req.body.appointmentId ? String(req.body.appointmentId) : null, req.body.note);
            if (!result) {
                return res.status(400).json({ error: "Ek sipariş talebi için harici gider, ek malzeme veya ek işçilik maliyeti bulunamadı." });
            }

            res.status(201).json({ message: "Ek sipariş talebi yöneticiye iletildi.", addonRequest: result.request, totals: result.totals });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Manager-facing: resolve (HANDLED / DISMISSED) a technician addon request.
    async resolveAddonRequest(req: Request, res: Response) {
        try {
            const requestId = req.params.requestId as string;
            const tenantId = req.user!.tenantId;
            const nextStatus = String(req.body.status || "DISMISSED").toUpperCase();
            if (!["HANDLED", "DISMISSED", "PENDING"].includes(nextStatus)) {
                return res.status(400).json({ error: "Geçersiz talep durumu." });
            }

            const request: any = await (prisma as any).projectAddonRequest.findFirst({ where: { id: requestId, tenantId } });
            if (!request) return res.status(404).json({ error: "Ek sipariş talebi bulunamadı." });

            const updated = await (prisma as any).projectAddonRequest.update({
                where: { id: request.id },
                data: {
                    status: nextStatus,
                    resolvedById: nextStatus === "PENDING" ? null : req.user!.id,
                    resolvedAt: nextStatus === "PENDING" ? null : new Date(),
                },
            });
            res.status(200).json({ message: "Ek sipariş talebi güncellendi.", addonRequest: updated });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    private parseAppointmentBody(body: any) {
        const startTime = new Date(body.startTime);
        const endTime = new Date(body.endTime);
        if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || endTime <= startTime) {
            throw new Error("Geçerli bir başlangıç ve bitiş saati girin.");
        }
        return {
            startTime,
            endTime,
            notes: body.notes === undefined ? undefined : String(body.notes || "").trim() || null
        };
    }

    // A customer may receive at most one field appointment per calendar day, regardless of project/order.
    private async findCustomerSameDayAppointment(customerId: string, day: Date, excludeAppointmentId?: string) {
        if (!customerId) return null;
        return await (prisma as any).appointment.findFirst({
            where: {
                customerId,
                projectId: { not: null },
                status: { in: ["BOOKED", "COMPLETED"] },
                ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
                startTime: { gte: startOfDay(day), lte: endOfDay(day) },
            },
        });
    }

    private async findProjectAppointmentConflict(projectId: string, startTime: Date, endTime: Date, appointmentId?: string, salesOrderId?: string | null) {
        return await (prisma as any).appointment.findFirst({
            where: {
                projectId,
                ...(salesOrderId !== undefined ? { salesOrderId } : {}),
                ...(appointmentId ? { id: { not: appointmentId } } : {}),
                startTime: { lt: endTime },
                endTime: { gt: startTime }
            }
        });
    }

    private async findTechnicianScheduleConflict(technicianIds: string[], startTime: Date, endTime: Date, tenantId: string, appointmentId?: string) {
        return findTechnicianScheduleConflict(technicianIds, startTime, endTime, tenantId, { appointmentId });
    }

    private appointmentTechnicianIdsFromBody(body: any, fallbackIds: string[] = []) {
        if (body.technicianIds !== undefined) return normalizeIdList(body.technicianIds);
        if (body.assignedTechId !== undefined) return normalizeIdList([body.assignedTechId]);
        return [...new Set(fallbackIds.filter(Boolean))];
    }

    private async replaceProjectAppointmentAssignments(appointmentId: string, technicianIds: string[]) {
        const ids = [...new Set(technicianIds.filter(Boolean))];
        await (prisma as any).$transaction(async (tx: any) => {
            await tx.projectAppointmentAssignment.deleteMany({ where: { appointmentId } });
            if (ids.length) {
                await tx.projectAppointmentAssignment.createMany({
                    data: ids.map((technicianId) => ({
                        id: nanoid(10),
                        appointmentId,
                        technicianId,
                    })),
                    skipDuplicates: true,
                });
            }
        });
    }

    async createAppointment(req: Request, res: Response) {
        try {
            const project = await this.projectRepository.findById(req.params.id as string);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }

            const parsed = this.parseAppointmentBody(req.body);
            const salesOrderId = await this.resolveProjectSalesOrderId(project.id, req.user!.tenantId, req.body.salesOrderId);
            const sameDayForCustomer = await this.findCustomerSameDayAppointment((project as any).customerId, parsed.startTime);
            if (sameDayForCustomer) return res.status(409).json({ error: "Bu müşteri için aynı güne ait başka bir randevu var. Bir günde tek randevu verilebilir." });
            const conflict = await this.findProjectAppointmentConflict(project.id, parsed.startTime, parsed.endTime, undefined, salesOrderId);
            if (conflict) return res.status(409).json({ error: "Bu proje için saat planı çakışıyor." });

            const technicians = await this.validateProjectTechnicians(this.appointmentTechnicianIdsFromBody(req.body), req.user!.tenantId) as any[];
            const technicianIds = technicians.map((technician: any) => technician.id);
            const responsibleTechnician = technicians[0] || null;
            const techConflict = await this.findTechnicianScheduleConflict(technicianIds, parsed.startTime, parsed.endTime, req.user!.tenantId);
            if (techConflict) return res.status(409).json({ error: techConflict.message });

            const appointment = await (prisma as any).appointment.create({
                data: {
                    id: nanoid(10),
                    tenantId: (project as any).tenantId,
                    projectId: project.id,
                    salesOrderId,
                    assignedTechId: responsibleTechnician?.id || null,
                    customerId: (project as any).customerId,
                    startTime: parsed.startTime,
                    endTime: parsed.endTime,
                    notes: parsed.notes ?? null,
                    status: "BOOKED",
                    isLocked: true
                },
                include: {
                    assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
                    technicianAssignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } } },
                }
            });
            await this.replaceProjectAppointmentAssignments(appointment.id, technicianIds);

            if (technicianIds.length) {
                await this.notifyMany((project as any).tenantId, technicianIds, {
                    type: "PROJECT_INSTALLATION_ASSIGNED",
                    title: "Yeni montaj randevusu",
                    message: `${(project as any).projectName} montajı size atandı.`,
                    linkUrl: "/projects/installation/calendar",
                    metadata: { projectId: project.id, appointmentId: appointment.id, salesOrderId },
                });
            }

            res.status(201).json(appointment);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateAppointment(req: Request, res: Response) {
        try {
            const appointment = await (prisma as any).appointment.findUnique({
                where: { id: req.params.appointmentId as string },
                include: { project: true, technicianAssignments: true }
            });
            if (!appointment?.project || appointment.project.tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }

            const parsed = this.parseAppointmentBody(req.body);
            const salesOrderId = await this.resolveProjectSalesOrderId(appointment.projectId, req.user!.tenantId, req.body.salesOrderId || appointment.salesOrderId);
            const sameDayForCustomer = await this.findCustomerSameDayAppointment(appointment.customerId || appointment.project.customerId, parsed.startTime, appointment.id);
            if (sameDayForCustomer) return res.status(409).json({ error: "Bu müşteri için aynı güne ait başka bir randevu var. Bir günde tek randevu verilebilir." });
            const conflict = await this.findProjectAppointmentConflict(appointment.projectId, parsed.startTime, parsed.endTime, appointment.id, salesOrderId);
            if (conflict) return res.status(409).json({ error: "Bu proje için saat planı çakışıyor." });

            const fallbackTechnicianIds = [
                appointment.assignedTechId,
                ...((appointment.technicianAssignments || []).map((assignment: any) => assignment.technicianId)),
            ].filter(Boolean);
            const technicians = await this.validateProjectTechnicians(this.appointmentTechnicianIdsFromBody(req.body, fallbackTechnicianIds), req.user!.tenantId) as any[];
            const technicianIds = technicians.map((technician: any) => technician.id);
            const responsibleTechnician = technicians[0] || null;
            const techConflict = await this.findTechnicianScheduleConflict(technicianIds, parsed.startTime, parsed.endTime, req.user!.tenantId, appointment.id);
            if (techConflict) return res.status(409).json({ error: techConflict.message });

            const updated = await (prisma as any).appointment.update({
                where: { id: appointment.id },
                data: {
                    startTime: parsed.startTime,
                    endTime: parsed.endTime,
                    salesOrderId,
                    assignedTechId: responsibleTechnician?.id || null,
                    notes: parsed.notes ?? appointment.notes,
                    status: "BOOKED",
                    isLocked: true
                },
                include: {
                    assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
                    technicianAssignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } } },
                }
            });
            await this.replaceProjectAppointmentAssignments(appointment.id, technicianIds);

            const previousIds = new Set(fallbackTechnicianIds);
            const addedIds = technicianIds.filter((id) => !previousIds.has(id));
            if (addedIds.length) {
                await this.notifyMany(appointment.project.tenantId, addedIds, {
                    type: "PROJECT_INSTALLATION_ASSIGNED",
                    title: "Montaj randevusu size atandı",
                    message: `${appointment.project.projectName} montajı için görevlendirildiniz.`,
                    linkUrl: "/projects/installation/calendar",
                    metadata: { projectId: appointment.projectId, appointmentId: appointment.id, salesOrderId },
                });
            }

            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteAppointment(req: Request, res: Response) {
        try {
            const appointment = await (prisma as any).appointment.findUnique({
                where: { id: req.params.appointmentId as string },
                include: { project: true }
            });
            if (!appointment?.project || appointment.project.tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }

            const dayStart = startOfDay(new Date(appointment.startTime));
            const dayEnd = endOfDay(new Date(appointment.startTime));
            const fallbackScope = {
                projectId: appointment.projectId,
                salesOrderId: appointment.salesOrderId || null,
                appointmentId: null,
            };

            await (prisma as any).$transaction(async (tx: any) => {
                const reports: any[] = await tx.projectReport.findMany({
                    where: {
                        OR: [
                            { appointmentId: appointment.id },
                            { ...fallbackScope, workDate: { gte: dayStart, lte: dayEnd } },
                        ],
                    },
                    select: { id: true },
                });
                const reportIds = reports.map((report) => report.id);
                if (reportIds.length) {
                    await tx.reportMaterial.deleteMany({ where: { reportId: { in: reportIds } } });
                    await tx.projectReport.deleteMany({ where: { id: { in: reportIds } } });
                }

                await tx.projectExpense.deleteMany({
                    where: {
                        OR: [
                            { appointmentId: appointment.id },
                            { ...fallbackScope, expenseDate: { gte: dayStart, lte: dayEnd } },
                        ],
                    },
                });

                const extraMaterials: any[] = await tx.projectExtraMaterial.findMany({
                    where: {
                        OR: [
                            { appointmentId: appointment.id },
                            { ...fallbackScope, addedAt: { gte: dayStart, lte: dayEnd } },
                        ],
                    },
                    select: { id: true, materialId: true, quantity: true },
                });
                for (const row of extraMaterials) {
                    await tx.material.update({
                        where: { id: row.materialId },
                        data: { stockQuantity: { increment: Number(row.quantity || 0) } },
                    });
                }
                if (extraMaterials.length) {
                    await tx.projectExtraMaterial.deleteMany({ where: { id: { in: extraMaterials.map((row) => row.id) } } });
                }

                await tx.appointment.delete({ where: { id: appointment.id } });
            });
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
