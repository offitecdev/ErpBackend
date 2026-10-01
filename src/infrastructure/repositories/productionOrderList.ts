import { Prisma } from '@prisma/client';
import prisma from '../database/prisma.client';
import type { ProductionOrderListFilter, ProductionOrderListPage } from '../../domain/repositories/IProductionRepository';

/** Page headers and counts only; device positions and purchase documents belong to detail views. */
export const listProductionOrderPage = async (
    tenantId: string, filter: ProductionOrderListFilter,
): Promise<ProductionOrderListPage> => {
    const page = Number.isFinite(filter.page) ? Math.max(1, Math.floor(filter.page)) : 1;
    const pageSize = Number.isFinite(filter.pageSize) ? Math.min(100, Math.max(1, Math.floor(filter.pageSize))) : 20;
    const search = filter.search?.trim().slice(0, 120);
    const where: Prisma.ProductionProjectWhereInput = {
        tenantId, isActive: true,
        ...(filter.kind ? { sourceKind: filter.kind } : {}),
        ...(search ? { OR: [
            { projectNumber: { contains: search } }, { projectName: { contains: search } },
            { customerName: { contains: search } },
            { orders: { some: { tenantId, orderNumber: { contains: search } } } },
        ] } : {}),
    };
    const [rows, total] = await Promise.all([
        prisma.productionProject.findMany({
            where, skip: (page - 1) * pageSize, take: pageSize,
            orderBy: [{ projectNumber: 'desc' }, { id: 'desc' }],
            select: {
                id: true, sourceKind: true, projectNumber: true, projectName: true,
                customerName: true, sourceTenantId: true,
                orders: { where: { tenantId }, select: { orderNumber: true, orderKind: true }, orderBy: [{ orderDate: 'asc' }, { orderNumber: 'asc' }] },
                _count: { select: { items: { where: { tenantId, isActive: true } } } },
            },
        }),
        prisma.productionProject.count({ where }),
    ]);
    const ids = rows.map((row) => row.id);
    const [tenants, ordered] = await Promise.all([
        rows.length ? prisma.tenant.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.sourceTenantId))] } }, select: { id: true, tenantName: true } }) : [],
        ids.length ? prisma.$queryRaw<Array<{ projectId: string; ordered: bigint }>>(Prisma.sql`
            SELECT counted.projectId, COUNT(*) AS ordered FROM (
                SELECT item.productionProjectId AS projectId, item.id
                FROM uretim_proje_kalemleri item
                JOIN uretim_siparisleri line ON line.productionItemId = item.id AND line.tenantId = ${tenantId}
                JOIN PurchaseOrder po ON po.id = line.purchaseOrderId AND po.tenantId = ${tenantId}
                WHERE item.tenantId = ${tenantId} AND item.isActive = 1
                    AND item.productionProjectId IN (${Prisma.join(ids)})
                GROUP BY item.productionProjectId, item.id
                HAVING ROUND(SUM(line.lineTotal), 2) > 0
            ) counted GROUP BY counted.projectId
        `) : [],
    ]);
    const names = new Map(tenants.map((row) => [row.id, row.tenantName]));
    const counts = new Map(ordered.map((row) => [row.projectId, Number(row.ordered)]));
    return {
        page, pageSize, total,
        projects: rows.map((row) => ({
            project: { id: row.id, sourceKind: row.sourceKind === 'DELIVERY' ? 'DELIVERY' : 'PROJECT', projectNumber: row.projectNumber, projectName: row.projectName, customerName: row.customerName },
            sourceTenantName: names.get(row.sourceTenantId) ?? null,
            orderNumbers: row.orders.map((order) => order.orderNumber),
            mainOrderNumbers: row.orders.filter((order) => order.orderKind !== 'ADDON').map((order) => order.orderNumber),
            addonCount: row.orders.filter((order) => order.orderKind === 'ADDON').length,
            counts: { ordered: counts.get(row.id) ?? 0, total: row._count.items },
        })),
    };
};
