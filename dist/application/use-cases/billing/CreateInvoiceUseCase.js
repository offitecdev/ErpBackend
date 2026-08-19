"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateInvoiceUseCase = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const documentNumber_1 = require("../../../shared/documentNumber");
const INVOICE_KINDS = ["RECHNUNG", "AKONTO", "ZWISCHEN", "SCHLUSS"];
const parseIsoDate = (value) => {
    if (!value)
        return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
const DEFAULT_PARTIAL_PERCENT = 60;
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
class CreateInvoiceUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(input) {
        const { tenantId, issuedByEmployeeId } = input;
        const salesOrderId = input.salesOrderId?.trim() || null;
        const projectId = input.projectId?.trim() || null;
        if ((!salesOrderId && !projectId) || (salesOrderId && projectId)) {
            throw new Error("Faturalandırma için tek bir hedef (sipariş veya proje) belirtin.");
        }
        // Resolve base amount + line item sources
        let baseAmount = 0;
        let customerId = null;
        let resolvedProjectId = projectId;
        // Tekliften devralınan meta — istek göndermezse buradan doldurulur.
        let tenderSalesperson = null;
        let tenderCommission = null;
        const sources = [];
        if (salesOrderId) {
            const order = await prisma_client_1.default.salesOrder.findFirst({
                where: { id: salesOrderId, tenantId },
                include: {
                    tender: {
                        select: {
                            salespersonName: true,
                            commissionNumber: true,
                            // Verkäufer boşsa teklifin SAHİBİ satıcıdır — teklif PDF'i de
                            // Verkäufer satırında oluşturanı basar, fatura onu izler.
                            createdBy: { select: { firstName: true, lastName: true } },
                        },
                    },
                },
            });
            if (!order)
                throw new Error("Sipariş bulunamadı.");
            baseAmount = Number(order.totalAmount || 0);
            customerId = order.customerId || null;
            resolvedProjectId = order.projectId || null;
            const tenderCreator = [order.tender?.createdBy?.firstName, order.tender?.createdBy?.lastName]
                .filter(Boolean).join(" ").trim();
            tenderSalesperson = order.tender?.salespersonName || tenderCreator || null;
            tenderCommission = order.tender?.commissionNumber || null;
            sources.push({
                description: `Sipariş ${order.orderNumber}`,
                sourceType: "ORDER",
                sourceId: order.id,
                quantity: 1,
                unitAmount: baseAmount,
                lineTotal: baseAmount,
            });
        }
        else if (projectId) {
            const project = await prisma_client_1.default.project.findFirst({
                where: { id: projectId, tenantId },
                include: { salesOrders: { select: { id: true, orderNumber: true, totalAmount: true } } },
            });
            if (!project)
                throw new Error("Proje bulunamadı.");
            customerId = project.customerId || null;
            const orders = project.salesOrders || [];
            if (orders.length > 0) {
                for (const order of orders) {
                    const amount = Number(order.totalAmount || 0);
                    baseAmount += amount;
                    sources.push({
                        description: `Sipariş ${order.orderNumber}`,
                        sourceType: "ORDER",
                        sourceId: order.id,
                        quantity: 1,
                        unitAmount: amount,
                        lineTotal: amount,
                    });
                }
            }
            if (baseAmount <= 0) {
                baseAmount = Number(project.plannedBudget || 0);
                sources.length = 0;
                sources.push({
                    description: `Proje ${project.projectName} (planlanan bütçe)`,
                    sourceType: "MANUAL",
                    sourceId: project.id,
                    quantity: 1,
                    unitAmount: baseAmount,
                    lineTotal: baseAmount,
                });
            }
        }
        if (baseAmount <= 0) {
            throw new Error("Faturalandırılacak tutar bulunamadı (0).");
        }
        // Invoices accumulate: each billing action creates a NEW invoice and the
        // summed billedPercent across active invoices is the billing progress
        // (matches GetBillingSummaryUseCase). Corrections go through the cancel
        // flow, which releases the cancelled invoice's percentage again.
        const billed = salesOrderId
            ? await this.invoiceRepository.sumBilledForOrder(salesOrderId)
            : await this.invoiceRepository.sumBilledForProject(projectId);
        const billedSoFar = billed.percent;
        const remaining = Math.max(0, round2(100 - billedSoFar));
        if (remaining <= 0.005) {
            throw new Error("Bu hedef zaten tamamen faturalandırılmış.");
        }
        // Fatura türü: istemci gönderirse doğrula, göndermezse billingType +
        // mevcut faturalandırma durumundan türet (eski istemciler değişmeden
        // çalışsın diye).
        let kind;
        if (input.kind) {
            if (!INVOICE_KINDS.includes(input.kind)) {
                throw new Error("Geçersiz fatura türü.");
            }
            kind = input.kind;
        }
        else if (input.billingType === "FULL") {
            kind = billedSoFar > 0.005 ? "SCHLUSS" : "RECHNUNG";
        }
        else {
            kind = billedSoFar > 0.005 ? "ZWISCHEN" : "AKONTO";
        }
        if (kind === "RECHNUNG" && billedSoFar > 0.005) {
            throw new Error("Tam fatura yalnızca hiç fatura kesilmemişken oluşturulabilir. Kalan tutar için Schlussrechnung kullanın.");
        }
        // Determine percent. RECHNUNG/SCHLUSS = the open remainder;
        // AKONTO/ZWISCHEN = requested (default 60%), capped by what is open.
        let percent;
        if (kind === "RECHNUNG" || kind === "SCHLUSS") {
            percent = remaining;
        }
        else {
            const requested = input.percent == null ? DEFAULT_PARTIAL_PERCENT : Number(input.percent);
            if (!Number.isFinite(requested) || requested <= 0 || requested > 100) {
                throw new Error("Geçersiz faturalandırma oranı. 0 ile 100 arasında olmalıdır.");
            }
            if (requested > remaining + 0.005) {
                throw new Error(`En fazla %${remaining} faturalandırılabilir.`);
            }
            percent = round2(requested);
        }
        // KAPANIŞ FATURASI KALAN FRANKI ALIR (Vorgabe 19.08.2026). Yüzdeden
        // hesaplanan tutar her faturada kuruşa yuvarlandığı için (%33.33 +
        // %33.33 + %33.34 → 4'094.99 ≠ 4'095.00), hedefi %100'e tamamlayan
        // fatura yüzdesinden değil, AÇIK BAKİYEDEN hesaplanır: böylece
        // faturaların toplamı sözleşme tutarına birebir oturur ve geriye 0.01
        // bile kalmaz. Aradaki fark sipariş toplamı sonradan değiştiği için
        // büyümüşse de kapanış faturası onu kapatır — açık bakiye 0'dır.
        const closesTarget = percent >= remaining - 0.005;
        const amount = closesTarget
            ? Math.max(0, round2(baseAmount - billed.amount))
            : round2((baseAmount * percent) / 100);
        // Scale line items by percent
        const lineItems = sources.map((source) => {
            const lineTotal = round2((source.lineTotal * percent) / 100);
            return {
                description: percent < 100 ? `${source.description} (%${percent})` : source.description,
                sourceType: source.sourceType,
                sourceId: source.sourceId ?? null,
                quantity: source.quantity,
                unitAmount: lineTotal,
                lineTotal,
            };
        });
        // Kalemler faturanın tutarını AYNEN toplamalı: kapanışta oluşan yuvarlama
        // farkı son kaleme yazılır (tek kalemli sipariş faturasında bu, kalemi
        // doğrudan kalan bakiyeye eşitler).
        const lastItem = lineItems[lineItems.length - 1];
        if (lastItem) {
            const drift = round2(amount - lineItems.reduce((sum, item) => sum + item.lineTotal, 0));
            if (drift !== 0) {
                lastItem.lineTotal = round2(lastItem.lineTotal + drift);
                lastItem.unitAmount = lastItem.lineTotal;
            }
        }
        const invoiceData = {
            tenantId,
            customerId,
            projectId: resolvedProjectId,
            salesOrderId,
            // billingType, kind'dan türetilir ki ikisi asla çelişmesin.
            billingType: (kind === "RECHNUNG" || kind === "SCHLUSS" ? "FULL" : "PARTIAL"),
            kind,
            invoiceDate: parseIsoDate(input.invoiceDate) ?? new Date(),
            // Fälligkeit gönderilmezse Rechnungsdatum'a eşitlenir — iki tarih
            // çoğunlukla aynı gündür (kullanıcı isteği), belge boş satır basmaz.
            dueDate: parseIsoDate(input.dueDate) ?? parseIsoDate(input.invoiceDate) ?? new Date(),
            salespersonName: input.salespersonName?.trim() || tenderSalesperson,
            commissionNumber: input.commissionNumber?.trim() || tenderCommission,
            billedPercent: percent,
            baseAmount: round2(baseAmount),
            amount,
            status: "ISSUED",
            notes: input.notes?.trim() || null,
            issuedByEmployeeId,
        };
        // Fatura kodu RE- serisinden gelir ve her dilde aynıdır. Eskiden
        // `countForTenant() + 1` kullanılıyordu; silinen/iptal edilen bir fatura
        // sayımı düşürdüğü için aynı numara ikinci kez dağıtılabiliyordu —
        // DocumentCounter yalnızca ileri gider.
        const invoiceNumber = await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'INVOICE');
        return this.invoiceRepository.createWithItems({ ...invoiceData, invoiceNumber }, lineItems);
    }
}
exports.CreateInvoiceUseCase = CreateInvoiceUseCase;
//# sourceMappingURL=CreateInvoiceUseCase.js.map