/**
 * Company-level module lookup. The company category ("Numara" profile) mapped
 * onto a tenant decides which modules that company runs; a company without a
 * category runs all of them. Mirrors the frontend's moduleCatalog helpers so
 * the menu and the API agree on what a company can reach.
 */
import prisma from '../infrastructure/database/prisma.client';
import { isModuleEnabledForCategory } from './moduleCatalog';

/** `client` accepts a transaction handle so callers inside `$transaction` can
    read through the same connection. */
export const isModuleEnabledForTenant = async (
    tenantId: string,
    moduleKey: string,
    client: any = prisma,
): Promise<boolean> => {
    const tenant = await client.tenant.findUnique({
        where: { id: tenantId },
        select: { moduleProfile: { select: { moduleKeys: true } } },
    });
    if (!tenant) return false;
    return isModuleEnabledForCategory(tenant.moduleProfile?.moduleKeys, moduleKey);
};
