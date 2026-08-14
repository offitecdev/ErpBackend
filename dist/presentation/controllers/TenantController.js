"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantController = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const tenantAccess_1 = require("../utils/tenantAccess");
const client_1 = require("@prisma/client");
const authIdentityCache_1 = require("../../shared/authIdentityCache");
class TenantController {
    createTenantUseCase;
    updateTenantUseCase;
    constructor(createTenantUseCase, updateTenantUseCase) {
        this.createTenantUseCase = createTenantUseCase;
        this.updateTenantUseCase = updateTenantUseCase;
    }
    async list(req, res) {
        try {
            const homeTenantId = req.user.homeTenantId ?? req.user.tenantId;
            // requireAuth has already loaded this identity in the current
            // request, so this is a memory hit rather than a second SQL query.
            const identity = await (0, authIdentityCache_1.getAuthIdentity)(req.user.id);
            const assignedTenantIds = (0, tenantAccess_1.parseAllowedTenantIds)(identity?.allowedTenantIds);
            // Prisma's relation include issued separate Tenant and
            // ModuleProfile queries. The switcher needs a small projection, so
            // fetch it with one join across the remote database connection.
            const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT
                    tenant.id,
                    tenant.tenantName,
                    tenant.isActive,
                    tenant.parentTenantId,
                    tenant.isProjectModuleEnabled,
                    tenant.createdAt,
                    tenant.moduleProfileId,
                    tenant.companyNumber,
                    profile.id AS profileId,
                    profile.profileNumber,
                    profile.name AS profileName,
                    profile.moduleKeys AS profileModuleKeys
                FROM Tenant AS tenant
                LEFT JOIN ModuleProfile AS profile ON profile.id = tenant.moduleProfileId
                WHERE tenant.isActive = 1
                ORDER BY tenant.parentTenantId ASC, tenant.tenantName ASC
            `);
            const tenants = rows.map((row) => {
                let moduleKeys = [];
                if (Array.isArray(row.profileModuleKeys)) {
                    moduleKeys = row.profileModuleKeys.map(String);
                }
                else if (typeof row.profileModuleKeys === 'string') {
                    try {
                        const parsed = JSON.parse(row.profileModuleKeys);
                        if (Array.isArray(parsed))
                            moduleKeys = parsed.map(String);
                    }
                    catch {
                        moduleKeys = [];
                    }
                }
                return {
                    id: row.id,
                    tenantName: row.tenantName,
                    isActive: Boolean(row.isActive),
                    parentTenantId: row.parentTenantId,
                    isProjectModuleEnabled: Boolean(row.isProjectModuleEnabled),
                    createdAt: row.createdAt,
                    moduleProfileId: row.moduleProfileId,
                    companyNumber: row.companyNumber,
                    moduleProfile: row.profileId ? {
                        id: row.profileId,
                        profileNumber: Number(row.profileNumber || 0),
                        name: row.profileName || '',
                        moduleKeys,
                    } : null,
                };
            });
            const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
            const rootOf = (tenantId) => {
                let current = byId.get(tenantId);
                if (!current)
                    return null;
                for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
                    const parent = byId.get(current.parentTenantId);
                    if (!parent)
                        return null;
                    current = parent;
                }
                return current.id;
            };
            const homeRootId = rootOf(homeTenantId);
            // Personal company assignment narrows the switcher to the assigned
            // companies (the same set the auth middleware accepts). Ids outside
            // the own tree are dropped; nothing left = no restriction.
            const assignedInTree = (assignedTenantIds ?? []).filter((tenantId) => rootOf(tenantId) === homeRootId);
            const visibleTenants = tenants
                .filter((tenant) => rootOf(tenant.id) === homeRootId)
                .filter((tenant) => !assignedInTree.length || assignedInTree.includes(tenant.id))
                .sort((a, b) => {
                if (!a.parentTenantId && b.parentTenantId)
                    return -1;
                if (a.parentTenantId && !b.parentTenantId)
                    return 1;
                return a.tenantName.localeCompare(b.tenantName, 'tr');
            });
            res.status(200).json({ tenants: visibleTenants });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async create(req, res) {
        try {
            const result = await this.createTenantUseCase.execute(req.body);
            res.status(201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async update(req, res) {
        try {
            const { id } = req.params;
            if (!id || typeof id !== 'string') {
                res.status(400).json({ error: 'Invalid tenant ID' });
                return;
            }
            const result = await this.updateTenantUseCase.execute(id, req.body);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.TenantController = TenantController;
//# sourceMappingURL=TenantController.js.map