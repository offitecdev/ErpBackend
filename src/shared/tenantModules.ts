/**
 * Company-level module lookup. The company category ("Numara" profile) mapped
 * onto a tenant decides which modules that company runs; a company without a
 * category runs all of them. Mirrors the frontend's moduleCatalog helpers so
 * the menu and the API agree on what a company can reach.
 */
import prisma from '../infrastructure/database/prisma.client';
import { isModuleEnabledForCategory } from './moduleCatalog';

const MODULE_PROFILE_CACHE_TTL_MS = 60_000;
type TenantModuleProfile = { exists: boolean; moduleKeys: unknown };
const moduleProfileCache = new Map<string, { expiresAt: number; profile: TenantModuleProfile }>();
const moduleProfileInFlight = new Map<string, Promise<TenantModuleProfile>>();

export const clearTenantModuleCache = (tenantId?: string): void => {
    if (tenantId) {
        moduleProfileCache.delete(tenantId);
        moduleProfileInFlight.delete(tenantId);
        return;
    }
    moduleProfileCache.clear();
    moduleProfileInFlight.clear();
};

const readTenantModuleProfile = async (tenantId: string): Promise<TenantModuleProfile> => {
    const cached = moduleProfileCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.profile;

    const pending = moduleProfileInFlight.get(tenantId);
    if (pending) return pending;

    const request = prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { moduleProfile: { select: { moduleKeys: true } } },
    }).then((tenant) => {
        const profile = {
            exists: Boolean(tenant),
            moduleKeys: tenant?.moduleProfile?.moduleKeys ?? null,
        };
        moduleProfileCache.set(tenantId, {
            expiresAt: Date.now() + MODULE_PROFILE_CACHE_TTL_MS,
            profile,
        });
        return profile;
    }).finally(() => moduleProfileInFlight.delete(tenantId));

    moduleProfileInFlight.set(tenantId, request);
    return request;
};

/** `client` accepts a transaction handle so callers inside `$transaction` can
    read through the same connection. */
export const isModuleEnabledForTenant = async (
    tenantId: string,
    moduleKey: string,
    client: any = prisma,
): Promise<boolean> => {
    if (client === prisma) {
        const profile = await readTenantModuleProfile(tenantId);
        if (!profile.exists) return false;
        return isModuleEnabledForCategory(profile.moduleKeys, moduleKey);
    }

    const tenant = await client.tenant.findUnique({
        where: { id: tenantId },
        select: { moduleProfile: { select: { moduleKeys: true } } },
    });
    if (!tenant) return false;
    return isModuleEnabledForCategory(tenant.moduleProfile?.moduleKeys, moduleKey);
};
