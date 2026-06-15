import { IInvoiceRepository, InvoiceLineItemInput } from "../../../domain/repositories/IInvoiceRepository";
import { InvoiceBillingType } from "../../../domain/entities/Invoice";
import prisma from "../../../infrastructure/database/prisma.client";

export interface CreateInvoiceInput {
    tenantId: string;
    issuedByEmployeeId: string;
    salesOrderId?: string | null;
    projectId?: string | null;
    billingType: InvoiceBillingType;
    percent?: number | null;
    invoiceNumber?: string | null;
    notes?: string | null;
}

const DEFAULT_PARTIAL_PERCENT = 60;
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export class CreateInvoiceUseCase {
    constructor(private invoiceRepository: IInvoiceRepository) {}

    async execute(input: CreateInvoiceInput) {
        const { tenantId, issuedByEmployeeId } = input;
        const salesOrderId = input.salesOrderId?.trim() || null;
        const projectId = input.projectId?.trim() || null;

        if ((!salesOrderId && !projectId) || (salesOrderId && projectId)) {
            throw new Error("Faturalandırma için tek bir hedef (sipariş veya proje) belirtin.");
        }

        // Resolve base amount + line item sources
        let baseAmount = 0;
        let customerId: string | null = null;
        let resolvedProjectId: string | null = projectId;
        const sources: Array<Omit<InvoiceLineItemInput, "quantity"> & { quantity: number }> = [];

        if (salesOrderId) {
            const order: any = await (prisma as any).salesOrder.findFirst({
                where: { id: salesOrderId, tenantId },
            });
            if (!order) throw new Error("Sipariş bulunamadı.");
            baseAmount = Number(order.totalAmount || 0);
            customerId = order.customerId || null;
            resolvedProjectId = order.projectId || null;
            sources.push({
                description: `Sipariş ${order.orderNumber}`,
                sourceType: "ORDER",
                sourceId: order.id,
                quantity: 1,
                unitAmount: baseAmount,
                lineTotal: baseAmount,
            });
        } else if (projectId) {
            const project: any = await (prisma as any).project.findFirst({
                where: { id: projectId, tenantId },
                include: { salesOrders: { select: { id: true, orderNumber: true, totalAmount: true } } },
            });
            if (!project) throw new Error("Proje bulunamadı.");
            customerId = project.customerId || null;
            const orders: any[] = project.salesOrders || [];
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

        // Check for existing active invoice for this order/project
        const existingInvoice = salesOrderId
            ? await this.invoiceRepository.findActiveByOrder(salesOrderId, tenantId)
            : await this.invoiceRepository.findActiveByProject(projectId!, tenantId);

        // Determine percent. FULL = 100%; PARTIAL = requested (default 60%).
        let percent: number;
        if (input.billingType === "FULL") {
            percent = 100;
        } else {
            const requested = input.percent == null ? DEFAULT_PARTIAL_PERCENT : Number(input.percent);
            if (!Number.isFinite(requested) || requested <= 0 || requested > 100) {
                throw new Error("Geçersiz faturalandırma oranı. 0 ile 100 arasında olmalıdır.");
            }
            percent = requested;
        }

        const amount = round2((baseAmount * percent) / 100);

        // Scale line items by percent
        const lineItems: InvoiceLineItemInput[] = sources.map((source) => {
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

        const invoiceData = {
            tenantId,
            customerId,
            projectId: resolvedProjectId,
            salesOrderId,
            billingType: input.billingType,
            billedPercent: percent,
            baseAmount: round2(baseAmount),
            amount,
            status: "ISSUED" as const,
            notes: input.notes?.trim() || null,
            issuedByEmployeeId,
        };

        if (existingInvoice) {
            // Update existing invoice instead of creating a new one
            return this.invoiceRepository.updateWithItems(existingInvoice.id, invoiceData, lineItems);
        }

        // Invoice number (only needed for new invoices)
        let invoiceNumber = input.invoiceNumber?.trim() || "";
        if (!invoiceNumber) {
            const year = new Date().getFullYear();
            const seq = (await this.invoiceRepository.countForTenant(tenantId)) + 1;
            invoiceNumber = `INV-${year}-${String(seq).padStart(4, "0")}`;
        }

        return this.invoiceRepository.createWithItems({ ...invoiceData, invoiceNumber }, lineItems);
    }
}
