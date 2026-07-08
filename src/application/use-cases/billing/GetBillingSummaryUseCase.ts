import { IInvoiceRepository } from "../../../domain/repositories/IInvoiceRepository";
import prisma from "../../../infrastructure/database/prisma.client";

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export interface BillingSummary {
    baseAmount: number;
    billedPercent: number;
    billedAmount: number;
    remainingPercent: number;
    remainingAmount: number;
    invoices: Array<{
        id: string;
        invoiceNumber: string;
        billingType: string;
        billedPercent: number;
        amount: number;
        status: string;
        createdAt: Date;
    }>;
}

export class GetBillingSummaryUseCase {
    constructor(private invoiceRepository: IInvoiceRepository) {}

    async execute(params: { tenantId: string; salesOrderId?: string | null; projectId?: string | null }): Promise<BillingSummary> {
        const { tenantId } = params;
        const salesOrderId = params.salesOrderId?.trim() || null;
        const projectId = params.projectId?.trim() || null;

        if ((!salesOrderId && !projectId) || (salesOrderId && projectId)) {
            throw new Error("Özet için tek bir hedef (sipariş veya proje) belirtin.");
        }

        let baseAmount = 0;
        if (salesOrderId) {
            const order: any = await (prisma as any).salesOrder.findFirst({
                where: { id: salesOrderId, tenantId },
                select: { totalAmount: true },
            });
            if (!order) throw new Error("Sipariş bulunamadı.");
            baseAmount = Number(order.totalAmount || 0);
        } else {
            const project: any = await (prisma as any).project.findFirst({
                where: { id: projectId, tenantId },
                select: { plannedBudget: true, salesOrders: { select: { totalAmount: true } } },
            });
            if (!project) throw new Error("Proje bulunamadı.");
            const ordersTotal = (project.salesOrders || []).reduce((sum: number, o: any) => sum + Number(o.totalAmount || 0), 0);
            baseAmount = ordersTotal > 0 ? ordersTotal : Number(project.plannedBudget || 0);
        }

        const invoices = await this.invoiceRepository.list({
            tenantId,
            salesOrderId: salesOrderId || undefined,
            projectId: projectId || undefined,
        });

        return this.buildSummary(baseAmount, invoices);
    }

    /**
     * Computes billing summaries for many sales orders with a single invoice query
     * instead of one query per order (avoids the N+1 fan-out on list endpoints).
     * `baseAmount` is taken from the already-loaded order so no extra lookups are needed.
     */
    async executeBatch(
        tenantId: string,
        targets: Array<{ salesOrderId: string; baseAmount: number }>
    ): Promise<Map<string, BillingSummary>> {
        const result = new Map<string, BillingSummary>();
        const ids = [...new Set(targets.map((t) => t.salesOrderId).filter(Boolean))];
        if (ids.length === 0) return result;

        const invoices = await this.invoiceRepository.listForOrders(tenantId, ids);

        const byOrder = new Map<string, typeof invoices>();
        for (const inv of invoices) {
            const key = (inv as any).salesOrderId ?? (inv as any).salesOrder?.id;
            if (!key) continue;
            const bucket = byOrder.get(key);
            if (bucket) bucket.push(inv);
            else byOrder.set(key, [inv]);
        }

        for (const { salesOrderId, baseAmount } of targets) {
            if (result.has(salesOrderId)) continue;
            result.set(salesOrderId, this.buildSummary(baseAmount, byOrder.get(salesOrderId) || []));
        }
        return result;
    }

    private buildSummary(
        baseAmount: number,
        invoices: Array<{ id: string; invoiceNumber: string; billingType: string; billedPercent: number; amount: number; status: string; createdAt: Date }>
    ): BillingSummary {
        const active = invoices.filter((inv) => inv.status !== "CANCELLED");
        const billedPercent = round2(active.reduce((sum, inv) => sum + Number(inv.billedPercent || 0), 0));
        const billedAmount = round2(active.reduce((sum, inv) => sum + Number(inv.amount || 0), 0));
        const remainingPercent = round2(Math.max(0, 100 - billedPercent));
        const remainingAmount = round2(Math.max(0, baseAmount - billedAmount));

        return {
            baseAmount: round2(baseAmount),
            billedPercent,
            billedAmount,
            remainingPercent,
            remainingAmount,
            invoices: invoices.map((inv) => ({
                id: inv.id,
                invoiceNumber: inv.invoiceNumber,
                billingType: inv.billingType,
                billedPercent: inv.billedPercent,
                amount: inv.amount,
                status: inv.status,
                createdAt: inv.createdAt,
            })),
        };
    }
}
