import { Request, Response } from 'express';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { GetBillingSummaryUseCase } from '../../application/use-cases/billing/GetBillingSummaryUseCase';
import { InvoiceRepository } from '../../infrastructure/repositories/InvoiceRepository';
import { orderTotal } from './salesOrder.pricing';
import { parsePaymentStages, serializePaymentStages, validatePaymentStages } from '../../application/utils/paymentSchedule';
import { isModuleEnabledForTenant } from '../../shared/tenantModules';

const billingSummaryUseCase = new GetBillingSummaryUseCase(new InvoiceRepository());

// Resolve billing summaries for a set of orders with one invoice query (no N+1).
// `baseAmount` comes from the already-loaded order rows, so no extra lookups are made.
const safeBatchSummaries = async (
    tenantId: string,
    targets: Array<{ salesOrderId: string; baseAmount: number; paymentStages?: string | null }>
) => {
    try {
        return await billingSummaryUseCase.executeBatch(tenantId, targets);
    } catch {
        return new Map<string, Awaited<ReturnType<typeof billingSummaryUseCase.execute>>>();
    }
};

// Aynı özet hesabı, faturalar zaten yüklendiğinde (liste uç noktaları fatura
// sorgusunu sipariş sorgusuyla paralel çalıştırır). Hata durumunda liste
// çökmesin diye özetler boş kalır — `safeBatchSummaries` ile aynı davranış.
const summariesFromInvoices = (
    targets: Array<{ salesOrderId: string; baseAmount: number; paymentStages?: string | null }>,
    invoices: any[],
) => {
    try {
        return billingSummaryUseCase.buildBatchFromInvoices(targets, invoices);
    } catch {
        return new Map<string, Awaited<ReturnType<typeof billingSummaryUseCase.execute>>>();
    }
};

// The list only ever shows "total / invoiced / remaining", and remaining is
// derived client-side as total - billed. Sending the whole summary would ship
// every invoice row of every order, so the list gets just these two figures.
const listBillingFigures = (summary: { baseAmount: number; billedAmount: number } | undefined) =>
    summary ? { baseAmount: summary.baseAmount, billedAmount: summary.billedAmount } : null;

type OrderMode = 'PROJECT_NEW' | 'PROJECT_EXISTING' | 'INVOICE';

const allowedOrderModes = new Set<OrderMode>(['PROJECT_NEW', 'PROJECT_EXISTING', 'INVOICE']);

