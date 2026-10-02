import { nanoid } from 'nanoid';
import prisma from '../database/prisma.client';
import type {
    IProductionSupplierLinkRepository,
    ProductionSupplierLink,
    ProductionSupplierOption,
} from '../../domain/repositories/IProductionRepository';
import { getCompanyTreeTenantIds } from '../../presentation/controllers/serviceTenantScope';

/**
 * ── MODUL-EINSTELLUNGEN › PRODUKTION › PRODUKTIONSLIEFERANT (02.10.2026) ────
 * Tabelle `uretim_tedarikci_baglari`: welcher Lieferant der bestellenden Firma
 * die Produktionsfirma ist. Gelesen wird sie auch in shared/producerOrders.ts.
 */
export class PrismaProductionSupplierLinkRepository implements IProductionSupplierLinkRepository {
    async list(tenantId: string): Promise<ProductionSupplierLink[]> {
        const rows = await prisma.productionSupplierLink.findMany({
            where: { tenantId },
            select: { supplierId: true, producerTenantId: true },
        });
        return rows.map((row) => ({ supplierId: row.supplierId, producerTenantId: row.producerTenantId }));
    }

    async replace(tenantId: string, links: ProductionSupplierLink[], updatedById: string): Promise<void> {
        await prisma.$transaction([
            prisma.productionSupplierLink.deleteMany({ where: { tenantId } }),
            ...(links.length
                ? [prisma.productionSupplierLink.createMany({
                    data: links.map((link) => ({
                        id: nanoid(12),
                        tenantId,
                        supplierId: link.supplierId,
                        producerTenantId: link.producerTenantId,
                        updatedById,
                    })),
                })]
                : []),
        ]);
    }

    async producers(tenantId: string): Promise<Array<{ id: string; name: string }>> {
        const treeIds = (await getCompanyTreeTenantIds(tenantId)).filter((id) => id !== tenantId);
        if (!treeIds.length) return [];
        const rows = await (prisma as any).tenant.findMany({
            where: { id: { in: treeIds }, companyType: 'PRODUCTION', isActive: true },
            select: { id: true, tenantName: true },
            orderBy: { tenantName: 'asc' },
        });
        return (rows as any[]).map((row) => ({ id: String(row.id), name: String(row.tenantName ?? '') }));
    }

    async suppliers(tenantId: string): Promise<ProductionSupplierOption[]> {
        const rows = await prisma.supplier.findMany({
            where: { tenantId },
            select: { id: true, companyName: true, isActive: true },
            orderBy: { companyName: 'asc' },
        });
        return rows.map((row) => ({ id: row.id, name: row.companyName, isActive: Boolean(row.isActive) }));
    }
}
