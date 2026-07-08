"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoiceRepository = void 0;
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
    async list(filter) {
        const where = { tenantId: filter.tenantId };
        if (filter.projectId)
            where.projectId = filter.projectId;
        if (filter.salesOrderId)
            where.salesOrderId = filter.salesOrderId;
        if (filter.customerId)
            where.customerId = filter.customerId;
        if (filter.status)
            where.status = filter.status;
        return (await prisma_client_1.default.invoice.findMany({
            where,
            orderBy: { createdAt: "desc" },
            include: invoiceInclude,
        }));
    }
    async listForOrders(tenantId, salesOrderIds) {
        if (salesOrderIds.length === 0)
            return [];
        return (await prisma_client_1.default.invoice.findMany({
            where: { tenantId, salesOrderId: { in: salesOrderIds } },
            orderBy: { createdAt: "desc" },
            include: invoiceInclude,
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
}
exports.InvoiceRepository = InvoiceRepository;
//# sourceMappingURL=InvoiceRepository.js.map