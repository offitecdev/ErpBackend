"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaProductionSupplierLinkRepository = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const serviceTenantScope_1 = require("../../presentation/controllers/serviceTenantScope");
/**
 * ── MODUL-EINSTELLUNGEN › PRODUKTION › PRODUKTIONSLIEFERANT (02.10.2026) ────
 * Tabelle `uretim_tedarikci_baglari`: welcher Lieferant der bestellenden Firma
 * die Produktionsfirma ist. Gelesen wird sie auch in shared/producerOrders.ts.
 */
class PrismaProductionSupplierLinkRepository {
    async list(tenantId) {
        const rows = await prisma_client_1.default.productionSupplierLink.findMany({
            where: { tenantId },
            select: { supplierId: true, producerTenantId: true },
        });
        return rows.map((row) => ({ supplierId: row.supplierId, producerTenantId: row.producerTenantId }));
    }
    async replace(tenantId, links, updatedById) {
        await prisma_client_1.default.$transaction([
            prisma_client_1.default.productionSupplierLink.deleteMany({ where: { tenantId } }),
            ...(links.length
                ? [prisma_client_1.default.productionSupplierLink.createMany({
                        data: links.map((link) => ({
                            id: (0, nanoid_1.nanoid)(12),
                            tenantId,
                            supplierId: link.supplierId,
                            producerTenantId: link.producerTenantId,
                            updatedById,
                        })),
                    })]
                : []),
        ]);
    }
    async producers(tenantId) {
        const treeIds = (await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId)).filter((id) => id !== tenantId);
        if (!treeIds.length)
            return [];
        const rows = await prisma_client_1.default.tenant.findMany({
            where: { id: { in: treeIds }, companyType: 'PRODUCTION', isActive: true },
            select: { id: true, tenantName: true },
            orderBy: { tenantName: 'asc' },
        });
        return rows.map((row) => ({ id: String(row.id), name: String(row.tenantName ?? '') }));
    }
    async suppliers(tenantId) {
        const rows = await prisma_client_1.default.supplier.findMany({
            where: { tenantId },
            select: { id: true, companyName: true, isActive: true },
            orderBy: { companyName: 'asc' },
        });
        return rows.map((row) => ({ id: row.id, name: row.companyName, isActive: Boolean(row.isActive) }));
    }
}
exports.PrismaProductionSupplierLinkRepository = PrismaProductionSupplierLinkRepository;
//# sourceMappingURL=ProductionSupplierLinkRepository.js.map