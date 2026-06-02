"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantController = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
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
            const tenants = await prisma_client_1.default.tenant.findMany({
                where: { isActive: true },
                select: {
                    id: true,
                    tenantName: true,
                    isActive: true,
                    parentTenantId: true,
                    isProjectModuleEnabled: true,
                    createdAt: true,
                },
                orderBy: [{ parentTenantId: 'asc' }, { tenantName: 'asc' }],
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
            const visibleTenants = tenants
                .filter((tenant) => rootOf(tenant.id) === homeRootId)
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