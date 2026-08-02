import prisma from '../../infrastructure/database/prisma.client';
import { collectDescendantIds, getAllTenants } from '../../shared/tenantTree';

// Tenant tablosu artık istek başına değil, paylaşılan önbellekten okunuyor —
// aşağıdaki iki yardımcı her CRM/servis isteğinde çağrıldığı için bu tek başına
// istek başına ~170 ms'lik bir ağ turunu kaldırıyor.
const getDescendantTenantIds = collectDescendantIds;

export async function getServiceTenantScope(selectedTenantId: string): Promise<string[]> {
    const tenants = await getAllTenants();
    const selectedTenant = tenants.find((tenant) => tenant.id === selectedTenantId);

    if (!selectedTenant?.isActive) return [];
    if (selectedTenant.parentTenantId) return [selectedTenant.id];

    return getDescendantTenantIds(
        tenants.filter((tenant) => tenant.isActive),
        selectedTenant.id
    );
}

/**
 * Every active tenant id in the caller's company tree (root + all
 * descendants), no matter which tenant is selected. Personnel are shared
 * company-wide: the same staff pool appears under the main tenant and every
 * sub-tenant — use this for employee queries, getServiceTenantScope for
 * business data (calls, contracts, customers…), which stays per-tenant.
 */
export async function getCompanyTreeTenantIds(selectedTenantId: string): Promise<string[]> {
    const tenants = await getAllTenants();
    const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    let current = byId.get(selectedTenantId);
    if (!current?.isActive) return [];
    for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
        const parent = byId.get(current.parentTenantId);
        if (!parent?.isActive) return [];
        current = parent;
    }
    return getDescendantTenantIds(tenants.filter((tenant) => tenant.isActive), current.id);
}

export async function getCustomerInServiceTenantScope(customerId: string, selectedTenantId: string) {
    const tenantIds = await getServiceTenantScope(selectedTenantId);
    return prisma.customer.findFirst({
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

export const isTenantInServiceTenantScope = async (tenantId: string, selectedTenantId: string) => {
    const tenantIds = await getServiceTenantScope(selectedTenantId);
    return tenantIds.includes(tenantId);
};