export class SalesOrderController {
    /**
     * Sipariş listesi. Dört ilişki de çoktan-bire olduğu için hepsi TEK sorguda
     * JOIN'lenir; cevap şekli eski `include` çıktısıyla birebir aynı.
     *
     * Prisma her `include`u ayrı bir sorgu turu olarak çalıştırıyordu ve
     * veritabanı uzak (ifade başına ~100 ms): bu uç nokta beş ARDIŞIK ifade
     * harcıyordu, artık bir tane.
     */
    async list(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const conditions: Prisma.Sql[] = [Prisma.sql`so.tenantId = ${tenantId}`];
            if (req.query.customerId) {
                conditions.push(Prisma.sql`so.customerId = ${String(req.query.customerId)}`);
            }
            if (req.query.search) {
                const pattern = `%${String(req.query.search)}%`;
                conditions.push(Prisma.sql`(
                    so.orderNumber LIKE ${pattern}
                    OR t.tenderNumber LIKE ${pattern}
                    OR c.companyName LIKE ${pattern}
                    OR p.projectName LIKE ${pattern}
                )`);
            }

            const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT
                    so.id, so.tenantId, so.customerId, so.tenderId, so.projectId,
                    so.parentSalesOrderId, so.revisionNumber, so.orderNumber, so.orderType,
                    so.status, so.totalAmount, so.paymentStages, so.createdByEmployeeId,
                    so.createdAt, so.updatedAt, so.orderDate,
                    c.companyName AS customerCompanyName,
                    c.mainEmail AS customerMainEmail,
                    c.mainPhone AS customerMainPhone,
                    t.tenderNumber AS tenderNumber,
                    t.status AS tenderStatus,
                    t.projectId AS tenderProjectId,
                    p.projectName AS projectName,
                    p.status AS projectStatus,
                    e.firstName AS creatorFirstName,
                    e.lastName AS creatorLastName,
                    e.email AS creatorEmail
                FROM SalesOrder so
                LEFT JOIN Customer c ON c.id = so.customerId
                LEFT JOIN Tender t ON t.id = so.tenderId
                LEFT JOIN Project p ON p.id = so.projectId
                LEFT JOIN Employee e ON e.id = so.createdByEmployeeId
                WHERE ${Prisma.join(conditions, ' AND ')}
                ORDER BY so.createdAt DESC
            `);

            const orders = rows.map((row) => ({
                id: row.id,
                tenantId: row.tenantId,
                customerId: row.customerId ?? null,
                tenderId: row.tenderId ?? null,
                projectId: row.projectId ?? null,
                parentSalesOrderId: row.parentSalesOrderId ?? null,
                revisionNumber: row.revisionNumber ?? null,
                orderNumber: row.orderNumber,
                orderType: row.orderType,
                status: row.status,
                totalAmount: Number(row.totalAmount ?? 0),
                paymentStages: row.paymentStages ?? null,
                createdByEmployeeId: row.createdByEmployeeId,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                orderDate: row.orderDate ?? null,
                customer: row.customerId
                    ? {
                        id: row.customerId,
                        companyName: row.customerCompanyName,
                        mainEmail: row.customerMainEmail ?? null,
                        mainPhone: row.customerMainPhone ?? null,
                    }
                    : null,
                tender: row.tenderId
                    ? {
                        id: row.tenderId,
                        tenderNumber: row.tenderNumber,
                        status: row.tenderStatus,
                        projectId: row.tenderProjectId ?? null,
                    }
                    : null,
                project: row.projectId
                    ? { id: row.projectId, projectName: row.projectName, status: row.projectStatus }
                    : null,
                createdBy: row.createdByEmployeeId
                    ? {
                        id: row.createdByEmployeeId,
                        firstName: row.creatorFirstName,
                        lastName: row.creatorLastName,
                        email: row.creatorEmail,
                    }
                    : null,
            }));

            res.status(200).json(orders);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // "Siparişlerim" – top-level orders with their addon orders.
    //
    // This is a list feed, not a detail feed: it carries exactly the columns the
    // My Orders table renders (order no, customer, status, total, invoiced,
    // remaining) plus the ids the project flow screens group by. Everything else
    // — the tender/project/creator relations, the customer's contact details, the
    // per-order invoice list inside the billing summary — belongs to
    // `getById` and is deliberately not selected here.
    async myOrders(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const where: any = { tenantId, parentSalesOrderId: null };
            if (req.query.search) {
                const search = String(req.query.search);
                where.OR = [
                    { orderNumber: { contains: search } },
                    { customer: { companyName: { contains: search } } },
                    { project: { projectName: { contains: search } } },
                ];
            }

            // Üç ilişki sorgusu (üst siparişler + müşteri + ek siparişler) tek
            // JOIN'e indi ve fatura özetleri artık sipariş sorgusunu BEKLEMİYOR:
            // aynı WHERE'i alt sorgu olarak kullandığı için ikisi paralel koşuyor.
            // Uzak veritabanında her ifade ~100 ms olduğundan bu uç nokta dört
            // ardışık turdan iki paralel tura indi.
            const [orders, invoiceRows] = await Promise.all([
                (prisma as any).salesOrder.findMany({
                    where,
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        orderNumber: true,
                        totalAmount: true,
                        createdAt: true,
                        // Kept: the project screens filter the same feed by project.
                        projectId: true,
                        customer: { select: { id: true, companyName: true } },
                        addonSalesOrders: {
                            orderBy: [{ revisionNumber: 'asc' }, { createdAt: 'asc' }],
                            select: { id: true, orderNumber: true, totalAmount: true },
                        },
                    },
                }),
                // Listelenen siparişlerin (ve ek siparişlerinin) faturaları.
                (prisma as any).invoice.findMany({
                    where: {
                        tenantId,
                        OR: [
                            { salesOrder: { is: where } },
                            { salesOrder: { is: { tenantId, parentSalesOrder: { is: where } } } },
                        ],
                    },
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        salesOrderId: true,
                        invoiceNumber: true,
                        billingType: true,
                        billedPercent: true,
                        amount: true,
                        status: true,
                        createdAt: true,
                    },
                }),
            ]);

            const targets = orders.flatMap((order: any) => [
                { salesOrderId: order.id, baseAmount: Number(order.totalAmount || 0) },
                ...(order.addonSalesOrders || []).map((addon: any) => ({
                    salesOrderId: addon.id,
                    baseAmount: Number(addon.totalAmount || 0),
                })),
            ]);
            const summaries = summariesFromInvoices(targets, invoiceRows);

            const enriched = orders.map((order: any) => ({
                ...order,
                billingSummary: listBillingFigures(summaries.get(order.id)),
                addonSalesOrders: (order.addonSalesOrders || []).map((addon: any) => ({
                    ...addon,
                    billingSummary: listBillingFigures(summaries.get(addon.id)),
                })),
            }));

            res.status(200).json(enriched);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Single order detail – project, assembly phases (reports), costs, addons, billing
    async getById(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);

            const order: any = await (prisma as any).salesOrder.findFirst({
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
                        select: { id: true, orderNumber: true, orderType: true, status: true, revisionNumber: true, totalAmount: true, paymentStages: true, createdAt: true, orderDate: true },
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

            if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

            const summaries = await safeBatchSummaries(tenantId, [
                { salesOrderId: order.id, baseAmount: Number(order.totalAmount || 0), paymentStages: order.paymentStages ?? null },
                ...(order.addonSalesOrders || []).map((addon: any) => ({
                    salesOrderId: addon.id,
                    baseAmount: Number(addon.totalAmount || 0),
                    paymentStages: addon.paymentStages ?? null,
                })),
            ]);
            const billingSummary = summaries.get(order.id) ?? null;
            const addonSalesOrders = (order.addonSalesOrders || []).map((addon: any) => ({
                ...addon,
                billingSummary: summaries.get(addon.id) ?? null,
            }));

            const expensesTotal = (order.expenses || []).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);
            const extraMaterialsTotal = (order.extraMaterials || []).reduce((sum: number, m: any) => sum + Number(m.quantity || 0) * Number(m.unitPrice || 0), 0);
            const overtimeTotal = (order.reports || []).reduce((sum: number, r: any) => sum + Number(r.overtimeCost || 0), 0);
            const addonTotal = (order.addonSalesOrders || []).reduce((sum: number, a: any) => sum + Number(a.totalAmount || 0), 0);

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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Set or clear the order's payment schedule (percent stages summing to 100).
    async updatePaymentStages(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);
            const raw = req.body?.paymentStages;

            let serialized: string | null = null;
            if (raw !== null && raw !== undefined && raw !== '') {
                const stages = Array.isArray(raw) ? raw.map(Number) : parsePaymentStages(String(raw));
                const stageError = stages ? validatePaymentStages(stages) : 'Geçersiz ödeme planı.';
                if (stageError) return res.status(400).json({ error: stageError });
                serialized = serializePaymentStages(stages!);
            }

            const result = await (prisma as any).salesOrder.updateMany({
                where: { id, tenantId },
                data: { paymentStages: serialized },
            });
            if (result.count === 0) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

            res.status(200).json({ message: 'Ödeme planı güncellendi.', paymentStages: serialized });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createFromTender(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const tenderId = String(req.body.tenderId || '').trim();
            const mode = String(req.body.mode || '') as OrderMode;
            const projectName = String(req.body.projectName || '').trim();
            const existingProjectId = String(req.body.projectId || '').trim();
            const overtimeHourlyRate = Math.max(0, Number(req.body.overtimeHourlyRate || 0));

            if (!tenderId) return res.status(400).json({ error: 'Teklif ID zorunludur.' });
            if (!allowedOrderModes.has(mode)) return res.status(400).json({ error: 'Gecersiz siparis turu.' });
            if (mode === 'PROJECT_EXISTING' && !existingProjectId) return res.status(400).json({ error: 'Proje secimi zorunludur.' });

            const result = await prisma.$transaction(async (tx) => {
                const tender: any = await (tx as any).tender.findUnique({
                    where: { id: tenderId },
                    include: {
                        positions: { include: { calculation: true } },
                        salesOrder: true,
                    },
                });
                if (!tender || tender.tenantId !== tenantId) throw new Error('Teklif bulunamadi.');
                if (!tender.customerId) throw new Error('Siparis icin teklifin musterisi olmalidir.');
                if (tender.salesOrder) {
                    return {
                        salesOrder: tender.salesOrder,
                        project: tender.salesOrder.projectId
                            ? await (tx as any).project.findUnique({ where: { id: tender.salesOrder.projectId } })
                            : null,
                        reused: true,
                    };
                }

                const totalAmount = orderTotal(tender.positions || [], tender.directDiscount, tender.extraDiscount);
                let project: any = null;
                let scheduleSlots: any[] = [];

                if (mode === 'PROJECT_NEW' || mode === 'PROJECT_EXISTING') {
                    // Company category ("Numara" profile) decides; no category = every module.
                    if (!await isModuleEnabledForTenant(tenantId, 'projects', tx)) {
                        throw new Error('Proje modulu aktif degil.');
                    }
                }

                if (mode === 'PROJECT_NEW') {
                    scheduleSlots = await (tx as any).offerScheduleSlot.findMany({
                        where: { tenderId },
                        orderBy: { startTime: 'asc' },
                        include: { technicianAssignments: true },
                    });
                    project = await (tx as any).project.create({
                        data: {
                            id: nanoid(10),
                            tenantId,
                            customerId: tender.customerId,
                            tenderId,
                            managerId: employeeId,
                            projectName: projectName || tender.tenderNumber,
                            status: 'ACTIVE',
                            plannedBudget: totalAmount,
                            actualCost: 0,
                            startDate: scheduleSlots[0]?.startTime || new Date(),
                            bookingToken: crypto.randomBytes(32).toString('hex'),
                            overtimeHourlyRate,
                            overtimeTolerancePercent: 15,
                        },
                    });
                }

                if (mode === 'PROJECT_EXISTING') {
                    project = await (tx as any).project.findFirst({
                        where: { id: existingProjectId, tenantId },
                    });
                    if (!project) throw new Error('Proje bulunamadi.');
                }

                const orderNumber = project?.id ? `AUF-${tender.tenderNumber}` : `SO-${tender.tenderNumber}`;
                const salesOrder = await (tx as any).salesOrder.create({
                    data: {
                        id: nanoid(10),
                        tenantId,
                        customerId: tender.customerId,
                        tenderId,
                        projectId: project?.id || null,
                        orderNumber,
                        orderType: mode,
                        status: 'ORDERED',
                        totalAmount,
                        paymentStages: tender.paymentStages ?? null,
                        createdByEmployeeId: employeeId,
                    },
                });

                if (project?.id && scheduleSlots.length > 0) {
                    // Carry each proposal slot's technician assignment forward into
                    // the project appointment so both screens stay in sync.
                    for (const slot of scheduleSlots) {
                        const appointment = await (tx as any).appointment.create({
                            data: {
                                id: nanoid(10),
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
                        const technicianIds = [...new Set((slot.technicianAssignments || []).map((assignment: any) => assignment.technicianId).filter(Boolean))];
                        if (technicianIds.length) {
                            await (tx as any).projectAppointmentAssignment.createMany({
                                data: technicianIds.map((technicianId) => ({
                                    id: nanoid(10),
                                    appointmentId: appointment.id,
                                    technicianId,
                                })),
                                skipDuplicates: true,
                            });
                        }
                    }
                }

                await (tx as any).tender.update({
                    where: { id: tenderId },
                    data: {
                        status: 'Approved',
                        sourceStatus: 'Verkaufsauftrag',
                        projectId: project?.id || null,
                    },
                });

                await (tx as any).customerActivity.create({
                    data: {
                        id: nanoid(10),
                        customerId: tender.customerId,
                        employeeId,
                        activityType: 'SALES_ORDER_CREATED',
                        description: `${orderNumber} siparisi olusturuldu.`,
                        referenceId: salesOrder.id,
                        activityDate: new Date(),
                    },
                });

                await (tx as any).tenderActivityLog.create({
                    data: {
                        id: nanoid(12),
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
