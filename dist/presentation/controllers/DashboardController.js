"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardController = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const serviceTenantScope_1 = require("./serviceTenantScope");
const salesOrder_pricing_1 = require("./salesOrder.pricing");
const round2 = (value) => Math.round(value * 100) / 100;
// Percentage with one decimal; 0 when the denominator is empty.
const rate = (part, whole) => whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
// Order buckets for the delivery-vs-project split. INVOICE conversions are
// direct delivery orders; everything project-bound (new/existing conversions,
// Nachtrag addons, Regie) counts to the project bucket. Unknown types land in
// "other" so a future mode never silently vanishes from the total.
const DELIVERY_ORDER_TYPES = new Set(['INVOICE']);
const PROJECT_ORDER_TYPES = new Set(['PROJECT_NEW', 'PROJECT_EXISTING', 'PROJECT_ADDON', 'REGIE']);
// Gross offer value per tender, mirroring salesOrder.pricing.orderTotal():
// line net after line discount (calculated price as fallback), grossed up by
// VAT (0/NULL -> DEFAULT_VAT), then both document-level discounts applied
// sequentially. Keeps the dashboard figure equal to the offer PDF total.
const tenderGrossSql = (tenantIds) => client_1.Prisma.sql `
    SELECT COALESCE(SUM(
        sub.gross
        * (1 - LEAST(100, GREATEST(0, COALESCE(t.directDiscount, 0))) / 100)
        * (1 - LEAST(100, GREATEST(0, COALESCE(t.extraDiscount, 0))) / 100)
    ), 0) AS total
    FROM Tender t
    JOIN (
        SELECT p.tenderId AS tenderId,
            SUM(
                (CASE
                    WHEN p.unitPrice IS NOT NULL AND p.quantity > 0
                        THEN p.quantity * p.unitPrice * (1 - COALESCE(p.discount, 0) / 100)
                    ELSE GREATEST(0, COALESCE(ci.totalCalculatedPrice, 0))
                END)
                * (1 + (CASE
                    WHEN COALESCE(p.taxRate, 0) = 0 THEN ${salesOrder_pricing_1.DEFAULT_VAT}
                    ELSE p.taxRate
                END) / 100)
            ) AS gross
        FROM Position p
        LEFT JOIN CalculationItem ci ON ci.positionId = p.id
        GROUP BY p.tenderId
    ) sub ON sub.tenderId = t.id
    WHERE t.tenantId IN (${client_1.Prisma.join(tenantIds)})
`;
class DashboardController {
    /**
     * GET /dashboard/summary — all headline numbers for the overview screen in
     * one round trip: entity counts, quote-conversion rates and the financial
     * totals (quote value, order value split by bucket, invoiced/paid/unbilled).
     */
    async getSummary(req, res) {
        try {
            const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(req.user.tenantId);
            if (tenantIds.length === 0) {
                res.status(200).json(emptySummary());
                return;
            }
            const scoped = { tenantId: { in: tenantIds } };
            const [customerCount, tenderCount, projectCount, activeProjectCount, convertedTenderCount, projectTenderCount, deliveryTenderCount, ordersByType, quoteValueRows, invoicedAgg, paidAgg,] = await Promise.all([
                prisma_client_1.default.customer.count({ where: { ...scoped, isActive: true } }),
                prisma_client_1.default.tender.count({ where: scoped }),
                prisma_client_1.default.project.count({ where: scoped }),
                prisma_client_1.default.project.count({ where: { ...scoped, status: 'ACTIVE' } }),
                prisma_client_1.default.tender.count({ where: { ...scoped, salesOrder: { isNot: null } } }),
                prisma_client_1.default.tender.count({ where: { ...scoped, salesOrder: { is: { projectId: { not: null } } } } }),
                prisma_client_1.default.tender.count({ where: { ...scoped, salesOrder: { is: { orderType: 'INVOICE' } } } }),
                prisma_client_1.default.salesOrder.groupBy({
                    by: ['orderType'],
                    where: scoped,
                    _count: { _all: true },
                    _sum: { totalAmount: true },
                }),
                prisma_client_1.default.$queryRaw(tenderGrossSql(tenantIds)),
                // Cancelled invoices never count as billed.
                prisma_client_1.default.invoice.aggregate({
                    where: { ...scoped, status: { not: 'CANCELLED' } },
                    _sum: { amount: true },
                }),
                prisma_client_1.default.invoice.aggregate({
                    where: { ...scoped, status: 'PAID' },
                    _sum: { amount: true },
                }),
            ]);
            const orderCountsByType = ordersByType.map((row) => ({
                type: row.orderType,
                count: row._count._all,
                total: round2(Number(row._sum.totalAmount ?? 0)),
            }));
            const bucketTotal = (bucket) => round2(orderCountsByType
                .filter((row) => bucket.has(row.type))
                .reduce((sum, row) => sum + row.total, 0));
            const orderCount = orderCountsByType.reduce((sum, row) => sum + row.count, 0);
            const orderValueTotal = round2(orderCountsByType.reduce((sum, row) => sum + row.total, 0));
            const deliveryValue = bucketTotal(DELIVERY_ORDER_TYPES);
            const projectValue = bucketTotal(PROJECT_ORDER_TYPES);
            const invoiced = round2(Number(invoicedAgg._sum.amount ?? 0));
            const paid = round2(Number(paidAgg._sum.amount ?? 0));
            res.status(200).json({
                counts: {
                    customers: customerCount,
                    tenders: tenderCount,
                    orders: orderCount,
                    projects: projectCount,
                    activeProjects: activeProjectCount,
                },
                conversion: {
                    tenders: tenderCount,
                    converted: convertedTenderCount,
                    toProject: projectTenderCount,
                    toDelivery: deliveryTenderCount,
                    orderRate: rate(convertedTenderCount, tenderCount),
                    projectRate: rate(projectTenderCount, tenderCount),
                    deliveryRate: rate(deliveryTenderCount, tenderCount),
                },
                financials: {
                    quoteValue: round2(Number(quoteValueRows[0]?.total ?? 0)),
                    orderValue: {
                        total: orderValueTotal,
                        delivery: deliveryValue,
                        project: projectValue,
                        other: round2(orderValueTotal - deliveryValue - projectValue),
                    },
                    orderCountsByType,
                    invoiced,
                    paid,
                    open: round2(Math.max(0, invoiced - paid)),
                    unbilled: round2(Math.max(0, orderValueTotal - invoiced)),
                },
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * GET /dashboard/charts — series and distributions behind the overview
     * charts: a 12-month history (tenders/orders/order value/invoiced) plus
     * status breakdowns per entity. Months with no rows are zero-filled so the
     * frontend can render the axis without gap handling.
     */
    async getCharts(req, res) {
        try {
            const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(req.user.tenantId);
            if (tenantIds.length === 0) {
                res.status(200).json(emptyCharts());
                return;
            }
            const scoped = { tenantId: { in: tenantIds } };
            const now = new Date();
            const from = new Date(now.getFullYear(), now.getMonth() - 11, 1);
            const tenantIn = client_1.Prisma.join(tenantIds);
            const [tenderMonths, orderMonths, invoiceMonths, tendersByStatus, projectsByStatus, invoicesByKind, customersByStatus] = await Promise.all([
                prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                    SELECT DATE_FORMAT(t.createdAt, '%Y-%m') AS month, COUNT(*) AS count
                    FROM Tender t
                    WHERE t.tenantId IN (${tenantIn}) AND t.createdAt >= ${from}
                    GROUP BY month
                `),
                prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                    SELECT DATE_FORMAT(o.createdAt, '%Y-%m') AS month, COUNT(*) AS count,
                        COALESCE(SUM(o.totalAmount), 0) AS total
                    FROM SalesOrder o
                    WHERE o.tenantId IN (${tenantIn}) AND o.createdAt >= ${from}
                    GROUP BY month
                `),
                // Business date first (invoiceDate), creation date as fallback.
                prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                    SELECT DATE_FORMAT(COALESCE(i.invoiceDate, i.createdAt), '%Y-%m') AS month,
                        COALESCE(SUM(i.amount), 0) AS total
                    FROM Invoice i
                    WHERE i.tenantId IN (${tenantIn})
                        AND i.status <> 'CANCELLED'
                        AND COALESCE(i.invoiceDate, i.createdAt) >= ${from}
                    GROUP BY month
                `),
                prisma_client_1.default.tender.groupBy({ by: ['status'], where: scoped, _count: { _all: true } }),
                prisma_client_1.default.project.groupBy({ by: ['status'], where: scoped, _count: { _all: true } }),
                prisma_client_1.default.invoice.groupBy({
                    by: ['kind'],
                    where: { ...scoped, status: { not: 'CANCELLED' } },
                    _count: { _all: true },
                    _sum: { amount: true },
                }),
                prisma_client_1.default.customer.groupBy({
                    by: ['status'],
                    where: { ...scoped, isActive: true },
                    _count: { _all: true },
                }),
            ]);
            const tenderByMonth = new Map(tenderMonths.map((row) => [row.month, Number(row.count)]));
            const orderByMonth = new Map(orderMonths.map((row) => [row.month, row]));
            const invoiceByMonth = new Map(invoiceMonths.map((row) => [row.month, Number(row.total ?? 0)]));
            const monthly = Array.from({ length: 12 }, (_, index) => {
                const date = new Date(now.getFullYear(), now.getMonth() - 11 + index, 1);
                const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
                const orderRow = orderByMonth.get(month);
                return {
                    month,
                    tenders: tenderByMonth.get(month) ?? 0,
                    orders: orderRow ? Number(orderRow.count) : 0,
                    orderValue: round2(Number(orderRow?.total ?? 0)),
                    invoiced: round2(invoiceByMonth.get(month) ?? 0),
                };
            });
            res.status(200).json({
                monthly,
                tendersByStatus: tendersByStatus.map((row) => ({
                    status: row.status,
                    count: row._count._all,
                })),
                projectsByStatus: projectsByStatus.map((row) => ({
                    status: row.status,
                    count: row._count._all,
                })),
                invoicesByKind: invoicesByKind.map((row) => ({
                    kind: row.kind,
                    count: row._count._all,
                    total: round2(Number(row._sum.amount ?? 0)),
                })),
                customersByStatus: customersByStatus.map((row) => ({
                    status: row.status,
                    count: row._count._all,
                })),
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.DashboardController = DashboardController;
const emptySummary = () => ({
    counts: { customers: 0, tenders: 0, orders: 0, projects: 0, activeProjects: 0 },
    conversion: {
        tenders: 0, converted: 0, toProject: 0, toDelivery: 0,
        orderRate: 0, projectRate: 0, deliveryRate: 0,
    },
    financials: {
        quoteValue: 0,
        orderValue: { total: 0, delivery: 0, project: 0, other: 0 },
        orderCountsByType: [],
        invoiced: 0, paid: 0, open: 0, unbilled: 0,
    },
});
const emptyCharts = () => ({
    monthly: [],
    tendersByStatus: [],
    projectsByStatus: [],
    invoicesByKind: [],
    customersByStatus: [],
});
//# sourceMappingURL=DashboardController.js.map