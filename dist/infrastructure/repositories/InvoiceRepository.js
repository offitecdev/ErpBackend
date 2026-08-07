"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoiceRepository = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const invoiceInclude = {
    lineItems: true,
    customer: { select: { id: true, companyName: true } },
    project: { select: { id: true, projectName: true } },
    salesOrder: { select: { id: true, orderNumber: true } },
    issuedBy: { select: { id: true, firstName: true, lastName: true } },
};
class InvoiceRepository {
    async createWithItems(invoice, items) {
        return (await prisma_client_1.default.$transaction(async (tx) => {
            const created = await tx.invoice.create({ data: invoice });
            if (items.length > 0) {
                await tx.invoiceLineItem.createMany({
                    data: items.map((item) => ({ ...item, invoiceId: created.id })),
                });
            }
            return tx.invoice.findUnique({ where: { id: created.id }, include: invoiceInclude });
        }));
    }
    async updateWithItems(id, invoice, items) {
        return (await prisma_client_1.default.$transaction(async (tx) => {
            await tx.invoice.update({ where: { id }, data: invoice });
            await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
            if (items.length > 0) {
                await tx.invoiceLineItem.createMany({
                    data: items.map((item) => ({ ...item, invoiceId: id })),
                });
            }
            return tx.invoice.findUnique({ where: { id }, include: invoiceInclude });
        }));
    }
    async findActiveByOrder(salesOrderId, tenantId) {
        return (await prisma_client_1.default.invoice.findFirst({
            where: { salesOrderId, tenantId, status: { not: "CANCELLED" } },
            include: invoiceInclude,
        }));
    }
    async findActiveByProject(projectId, tenantId) {
        return (await prisma_client_1.default.invoice.findFirst({
            where: { projectId, tenantId, status: { not: "CANCELLED" } },
            include: invoiceInclude,
        }));
    }
    async findById(id, tenantId) {
        return (await prisma_client_1.default.invoice.findFirst({
            where: { id, tenantId },
            include: invoiceInclude,
        }));
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
    async list(filter) {
        const conditions = [client_1.Prisma.sql `i.tenantId = ${filter.tenantId}`];
        if (filter.projectId)
            conditions.push(client_1.Prisma.sql `i.projectId = ${filter.projectId}`);
        if (filter.salesOrderId)
            conditions.push(client_1.Prisma.sql `i.salesOrderId = ${filter.salesOrderId}`);
        if (filter.customerId)
            conditions.push(client_1.Prisma.sql `i.customerId = ${filter.customerId}`);
        if (filter.status)
            conditions.push(client_1.Prisma.sql `i.status = ${filter.status}`);
        const whereSql = client_1.Prisma.join(conditions, ' AND ');
        const [rows, lineItems] = await Promise.all([
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT
                    i.id, i.tenantId, i.customerId, i.projectId, i.salesOrderId,
                    i.invoiceNumber, i.billingType, i.kind, i.invoiceDate, i.dueDate,
                    i.salespersonName, i.commissionNumber, i.billedPercent, i.baseAmount,
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
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT li.id, li.invoiceId, li.description, li.sourceType, li.sourceId,
                       li.quantity, li.unitAmount, li.lineTotal
                FROM InvoiceLineItem li
                WHERE li.invoiceId IN (SELECT i.id FROM Invoice i WHERE ${whereSql})
            `),
        ]);
        const itemsByInvoice = new Map();
        for (const item of lineItems) {
            const bucket = itemsByInvoice.get(item.invoiceId);
            if (bucket)
                bucket.push(item);
            else
                itemsByInvoice.set(item.invoiceId, [item]);
        }
        return rows.map((row) => ({
            id: row.id,
            tenantId: row.tenantId,
            customerId: row.customerId ?? null,
            projectId: row.projectId ?? null,
            salesOrderId: row.salesOrderId ?? null,
            invoiceNumber: row.invoiceNumber,
            billingType: row.billingType,
            kind: row.kind ?? 'RECHNUNG',
            invoiceDate: row.invoiceDate ?? null,
            dueDate: row.dueDate ?? null,
            salespersonName: row.salespersonName ?? null,
            commissionNumber: row.commissionNumber ?? null,
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
        }));
    }
    // Feeds the batch billing summary only, so it selects the summary columns
    // instead of the full `invoiceInclude` — no line items, no joined customer /
    // project / order / employee rows for every invoice of every listed order.
    async listForOrders(tenantId, salesOrderIds) {
        if (salesOrderIds.length === 0)
            return [];
        return (await prisma_client_1.default.invoice.findMany({
            where: { tenantId, salesOrderId: { in: salesOrderIds } },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                salesOrderId: true,
                invoiceNumber: true,
                billingType: true,
                kind: true,
                billedPercent: true,
                amount: true,
                status: true,
                createdAt: true,
            },
        }));
    }
    async countForTenant(tenantId) {
        return prisma_client_1.default.invoice.count({ where: { tenantId } });
    }
    async sumBilledPercent(where) {
        const agg = await prisma_client_1.default.invoice.aggregate({
            where: { ...where, status: { not: "CANCELLED" } },
            _sum: { billedPercent: true },
        });
        return Number(agg?._sum?.billedPercent || 0);
    }
    async sumBilledPercentForOrder(salesOrderId) {
        return this.sumBilledPercent({ salesOrderId });
    }
    async sumBilledPercentForProject(projectId) {
        return this.sumBilledPercent({ projectId });
    }
    async updateStatus(id, tenantId, status) {
        const existing = await prisma_client_1.default.invoice.findFirst({ where: { id, tenantId } });
        if (!existing)
            throw new Error("Fatura bulunamadı.");
        await prisma_client_1.default.invoice.update({ where: { id }, data: { status } });
        return (await prisma_client_1.default.invoice.findUnique({ where: { id }, include: invoiceInclude }));
    }
    async delete(id, tenantId) {
        const existing = await prisma_client_1.default.invoice.findFirst({ where: { id, tenantId } });
        if (!existing)
            throw new Error("Fatura bulunamadı.");
        await prisma_client_1.default.$transaction(async (tx) => {
            await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
            await tx.invoice.delete({ where: { id } });
        });
    }
}
exports.InvoiceRepository = InvoiceRepository;
//# sourceMappingURL=InvoiceRepository.js.map