import prisma from "../database/prisma.client";
import { Invoice, InvoiceStatus } from "../../domain/entities/Invoice";
import { IInvoiceFilter, IInvoiceRepository, InvoiceLineItemInput } from "../../domain/repositories/IInvoiceRepository";

const invoiceInclude = {
    lineItems: true,
    customer: { select: { id: true, companyName: true } },
    project: { select: { id: true, projectName: true } },
    salesOrder: { select: { id: true, orderNumber: true } },
    issuedBy: { select: { id: true, firstName: true, lastName: true } },
};

export class InvoiceRepository implements IInvoiceRepository {
    async createWithItems(invoice: Partial<Invoice>, items: InvoiceLineItemInput[]): Promise<Invoice> {
        return (await prisma.$transaction(async (tx) => {
            const created = await (tx as any).invoice.create({ data: invoice as any });
            if (items.length > 0) {
                await (tx as any).invoiceLineItem.createMany({
                    data: items.map((item) => ({ ...item, invoiceId: created.id })),
                });
            }
            return (tx as any).invoice.findUnique({ where: { id: created.id }, include: invoiceInclude });
        })) as unknown as Invoice;
    }

    async updateWithItems(id: string, invoice: Partial<Invoice>, items: InvoiceLineItemInput[]): Promise<Invoice> {
        return (await prisma.$transaction(async (tx) => {
            await (tx as any).invoice.update({ where: { id }, data: invoice as any });
            await (tx as any).invoiceLineItem.deleteMany({ where: { invoiceId: id } });
            if (items.length > 0) {
                await (tx as any).invoiceLineItem.createMany({
                    data: items.map((item) => ({ ...item, invoiceId: id })),
                });
            }
            return (tx as any).invoice.findUnique({ where: { id }, include: invoiceInclude });
        })) as unknown as Invoice;
    }

    async findActiveByOrder(salesOrderId: string, tenantId: string): Promise<Invoice | null> {
        return (await (prisma as any).invoice.findFirst({
            where: { salesOrderId, tenantId, status: { not: "CANCELLED" } },
            include: invoiceInclude,
        })) as unknown as Invoice | null;
    }

    async findActiveByProject(projectId: string, tenantId: string): Promise<Invoice | null> {
        return (await (prisma as any).invoice.findFirst({
            where: { projectId, tenantId, status: { not: "CANCELLED" } },
            include: invoiceInclude,
        })) as unknown as Invoice | null;
    }

    async findById(id: string, tenantId: string): Promise<Invoice | null> {
        return (await (prisma as any).invoice.findFirst({
            where: { id, tenantId },
            include: invoiceInclude,
        })) as unknown as Invoice | null;
    }

    async list(filter: IInvoiceFilter): Promise<Invoice[]> {
        const where: any = { tenantId: filter.tenantId };
        if (filter.projectId) where.projectId = filter.projectId;
        if (filter.salesOrderId) where.salesOrderId = filter.salesOrderId;
        if (filter.customerId) where.customerId = filter.customerId;
        if (filter.status) where.status = filter.status;
        return (await (prisma as any).invoice.findMany({
            where,
            orderBy: { createdAt: "desc" },
            include: invoiceInclude,
        })) as unknown as Invoice[];
    }

    async countForTenant(tenantId: string): Promise<number> {
        return (prisma as any).invoice.count({ where: { tenantId } });
    }

    private async sumBilledPercent(where: any): Promise<number> {
        const agg = await (prisma as any).invoice.aggregate({
            where: { ...where, status: { not: "CANCELLED" } },
            _sum: { billedPercent: true },
        });
        return Number(agg?._sum?.billedPercent || 0);
    }

    async sumBilledPercentForOrder(salesOrderId: string): Promise<number> {
        return this.sumBilledPercent({ salesOrderId });
    }

    async sumBilledPercentForProject(projectId: string): Promise<number> {
        return this.sumBilledPercent({ projectId });
    }

    async updateStatus(id: string, tenantId: string, status: InvoiceStatus): Promise<Invoice> {
        const existing = await (prisma as any).invoice.findFirst({ where: { id, tenantId } });
        if (!existing) throw new Error("Fatura bulunamadı.");
        await (prisma as any).invoice.update({ where: { id }, data: { status } });
        return (await (prisma as any).invoice.findUnique({ where: { id }, include: invoiceInclude })) as unknown as Invoice;
    }
}
