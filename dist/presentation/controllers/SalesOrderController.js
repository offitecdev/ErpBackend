"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SalesOrderController = void 0;
const crypto_1 = __importDefault(require("crypto"));
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const GetBillingSummaryUseCase_1 = require("../../application/use-cases/billing/GetBillingSummaryUseCase");
const InvoiceRepository_1 = require("../../infrastructure/repositories/InvoiceRepository");
const salesOrder_pricing_1 = require("./salesOrder.pricing");
const paymentSchedule_1 = require("../../application/utils/paymentSchedule");
const tenantModules_1 = require("../../shared/tenantModules");
const documentNumber_1 = require("../../shared/documentNumber");
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
// Aynı özet hesabı, faturalar zaten yüklendiğinde (liste uç noktaları fatura
// sorgusunu sipariş sorgusuyla paralel çalıştırır). Hata durumunda liste
// çökmesin diye özetler boş kalır — `safeBatchSummaries` ile aynı davranış.
const summariesFromInvoices = (targets, invoices) => {
    try {
        return billingSummaryUseCase.buildBatchFromInvoices(targets, invoices);
    }
    catch {
        return new Map();
    }
};
// The list only ever shows "total / invoiced / remaining", and remaining is
// derived client-side as total - billed. Sending the whole summary would ship
// every invoice row of every order, so the list gets just these two figures.
const listBillingFigures = (summary) => summary ? { baseAmount: summary.baseAmount, billedAmount: summary.billedAmount } : null;
const allowedOrderModes = new Set(['PROJECT_NEW', 'PROJECT_EXISTING', 'INVOICE']);
class SalesOrderController {
    /**
     * Sipariş listesi. Dört ilişki de çoktan-bire olduğu için hepsi TEK sorguda
     * JOIN'lenir; cevap şekli eski `include` çıktısıyla birebir aynı.
     *
     * Prisma her `include`u ayrı bir sorgu turu olarak çalıştırıyordu ve
     * veritabanı uzak (ifade başına ~100 ms): bu uç nokta beş ARDIŞIK ifade
     * harcıyordu, artık bir tane.
     */
    async list(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const conditions = [client_1.Prisma.sql `so.tenantId = ${tenantId}`];
            if (req.query.customerId) {
                conditions.push(client_1.Prisma.sql `so.customerId = ${String(req.query.customerId)}`);
            }
            if (req.query.search) {
                const pattern = `%${String(req.query.search)}%`;
                conditions.push(client_1.Prisma.sql `(
                    so.orderNumber LIKE ${pattern}
                    OR t.tenderNumber LIKE ${pattern}
                    OR c.companyName LIKE ${pattern}
                    OR p.projectName LIKE ${pattern}
                )`);
            }
            const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
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
                WHERE ${client_1.Prisma.join(conditions, ' AND ')}
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
        }
        catch (error) {
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
    async myOrders(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const where = { tenantId, parentSalesOrderId: null };
            if (req.query.search) {
                const search = String(req.query.search);
                where.OR = [
                    { orderNumber: { contains: search } },
                    // Yeniden numaralandırmadan önceki kod da aranabilir.
                    { legacyNumber: { contains: search } },
                    { customer: { companyName: { contains: search } } },
                    { project: { projectNumber: { contains: search } } },
                    { project: { projectName: { contains: search } } },
                ];
            }
            // Üç ilişki sorgusu (üst siparişler + müşteri + ek siparişler) tek
            // JOIN'e indi ve fatura özetleri artık sipariş sorgusunu BEKLEMİYOR:
            // aynı WHERE'i alt sorgu olarak kullandığı için ikisi paralel koşuyor.
            // Uzak veritabanında her ifade ~100 ms olduğundan bu uç nokta dört
            // ardışık turdan iki paralel tura indi.
            const [orders, invoiceRows] = await Promise.all([
                prisma_client_1.default.salesOrder.findMany({
                    where,
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        orderNumber: true,
                        totalAmount: true,
                        createdAt: true,
                        // Teklif onaylanırken seçilen yol (proje siparişi / teslimat
                        // siparişi) listede rozet olarak gösterilir.
                        orderType: true,
                        // Kept: the project screens filter the same feed by project.
                        projectId: true,
                        // Sipariş listesi bağlı projeyi gösterir; projesi OLMAYAN
                        // sipariş (teklifin "fatura/teslimat" yolu) listede
                        // "Teslimat siparişi" olarak işaretlenir.
                        project: { select: { id: true, projectNumber: true, projectName: true } },
                        customer: { select: { id: true, companyName: true } },
                        addonSalesOrders: {
                            orderBy: [{ revisionNumber: 'asc' }, { createdAt: 'asc' }],
                            // Liste ek siparişleri kendi satırları olarak da gösterir;
                            // satırdaki tarih ek işin ait olduğu gün (orderDate),
                            // yoksa oluşturulma tarihidir.
                            select: { id: true, orderNumber: true, totalAmount: true, createdAt: true, orderDate: true },
                        },
                    },
                }),
                // Listelenen siparişlerin (ve ek siparişlerinin) faturaları.
                prisma_client_1.default.invoice.findMany({
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
            const targets = orders.flatMap((order) => [
                { salesOrderId: order.id, baseAmount: Number(order.totalAmount || 0) },
                ...(order.addonSalesOrders || []).map((addon) => ({
                    salesOrderId: addon.id,
                    baseAmount: Number(addon.totalAmount || 0),
                })),
            ]);
            const summaries = summariesFromInvoices(targets, invoiceRows);
            const enriched = orders.map((order) => ({
                ...order,
                billingSummary: listBillingFigures(summaries.get(order.id)),
                addonSalesOrders: (order.addonSalesOrders || []).map((addon) => ({
                    ...addon,
                    billingSummary: listBillingFigures(summaries.get(addon.id)),
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
                    // Adresler ve teslim tarihi SİPARİŞTE DEĞİL, teklifte durur — sipariş
                    // görünümünün "Übersicht" sekmesi bunları buradan okur. Hangisinin
                    // gösterileceğini sipariş türü belirler: proje siparişinde nihai adres
                    // MONTAJ adresidir, teslimat siparişinde doğrudan TESLİMAT adresi ve
                    // teslim tarihi (projede teslim tarihi YOKTUR, randevular taşır).
                    tender: {
                        select: {
                            id: true,
                            tenderNumber: true,
                            commissionNumber: true,
                            // Rechnung bölümündeki Verkäufer alanı buradan ön-dolar:
                            // teklifin satıcısı, yoksa teklifi oluşturan kişi.
                            salespersonName: true,
                            createdBy: { select: { firstName: true, lastName: true } },
                            billingAddress: true,
                            installationAddress: true,
                            deliveryAddress: true,
                            internalDeliveryDate: true,
                        },
                    },
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
                            // reportDate: ek siparişlerin dilimi sunucuda reportDate ile
                            // kesilir (createAddonOrderForParent); ek sipariş popup'ının
                            // istemci tarafı dilimlemesi aynı alanı kullanır.
                            id: true, workDate: true, reportDate: true, reportType: true, operationsDone: true, technicalNotes: true,
                            workedMinutes: true, overtimeMinutes: true, overtimeCost: true, overtimeHourlyRate: true, isSigned: true, signedAt: true,
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
                { salesOrderId: order.id, baseAmount: Number(order.totalAmount || 0), paymentStages: order.paymentStages ?? null },
                ...(order.addonSalesOrders || []).map((addon) => ({
                    salesOrderId: addon.id,
                    baseAmount: Number(addon.totalAmount || 0),
                    paymentStages: addon.paymentStages ?? null,
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
    // Set or clear the order's payment schedule (dated percent stages summing to 100).
    async updatePaymentStages(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const id = String(req.params.id);
            const raw = req.body?.paymentStages;
            let serialized = null;
            if (raw !== null && raw !== undefined && raw !== '') {
                const stages = (0, paymentSchedule_1.normalizePaymentStages)(raw);
                const stageError = stages ? (0, paymentSchedule_1.validatePaymentStages)(stages) : 'Geçersiz ödeme planı.';
                if (stageError)
                    return res.status(400).json({ error: stageError });
                serialized = (0, paymentSchedule_1.serializePaymentStages)(stages);
            }
            const result = await prisma_client_1.default.salesOrder.updateMany({
                where: { id, tenantId },
                data: { paymentStages: serialized },
            });
            if (result.count === 0)
                return res.status(404).json({ error: 'Sipariş bulunamadı.' });
            res.status(200).json({ message: 'Ödeme planı güncellendi.', paymentStages: serialized });
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
            // Proje adı artık teklifte GİRİLMEZ: sistem üretir (aşağıda koda eşitlenir).
            // Gövdede `projectName` gelse bile yok sayılır.
            const existingProjectId = String(req.body.projectId || '').trim();
            const overtimeHourlyRate = Math.max(0, Number(req.body.overtimeHourlyRate || 0));
            // Teslimat siparişinde (proje açılmayan yol) teslim tarihi ZORUNLUDUR:
            // siparişin tek zaman taahhüdü budur, projeli siparişte ise takvimi
            // randevular taşır. Tarih teklifin `internalDeliveryDate` alanına yazılır.
            const rawDeliveryDate = String(req.body.deliveryDate || '').trim();
            const deliveryDate = rawDeliveryDate ? new Date(rawDeliveryDate) : null;
            if (rawDeliveryDate && Number.isNaN(deliveryDate.getTime())) {
                return res.status(400).json({ error: 'Teslim tarihi gecersiz.' });
            }
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
                // Sipariş zaten açılmışsa hiçbir şey doğrulanmaz/yazılmaz —
                // bu çağrı mevcut siparişi geri vermekten ibarettir.
                if (tender.salesOrder) {
                    return {
                        salesOrder: tender.salesOrder,
                        project: tender.salesOrder.projectId
                            ? await tx.project.findUnique({ where: { id: tender.salesOrder.projectId } })
                            : null,
                        reused: true,
                    };
                }
                // Teslimat siparişi: gövdeden gelen tarih yoksa teklifte kayıtlı
                // olan kabul edilir; ikisi de yoksa sipariş açılmaz.
                const effectiveDeliveryDate = deliveryDate ?? tender.internalDeliveryDate ?? null;
                if (mode === 'INVOICE' && !effectiveDeliveryDate) {
                    throw new Error('Teslimat siparisi icin teslim tarihi zorunludur.');
                }
                if (deliveryDate) {
                    await tx.tender.update({
                        where: { id: tenderId },
                        data: { internalDeliveryDate: deliveryDate },
                    });
                }
                const totalAmount = (0, salesOrder_pricing_1.orderTotal)(tender.positions || [], tender.directDiscount, tender.extraDiscount);
                let project = null;
                let scheduleSlots = [];
                if (mode === 'PROJECT_NEW' || mode === 'PROJECT_EXISTING') {
                    // Company category ("Numara" profile) decides; no category = every module.
                    if (!await (0, tenantModules_1.isModuleEnabledForTenant)(tenantId, 'projects', tx)) {
                        throw new Error('Proje modulu aktif degil.');
                    }
                }
                if (mode === 'PROJECT_NEW') {
                    scheduleSlots = await tx.offerScheduleSlot.findMany({
                        where: { tenderId },
                        orderBy: { startTime: 'asc' },
                        include: { technicianAssignments: true },
                    });
                    // Projenin ADI KODUDUR (PR-2026-10001) ve sayaç kaldığı yerden
                    // devam eder. Eskiden teklif kodu (A-2026-5980) ada
                    // kopyalanıyordu; proje listesinde ad sütunu teklif
                    // sütununu tekrar ediyor, proje kendi kimliğini taşımıyordu.
                    const projectNumber = await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'PROJECT', tx);
                    project = await tx.project.create({
                        data: {
                            id: (0, nanoid_1.nanoid)(10),
                            tenantId,
                            customerId: tender.customerId,
                            tenderId,
                            managerId: employeeId,
                            projectNumber,
                            projectName: projectNumber,
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
                // Sipariş kodu teklifin kodunu AYNEN izler (kullanıcı isteği):
                // AN-2026-10007 → AU-2026-10007. Yıl ve sıra tekliften kopyalanır,
                // yalnızca önek değişir — teklifle siparişin kod sonu hep eşittir.
                // Aynı kodu paylaşan İKİNCİ teklif sürümü siparişe çevrilirse
                // FARKLI bir numara VERİLMEZ: aynı kod "-2" ("-3", …) ekini alır
                // (kullanıcı isteği: AU-2026-10046 → AU-2026-10046-2). Sayaç
                // yalnızca çözümlenemeyen (çok eski/dış) teklif kodları için
                // devreye girer.
                const parsedTenderNumber = (0, documentNumber_1.parseDocumentNumber)(tender.tenderNumber, 'QUOTE');
                let orderNumber = null;
                if (parsedTenderNumber) {
                    const candidate = (0, documentNumber_1.formatDocumentNumber)('ORDER', parsedTenderNumber.year, parsedTenderNumber.seq);
                    const taken = await tx.salesOrder.findFirst({
                        where: { tenantId, orderNumber: candidate },
                        select: { id: true },
                    });
                    if (!taken) {
                        orderNumber = candidate;
                    }
                    else {
                        const siblings = await tx.salesOrder.findMany({
                            where: { tenantId, orderNumber: { startsWith: `${candidate}-` } },
                            select: { orderNumber: true },
                        });
                        let maxSuffix = 1;
                        for (const sibling of siblings) {
                            const suffix = Number(sibling.orderNumber.slice(candidate.length + 1));
                            if (Number.isFinite(suffix) && suffix > maxSuffix)
                                maxSuffix = suffix;
                        }
                        orderNumber = `${candidate}-${maxSuffix + 1}`;
                    }
                    // Sayaç türetilen sıranın altında kalmasın: sayaçtan üretilecek
                    // bir sonraki yedek kod bu sırayı ikinci kez dağıtamaz.
                    await (0, documentNumber_1.raiseDocumentCounter)(tenantId, 'ORDER', parsedTenderNumber.seq, tx);
                }
                if (!orderNumber)
                    orderNumber = await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'ORDER', tx);
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
                        paymentStages: tender.paymentStages ?? null,
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