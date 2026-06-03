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
