"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isModuleEnabledForTenant = void 0;
/**
 * Company-level module lookup. The company category ("Numara" profile) mapped
 * onto a tenant decides which modules that company runs; a company without a
 * category runs all of them. Mirrors the frontend's moduleCatalog helpers so
 * the menu and the API agree on what a company can reach.
 */
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
const moduleCatalog_1 = require("./moduleCatalog");
/** `client` accepts a transaction handle so callers inside `$transaction` can
    read through the same connection. */
const isModuleEnabledForTenant = async (tenantId, moduleKey, client = prisma_client_1.default) => {
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