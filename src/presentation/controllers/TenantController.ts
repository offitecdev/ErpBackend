import { Request , Response } from "express";
import { CreateTenantUseCase } from "../../application/use-cases/tenant/CreateTenantUseCase";
import { UpdateTenantUseCase } from "../../application/use-cases/tenant/UpdateTenantUseCase";
import prisma from "../../infrastructure/database/prisma.client";
import { parseAllowedTenantIds } from "../utils/tenantAccess";
import { Prisma } from "@prisma/client";
import { getAuthIdentity } from "../../shared/authIdentityCache";
import { mayReachWholeCompanyTree } from "../../shared/tenantSwitchAccess";

export class TenantController {
    constructor(
        private createTenantUseCase: CreateTenantUseCase,
        private updateTenantUseCase: UpdateTenantUseCase
    ) {}

    async list(req: Request, res: Response) {
        try {
            const homeTenantId = req.user!.homeTenantId ?? req.user!.tenantId;
            // requireAuth has already loaded this identity in the current
            // request, so this is a memory hit rather than a second SQL query.
            const [identity, reachesWholeTree] = await Promise.all([
                getAuthIdentity(req.user!.id),
                mayReachWholeCompanyTree(req.user!.id),
            ]);
            const assignedTenantIds = parseAllowedTenantIds(identity?.allowedTenantIds);

            type TenantRow = {
                id: string;
                tenantName: string;
                isActive: boolean | number;
                parentTenantId: string | null;
                isProjectModuleEnabled: boolean | number;
                createdAt: Date;
                moduleProfileId: string | null;
                companyNumber: number;
                profileId: string | null;
                profileNumber: number | null;
                profileName: string | null;
                profileModuleKeys: unknown;
            };

            // Prisma's relation include issued separate Tenant and
            // ModuleProfile queries. The switcher needs a small projection, so
            // fetch it with one join across the remote database connection.
            const rows = await prisma.$queryRaw<TenantRow[]>(Prisma.sql`
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
                let moduleKeys: string[] = [];
                if (Array.isArray(row.profileModuleKeys)) {
                    moduleKeys = row.profileModuleKeys.map(String);
                } else if (typeof row.profileModuleKeys === 'string') {
                    try {
                        const parsed = JSON.parse(row.profileModuleKeys);
                        if (Array.isArray(parsed)) moduleKeys = parsed.map(String);
                    } catch {
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
            /* Der Firmenumschalter zeigt genau die zugeteilten Firmen (dieselbe
               Menge, die die Auth-Schicht akzeptiert). KEINE Zuteilung heisst
               seit dem 31.08.2026 die eigene Firma — nicht mehr der ganze Baum.
               Nur so sieht eine Untergesellschaft ihre Schwestern gar nicht erst.

               DIE ZUTEILUNG WIRD NICHT MEHR AUF DEN EIGENEN BAUM BESCHNITTEN
               (Vorgabe 31.08.2026): «Eine Auswahl muss getroffen werden, sie
               muss angegeben werden — unabhaengig davon, ob es eine Unter-
               gesellschaft ist oder nicht.» Wer eine zweite Firmengruppe unter
               Personal → Person → Zugang ausdruecklich angehakt bekommt, findet
               sie hier. Vorher fiel genau dieser Haken stumm heraus. */
            const assigned = (assignedTenantIds ?? []).filter((tenantId) => byId.has(tenantId));
            const selectable = assigned.length ? assigned : [homeTenantId];
            /* Die Rolle kommt oben drauf (Vorgabe 31.08.2026): wer die
               Administratorrolle traegt oder eine Rolle mit gesetztem
               `Role.canSwitchTenant` — Verwaltung und Projektleitung —
               bekommt den GANZEN eigenen Baum, ohne in jeder Firma einzeln
               angehakt zu sein. Weiter als der eigene Baum traegt die Rolle
               nicht: eine zweite Firmengruppe bleibt eine Sache des Hakens. */
            const visibleTenants = tenants
                .filter((tenant) => selectable.includes(tenant.id)
                    || (reachesWholeTree && rootOf(tenant.id) === homeRootId))
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

