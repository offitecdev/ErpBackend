import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { CreateProjectFromTenderUseCase } from '../../application/use-cases/project/CreateProjectFromTenderUseCase';
import { AddProjectReportUseCase, ReportInput } from '../../application/use-cases/project/AddProjectReportUseCase';
import { RequestExtraMaterialUseCase } from '../../application/use-cases/project/RequestExtraMaterialUseCase';
import { ApproveVariationUseCase } from '../../application/use-cases/project/ApproveVariationUseCase';
import { AddProjectExpenseUseCase } from '../../application/use-cases/project/AddProjectExpenseUseCase';
import {
    ProjectRepository,
    type ProjectDetailView as ProjectDetailDataView,
} from '../../infrastructure/repositories/ProjectRepository';
import { ProjectReportRepository } from '../../infrastructure/repositories/ProjectReportRepository';
import { MaterialRepository } from '../../infrastructure/repositories/MaterialRepository';
import prisma from '../../infrastructure/database/prisma.client';
import { SmtpMailService } from '../../infrastructure/services/SmtpMailService';
import { getCompanyTreeTenantIds } from './serviceTenantScope';
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
        // Personnel are shared company-wide -> technicians of the whole tree qualify.
        const tenantIds = await getCompanyTreeTenantIds(tenantId);
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
            // `view=picker` — seçim pencereleri için yalın liste: proje + sipariş
            // başlıkları, rapor/malzeme ağaçları olmadan (takvim sihirbazı kullanır).
            if (req.query.view === "picker") {
                const where: any = { tenantId };
                if (req.query.customerId) where.customerId = String(req.query.customerId);
                // Seçim kutusu yalnızca ilk birkaç satırı ister (take=7); "tümünü
                // gör" penceresi take olmadan tam listeyi çeker.
                const take = Math.min(100, Math.max(0, Number(req.query.take) || 0));
                const projects = await (prisma as any).project.findMany({
                    where,
                    ...(take ? { take } : {}),
                    orderBy: { createdAt: "desc" },
                    select: {
                        id: true,
                        projectName: true,
                        status: true,
                        customerId: true,
                        customer: { select: { id: true, companyName: true } },
                        salesOrders: {
                            orderBy: { createdAt: "asc" },
                            select: { id: true, orderNumber: true, status: true, orderType: true, parentSalesOrderId: true, totalAmount: true },
                        },
                    },
                });
                return res.status(200).json(projects);
            }
            const filter: any = { tenantId };
            if (req.query.status) filter.status = req.query.status;
            if (req.query.managerId) filter.managerId = req.query.managerId;
            if (req.query.customerId) filter.customerId = req.query.customerId;
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
                    // Same lite material shape as the position mappings below —
                    // both feed one material list. `material: true` would also
                    // pull the imageUrl TEXT column, which nothing here renders.
                    select: {
                        id: true,
                        materialId: true,
                        quantity: true,
                        unitCost: true,
                        description: true,
                        material: {
                            select: { id: true, serialId: true, name: true, stockQuantity: true, unitCost: true },
                        },
                    },
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
            // `select`, not `include`: the installation screens read the project
            // only for its name, customer, offer, reports, expenses and extra
            // materials. A bare `include` also ships every project scalar
            // (bookingToken, plannedBudget, overtime settings, tenant/manager ids,
            // dates) plus the manager join — none of which is rendered here.
            project: {
                select: {
                    id: true,
                    projectName: true,
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true } },
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
                    extraMaterials: {
                        orderBy: { addedAt: "desc" as const },
                        include: { material: { select: { id: true, serialId: true, name: true, stockQuantity: true, unitCost: true } } },
                    },
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

    // Technician appointment pop-up: exactly the contact and assignment fields
    // rendered by AppointmentSheet. Order totals, tenders, managers, report
    // trees and image blobs belong to their own screens and are not loaded here.
    private projectTechnicianPopupSelect() {
        return {
            id: true,
            projectId: true,
            salesOrderId: true,
            assignedTechId: true,
            startTime: true,
            endTime: true,
            status: true,
            notes: true,
            ccEmails: true,
            assignedTechnician: {
                select: { id: true, firstName: true, lastName: true },
            },
            technicianAssignments: {
                orderBy: { assignedAt: "asc" as const },
                select: {
                    technicianId: true,
                    technician: { select: { id: true, firstName: true, lastName: true } },
                },
            },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    customer: {
                        select: { id: true, companyName: true, mainPhone: true, address: true },
                    },
                },
            },
        };
    }

    // Fast initial payload for the technician work screen. The expensive tender
    // tree, expenses and catalogue are intentionally loaded by their own tabs.
    private projectInstallationWorkSelect(appointmentId: string) {
        return {
            id: true,
            tenantId: true,
            projectId: true,
            salesOrderId: true,
            assignedTechId: true,
            customerId: true,
            startTime: true,
            endTime: true,
            status: true,
            notes: true,
            isLocked: true,
            assignedTechnician: {
                select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true },
            },
            technicianAssignments: {
                orderBy: { assignedAt: "asc" as const },
                select: {
                    technicianId: true,
                    technician: {
                        select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true },
                    },
                },
            },
            salesOrder: {
                select: { id: true, orderNumber: true, parentSalesOrderId: true, revisionNumber: true },
            },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    overtimeHourlyRate: true,
                    overtimeTolerancePercent: true,
                    customer: {
                        select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true },
                    },
                    salesOrders: {
                        orderBy: { createdAt: "asc" as const },
                        select: { id: true, orderNumber: true },
                    },
                    reports: {
                        where: { appointmentId },
                        orderBy: { reportDate: "desc" as const },
                        select: {
                            id: true,
                            projectId: true,
                            salesOrderId: true,
                            appointmentId: true,
                            employeeId: true,
                            reportDate: true,
                            reportType: true,
                            workDate: true,
                            startedAt: true,
                            endedAt: true,
                            workedMinutes: true,
                            plannedMinutesForDay: true,
                            overtimeMinutes: true,
                            overtimeHourlyRate: true,
                            overtimeCost: true,
                            operationsDone: true,
                            technicalNotes: true,
                            isSigned: true,
                            signedAt: true,
                            employee: {
                                select: { id: true, firstName: true, lastName: true, email: true },
                            },
                            images: {
                                orderBy: { createdAt: "asc" as const },
                                select: { id: true, imageData: true, caption: true, createdAt: true },
                            },
                        },
                    },
                },
            },
        };
    }

    private projectInstallationExpenseSelect() {
        return {
            id: true,
            expenses: {
                orderBy: { expenseDate: "desc" as const },
                select: {
                    id: true,
                    expenseType: true,
                    amount: true,
                    description: true,
                    expenseDate: true,
                    appointmentId: true,
                    salesOrderId: true,
                },
            },
        };
    }

    private projectInstallationMaterialSelect() {
        return {
            id: true,
            salesOrder: {
                select: {
                    id: true,
                    orderNumber: true,
                    parentSalesOrderId: true,
                    revisionNumber: true,
                    tenderId: true,
                    tender: this.tenderMaterialInclude(),
                },
            },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    tender: this.tenderMaterialInclude(),
                },
            },
            extraMaterials: {
                orderBy: { addedAt: "desc" as const },
                select: {
                    id: true,
                    materialId: true,
                    quantity: true,
                    unitPrice: true,
                    description: true,
                    addedAt: true,
                    appointmentId: true,
                    salesOrderId: true,
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
        };
    }

    // Teknisyen montaj listesi için asgari yük: tablo satırı (sipariş no, müşteri,
    // proje, tarih) + durum türetimi (rapor imzalı mı — findReport eşleşmesi için
    // gereken skaler alanlar). projectInstallationInclude'un taşıdığı rapor
    // GÖRSELLERİ / müşteri imzası (base64 LongText'ler), malzeme ağaçları,
    // giderler burada bilerek yok — liste saniyeler yerine milisaniyede dönsün.
    private projectMontageListInclude() {
        return {
            salesOrder: { select: { id: true, orderNumber: true } },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    customer: { select: { id: true, companyName: true } },
                    salesOrders: {
                        orderBy: { createdAt: "asc" as const },
                        select: { id: true, orderNumber: true },
                    },
                    reports: {
                        select: {
                            id: true,
                            isSigned: true,
                            appointmentId: true,
                            salesOrderId: true,
                            workDate: true,
                            reportDate: true,
                            startedAt: true,
                        },
                    },
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

            // Montaj tabloları SUNUCUDA sayfalanır ve yalnızca tablo kolonlarını
            // alır: satır başına düz bir DTO döner (sipariş no, müşteri, proje,
            // saatler, imza durumu). Pop-up/iş ekranı verileri burada YOK — onlar
            // açıldıkları anda kendi detay uçlarından yüklenir.
            if (String(req.query.view || "") === "montage-page") {
                return this.listMontageOrdersPage(req, res, start, end);
            }

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
                // The calendar asks for the trimmed grid include, the montage list
                // for the row-only include; the installation screens (which derive
                // their detail from this list) keep the full one.
                include: String(req.query.view || "") === "calendar"
                    ? this.projectCalendarListInclude()
                    : String(req.query.view || "") === "montage"
                        ? this.projectMontageListInclude()
                        : this.projectInstallationInclude(),
            });
            res.status(200).json(appointments);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Sayfalı montaj listesi: mode=active (BOOKED, en yakını önce) |
    // completed (COMPLETED, en yenisi önce), 10'arlı sayfa. "İmzalı mı"
    // yalnızca SAYFADAKİ randevuların raporlarına bakılarak hesaplanır —
    // frontend'in findReport kuralının aynısı (aynı gün + randevu/sipariş
    // kapsamı), böylece durum rozetleri iki tarafta aynı sonucu verir.
    private async listMontageOrdersPage(req: Request, res: Response, start: Date, end: Date) {
        const mode = String(req.query.mode || "active") === "completed" ? "completed" : "active";
        const page = Math.max(1, Number(req.query.page || 1) || 1);
        const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 10) || 10));

        const where: any = {
            tenantId: (req as any).user!.tenantId,
            OR: [
                { assignedTechId: (req as any).user!.id },
                { technicianAssignments: { some: { technicianId: (req as any).user!.id } } },
            ],
            projectId: { not: null },
            status: mode === "completed" ? "COMPLETED" : "BOOKED",
            startTime: { gte: start },
            endTime: { lte: end },
            ...(mode === "completed" ? { reports: { some: { employeeId: (req as any).user!.id } } } : {}),
        };

        const fetched = await (prisma as any).appointment.findMany({
            where,
            orderBy: { startTime: mode === "completed" ? "desc" : "asc" },
            skip: (page - 1) * pageSize,
            take: pageSize + 1,
            select: {
                id: true,
                startTime: true,
                endTime: true,
                status: true,
                salesOrderId: true,
                projectId: true,
                salesOrder: { select: { orderNumber: true } },
                project: {
                    select: {
                        projectName: true,
                        customer: { select: { companyName: true } },
                    },
                },
                ...(mode === "completed"
                    ? {
                        reports: {
                            where: { employeeId: (req as any).user!.id },
                            orderBy: { reportDate: "desc" as const },
                            take: 1,
                            select: { id: true, isSigned: true },
                        },
                    }
                    : {}),
            },
        });
        const hasMore = fetched.length > pageSize;
        const appointments = fetched.slice(0, pageSize);
        const offset = (page - 1) * pageSize;
        const total = hasMore
            ? await (prisma as any).appointment.count({ where })
            : offset + appointments.length;

        // İmza durumu yalnızca appointmentId üzerinden hesaplanır. Bir siparişin
        // başka gün/randevusuna ait raporu bu satırı imzalı gösteremez.
        res.status(200).json({
            items: appointments.map((appt: any) => ({
                id: appt.id,
                startTime: appt.startTime,
                endTime: appt.endTime,
                status: appt.status,
                projectId: appt.projectId,
                salesOrderId: appt.salesOrderId,
                orderNumber: appt.salesOrder?.orderNumber || appt.project?.projectName || appt.id,
                projectName: appt.project?.projectName || "-",
                customerName: appt.project?.customer?.companyName || "-",
                fieldReportId: appt.reports?.[0]?.id || null,
                signed: Boolean(appt.reports?.[0]?.isSigned),
            })),
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            page,
            pageSize,
        });
    }

    /**
     * Technician report registry used by the montage panel.
     *
     * The list deliberately returns only the visible table columns. In
     * particular it never selects report images, checklist JSON or the
     * LongText customer-signature fields. Field-report preview data is loaded
     * from getMyMontageReport only after the user opens a row.
     */
    async listMyMontageReportOrders(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const page = Math.max(1, Number(req.query.page || 1) || 1);
            const pageSize = Math.min(20, Math.max(1, Number(req.query.pageSize || 10) || 10));
            const search = String(req.query.search || "").trim();
            const offset = (page - 1) * pageSize;
            const searchFilter = search
                ? Prisma.sql`
                    AND (
                        so.orderNumber LIKE ${`%${search}%`}
                        OR p.projectName LIKE ${`%${search}%`}
                        OR c.companyName LIKE ${`%${search}%`}
                    )
                `
                : Prisma.empty;

            // One narrow query replaces the previous sequential groupBy + order
            // lookup (+ occasional second groupBy for total). COUNT(*) OVER()
            // keeps exact 10-row pagination without another database round trip.
            const rows = await prisma.$queryRaw<Array<{
                salesOrderId: string;
                orderNumber: string;
                projectId: string | null;
                projectName: string | null;
                customerName: string | null;
                fieldReportCount: bigint | number;
                latestReportDate: Date | null;
                totalRows: bigint | number;
            }>>(Prisma.sql`
                SELECT
                    so.id AS salesOrderId,
                    so.orderNumber AS orderNumber,
                    so.projectId AS projectId,
                    p.projectName AS projectName,
                    c.companyName AS customerName,
                    COUNT(pr.id) AS fieldReportCount,
                    MAX(pr.reportDate) AS latestReportDate,
                    COUNT(*) OVER() AS totalRows
                FROM ProjectReport pr
                INNER JOIN Project p
                    ON p.id = pr.projectId
                    AND p.tenantId = ${tenantId}
                INNER JOIN SalesOrder so
                    ON so.id = pr.salesOrderId
                    AND so.tenantId = ${tenantId}
                LEFT JOIN Customer c
                    ON c.id = p.customerId
                WHERE pr.employeeId = ${employeeId}
                    AND pr.salesOrderId IS NOT NULL
                    ${searchFilter}
                GROUP BY
                    so.id,
                    so.orderNumber,
                    so.projectId,
                    p.projectName,
                    c.companyName
                ORDER BY latestReportDate DESC
                LIMIT ${pageSize}
                OFFSET ${offset}
            `);
            const total = Number(rows[0]?.totalRows || 0);

            res.status(200).json({
                items: rows.map((row) => ({
                    salesOrderId: row.salesOrderId,
                    orderNumber: row.orderNumber || row.salesOrderId,
                    projectId: row.projectId || null,
                    projectName: row.projectName || "-",
                    customerName: row.customerName || "-",
                    fieldReportCount: Number(row.fieldReportCount || 0),
                    latestReportDate: row.latestReportDate || null,
                })),
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
                page,
                pageSize,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getMyMontageReportOrder(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const salesOrderId = String(req.params.salesOrderId || "");
            const fieldReports = await (prisma as any).projectReport.findMany({
                where: {
                    employeeId,
                    salesOrderId,
                    project: { tenantId },
                },
                orderBy: { reportDate: "desc" },
                select: {
                    id: true,
                    appointmentId: true,
                    reportDate: true,
                    workDate: true,
                    isSigned: true,
                    appointment: {
                        select: { id: true, startTime: true, endTime: true },
                    },
                    employee: {
                        select: { firstName: true, lastName: true },
                    },
                },
            });
            if (!fieldReports.length) return res.status(404).json({ error: "Sipariş saha raporu bulunamadı." });

            const order = await (prisma as any).salesOrder.findFirst({
                where: { id: salesOrderId, tenantId },
                select: {
                    id: true,
                    orderNumber: true,
                    projectId: true,
                    project: {
                        select: {
                            projectName: true,
                            customer: { select: { companyName: true } },
                        },
                    },
                },
            });
            if (!order) return res.status(404).json({ error: "Sipariş bulunamadı." });

            const [deliveryReport, exactGeneral, fallbackGeneral] = await Promise.all([
                (prisma as any).deliveryReport.findFirst({
                    where: { tenantId, salesOrderId },
                    orderBy: { createdAt: "desc" },
                    select: { id: true, isSigned: true, createdAt: true, checklistName: true },
                }),
                (prisma as any).signatureRequest.findFirst({
                    where: { tenantId, reportType: "GENERAL", reportId: salesOrderId },
                    orderBy: { createdAt: "desc" },
                    select: { id: true, status: true, createdAt: true },
                }),
                (prisma as any).signatureRequest.findFirst({
                    where: {
                        tenantId,
                        reportType: "GENERAL",
                        projectId: order.projectId || "__no_match__",
                        title: { contains: order.orderNumber },
                    },
                    orderBy: { createdAt: "desc" },
                    select: { id: true, status: true, createdAt: true },
                }),
            ]);

            res.status(200).json({
                order: {
                    salesOrderId: order.id,
                    orderNumber: order.orderNumber,
                    projectId: order.projectId,
                    projectName: order.project?.projectName || "-",
                    customerName: order.project?.customer?.companyName || "-",
                },
                fieldReports,
                deliveryReport,
                generalReport: exactGeneral || fallbackGeneral,
                createAppointmentId: fieldReports.find((row: any) => row.appointmentId)?.appointmentId || null,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getMyMontageReportResources(req: Request, res: Response) {
        try {
            const report = await (prisma as any).projectReport.findFirst({
                where: {
                    id: String(req.params.reportId),
                    employeeId: req.user!.id,
                    project: { tenantId: req.user!.tenantId },
                },
                select: {
                    id: true,
                    appointmentId: true,
                    usedMaterials: {
                        select: {
                            id: true,
                            quantity: true,
                            costAtTime: true,
                            article: { select: { articleCode: true, name: true, unit: true } },
                            material: { select: { name: true } },
                        },
                    },
                },
            });
            if (!report) return res.status(404).json({ error: "Saha raporu bulunamadı." });
            if (!report.appointmentId) {
                return res.status(200).json({ usedMaterials: report.usedMaterials, extraMaterials: [], expenses: [] });
            }
            const [extraMaterials, expenses] = await Promise.all([
                (prisma as any).projectExtraMaterial.findMany({
                    where: { appointmentId: report.appointmentId },
                    select: {
                        id: true,
                        quantity: true,
                        unitPrice: true,
                        description: true,
                        material: { select: { name: true } },
                    },
                }),
                (prisma as any).projectExpense.findMany({
                    where: { appointmentId: report.appointmentId },
                    select: {
                        id: true,
                        expenseType: true,
                        amount: true,
                        description: true,
                        expenseDate: true,
                    },
                }),
            ]);
            res.status(200).json({ usedMaterials: report.usedMaterials, extraMaterials, expenses });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listMyMontageReports(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const page = Math.max(1, Number(req.query.page || 1) || 1);
            const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 10) || 10));
            const kind = ["field", "delivery", "general"].includes(String(req.query.kind))
                ? String(req.query.kind)
                : "all";
            const signed = ["signed", "unsigned"].includes(String(req.query.signed))
                ? String(req.query.signed)
                : "all";
            const search = String(req.query.search || "").trim();
            const signedValue = signed === "all" ? undefined : signed === "signed";

            const matchingProjects = search
                ? await (prisma as any).project.findMany({
                    where: {
                        tenantId,
                        OR: [
                            { projectName: { contains: search } },
                            { customer: { is: { companyName: { contains: search } } } },
                        ],
                    },
                    select: { id: true },
                })
                : [];
            const matchingOrders = search
                ? await (prisma as any).salesOrder.findMany({
                    where: {
                        tenantId,
                        orderNumber: { contains: search },
                    },
                    select: { id: true },
                })
                : [];
            const matchingProjectIds = matchingProjects.map((row: any) => row.id);
            const matchingOrderIds = matchingOrders.map((row: any) => row.id);

            const fieldWhere: any = {
                employeeId,
                project: { tenantId },
                ...(signedValue === undefined ? {} : { isSigned: signedValue }),
            };
            const deliveryWhere: any = {
                tenantId,
                employeeId,
                ...(signedValue === undefined ? {} : { isSigned: signedValue }),
            };
            const assignedProjectRows = kind === "all" || kind === "general"
                ? await (prisma as any).appointment.findMany({
                    where: {
                        tenantId,
                        projectId: { not: null },
                        OR: [
                            { assignedTechId: employeeId },
                            { technicianAssignments: { some: { technicianId: employeeId } } },
                        ],
                    },
                    distinct: ["projectId"],
                    select: { projectId: true },
                })
                : [];
            const assignedProjectIds = assignedProjectRows.map((row: any) => row.projectId).filter(Boolean);
            const generalWhere: any = {
                tenantId,
                reportType: "GENERAL",
                projectId: assignedProjectIds.length ? { in: assignedProjectIds } : "__no_match__",
                ...(signedValue === undefined
                    ? {}
                    : signedValue
                        ? { status: "SIGNED" }
                        : { status: { not: "SIGNED" } }),
            };

            if (search) {
                fieldWhere.OR = [
                    { operationsDone: { contains: search } },
                    ...(matchingProjectIds.length ? [{ projectId: { in: matchingProjectIds } }] : []),
                    ...(matchingOrderIds.length ? [{ salesOrderId: { in: matchingOrderIds } }] : []),
                ];
                deliveryWhere.OR = [
                    ...(matchingProjectIds.length ? [{ projectId: { in: matchingProjectIds } }] : []),
                    ...(matchingOrderIds.length ? [{ salesOrderId: { in: matchingOrderIds } }] : []),
                ];
                if (!deliveryWhere.OR.length) deliveryWhere.id = "__no_match__";
                generalWhere.OR = [
                    { title: { contains: search } },
                    ...(matchingProjectIds.length ? [{ projectId: { in: matchingProjectIds } }] : []),
                ];
            }

            const includeField = kind !== "delivery" && kind !== "general";
            const includeDelivery = kind !== "field" && kind !== "general";
            const includeGeneral = kind !== "field" && kind !== "delivery";
            const requestedRows = page * pageSize;

            const [fieldTotal, deliveryTotal, generalTotal, fieldReports, deliveryReports, generalReports] = await Promise.all([
                includeField ? (prisma as any).projectReport.count({ where: fieldWhere }) : 0,
                includeDelivery ? (prisma as any).deliveryReport.count({ where: deliveryWhere }) : 0,
                includeGeneral ? (prisma as any).signatureRequest.count({ where: generalWhere }) : 0,
                includeField
                    ? (prisma as any).projectReport.findMany({
                        where: fieldWhere,
                        orderBy: { reportDate: "desc" },
                        take: requestedRows,
                        select: {
                            id: true,
                            reportDate: true,
                            workDate: true,
                            appointmentId: true,
                            projectId: true,
                            salesOrderId: true,
                            isSigned: true,
                            project: {
                                select: {
                                    projectName: true,
                                    customer: { select: { companyName: true } },
                                },
                            },
                            salesOrder: { select: { orderNumber: true } },
                        },
                    })
                    : [],
                includeDelivery
                    ? (prisma as any).deliveryReport.findMany({
                        where: deliveryWhere,
                        orderBy: { createdAt: "desc" },
                        take: requestedRows,
                        select: {
                            id: true,
                            createdAt: true,
                            appointmentId: true,
                            projectId: true,
                            salesOrderId: true,
                            isSigned: true,
                        },
                    })
                    : [],
                includeGeneral
                    ? (prisma as any).signatureRequest.findMany({
                        where: generalWhere,
                        orderBy: { createdAt: "desc" },
                        take: requestedRows,
                        select: {
                            id: true,
                            createdAt: true,
                            projectId: true,
                            title: true,
                            status: true,
                            signedAt: true,
                        },
                    })
                    : [],
            ]);

            // DeliveryReport intentionally has no Prisma relation to project/order.
            // Resolve just the labels required by the current page in two batched
            // scalar queries.
            const deliveryProjectIds = [...new Set([
                ...deliveryReports.map((row: any) => row.projectId),
                ...generalReports.map((row: any) => row.projectId),
            ].filter(Boolean))] as string[];
            const deliveryOrderIds = [...new Set(deliveryReports.map((row: any) => row.salesOrderId).filter(Boolean))] as string[];
            const [deliveryProjects, deliveryOrders] = await Promise.all([
                deliveryProjectIds.length
                    ? (prisma as any).project.findMany({
                        where: { id: { in: deliveryProjectIds }, tenantId },
                        select: {
                            id: true,
                            projectName: true,
                            customer: { select: { companyName: true } },
                        },
                    })
                    : [],
                deliveryOrderIds.length
                    ? (prisma as any).salesOrder.findMany({
                        where: { id: { in: deliveryOrderIds }, tenantId },
                        select: { id: true, orderNumber: true },
                    })
                    : [],
            ]);
            const projectLabels = new Map<string, any>(deliveryProjects.map((row: any) => [row.id, row]));
            const orderLabels = new Map<string, any>(deliveryOrders.map((row: any) => [row.id, row]));

            const rows = [
                ...fieldReports.map((report: any) => ({
                    key: `field-${report.id}`,
                    id: report.id,
                    kind: "field",
                    date: report.workDate || report.reportDate,
                    customerName: report.project?.customer?.companyName || "-",
                    projectName: report.project?.projectName || "-",
                    projectId: report.projectId || null,
                    orderNumber: report.salesOrder?.orderNumber || "-",
                    appointmentId: report.appointmentId || null,
                    signed: Boolean(report.isSigned),
                })),
                ...deliveryReports.map((report: any) => {
                    const project = report.projectId ? projectLabels.get(report.projectId) : null;
                    const order = report.salesOrderId ? orderLabels.get(report.salesOrderId) : null;
                    return {
                        key: `delivery-${report.id}`,
                        id: report.id,
                        kind: "delivery",
                        date: report.createdAt,
                        customerName: project?.customer?.companyName || "-",
                        projectName: project?.projectName || "-",
                        projectId: report.projectId || null,
                        orderNumber: order?.orderNumber || "-",
                        appointmentId: report.appointmentId || null,
                        signed: Boolean(report.isSigned),
                    };
                }),
                ...generalReports.map((report: any) => {
                    const project = report.projectId ? projectLabels.get(report.projectId) : null;
                    return {
                        key: `general-${report.id}`,
                        id: report.id,
                        kind: "general",
                        date: report.createdAt,
                        customerName: project?.customer?.companyName || "-",
                        projectName: project?.projectName || "-",
                        projectId: report.projectId || null,
                        orderNumber: report.title || "-",
                        appointmentId: null,
                        signed: report.status === "SIGNED",
                    };
                }),
            ]
                .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
                .slice((page - 1) * pageSize, page * pageSize);

            const total = Number(fieldTotal) + Number(deliveryTotal) + Number(generalTotal);
            res.status(200).json({
                items: rows,
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
                page,
                pageSize,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /** Full field-report preview, fetched only after a report row is opened. */
    async getMyMontageReport(req: Request, res: Response) {
        try {
            const report = await (prisma as any).projectReport.findFirst({
                where: {
                    id: String(req.params.reportId),
                    employeeId: req.user!.id,
                    project: { tenantId: req.user!.tenantId },
                },
                include: {
                    project: {
                        select: {
                            id: true,
                            projectName: true,
                            customer: { select: { id: true, companyName: true } },
                        },
                    },
                    salesOrder: { select: { id: true, orderNumber: true } },
                    appointment: { select: { id: true, startTime: true, endTime: true } },
                    employee: { select: { id: true, firstName: true, lastName: true } },
                    images: {
                        orderBy: { createdAt: "asc" },
                        select: { id: true, imageData: true, caption: true },
                    },
                },
            });
            if (!report) return res.status(404).json({ error: "Saha raporu bulunamadı." });
            res.status(200).json(report);
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
            const appointmentId = String(req.params.appointmentId || "");
            const section = String(req.query.section || "work");
            const where = {
                id: appointmentId,
                tenantId: req.user!.tenantId,
                OR: [
                    { assignedTechId: req.user!.id },
                    { technicianAssignments: { some: { technicianId: req.user!.id } } },
                ],
                projectId: { not: null },
            };
            const appointment = section === "general"
                ? await (prisma as any).appointment.findFirst({
                    where,
                    include: this.projectInstallationInclude(),
                })
                : await (prisma as any).appointment.findFirst({
                    where,
                    select: section === "expenses"
                        ? this.projectInstallationExpenseSelect()
                        : section === "materials"
                            ? this.projectInstallationMaterialSelect()
                            : this.projectInstallationWorkSelect(appointmentId),
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
            const appointment = await (prisma as any).appointment.findFirst(
                opts.technicianScope
                    ? { where, select: this.projectTechnicianPopupSelect() }
                    : { where, include: this.projectCalendarDetailInclude() },
            );
            if (!appointment) return res.status(404).json({ error: "Randevu bulunamadı." });
            res.status(200).json(appointment);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getById(req: Request, res: Response) {
        try {
            const allowedViews = new Set([
                "overview",
                "details",
                "planning",
                "fieldReports",
                "generalReport",
                "delivery",
                "signatures",
                "expenses",
                "materials",
                "overtime",
                "billing",
                "addons",
            ]);
            const requestedView = String(req.query.view || "");
            if (requestedView && !allowedViews.has(requestedView)) {
                return res.status(400).json({ error: "Geçersiz proje detay görünümü." });
            }
            const project = requestedView
                ? await this.projectRepository.findDetailById(
                    req.params.id as string,
                    req.user!.tenantId,
                    requestedView as ProjectDetailDataView,
                )
                : await this.projectRepository.findById(req.params.id as string, req.user!.tenantId);
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

            // LİSTE GÖVDESİ — rapor İÇERİĞİ taşınmaz. Tablolar yalnızca tarih,
            // süre/mesai kolonları, etiketler ve onay/imza durumunu çiziyor.
            // `operationsDone` / `technicalNotes` / `customerSignature` (base64
            // imza) ile `usedMaterials`, `images`, `employee`, `appointment`
            // ilişkileri sadece PDF üretilirken gerekiyor; PDF yolu zaten projeyi
            // `GET /projects/:id` ile baştan çekip tam raporu oradan okuyor.
            //
            // Bu ilişkiler Prisma'da ilişki başına AYRI bir sorgu turu demekti
            // (usedMaterials iki seviye olduğu için iki tur) — uzak veritabanında
            // ifade başına ~100 ms. Kalan iki ilişki tek ham JOIN'de geliyor.
            const whereSql: Prisma.Sql[] = [Prisma.sql`pj.tenantId = ${tenantId}`];
            if (startRaw && !Number.isNaN(startRaw.getTime())) {
                whereSql.push(Prisma.sql`pr.workDate >= ${startOfDay(startRaw)}`);
            }
            if (endRaw && !Number.isNaN(endRaw.getTime())) {
                whereSql.push(Prisma.sql`pr.workDate <= ${endOfDay(endRaw)}`);
            }
            if (search) {
                const pattern = `%${search}%`;
                whereSql.push(Prisma.sql`(
                    pj.projectName LIKE ${pattern}
                    OR c.companyName LIKE ${pattern}
                    OR pr.operationsDone LIKE ${pattern}
                )`);
            }

            const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT
                    pr.id, pr.projectId, pr.salesOrderId, pr.appointmentId,
                    pr.reportDate, pr.workDate, pr.startedAt, pr.endedAt,
                    pr.workedMinutes, pr.plannedMinutesForDay, pr.overtimeMinutes,
                    pr.overtimeHourlyRate, pr.overtimeCost,
                    pr.isSigned, pr.hoursApprovedAt, pr.autoApproved,
                    pj.projectName AS projectName,
                    c.id AS customerId,
                    c.companyName AS customerName,
                    so.orderNumber AS orderNumber
                FROM ProjectReport pr
                INNER JOIN Project pj ON pj.id = pr.projectId
                LEFT JOIN Customer c ON c.id = pj.customerId
                LEFT JOIN SalesOrder so ON so.id = pr.salesOrderId
                WHERE ${Prisma.join(whereSql, ' AND ')}
                ORDER BY pr.reportDate DESC
                LIMIT 500
            `);

            const reports = rows.map((row) => ({
                id: row.id,
                projectId: row.projectId,
                salesOrderId: row.salesOrderId ?? null,
                appointmentId: row.appointmentId ?? null,
                reportDate: row.reportDate,
                workDate: row.workDate,
                startedAt: row.startedAt ?? null,
                endedAt: row.endedAt ?? null,
                workedMinutes: Number(row.workedMinutes ?? 0),
                plannedMinutesForDay: Number(row.plannedMinutesForDay ?? 0),
                overtimeMinutes: Number(row.overtimeMinutes ?? 0),
                overtimeHourlyRate: Number(row.overtimeHourlyRate ?? 0),
                overtimeCost: Number(row.overtimeCost ?? 0),
                isSigned: Boolean(row.isSigned),
                hoursApprovedAt: row.hoursApprovedAt ?? null,
                autoApproved: Boolean(row.autoApproved),
                project: {
                    id: row.projectId,
                    projectName: row.projectName ?? null,
                    customer: row.customerId
                        ? { id: row.customerId, companyName: row.customerName ?? null }
                        : null,
                },
                salesOrder: row.salesOrderId
                    ? { id: row.salesOrderId, orderNumber: row.orderNumber ?? null }
                    : null,
            }));
            res.status(200).json(reports);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listMaterials(req: Request, res: Response) {
        try {
            const materials = await this.materialRepository.list(
                req.user!.tenantId,
                { compact: req.query.view === "picker" },
            );
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
            const report = await (prisma as any).projectReport.findFirst({
                where: { id: reportId, project: { tenantId: req.user!.tenantId } },
                select: { id: true },
            });
            if (!report) return res.status(404).json({ error: "Saha raporu bulunamadı." });
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

            const isAddon = Boolean(order.parentSalesOrderId);

            // Deleting a main order removes its addon orders with it, so the whole
            // family (order + addons) must be un-billed before anything is deleted.
            const addons: any[] = isAddon
                ? []
                : await (prisma as any).salesOrder.findMany({
                    where: { parentSalesOrderId: order.id, projectId, tenantId },
                    select: { id: true },
                });
            const familyIds = [order.id, ...addons.map((addon) => addon.id)];
            const invoiceCount = await (prisma as any).invoice.count({ where: { salesOrderId: { in: familyIds } } });
            if (invoiceCount > 0) {
                return res.status(400).json({ error: "Faturalandırılmış bir sipariş silinemez." });
            }

            await (prisma as any).$transaction(async (tx: any) => {
                if (!isAddon) {
                    // Records normally carry the parent order id, but sweep the whole
                    // family in case anything was ever stamped with an addon id.
                    // Reports own their materials/images via onDelete: Cascade.
                    const reports: any[] = await tx.projectReport.findMany({
                        where: { projectId, salesOrderId: { in: familyIds } },
                        select: { id: true },
                    });
                    if (reports.length) {
                        await tx.projectReport.deleteMany({ where: { id: { in: reports.map((r) => r.id) } } });
                    }

                    // Restock every extra material before removing it.
                    const extraMaterials: any[] = await tx.projectExtraMaterial.findMany({
                        where: { projectId, salesOrderId: { in: familyIds } },
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

                    await tx.projectExpense.deleteMany({ where: { projectId, salesOrderId: { in: familyIds } } });

                    // Appointment assignments cascade on Appointment delete.
                    await tx.appointment.deleteMany({ where: { projectId, salesOrderId: { in: familyIds } } });

                    // Addon orders carry no records of their own (they bill the parent's
                    // time slice, deleted above) — remove them entirely, not just zeroed.
                    if (addons.length) {
                        await tx.salesOrder.deleteMany({ where: { id: { in: addons.map((addon) => addon.id) } } });
                    }
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
        // CC listesi gönderilmediyse undefined kalır (update mevcut değeri korur).
        const ccEmails = body.ccEmails === undefined
            ? undefined
            : (Array.isArray(body.ccEmails) ? body.ccEmails : String(body.ccEmails || "").split(","))
                .map((value: unknown) => String(value ?? "").trim())
                .filter((email: string, index: number, list: string[]) => email.includes("@") && list.indexOf(email) === index);
        return {
            startTime,
            endTime,
            notes: body.notes === undefined ? undefined : String(body.notes || "").trim() || null,
            ccEmails
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
                    ccEmails: parsed.ccEmails ?? [],
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
                    ...(parsed.ccEmails !== undefined ? { ccEmails: parsed.ccEmails } : {}),
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
