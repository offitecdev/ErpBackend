"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SalesOrderController = void 0;
const crypto_1 = __importDefault(require("crypto"));
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const GetBillingSummaryUseCase_1 = require("../../application/use-cases/billing/GetBillingSummaryUseCase");
const InvoiceRepository_1 = require("../../infrastructure/repositories/InvoiceRepository");
const salesOrder_pricing_1 = require("./salesOrder.pricing");
const billingSummaryUseCase = new GetBillingSummaryUseCase_1.GetBillingSummaryUseCase(new InvoiceRepository_1.InvoiceRepository());
// Resolve billing summaries for a set of orders with one invoice query (no N+1).
// `baseAmount` comes from the already-loaded order rows, so no extra lookups are made.
const safeBatchSummaries = async (tenantId, targets) => {
    try {
        return await billingSummaryUseCase.executeBatch(tenantId, targets);
    }
    catch {
        return new Map();
    }
};
const allowedOrderModes = new Set(['PROJECT_NEW', 'PROJECT_EXISTING', 'INVOICE']);
class SalesOrderController {
    async list(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const where = { tenantId };
            if (req.query.customerId) {
                where.customerId = String(req.query.customerId);
            }
            if (req.query.search) {
                const search = String(req.query.search);
                where.OR = [
                    { orderNumber: { contains: search } },
                    { tender: { tenderNumber: { contains: search } } },
                    { customer: { companyName: { contains: search } } },
                    { project: { projectName: { contains: search } } },
                ];
            }
            const orders = await prisma_client_1.default.salesOrder.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
                    tender: { select: { id: true, tenderNumber: true, status: true, projectId: true } },
                    project: { select: { id: true, projectName: true, status: true } },
                    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
            });
            res.status(200).json(orders);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // "Siparişlerim" – top-level orders with addon hierarchy + billing summary
    async myOrders(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const where = { tenantId, parentSalesOrderId: null };
            if (req.query.search) {
                const search = String(req.query.search);
                where.OR = [
                    { orderNumber: { contains: search } },
                    { customer: { companyName: { contains: search } } },
                    { project: { projectName: { contains: search } } },
                ];
            }
            const orders = await prisma_client_1.default.salesOrder.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
                    project: { select: { id: true, projectName: true, status: true, plannedBudget: true, actualCost: true } },
                    addonSalesOrders: {
                        orderBy: [{ revisionNumber: 'asc' }, { createdAt: 'asc' }],
                        select: { id: true, orderNumber: true, orderType: true, status: true, revisionNumber: true, totalAmount: true, createdAt: true, orderDate: true },
                    },
                    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
            });
            const targets = orders.flatMap((order) => [
                { salesOrderId: order.id, baseAmount: Number(order.totalAmount || 0) },
                ...(order.addonSalesOrders || []).map((addon) => ({
                    salesOrderId: addon.id,
                    baseAmount: Number(addon.totalAmount || 0),
                })),
            ]);
            const summaries = await safeBatchSummaries(tenantId, targets);
            const enriched = orders.map((order) => ({
                ...order,
                billingSummary: summaries.get(order.id) ?? null,
                addonSalesOrders: (order.addonSalesOrders || []).map((addon) => ({
                    ...addon,
                    billingSummary: summaries.get(addon.id) ?? null,
                })),
            }));
            res.status(200).json(enriched);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Single order detail – project, assembly phases (reports), costs, addons, billing
    async getById(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const id = String(req.params.id);
            const order = await prisma_client_1.default.salesOrder.findFirst({
                where: { id, tenantId },
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true } },
                    project: {
                        select: {
                            id: true, projectName: true, status: true, plannedBudget: true, actualCost: true,
                            startDate: true, endDate: true,
                            phases: { select: { id: true, phaseName: true, progressPercentage: true, isCompleted: true } },
                        },
                    },
                    parentSalesOrder: { select: { id: true, orderNumber: true } },
                    addonSalesOrders: {
                        orderBy: [{ revisionNumber: 'asc' }, { createdAt: 'asc' }],
                        select: { id: true, orderNumber: true, orderType: true, status: true, revisionNumber: true, totalAmount: true, createdAt: true, orderDate: true },
                    },
                    reports: {
                        orderBy: { workDate: 'asc' },
                        select: {
                            id: true, workDate: true, reportType: true, operationsDone: true, technicalNotes: true,
                            workedMinutes: true, overtimeMinutes: true, overtimeCost: true, isSigned: true, signedAt: true,
                            employee: { select: { id: true, firstName: true, lastName: true } },
                        },
                    },
                    expenses: { select: { id: true, expenseType: true, amount: true, description: true, expenseDate: true } },
                    extraMaterials: {
                        select: {
                            id: true, quantity: true, unitPrice: true, description: true, addedAt: true,
                            material: { select: { id: true, name: true, serialId: true } },
                        },
                    },
                    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
            });
            if (!order)
                return res.status(404).json({ error: 'Sipariş bulunamadı.' });
            const summaries = await safeBatchSummaries(tenantId, [
                { salesOrderId: order.id, baseAmount: Number(order.totalAmount || 0) },
                ...(order.addonSalesOrders || []).map((addon) => ({
                    salesOrderId: addon.id,
                    baseAmount: Number(addon.totalAmount || 0),
                })),
            ]);
            const billingSummary = summaries.get(order.id) ?? null;
            const addonSalesOrders = (order.addonSalesOrders || []).map((addon) => ({
                ...addon,
                billingSummary: summaries.get(addon.id) ?? null,
            }));
            const expensesTotal = (order.expenses || []).reduce((sum, e) => sum + Number(e.amount || 0), 0);
            const extraMaterialsTotal = (order.extraMaterials || []).reduce((sum, m) => sum + Number(m.quantity || 0) * Number(m.unitPrice || 0), 0);
            const overtimeTotal = (order.reports || []).reduce((sum, r) => sum + Number(r.overtimeCost || 0), 0);
            const addonTotal = (order.addonSalesOrders || []).reduce((sum, a) => sum + Number(a.totalAmount || 0), 0);
            res.status(200).json({
                ...order,
                addonSalesOrders,
                billingSummary,
                costSummary: {
                    orderAmount: Number(order.totalAmount || 0),
                    expensesTotal,
                    extraMaterialsTotal,
                    overtimeTotal,
                    addonTotal,
                    grandTotal: Number(order.totalAmount || 0) + addonTotal,
                },
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async createFromTender(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const tenderId = String(req.body.tenderId || '').trim();
            const mode = String(req.body.mode || '');
            const projectName = String(req.body.projectName || '').trim();
            const existingProjectId = String(req.body.projectId || '').trim();
            const overtimeHourlyRate = Math.max(0, Number(req.body.overtimeHourlyRate || 0));
            if (!tenderId)
                return res.status(400).json({ error: 'Teklif ID zorunludur.' });
            if (!allowedOrderModes.has(mode))
                return res.status(400).json({ error: 'Gecersiz siparis turu.' });
            if (mode === 'PROJECT_EXISTING' && !existingProjectId)
                return res.status(400).json({ error: 'Proje secimi zorunludur.' });
            const result = await prisma_client_1.default.$transaction(async (tx) => {
                const tender = await tx.tender.findUnique({
                    where: { id: tenderId },
                    include: {
                        positions: { include: { calculation: true } },
                        salesOrder: true,
                    },
                });
                if (!tender || tender.tenantId !== tenantId)
                    throw new Error('Teklif bulunamadi.');
                if (!tender.customerId)
                    throw new Error('Siparis icin teklifin musterisi olmalidir.');
                if (tender.salesOrder) {
                    return {
                        salesOrder: tender.salesOrder,
                        project: tender.salesOrder.projectId
                            ? await tx.project.findUnique({ where: { id: tender.salesOrder.projectId } })
                            : null,
                        reused: true,
                    };
                }
                const totalAmount = (0, salesOrder_pricing_1.orderTotal)(tender.positions || [], tender.directDiscount);
                let project = null;
                let scheduleSlots = [];
                if (mode === 'PROJECT_NEW' || mode === 'PROJECT_EXISTING') {
                    const tenant = await tx.tenant.findUnique({
                        where: { id: tenantId },
                        select: { isProjectModuleEnabled: true },
                    });
                    if (!tenant?.isProjectModuleEnabled)
                        throw new Error('Proje modulu aktif degil.');
                }
                if (mode === 'PROJECT_NEW') {
                    scheduleSlots = await tx.offerScheduleSlot.findMany({
                        where: { tenderId },
                        orderBy: { startTime: 'asc' },
                        include: { technicianAssignments: true },
                    });
                    project = await tx.project.create({
                        data: {
                            id: (0, nanoid_1.nanoid)(10),
                            tenantId,
                            customerId: tender.customerId,
                            tenderId,
                            managerId: employeeId,
                            projectName: projectName || tender.tenderNumber,
                            status: 'ACTIVE',
                            plannedBudget: totalAmount,
                            actualCost: 0,
                            startDate: scheduleSlots[0]?.startTime || new Date(),
                            bookingToken: crypto_1.default.randomBytes(32).toString('hex'),
                            overtimeHourlyRate,
                            overtimeTolerancePercent: 15,
                        },
                    });
                }
                if (mode === 'PROJECT_EXISTING') {
                    project = await tx.project.findFirst({
                        where: { id: existingProjectId, tenantId },
                    });
                    if (!project)
                        throw new Error('Proje bulunamadi.');
                }
                const orderNumber = project?.id ? `AUF-${tender.tenderNumber}` : `SO-${tender.tenderNumber}`;
                const salesOrder = await tx.salesOrder.create({
                    data: {
                        id: (0, nanoid_1.nanoid)(10),
                        tenantId,
                        customerId: tender.customerId,
                        tenderId,
                        projectId: project?.id || null,
                        orderNumber,
                        orderType: mode,
                        status: 'ORDERED',
                        totalAmount,
                        createdByEmployeeId: employeeId,
                    },
                });
                if (project?.id && scheduleSlots.length > 0) {
                    // Carry each proposal slot's technician assignment forward into
                    // the project appointment so both screens stay in sync.
                    for (const slot of scheduleSlots) {
                        const appointment = await tx.appointment.create({
                            data: {
                                id: (0, nanoid_1.nanoid)(10),
                                tenantId,
                                projectId: project.id,
                                salesOrderId: salesOrder.id,
                                customerId: tender.customerId,
                                assignedTechId: slot.assignedTechId || null,
                                startTime: slot.startTime,
                                endTime: slot.endTime,
                                status: 'BOOKED',
                                notes: slot.notes,
                                isLocked: true,
                            },
                        });
                        const technicianIds = [...new Set((slot.technicianAssignments || []).map((assignment) => assignment.technicianId).filter(Boolean))];
                        if (technicianIds.length) {
                            await tx.projectAppointmentAssignment.createMany({
                                data: technicianIds.map((technicianId) => ({
                                    id: (0, nanoid_1.nanoid)(10),
                                    appointmentId: appointment.id,
                                    technicianId,
                                })),
                                skipDuplicates: true,
                            });
                        }
                    }
                }
                await tx.tender.update({
                    where: { id: tenderId },
                    data: {
                        status: 'Approved',
                        sourceStatus: 'Verkaufsauftrag',
                        projectId: project?.id || null,
                    },
                });
                await tx.customerActivity.create({
                    data: {
                        id: (0, nanoid_1.nanoid)(10),
                        customerId: tender.customerId,
                        employeeId,
                        activityType: 'SALES_ORDER_CREATED',
                        description: `${orderNumber} siparisi olusturuldu.`,
                        referenceId: salesOrder.id,
                        activityDate: new Date(),
                    },
                });
                await tx.tenderActivityLog.create({
                    data: {
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId,
                        tenderId,
                        employeeId,
                        actionType: 'SALES_ORDER_CREATED',
                        fieldName: 'salesOrder',
                        oldValue: tender.status,
                        newValue: orderNumber,
                        description: `${orderNumber} siparisi olusturuldu.`,
                    },
                });
                return { salesOrder, project, reused: false };
            });
            res.status(result.reused ? 200 : 201).json({
                message: result.reused ? 'Bu teklif icin siparis zaten olusturulmus.' : 'Siparis olusturuldu.',
                ...result,
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.SalesOrderController = SalesOrderController;
//# sourceMappingURL=SalesOrderController.js.map