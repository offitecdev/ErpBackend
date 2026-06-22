"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectController = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const SmtpMailService_1 = require("../../infrastructure/services/SmtpMailService");
const serviceTenantScope_1 = require("./serviceTenantScope");
const nanoid_1 = require("nanoid");
const smtp = new SmtpMailService_1.SmtpMailService();
const startOfDay = (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};
const endOfDay = (date) => {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
};
const normalizeIdList = (value) => Array.isArray(value)
    ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
    : [];
const formatDateTime = (date) => date.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
const PROJECT_EXPENSE_TYPES = ["Nakliye", "Ekipman Kiralama", "Dış hizmetler", "Taşeron", "Diğer"];
class ProjectController {
    createProjectUseCase;
    addReportUseCase;
    requestVariationUseCase;
    approveVariationUseCase;
    addExpenseUseCase;
    projectRepository;
    reportRepository;
    materialRepository;
    constructor(createProjectUseCase, addReportUseCase, requestVariationUseCase, approveVariationUseCase, addExpenseUseCase, projectRepository, reportRepository, materialRepository) {
        this.createProjectUseCase = createProjectUseCase;
        this.addReportUseCase = addReportUseCase;
        this.requestVariationUseCase = requestVariationUseCase;
        this.approveVariationUseCase = approveVariationUseCase;
        this.addExpenseUseCase = addExpenseUseCase;
        this.projectRepository = projectRepository;
        this.reportRepository = reportRepository;
        this.materialRepository = materialRepository;
    }
    async resolveProjectSalesOrderId(projectId, tenantId, rawSalesOrderId) {
        const salesOrderId = String(rawSalesOrderId || '').trim();
        if (!salesOrderId)
            return null;
        const salesOrder = await prisma_client_1.default.salesOrder.findFirst({
            where: { id: salesOrderId, projectId, tenantId },
            select: { id: true },
        });
        if (!salesOrder)
            throw new Error("Sipariş bu projeye ait değil.");
        return salesOrder.id;
    }
    async notify(input) {
        await prisma_client_1.default.notification.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId: input.tenantId,
                recipientEmployeeId: input.recipientEmployeeId || null,
                type: input.type,
                title: input.title,
                message: input.message,
                linkUrl: input.linkUrl || null,
                metadata: input.metadata,
            },
        });
    }
    async notifyMany(tenantId, recipientEmployeeIds, payload) {
        for (const recipientEmployeeId of [...new Set(recipientEmployeeIds.filter(Boolean))]) {
            await this.notify({ tenantId, recipientEmployeeId, ...payload });
        }
    }
    async validateProjectTechnician(technicianId, tenantId) {
        const id = String(technicianId || "").trim();
        if (!id)
            return null;
        const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(tenantId);
        const employee = await prisma_client_1.default.employee.findFirst({
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
        if (!employee)
            throw new Error("Seçilen teknisyen bulunamadı.");
        return employee;
    }
    async validateProjectTechnicians(technicianIds, tenantId) {
        const ids = [...new Set(technicianIds.filter(Boolean))];
        if (!ids.length)
            return [];
        const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(tenantId);
        const employees = await prisma_client_1.default.employee.findMany({
            where: {
                id: { in: ids },
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
            },
        });
        const found = new Set(employees.map((employee) => employee.id));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length)
            throw new Error("Seçilen teknisyenlerden biri bulunamadı.");
        const byId = new Map(employees.map((employee) => [employee.id, employee]));
        return ids.map((id) => byId.get(id)).filter(Boolean);
    }
    async projectManagerRecipients(project) {
        const ids = [project.managerId].filter(Boolean);
        if (ids.length)
            return ids;
        const managers = await prisma_client_1.default.employee.findMany({
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
        return managers.map((employee) => employee.id);
    }
    async notifyProjectManagers(project, payload) {
        const recipientIds = await this.projectManagerRecipients(project);
        if (recipientIds.length) {
            await this.notifyMany(project.tenantId, recipientIds, payload);
        }
        else {
            await this.notify({ tenantId: project.tenantId, ...payload });
        }
    }
    async createAddonOrderForParent(project, parentSalesOrderId, employeeId) {
        const tenantId = project.tenantId;
        const parentOrder = await prisma_client_1.default.salesOrder.findFirst({ where: { id: parentSalesOrderId, projectId: project.id, tenantId } });
        if (!parentOrder)
            return null;
        const addons = await prisma_client_1.default.salesOrder.findMany({
            where: { parentSalesOrderId, projectId: project.id, tenantId },
            orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }],
        });
        const previousAddon = addons[0] || null;
        const nextRevision = Math.max(0, ...addons.map((order) => Number(order.revisionNumber || 0))) + 1;
        const createdAtFilter = previousAddon?.createdAt ? { gt: previousAddon.createdAt } : undefined;
        const [expenses, extraMaterials, reports] = await Promise.all([
            prisma_client_1.default.projectExpense.findMany({
                where: {
                    projectId: project.id,
                    salesOrderId: parentSalesOrderId,
                    ...(createdAtFilter ? { expenseDate: createdAtFilter } : {}),
                },
            }),
            prisma_client_1.default.projectExtraMaterial.findMany({
                where: {
                    projectId: project.id,
                    salesOrderId: parentSalesOrderId,
                    ...(createdAtFilter ? { addedAt: createdAtFilter } : {}),
                },
            }),
            prisma_client_1.default.projectReport.findMany({
                where: {
                    projectId: project.id,
                    salesOrderId: parentSalesOrderId,
                    ...(createdAtFilter ? { reportDate: createdAtFilter } : {}),
                },
            }),
        ]);
        const expenseTotal = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const materialTotal = extraMaterials.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
        const overtimeTotal = reports.reduce((sum, item) => sum + Number(item.overtimeCost || 0), 0);
        const totalAmount = expenseTotal + materialTotal + overtimeTotal;
        if (totalAmount <= 0)
            return null;
        const orderNumber = `${parentOrder.orderNumber}-N${nextRevision}`;
        const addonOrder = await prisma_client_1.default.salesOrder.create({
            data: {
                id: (0, nanoid_1.nanoid)(10),
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
    async list(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const filter = { tenantId };
            if (req.query.status)
                filter.status = req.query.status;
            if (req.query.managerId)
                filter.managerId = req.query.managerId;
            if (req.query.search)
                filter.search = req.query.search;
            const projects = await this.projectRepository.findAll(filter);
            res.status(200).json(projects);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async listTechnicians(req, res) {
        try {
            const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(req.user.tenantId);
            const technicians = await prisma_client_1.default.employee.findMany({
                where: {
                    tenantId: { in: tenantIds },
                    isActive: true,
                    OR: [
                        { roleName: "Teknisyen" },
                        { employeeRoles: { some: { role: { roleName: "Teknisyen" } } } },
                    ],
                },
                orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
                select: {
                    id: true,
                    tenantId: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    phone: true,
                    title: true,
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
                roleName: employee.employeeRoles.find((employeeRole) => employeeRole.role.roleName === "Teknisyen")?.role.roleName || employee.roleName,
            })));
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    tenderMaterialInclude() {
        return {
            select: {
                id: true,
                tenderNumber: true,
                status: true,
                projectId: true,
                usedMaterials: {
                    orderBy: { createdAt: "desc" },
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
    projectInstallationInclude() {
        return {
            assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
            technicianAssignments: { orderBy: { assignedAt: "asc" }, include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } } },
            salesOrder: { select: { id: true, orderNumber: true, totalAmount: true, parentSalesOrderId: true, revisionNumber: true, tenderId: true, tender: this.tenderMaterialInclude() } },
            project: {
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true } },
                    manager: { select: { id: true, firstName: true, lastName: true, email: true } },
                    tender: this.tenderMaterialInclude(),
                    salesOrders: {
                        orderBy: { createdAt: "asc" },
                        select: { id: true, orderNumber: true, totalAmount: true, parentSalesOrderId: true, revisionNumber: true, createdAt: true },
                    },
                    reports: {
                        orderBy: { reportDate: "desc" },
                        include: {
                            employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                            images: { orderBy: { createdAt: "asc" } },
                        },
                    },
                    expenses: { orderBy: { expenseDate: "desc" } },
                    extraMaterials: { orderBy: { addedAt: "desc" }, include: { material: true } },
                },
            },
        };
    }
    async listMyInstallations(req, res) {
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
            const appointments = await prisma_client_1.default.appointment.findMany({
                where: {
                    tenantId: req.user.tenantId,
                    OR: [
                        { assignedTechId: req.user.id },
                        { technicianAssignments: { some: { technicianId: req.user.id } } },
                    ],
                    projectId: { not: null },
                    status: { in: ["BOOKED", "COMPLETED"] },
                    startTime: { gte: start },
                    endTime: { lte: end },
                },
                orderBy: { startTime: "asc" },
                include: this.projectInstallationInclude(),
            });
            res.status(200).json(appointments);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Manager-facing list of every order appointment in the tenant for the range
    // (technicians use listMyInstallations, which scopes to their own assignments).
    async listAppointments(req, res) {
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
            const appointments = await prisma_client_1.default.appointment.findMany({
                where: {
                    tenantId: req.user.tenantId,
                    projectId: { not: null },
                    status: { in: ["BOOKED", "COMPLETED"] },
                    startTime: { gte: start },
                    endTime: { lte: end },
                },
                orderBy: { startTime: "asc" },
                include: this.projectInstallationInclude(),
            });
            res.status(200).json(appointments);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getMyInstallation(req, res) {
        try {
            const appointment = await prisma_client_1.default.appointment.findFirst({
                where: {
                    id: String(req.params.appointmentId || ""),
                    tenantId: req.user.tenantId,
                    OR: [
                        { assignedTechId: req.user.id },
                        { technicianAssignments: { some: { technicianId: req.user.id } } },
                    ],
                    projectId: { not: null },
                },
                include: this.projectInstallationInclude(),
            });
            if (!appointment)
                return res.status(404).json({ error: "Montaj randevusu bulunamadı." });
            res.status(200).json(appointment);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getById(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id, req.user.tenantId);
            if (!project) {
                return res.status(404).json({ error: "Proje bulunamadı veya seçili şirkette değil." });
            }
            res.status(200).json(project);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async update(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            const allowed = ['projectName', 'managerId', 'status', 'startDate', 'endDate', 'plannedBudget', 'overtimeHourlyRate'];
            const patch = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined)
                    patch[key] = req.body[key];
            }
            if (patch.startDate)
                patch.startDate = new Date(patch.startDate);
            if (patch.endDate)
                patch.endDate = new Date(patch.endDate);
            if (patch.plannedBudget !== undefined)
                patch.plannedBudget = Number(patch.plannedBudget);
            if (patch.overtimeHourlyRate !== undefined)
                patch.overtimeHourlyRate = Number(patch.overtimeHourlyRate);
            const updated = await this.projectRepository.updateProject(project.id, patch);
            res.status(200).json(updated);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async activate(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Flat list of every field report in the tenant, for the Services > Reports module.
    async listAllReports(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const search = String(req.query.search || "").trim();
            const startRaw = req.query.start ? new Date(String(req.query.start)) : null;
            const endRaw = req.query.end ? new Date(String(req.query.end)) : null;
            const where = { project: { tenantId } };
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
            const reports = await prisma_client_1.default.projectReport.findMany({
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async listMaterials(req, res) {
        try {
            const materials = await this.materialRepository.list(req.user.tenantId);
            res.status(200).json(materials);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async createMaterial(req, res) {
        try {
            const name = String(req.body.name || '').trim();
            const serialId = String(req.body.serialId || '').trim();
            const unitCost = Number(req.body.unitCost || 0);
            const stockQuantity = Number(req.body.stockQuantity || 0);
            const imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : null;
            if (!name)
                return res.status(400).json({ error: "Malzeme adi zorunludur." });
            if (!serialId)
                return res.status(400).json({ error: "Seri kodu zorunludur." });
            if (unitCost < 0 || stockQuantity < 0)
                return res.status(400).json({ error: "Fiyat ve stok negatif olamaz." });
            const material = await this.materialRepository.createMaterial(req.user.tenantId, name, serialId, unitCost, stockQuantity, imageUrl);
            res.status(201).json(material);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateMaterial(req, res) {
        try {
            const material = await this.materialRepository.findById(req.params.materialId);
            if (!material || material.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Malzeme bulunamadı." });
            }
            const patch = {};
            if (req.body.name !== undefined)
                patch.name = String(req.body.name).trim();
            if (req.body.serialId !== undefined)
                patch.serialId = String(req.body.serialId).trim();
            if (req.body.unitCost !== undefined)
                patch.unitCost = Number(req.body.unitCost);
            if (req.body.stockQuantity !== undefined)
                patch.stockQuantity = Number(req.body.stockQuantity);
            if (req.body.imageUrl !== undefined)
                patch.imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : null;
            if (req.body.isActive !== undefined)
                patch.isActive = Boolean(req.body.isActive);
            if (patch.name === '')
                return res.status(400).json({ error: "Malzeme adi zorunludur." });
            if (patch.serialId === '')
                return res.status(400).json({ error: "Seri kodu zorunludur." });
            if (patch.unitCost < 0 || patch.stockQuantity < 0)
                return res.status(400).json({ error: "Fiyat ve stok negatif olamaz." });
            const updated = await this.materialRepository.updateMaterial(material.id, patch);
            res.status(200).json(updated);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async deleteMaterial(req, res) {
        try {
            const material = await this.materialRepository.findById(req.params.materialId);
            if (!material || material.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Malzeme bulunamadı." });
            }
            await this.materialRepository.softDeleteMaterial(material.id);
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async createFromTender(req, res) {
        try {
            const { tenderId, managerId, overtimeHourlyRate } = req.body;
            const employeeId = req.user.id;
            const project = await this.createProjectUseCase.execute(tenderId, employeeId, managerId, req.user.tenantId, Number(overtimeHourlyRate || 0));
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || 'http://localhost:5173';
            const bookingLink = `${frontendUrl}/booking/${project.bookingToken}`;
            res.status(201).json({
                message: "Sipariş/proje oluşturuldu. Teklif mailindeki saat planları projeye kilitli randevu olarak aktarıldı.",
                project,
                bookingLink
            });
        }
        catch (error) {
            res.status(403).json({ error: error.message });
        }
    }
    async sendBookingMail(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            if (!project.bookingToken) {
                return res.status(400).json({ error: "Bu proje için randevu tokeni yok." });
            }
            const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId: req.user.tenantId } });
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || 'http://localhost:5173';
            const bookingLink = `${frontendUrl}/booking/${project.bookingToken}`;
            const customerEmail = project.customer?.mainEmail || "";
            const to = String(req.body.to || customerEmail || "").trim();
            const fromEmail = String(req.body.fromEmail || settings?.fromEmail || req.user.email || "").trim();
            const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
            const subject = String(req.body.subject || `${project.projectName} - Montaj randevusu`).trim();
            const message = req.body.message || "Lütfen size uygun montaj saatini seçin.";
            if (!to)
                return res.status(400).json({ error: "Alıcı e-posta adresi zorunludur." });
            if (!fromEmail)
                return res.status(400).json({ error: "Gönderici e-posta adresi zorunludur." });
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async addReport(req, res) {
        try {
            const salesOrderId = await this.resolveProjectSalesOrderId(req.params.id, req.user.tenantId, req.body.salesOrderId);
            const input = {
                projectId: req.params.id,
                salesOrderId,
                employeeId: req.user.id,
                workDate: req.body.workDate,
                startedAt: req.body.startedAt,
                endedAt: req.body.endedAt,
                operationsDone: req.body.operationsDone,
                technicalNotes: req.body.technicalNotes,
                images: Array.isArray(req.body.images) ? req.body.images.map(String) : undefined
            };
            const report = await this.addReportUseCase.execute(input);
            res.status(201).json({ message: "Saha raporu kaydedildi.", report });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateReport(req, res) {
        try {
            const report = await this.reportRepository.findById(req.params.reportId);
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            const project = await this.projectRepository.findById(report.projectId);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            const input = {
                projectId: report.projectId,
                salesOrderId: await this.resolveProjectSalesOrderId(report.projectId, req.user.tenantId, req.body.salesOrderId || report.salesOrderId),
                employeeId: req.user.id,
                workDate: req.body.workDate,
                startedAt: req.body.startedAt,
                endedAt: req.body.endedAt,
                operationsDone: req.body.operationsDone,
                technicalNotes: req.body.technicalNotes,
                images: Array.isArray(req.body.images) ? req.body.images.map(String) : undefined
            };
            const updated = await this.addReportUseCase.update(req.params.reportId, input);
            res.status(200).json({ message: "Saha raporu güncellendi.", report: updated });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Append used materials (reportMaterial rows) to an existing field report — used by the inline
    // "Saha" editor when adding used materials to a report that already exists.
    async addReportMaterials(req, res) {
        try {
            const reportId = req.params.reportId;
            const report = await prisma_client_1.default.projectReport.findFirst({
                where: { id: reportId, project: { tenantId: req.user.tenantId } },
                select: { id: true },
            });
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            const items = Array.isArray(req.body.materials) ? req.body.materials : [];
            const rows = [];
            for (const item of items) {
                const quantity = Number(item.quantity || 0);
                if (!item.materialId || quantity <= 0)
                    continue;
                const material = await this.materialRepository.findById(String(item.materialId));
                if (!material || material.tenantId !== req.user.tenantId)
                    continue;
                rows.push({
                    id: (0, nanoid_1.nanoid)(10),
                    reportId: report.id,
                    materialId: material.id,
                    quantity,
                    costAtTime: Number(material.unitCost || 0),
                });
            }
            if (rows.length) {
                await prisma_client_1.default.reportMaterial.createMany({ data: rows });
            }
            res.status(201).json({ message: "Kullanılan malzemeler eklendi.", count: rows.length });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async signReport(req, res) {
        try {
            const reportId = req.params.reportId;
            const { signatureBase64 } = req.body;
            await this.reportRepository.signReport(reportId, signatureBase64);
            res.status(200).json({ message: "Rapor müşteri tarafından imzalandı." });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async requestReportSignature(req, res) {
        try {
            const reportId = req.params.reportId;
            const channel = String(req.body.channel || "technician");
            const report = await prisma_client_1.default.projectReport.findFirst({
                where: { id: reportId, project: { tenantId: req.user.tenantId } },
                include: {
                    employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                    project: { include: { customer: true } },
                    salesOrder: { select: { orderNumber: true } },
                },
            });
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || "http://localhost:5173";
            const reportLink = `${frontendUrl}/projects/${report.projectId}`;
            const sent = [];
            if ((channel === "technician" || channel === "both") && report.employeeId) {
                await this.notify({
                    tenantId: req.user.tenantId,
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
                const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId: req.user.tenantId } });
                const to = String(req.body.to || report.project?.customer?.mainEmail || "").trim();
                const fromEmail = String(req.body.fromEmail || settings?.fromEmail || req.user.email || "").trim();
                const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
                const subject = String(req.body.subject || `${report.project?.projectName || "Proje"} - saha raporu imzası`).trim();
                const message = String(req.body.message || "Saha raporunuz imza için hazır. Lütfen Offitec ekibiyle birlikte raporu kontrol edip imzalayın.").trim();
                if (!to)
                    return res.status(400).json({ error: "Müşteri e-posta adresi bulunamadı." });
                if (!fromEmail)
                    return res.status(400).json({ error: "Gönderici e-posta adresi zorunludur." });
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async completeInstallation(req, res, options = {}) {
        try {
            const appointmentId = String(req.params.appointmentId || req.body.appointmentId || "");
            const isManagerCompletion = Boolean(options.allowManagerComplete);
            const appointment = await prisma_client_1.default.appointment.findFirst({
                where: {
                    id: appointmentId,
                    tenantId: req.user.tenantId,
                    ...(isManagerCompletion ? {} : {
                        OR: [
                            { assignedTechId: req.user.id },
                            { technicianAssignments: { some: { technicianId: req.user.id } } },
                        ],
                    }),
                    projectId: { not: null },
                },
                include: {
                    salesOrder: true,
                    project: { include: { salesOrders: { orderBy: { createdAt: "asc" } }, customer: true, manager: true } },
                },
            });
            if (!appointment?.project)
                return res.status(404).json({ error: "Montaj randevusu bulunamadı." });
            if (startOfDay(new Date(appointment.startTime)).getTime() > startOfDay(new Date()).getTime()) {
                return res.status(400).json({ error: "Montaj gunu gelmeden rapor kapatilamaz." });
            }
            const operationItems = Array.isArray(req.body.operationsDoneItems)
                ? req.body.operationsDoneItems.map(String).map((item) => item.trim()).filter(Boolean)
                : [];
            const operationsDone = operationItems.length
                ? operationItems.map((item) => `- ${item}`).join("\n")
                : String(req.body.operationsDone || "").trim()
                    // Managers can finish directly without filling anything in; record a standard note.
                    || (isManagerCompletion ? "Saha çalışması yönetici tarafından tamamlandı." : "");
            if (!operationsDone)
                return res.status(400).json({ error: "Yapilan isler zorunludur." });
            const salesOrderId = await this.resolveProjectSalesOrderId(appointment.projectId, req.user.tenantId, appointment.salesOrderId);
            // Field work belongs to its day: the report may end at the latest by midnight of the appointment day.
            const dayEnd = endOfDay(new Date(appointment.startTime));
            let endedAt = req.body.endedAt ? new Date(req.body.endedAt) : new Date();
            const startedAt = req.body.startedAt ? new Date(req.body.startedAt) : new Date(appointment.startTime);
            if (Number.isNaN(endedAt.getTime()) || Number.isNaN(startedAt.getTime())) {
                return res.status(400).json({ error: "Geçerli başlangıç ve bitiş zamanı girin." });
            }
            if (endedAt > dayEnd)
                endedAt = dayEnd;
            const reportEmployeeId = isManagerCompletion ? (appointment.assignedTechId || req.user.id) : req.user.id;
            const workDate = startOfDay(new Date(appointment.startTime));
            // A day can only hold one field report per order. If one already exists, reuse it and just
            // close the appointment instead of failing with "a report already exists".
            const isPrimaryOrder = (appointment.project.salesOrders?.[0]?.id || null) === (salesOrderId || null);
            const existingReport = await this.reportRepository.findByProjectAndWorkDate(appointment.projectId, workDate, salesOrderId ?? undefined, isPrimaryOrder);
            const reportResult = existingReport
                ? (await this.reportRepository.findById(existingReport.id) || existingReport)
                : await this.addReportUseCase.execute({
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
                });
            const cleanUsedMaterials = Array.isArray(req.body.usedMaterials) ? req.body.usedMaterials : [];
            const usedMaterialRows = [];
            for (const material of cleanUsedMaterials) {
                const quantity = Number(material.quantity || 0);
                if (!material.materialId || quantity <= 0)
                    continue;
                const materialRecord = await this.materialRepository.findById(String(material.materialId));
                if (!materialRecord || materialRecord.tenantId !== req.user.tenantId)
                    continue;
                usedMaterialRows.push({
                    id: (0, nanoid_1.nanoid)(10),
                    reportId: reportResult.id,
                    materialId: materialRecord.id,
                    quantity,
                    costAtTime: Number(materialRecord.unitCost || 0),
                });
            }
            if (usedMaterialRows.length) {
                await prisma_client_1.default.reportMaterial.createMany({ data: usedMaterialRows });
            }
            const cleanExpenses = Array.isArray(req.body.expenses) ? req.body.expenses : [];
            for (const expense of cleanExpenses) {
                const amount = Number(expense.amount || 0);
                if (!expense.expenseType || amount <= 0)
                    continue;
                await this.addExpenseUseCase.execute(appointment.projectId, String(expense.expenseType).trim(), amount, expense.description ? String(expense.description).trim() : "", salesOrderId, appointment.id);
            }
            const cleanMaterials = Array.isArray(req.body.materials) ? req.body.materials : [];
            for (const material of cleanMaterials) {
                const quantity = Number(material.quantity || 0);
                if (!material.materialId || quantity <= 0)
                    continue;
                await this.requestVariationUseCase.execute(appointment.projectId, req.user.id, String(material.materialId), quantity, material.description ? String(material.description).trim() : "", salesOrderId, appointment.id);
            }
            let report = reportResult;
            const signatureBase64 = typeof req.body.signatureBase64 === "string" ? req.body.signatureBase64 : "";
            if (signatureBase64) {
                await this.reportRepository.signReport(reportResult.id, signatureBase64);
                report = await this.reportRepository.findById(reportResult.id) || reportResult;
            }
            await prisma_client_1.default.appointment.update({
                where: { id: appointment.id },
                data: { status: "COMPLETED" },
            });
            // Finishing as administrator also approves the report's worked-hours / overtime.
            if (isManagerCompletion) {
                await prisma_client_1.default.projectReport.update({
                    where: { id: reportResult.id },
                    data: { hoursApprovedAt: new Date(), hoursApprovedById: req.user.id, autoApproved: false },
                });
            }
            const parentSalesOrderId = appointment.salesOrder?.parentSalesOrderId || salesOrderId || appointment.project.salesOrders?.[0]?.id || null;
            const addon = parentSalesOrderId
                ? await this.createAddonOrderForParent(appointment.project, parentSalesOrderId, req.user.id)
                : null;
            await this.notifyProjectManagers(appointment.project, {
                type: isManagerCompletion ? "PROJECT_INSTALLATION_MANAGER_COMPLETED" : signatureBase64 ? "PROJECT_INSTALLATION_COMPLETED" : "PROJECT_INSTALLATION_UNSIGNED",
                title: isManagerCompletion ? "Montaj yönetici tarafından bitirildi" : signatureBase64 ? "Montaj tamamlandı" : "Montaj imzasız geldi",
                message: isManagerCompletion
                    ? `${appointment.project.projectName} montajı yönetici tarafından bitirildi.`
                    : `${appointment.project.projectName} montajı teknisyen tarafından bitirildi${signatureBase64 ? "." : ", müşteri imzası yok."}`,
                linkUrl: `/projects/${appointment.projectId}`,
                metadata: { projectId: appointment.projectId, appointmentId: appointment.id, reportId: reportResult.id, addonSalesOrderId: addon?.salesOrder?.id || null },
            });
            res.status(201).json({
                message: isManagerCompletion ? "Montaj yönetici tarafından bitirildi." : signatureBase64 ? "Montaj tamamlandı ve imza alındı." : "Montaj imzasız tamamlandı.",
                report,
                addonOrder: addon?.salesOrder || null,
                addonTotals: addon?.totals || null,
                overtimeWarning: reportResult.overtimeWarning || null,
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async requestExtraMaterial(req, res) {
        try {
            const projectId = req.params.id;
            const employeeId = req.user.id;
            const { materialId, quantity, description } = req.body;
            const salesOrderId = await this.resolveProjectSalesOrderId(projectId, req.user.tenantId, req.body.salesOrderId);
            const appointmentId = req.body.appointmentId ? String(req.body.appointmentId) : null;
            const extraMaterial = await this.requestVariationUseCase.execute(projectId, employeeId, materialId, quantity, description, salesOrderId, appointmentId);
            res.status(201).json({ message: "Ek malzeme projeye eklendi.", extraMaterial });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async approveVariation(req, res) {
        try {
            const variationId = req.params.variationId;
            const managerId = req.user.id;
            const { isApproved } = req.body;
            const result = await this.approveVariationUseCase.execute(variationId, managerId, isApproved);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async addExpense(req, res) {
        try {
            const projectId = req.params.id;
            const { expenseType, amount, description } = req.body;
            const salesOrderId = await this.resolveProjectSalesOrderId(projectId, req.user.tenantId, req.body.salesOrderId);
            const appointmentId = req.body.appointmentId ? String(req.body.appointmentId) : null;
            const expense = await this.addExpenseUseCase.execute(projectId, expenseType, amount, description, salesOrderId, appointmentId);
            res.status(201).json({ message: "Harici gider eklendi.", expense });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateExpense(req, res) {
        try {
            const expense = await prisma_client_1.default.projectExpense.findUnique({
                where: { id: req.params.expenseId },
                include: { project: true },
            });
            if (!expense?.project || expense.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Harici gider bulunamadı." });
            }
            const patch = {};
            if (req.body.expenseType !== undefined) {
                const expenseType = String(req.body.expenseType || "").trim();
                if (!PROJECT_EXPENSE_TYPES.includes(expenseType)) {
                    return res.status(400).json({ error: "Geçersiz harici gider türü." });
                }
                patch.expenseType = expenseType;
            }
            if (req.body.amount !== undefined) {
                const amount = Number(req.body.amount || 0);
                if (amount <= 0)
                    return res.status(400).json({ error: "Tutar sıfırdan büyük olmalıdır." });
                patch.amount = amount;
            }
            if (req.body.description !== undefined) {
                patch.description = String(req.body.description || "").trim() || null;
            }
            if (req.body.salesOrderId !== undefined) {
                patch.salesOrderId = await this.resolveProjectSalesOrderId(expense.projectId, req.user.tenantId, req.body.salesOrderId);
            }
            const updated = await prisma_client_1.default.projectExpense.update({
                where: { id: expense.id },
                data: patch,
            });
            res.status(200).json({ message: "Harici gider güncellendi.", expense: updated });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async deleteExpense(req, res) {
        try {
            const expense = await prisma_client_1.default.projectExpense.findUnique({
                where: { id: req.params.expenseId },
                include: { project: true },
            });
            if (!expense?.project || expense.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Harici gider bulunamadı." });
            }
            await prisma_client_1.default.projectExpense.delete({ where: { id: expense.id } });
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateExtraMaterial(req, res) {
        try {
            const existing = await prisma_client_1.default.projectExtraMaterial.findUnique({
                where: { id: req.params.extraMaterialId },
                include: { project: true, material: true },
            });
            if (!existing?.project || existing.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Ek malzeme bulunamadı." });
            }
            const materialId = req.body.materialId !== undefined
                ? String(req.body.materialId || "").trim()
                : existing.materialId;
            if (!materialId)
                return res.status(400).json({ error: "Malzeme seçimi zorunludur." });
            const quantity = req.body.quantity !== undefined ? Number(req.body.quantity || 0) : Number(existing.quantity || 0);
            if (quantity <= 0)
                return res.status(400).json({ error: "Miktar sıfırdan büyük olmalıdır." });
            const material = await this.materialRepository.findById(materialId);
            if (!material || material.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Malzeme bulunamadı." });
            }
            const availableQuantity = Number(material.stockQuantity || 0) + (material.id === existing.materialId ? Number(existing.quantity || 0) : 0);
            if (availableQuantity < quantity) {
                return res.status(400).json({ error: `[Stok uyarısı] ${material.name} için kayıtlı miktar yetersiz.` });
            }
            const salesOrderId = req.body.salesOrderId !== undefined
                ? await this.resolveProjectSalesOrderId(existing.projectId, req.user.tenantId, req.body.salesOrderId)
                : existing.salesOrderId;
            const unitPrice = req.body.unitPrice !== undefined
                ? Number(req.body.unitPrice || 0)
                : material.id === existing.materialId
                    ? Number(existing.unitPrice || 0)
                    : Number(material.unitCost || 0);
            if (unitPrice < 0)
                return res.status(400).json({ error: "Birim fiyat negatif olamaz." });
            const description = req.body.description !== undefined
                ? String(req.body.description || "").trim() || null
                : existing.description;
            const updated = await prisma_client_1.default.$transaction(async (tx) => {
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
                }
                else {
                    const diff = quantity - previousQuantity;
                    if (diff > 0) {
                        await tx.material.update({ where: { id: material.id }, data: { stockQuantity: { decrement: diff } } });
                    }
                    else if (diff < 0) {
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async deleteExtraMaterial(req, res) {
        try {
            const existing = await prisma_client_1.default.projectExtraMaterial.findUnique({
                where: { id: req.params.extraMaterialId },
                include: { project: true },
            });
            if (!existing?.project || existing.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Ek malzeme bulunamadı." });
            }
            await prisma_client_1.default.$transaction(async (tx) => {
                await tx.material.update({
                    where: { id: existing.materialId },
                    data: { stockQuantity: { increment: Number(existing.quantity || 0) } },
                });
                await tx.projectExtraMaterial.delete({ where: { id: existing.id } });
            });
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async createAddonOrder(req, res) {
        try {
            const projectId = req.params.id;
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const rawParentSalesOrderId = String(req.body.parentSalesOrderId || req.body.salesOrderId || "").trim();
            if (!rawParentSalesOrderId)
                return res.status(400).json({ error: "Bağlı sipariş seçimi zorunludur." });
            const project = await this.projectRepository.findById(projectId);
            if (!project || project.tenantId !== tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            const selectedOrder = await prisma_client_1.default.salesOrder.findFirst({
                where: { id: rawParentSalesOrderId, projectId, tenantId },
            });
            if (!selectedOrder)
                return res.status(404).json({ error: "Sipariş bu projeye ait değil." });
            const parentSalesOrderId = selectedOrder.parentSalesOrderId || selectedOrder.id;
            const parentOrder = selectedOrder.parentSalesOrderId
                ? await prisma_client_1.default.salesOrder.findFirst({ where: { id: parentSalesOrderId, projectId, tenantId } })
                : selectedOrder;
            if (!parentOrder)
                return res.status(404).json({ error: "Ana sipariş bulunamadı." });
            const addons = await prisma_client_1.default.salesOrder.findMany({
                where: { parentSalesOrderId, projectId, tenantId },
                orderBy: [{ revisionNumber: 'desc' }, { createdAt: 'desc' }],
            });
            const previousAddon = addons[0] || null;
            const nextRevision = Math.max(0, ...addons.map((order) => Number(order.revisionNumber || 0))) + 1;
            const previousCreatedAt = previousAddon?.createdAt || null;
            const createdAtFilter = previousCreatedAt ? { gt: previousCreatedAt } : undefined;
            const [expenses, extraMaterials, reports] = await Promise.all([
                prisma_client_1.default.projectExpense.findMany({
                    where: {
                        projectId,
                        salesOrderId: parentSalesOrderId,
                        ...(createdAtFilter ? { expenseDate: createdAtFilter } : {}),
                    },
                }),
                prisma_client_1.default.projectExtraMaterial.findMany({
                    where: {
                        projectId,
                        salesOrderId: parentSalesOrderId,
                        ...(createdAtFilter ? { addedAt: createdAtFilter } : {}),
                    },
                }),
                prisma_client_1.default.projectReport.findMany({
                    where: {
                        projectId,
                        salesOrderId: parentSalesOrderId,
                        ...(createdAtFilter ? { reportDate: createdAtFilter } : {}),
                    },
                }),
            ]);
            const expenseTotal = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
            const materialTotal = extraMaterials.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
            const overtimeTotal = reports.reduce((sum, item) => sum + Number(item.overtimeCost || 0), 0);
            const totalAmount = expenseTotal + materialTotal + overtimeTotal;
            if (totalAmount <= 0) {
                return res.status(400).json({ error: "Ek sipariş oluşturmak için son ek siparişten sonra harici gider, ek malzeme veya ek işçilik maliyeti bulunamadı." });
            }
            const orderNumber = `${parentOrder.orderNumber}-N${nextRevision}`;
            const addonOrder = await prisma_client_1.default.salesOrder.create({
                data: {
                    id: (0, nanoid_1.nanoid)(10),
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
                    createdByEmployeeId: employeeId,
                },
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
                    tender: { select: { id: true, tenderNumber: true, status: true, projectId: true } },
                    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
            });
            res.status(201).json({
                message: `${orderNumber} ek siparişi oluşturuldu.`,
                salesOrder: addonOrder,
                totals: { expenses: expenseTotal, extraMaterials: materialTotal, overtime: overtimeTotal, total: totalAmount },
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    parseAppointmentBody(body) {
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
    async findCustomerSameDayAppointment(customerId, day, excludeAppointmentId) {
        if (!customerId)
            return null;
        return await prisma_client_1.default.appointment.findFirst({
            where: {
                customerId,
                projectId: { not: null },
                status: { in: ["BOOKED", "COMPLETED"] },
                ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
                startTime: { gte: startOfDay(day), lte: endOfDay(day) },
            },
        });
    }
    async findProjectAppointmentConflict(projectId, startTime, endTime, appointmentId, salesOrderId) {
        return await prisma_client_1.default.appointment.findFirst({
            where: {
                projectId,
                ...(salesOrderId !== undefined ? { salesOrderId } : {}),
                ...(appointmentId ? { id: { not: appointmentId } } : {}),
                startTime: { lt: endTime },
                endTime: { gt: startTime }
            }
        });
    }
    async findTechnicianScheduleConflict(technicianIds, startTime, endTime, tenantId, appointmentId) {
        const ids = [...new Set(technicianIds.filter(Boolean))];
        if (!ids.length)
            return null;
        const employeeLabel = (employee) => employee ? `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.email || "Teknisyen" : "Teknisyen";
        const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(tenantId);
        const projectConflict = await prisma_client_1.default.appointment.findFirst({
            where: {
                tenantId: tenantIds.length ? { in: tenantIds } : undefined,
                status: { in: ["BOOKED", "COMPLETED"] },
                ...(appointmentId ? { id: { not: appointmentId } } : {}),
                startTime: { lt: endTime },
                endTime: { gt: startTime },
                OR: [
                    { assignedTechId: { in: ids } },
                    { technicianAssignments: { some: { technicianId: { in: ids } } } },
                ],
            },
            include: {
                assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true } },
                technicianAssignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true } } } },
                project: { select: { projectName: true } },
            },
        });
        if (projectConflict) {
            const technicians = [
                projectConflict.assignedTechnician,
                ...((projectConflict.technicianAssignments || []).map((assignment) => assignment.technician)),
            ].filter(Boolean);
            const conflicted = technicians.find((employee) => ids.includes(employee.id)) || technicians[0];
            return {
                type: "project",
                message: `${employeeLabel(conflicted)} ${formatDateTime(projectConflict.startTime)} - ${formatDateTime(projectConflict.endTime)} arasında montajda: ${projectConflict.project?.projectName || "Proje montajı"}.`,
            };
        }
        const maintenanceConflict = await prisma_client_1.default.maintenanceTask.findFirst({
            where: {
                status: { not: "CANCELLED" },
                scheduledStartTime: { lt: endTime },
                scheduledEndTime: { gt: startTime },
                OR: [
                    { assignedTechId: { in: ids } },
                    { alternativeTechId: { in: ids } },
                    { assignments: { some: { technicianId: { in: ids } } } },
                ],
            },
            include: {
                technician: { select: { id: true, firstName: true, lastName: true, email: true } },
                alternativeTechnician: { select: { id: true, firstName: true, lastName: true, email: true } },
                assignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true } } } },
                contract: { include: { customer: { select: { companyName: true } } } },
            },
        });
        if (maintenanceConflict) {
            const technicians = [
                maintenanceConflict.technician,
                maintenanceConflict.alternativeTechnician,
                ...((maintenanceConflict.assignments || []).map((assignment) => assignment.technician)),
            ].filter(Boolean);
            const conflicted = technicians.find((employee) => ids.includes(employee.id)) || technicians[0];
            return {
                type: "maintenance",
                message: `${employeeLabel(conflicted)} ${formatDateTime(maintenanceConflict.scheduledStartTime)} - ${formatDateTime(maintenanceConflict.scheduledEndTime)} arasında bakımda: ${maintenanceConflict.contract?.customer?.companyName || maintenanceConflict.contract?.title || "Bakım görevi"}.`,
            };
        }
        return null;
    }
    appointmentTechnicianIdsFromBody(body, fallbackIds = []) {
        if (body.technicianIds !== undefined)
            return normalizeIdList(body.technicianIds);
        if (body.assignedTechId !== undefined)
            return normalizeIdList([body.assignedTechId]);
        return [...new Set(fallbackIds.filter(Boolean))];
    }
    async replaceProjectAppointmentAssignments(appointmentId, technicianIds) {
        const ids = [...new Set(technicianIds.filter(Boolean))];
        await prisma_client_1.default.$transaction(async (tx) => {
            await tx.projectAppointmentAssignment.deleteMany({ where: { appointmentId } });
            if (ids.length) {
                await tx.projectAppointmentAssignment.createMany({
                    data: ids.map((technicianId) => ({
                        id: (0, nanoid_1.nanoid)(10),
                        appointmentId,
                        technicianId,
                    })),
                    skipDuplicates: true,
                });
            }
        });
    }
    async createAppointment(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            const parsed = this.parseAppointmentBody(req.body);
            const salesOrderId = await this.resolveProjectSalesOrderId(project.id, req.user.tenantId, req.body.salesOrderId);
            const sameDayForCustomer = await this.findCustomerSameDayAppointment(project.customerId, parsed.startTime);
            if (sameDayForCustomer)
                return res.status(409).json({ error: "Bu müşteri için aynı güne ait başka bir randevu var. Bir günde tek randevu verilebilir." });
            const conflict = await this.findProjectAppointmentConflict(project.id, parsed.startTime, parsed.endTime, undefined, salesOrderId);
            if (conflict)
                return res.status(409).json({ error: "Bu proje için saat planı çakışıyor." });
            const technicians = await this.validateProjectTechnicians(this.appointmentTechnicianIdsFromBody(req.body), req.user.tenantId);
            const technicianIds = technicians.map((technician) => technician.id);
            const responsibleTechnician = technicians[0] || null;
            const techConflict = await this.findTechnicianScheduleConflict(technicianIds, parsed.startTime, parsed.endTime, req.user.tenantId);
            if (techConflict)
                return res.status(409).json({ error: techConflict.message });
            const appointment = await prisma_client_1.default.appointment.create({
                data: {
                    id: (0, nanoid_1.nanoid)(10),
                    tenantId: project.tenantId,
                    projectId: project.id,
                    salesOrderId,
                    assignedTechId: responsibleTechnician?.id || null,
                    customerId: project.customerId,
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
                await this.notifyMany(project.tenantId, technicianIds, {
                    type: "PROJECT_INSTALLATION_ASSIGNED",
                    title: "Yeni montaj randevusu",
                    message: `${project.projectName} montajı size atandı.`,
                    linkUrl: "/projects/installation/calendar",
                    metadata: { projectId: project.id, appointmentId: appointment.id, salesOrderId },
                });
            }
            res.status(201).json(appointment);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateAppointment(req, res) {
        try {
            const appointment = await prisma_client_1.default.appointment.findUnique({
                where: { id: req.params.appointmentId },
                include: { project: true, technicianAssignments: true }
            });
            if (!appointment?.project || appointment.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }
            const parsed = this.parseAppointmentBody(req.body);
            const salesOrderId = await this.resolveProjectSalesOrderId(appointment.projectId, req.user.tenantId, req.body.salesOrderId || appointment.salesOrderId);
            const sameDayForCustomer = await this.findCustomerSameDayAppointment(appointment.customerId || appointment.project.customerId, parsed.startTime, appointment.id);
            if (sameDayForCustomer)
                return res.status(409).json({ error: "Bu müşteri için aynı güne ait başka bir randevu var. Bir günde tek randevu verilebilir." });
            const conflict = await this.findProjectAppointmentConflict(appointment.projectId, parsed.startTime, parsed.endTime, appointment.id, salesOrderId);
            if (conflict)
                return res.status(409).json({ error: "Bu proje için saat planı çakışıyor." });
            const fallbackTechnicianIds = [
                appointment.assignedTechId,
                ...((appointment.technicianAssignments || []).map((assignment) => assignment.technicianId)),
            ].filter(Boolean);
            const technicians = await this.validateProjectTechnicians(this.appointmentTechnicianIdsFromBody(req.body, fallbackTechnicianIds), req.user.tenantId);
            const technicianIds = technicians.map((technician) => technician.id);
            const responsibleTechnician = technicians[0] || null;
            const techConflict = await this.findTechnicianScheduleConflict(technicianIds, parsed.startTime, parsed.endTime, req.user.tenantId, appointment.id);
            if (techConflict)
                return res.status(409).json({ error: techConflict.message });
            const updated = await prisma_client_1.default.appointment.update({
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async deleteAppointment(req, res) {
        try {
            const appointment = await prisma_client_1.default.appointment.findUnique({
                where: { id: req.params.appointmentId },
                include: { project: true }
            });
            if (!appointment?.project || appointment.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }
            const dayStart = startOfDay(new Date(appointment.startTime));
            const dayEnd = endOfDay(new Date(appointment.startTime));
            const fallbackScope = {
                projectId: appointment.projectId,
                salesOrderId: appointment.salesOrderId || null,
                appointmentId: null,
            };
            await prisma_client_1.default.$transaction(async (tx) => {
                const reports = await tx.projectReport.findMany({
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
                const extraMaterials = await tx.projectExtraMaterial.findMany({
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.ProjectController = ProjectController;
//# sourceMappingURL=ProjectController.js.map