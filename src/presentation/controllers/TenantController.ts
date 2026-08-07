import { Request , Response } from "express";
import { CreateTenantUseCase } from "../../application/use-cases/tenant/CreateTenantUseCase";
import { UpdateTenantUseCase } from "../../application/use-cases/tenant/UpdateTenantUseCase";
import prisma from "../../infrastructure/database/prisma.client";
import { parseAllowedTenantIds } from "../utils/tenantAccess";

export class TenantController {
    constructor(
        private createTenantUseCase: CreateTenantUseCase,
        private updateTenantUseCase: UpdateTenantUseCase
    ) {}

    async list(req: Request, res: Response) {
        try {
            const homeTenantId = req.user!.homeTenantId ?? req.user!.tenantId;
            const caller = await prisma.employee.findUnique({
                where: { id: req.user!.id },
                select: { allowedTenantIds: true },
            });
            const assignedTenantIds = parseAllowedTenantIds(caller?.allowedTenantIds);
            const tenants = await prisma.tenant.findMany({
                where: { isActive: true },
                select: {
                    id: true,
                    tenantName: true,
                    isActive: true,
                    parentTenantId: true,
                    isProjectModuleEnabled: true,
                    createdAt: true,
                    moduleProfileId: true,
                    // Belge kodundaki blok (numara × 10000) — kategoriden bağımsız.
                    companyNumber: true,
                    // The company category drives menu/module filtering client-side.
                    moduleProfile: { select: { id: true, profileNumber: true, name: true, moduleKeys: true } },
                },
                orderBy: [{ parentTenantId: 'asc' }, { tenantName: 'asc' }],
            });

            const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
            const rootOf = (tenantId: string): string | null => {
                let current = byId.get(tenantId);
                if (!current) return null;
                for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
                    const parent = byId.get(current.parentTenantId);
                    if (!parent) return null;
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
                    if (!a.parentTenantId && b.parentTenantId) return -1;
                    if (a.parentTenantId && !b.parentTenantId) return 1;
                    return a.tenantName.localeCompare(b.tenantName, 'tr');
                });

            res.status(200).json({ tenants: visibleTenants });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async create(req: Request, res: Response) {
        try {
            const result = await this.createTenantUseCase.execute(req.body);
            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }   

    }

    async update(req: Request, res: Response) {
        try {
            const { id } = req.params;
            if (!id || typeof id !== 'string') {
                res.status(400).json({ error: 'Invalid tenant ID' });
                return;
            }
            const result = await this.updateTenantUseCase.execute(id, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }   
    }
}


