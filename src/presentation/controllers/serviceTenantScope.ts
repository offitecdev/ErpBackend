import prisma from '../../infrastructure/database/prisma.client';

type TenantLite = {
    id: string;
    parentTenantId: string | null;
    isActive: boolean;
};

const getDescendantTenantIds = (tenants: TenantLite[], rootId: string) => {
    const result = new Set<string>([rootId]);
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

export async function getServiceTenantScope(selectedTenantId: string): Promise<string[]> {
    const tenants = await prisma.tenant.findMany({
        select: { id: true, parentTenantId: true, isActive: true },
    });
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
    const tenants = await prisma.tenant.findMany({
        select: { id: true, parentTenantId: true, isActive: true },
    });
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
