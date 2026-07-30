"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTenantInServiceTenantScope = void 0;
exports.getServiceTenantScope = getServiceTenantScope;
exports.getCompanyTreeTenantIds = getCompanyTreeTenantIds;
exports.getCustomerInServiceTenantScope = getCustomerInServiceTenantScope;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const getDescendantTenantIds = (tenants, rootId) => {
    const result = new Set([rootId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const tenant of tenants) {
            if (tenant.parentTenantId && result.has(tenant.parentTenantId) && !result.has(tenant.id)) {
                result.add(tenant.id);
                changed = true;
            }
        }
    }
    return Array.from(result);
};
async function getServiceTenantScope(selectedTenantId) {
    const tenants = await prisma_client_1.default.tenant.findMany({
        select: { id: true, parentTenantId: true, isActive: true },
    });
    const selectedTenant = tenants.find((tenant) => tenant.id === selectedTenantId);
    if (!selectedTenant?.isActive)
        return [];
    if (selectedTenant.parentTenantId)
        return [selectedTenant.id];
    return getDescendantTenantIds(tenants.filter((tenant) => tenant.isActive), selectedTenant.id);
}
/**
 * Every active tenant id in the caller's company tree (root + all
 * descendants), no matter which tenant is selected. Personnel are shared
 * company-wide: the same staff pool appears under the main tenant and every
 * sub-tenant — use this for employee queries, getServiceTenantScope for
 * business data (calls, contracts, customers…), which stays per-tenant.
 */
async function getCompanyTreeTenantIds(selectedTenantId) {
    const tenants = await prisma_client_1.default.tenant.findMany({
        select: { id: true, parentTenantId: true, isActive: true },
    });
    const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    let current = byId.get(selectedTenantId);
    if (!current?.isActive)
        return [];
    for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
        const parent = byId.get(current.parentTenantId);
        if (!parent?.isActive)
            return [];
        current = parent;
    }
    return getDescendantTenantIds(tenants.filter((tenant) => tenant.isActive), current.id);
}
async function getCustomerInServiceTenantScope(customerId, selectedTenantId) {
    const tenantIds = await getServiceTenantScope(selectedTenantId);
    return prisma_client_1.default.customer.findFirst({
        where: {
            id: customerId,
            tenantId: { in: tenantIds },
        },
        select: {
            id: true,
            tenantId: true,
        },
    });
}
const isTenantInServiceTenantScope = async (tenantId, selectedTenantId) => {
    const tenantIds = await getServiceTenantScope(selectedTenantId);
    return tenantIds.includes(tenantId);
};
exports.isTenantInServiceTenantScope = isTenantInServiceTenantScope;
//# sourceMappingURL=serviceTenantScope.js.map