"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetBillingSummaryUseCase = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const billingRounding_1 = require("../../utils/billingRounding");
const paymentSchedule_1 = require("../../utils/paymentSchedule");
class GetBillingSummaryUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(params) {
        const { tenantId } = params;
        const salesOrderId = params.salesOrderId?.trim() || null;
        const projectId = params.projectId?.trim() || null;
        if ((!salesOrderId && !projectId) || (salesOrderId && projectId)) {
            throw new Error("Özet için tek bir hedef (sipariş veya proje) belirtin.");
        }
        let baseAmount = 0;
        let paymentStagesRaw = null;
        if (salesOrderId) {
            const order = await prisma_client_1.default.salesOrder.findFirst({
                where: { id: salesOrderId, tenantId },
                select: { totalAmount: true, paymentStages: true },
            });
            if (!order)
                throw new Error("Sipariş bulunamadı.");
            baseAmount = Number(order.totalAmount || 0);
            paymentStagesRaw = order.paymentStages ?? null;
        }
        else {
            const project = await prisma_client_1.default.project.findFirst({
                where: { id: projectId, tenantId },
                select: { plannedBudget: true, salesOrders: { select: { totalAmount: true } } },
            });
            if (!project)
                throw new Error("Proje bulunamadı.");
            const ordersTotal = (project.salesOrders || []).reduce((sum, o) => sum + Number(o.totalAmount || 0), 0);
            baseAmount = ordersTotal > 0 ? ordersTotal : Number(project.plannedBudget || 0);
        }
        const invoices = await this.invoiceRepository.list({
            tenantId,
            salesOrderId: salesOrderId || undefined,
            projectId: projectId || undefined,
        });
        return this.buildSummary(baseAmount, invoices, paymentStagesRaw);
    }
    /**
     * Computes billing summaries for many sales orders with a single invoice query
     * instead of one query per order (avoids the N+1 fan-out on list endpoints).
     * `baseAmount` is taken from the already-loaded order so no extra lookups are needed.
     */
    async executeBatch(tenantId, targets) {
        const result = new Map();
        const ids = [...new Set(targets.map((t) => t.salesOrderId).filter(Boolean))];
        if (ids.length === 0)
            return result;
        const invoices = await this.invoiceRepository.listForOrders(tenantId, ids);
        return this.buildBatchFromInvoices(targets, invoices);
    }
    /**
     * `executeBatch`'in sorgusuz hâli: faturaları ZATEN yüklemiş çağıranlar için.
     * Liste uç noktaları fatura sorgusunu sipariş sorgusuyla PARALEL çalıştırıp
     * sonucu buraya veriyor — böylece iki uzak tur ardışık değil eş zamanlı olur.
     */
    buildBatchFromInvoices(targets, invoices) {
        const result = new Map();
        const byOrder = new Map();
        for (const inv of invoices) {
            const key = inv.salesOrderId ?? inv.salesOrder?.id;
            if (!key)
                continue;
            const bucket = byOrder.get(key);
            if (bucket)
                bucket.push(inv);
            else
                byOrder.set(key, [inv]);
        }
        for (const { salesOrderId, baseAmount, paymentStages } of targets) {
            if (result.has(salesOrderId))
                continue;
            result.set(salesOrderId, this.buildSummary(baseAmount, byOrder.get(salesOrderId) || [], paymentStages ?? null));
        }
        return result;
    }
    buildSummary(baseAmount, invoices, paymentStagesRaw) {
        const active = invoices.filter((inv) => inv.status !== "CANCELLED");
        const billedPercent = (0, billingRounding_1.round2)(active.reduce((sum, inv) => sum + Number(inv.billedPercent || 0), 0));
        const billedAmount = (0, billingRounding_1.round2)(active.reduce((sum, inv) => sum + Number(inv.amount || 0), 0));
        const paid = active.filter((inv) => inv.status === "PAID");
        const paidPercent = (0, billingRounding_1.round2)(paid.reduce((sum, inv) => sum + Number(inv.billedPercent || 0), 0));
        const paidAmount = (0, billingRounding_1.round2)(paid.reduce((sum, inv) => sum + Number(inv.amount || 0), 0));
        const remainingPercent = (0, billingRounding_1.round2)(Math.max(0, 100 - billedPercent));
        // %100 faturalandırılmış bir hedefte AÇIK BAKİYE KALMAZ — 0.01 bile
        // (Vorgabe 19.08.2026). Kalan kuruş, her faturanın tutarı ayrı ayrı
        // yuvarlandığı için oluşan yuvarlama tozudur; `openAmount` onu sıfırlar,
        // gerçek bir fark (sipariş toplamı sonradan büyüdüyse) olduğu gibi kalır.
        const remainingAmount = Math.max(0, (0, billingRounding_1.openAmount)(billedPercent, baseAmount, billedAmount));
        const paymentStages = (0, paymentSchedule_1.parsePaymentStages)(paymentStagesRaw);
        return {
            baseAmount: (0, billingRounding_1.round2)(baseAmount),
            billedPercent,
            billedAmount,
            paidPercent,
            paidAmount,
            remainingPercent,
            remainingAmount,
            paymentStages,
            nextStage: paymentStages ? (0, paymentSchedule_1.nextStageInfo)(paymentStages, billedPercent, remainingPercent) : null,
            invoices: invoices.map((inv) => ({
                id: inv.id,
                invoiceNumber: inv.invoiceNumber,
                billingType: inv.billingType,
                kind: inv.kind ?? "RECHNUNG",
                billedPercent: inv.billedPercent,
                amount: inv.amount,
                status: inv.status,
                createdAt: inv.createdAt,
            })),
        };
    }
}
exports.GetBillingSummaryUseCase = GetBillingSummaryUseCase;
//# sourceMappingURL=GetBillingSummaryUseCase.js.map