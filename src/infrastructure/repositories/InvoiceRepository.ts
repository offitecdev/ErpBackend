import { Prisma } from "@prisma/client";
import prisma from "../database/prisma.client";
import { Invoice, InvoiceStatus } from "../../domain/entities/Invoice";
import { IInvoiceFilter, IInvoiceRepository, InvoiceLineItemInput, InvoiceSummaryRow } from "../../domain/repositories/IInvoiceRepository";

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

    /**
     * Fatura listesi — cevap şekli `invoiceInclude` ile birebir aynı, ama iki
     * PARALEL ifadeyle üretiliyor (eskiden altı ARDIŞIK ifade).
     *
     * Prisma'da her `include` ayrı bir sorgu turu demek: veritabanı uzak olduğu
     * için (ifade başına ~100 ms) müşteri/proje/sipariş/personel/kalem ilişkileri
     * tek başına ~450 ms tutuyordu. Skaler ilişkiler artık tek JOIN'de geliyor;
     * kalemler ise aynı WHERE'i alt sorgu olarak kullandığı için sayfa id'lerini
     * beklemek zorunda değil, ilk sorguyla eş zamanlı koşuyor.
     */
    async list(filter: IInvoiceFilter): Promise<Invoice[]> {
        const conditions: Prisma.Sql[] = [Prisma.sql`i.tenantId = ${filter.tenantId}`];
        if (filter.projectId) conditions.push(Prisma.sql`i.projectId = ${filter.projectId}`);
        if (filter.salesOrderId) conditions.push(Prisma.sql`i.salesOrderId = ${filter.salesOrderId}`);
        if (filter.customerId) conditions.push(Prisma.sql`i.customerId = ${filter.customerId}`);
        if (filter.status) conditions.push(Prisma.sql`i.status = ${filter.status}`);
        const whereSql = Prisma.join(conditions, ' AND ');

        const [rows, lineItems] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT
                    i.id, i.tenantId, i.customerId, i.projectId, i.salesOrderId,
                    i.invoiceNumber, i.billingType, i.billedPercent, i.baseAmount,
                    i.amount, i.status, i.notes, i.issuedByEmployeeId,
                    i.createdAt, i.updatedAt,
                    c.companyName AS customerCompanyName,
                    pr.projectName AS projectName,
                    so.orderNumber AS orderNumber,
                    e.firstName AS issuerFirstName,
                    e.lastName AS issuerLastName
                FROM Invoice i
                LEFT JOIN Customer c ON c.id = i.customerId
                LEFT JOIN Project pr ON pr.id = i.projectId
                LEFT JOIN SalesOrder so ON so.id = i.salesOrderId
                LEFT JOIN Employee e ON e.id = i.issuedByEmployeeId
                WHERE ${whereSql}
                ORDER BY i.createdAt DESC
            `),
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT li.id, li.invoiceId, li.description, li.sourceType, li.sourceId,
                       li.quantity, li.unitAmount, li.lineTotal
                FROM InvoiceLineItem li
                WHERE li.invoiceId IN (SELECT i.id FROM Invoice i WHERE ${whereSql})
            `),
        ]);

        const itemsByInvoice = new Map<string, any[]>();
        for (const item of lineItems) {
            const bucket = itemsByInvoice.get(item.invoiceId);
            if (bucket) bucket.push(item);
            else itemsByInvoice.set(item.invoiceId, [item]);
        }

        return rows.map((row) => ({
            id: row.id,
            tenantId: row.tenantId,
            customerId: row.customerId ?? null,
            projectId: row.projectId ?? null,
            salesOrderId: row.salesOrderId ?? null,
            invoiceNumber: row.invoiceNumber,
            billingType: row.billingType,
            billedPercent: Number(row.billedPercent ?? 0),
            baseAmount: Number(row.baseAmount ?? 0),
            amount: Number(row.amount ?? 0),
            status: row.status,
            notes: row.notes ?? null,
            issuedByEmployeeId: row.issuedByEmployeeId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            lineItems: itemsByInvoice.get(row.id) ?? [],
            customer: row.customerId
                ? { id: row.customerId, companyName: row.customerCompanyName }
                : null,
            project: row.projectId
                ? { id: row.projectId, projectName: row.projectName }
                : null,
            salesOrder: row.salesOrderId
                ? { id: row.salesOrderId, orderNumber: row.orderNumber }
                : null,
            issuedBy: row.issuedByEmployeeId
                ? { id: row.issuedByEmployeeId, firstName: row.issuerFirstName, lastName: row.issuerLastName }
                : null,
        })) as unknown as Invoice[];
    }

    // Feeds the batch billing summary only, so it selects the summary columns
    // instead of the full `invoiceInclude` — no line items, no joined customer /
    // project / order / employee rows for every invoice of every listed order.
    async listForOrders(tenantId: string, salesOrderIds: string[]): Promise<InvoiceSummaryRow[]> {
        if (salesOrderIds.length === 0) return [];
        return (await (prisma as any).invoice.findMany({
            where: { tenantId, salesOrderId: { in: salesOrderIds } },
            orderBy: { createdAt: "desc" },
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
        })) as unknown as InvoiceSummaryRow[];
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
