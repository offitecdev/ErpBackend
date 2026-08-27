"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isModuleEnabledForTenant = exports.clearTenantModuleCache = void 0;
/**
 * Company-level module lookup. The company category ("Numara" profile) mapped
 * onto a tenant decides which modules that company runs; a company without a
 * category runs all of them. Mirrors the frontend's moduleCatalog helpers so
 * the menu and the API agree on what a company can reach.
 */
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
const moduleCatalog_1 = require("./moduleCatalog");
const MODULE_PROFILE_CACHE_TTL_MS = 60_000;
const moduleProfileCache = new Map();
const moduleProfileInFlight = new Map();
const clearTenantModuleCache = (tenantId) => {
    if (tenantId) {
        moduleProfileCache.delete(tenantId);
        moduleProfileInFlight.delete(tenantId);
        return;
    }
    moduleProfileCache.clear();
    moduleProfileInFlight.clear();
};
exports.clearTenantModuleCache = clearTenantModuleCache;
const readTenantModuleProfile = async (tenantId) => {
    const cached = moduleProfileCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now())
        return cached.profile;
    const pending = moduleProfileInFlight.get(tenantId);
    if (pending)
        return pending;
    const request = prisma_client_1.default.tenant.findUnique({
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
const isModuleEnabledForTenant = async (tenantId, moduleKey, client = prisma_client_1.default) => {
    if (client === prisma_client_1.default) {
        const profile = await readTenantModuleProfile(tenantId);
        if (!profile.exists)
            return false;
        return (0, moduleCatalog_1.isModuleEnabledForCategory)(profile.moduleKeys, moduleKey);
    }
    const tenant = await client.tenant.findUnique({
        where: { id: tenantId },
        select: { moduleProfile: { select: { moduleKeys: true } } },
    });
    if (!tenant)
        return false;
    return (0, moduleCatalog_1.isModuleEnabledForCategory)(tenant.moduleProfile?.moduleKeys, moduleKey);
};
exports.isModuleEnabledForTenant = isModuleEnabledForTenant;
//# sourceMappingURL=tenantModules.js.map