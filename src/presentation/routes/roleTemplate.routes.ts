import { Router } from 'express';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { getCompanyTreeTenantIds } from '../controllers/serviceTenantScope';
import { findTenantRootIdCached } from '../../shared/tenantTree';
import { auditLog } from '../../infrastructure/services/AuditLogService';
import { clearPermissionCacheForRole } from '../../infrastructure/repositories/RoleRepository';
import {
    ADMIN_PAGE_LEVELS,
    ALL_PAGES,
    PAGE_MODULES,
    adminModuleKeys,
    adminPermissionNames,
    moduleKeysForPageLevels,
    pageLevelsFromPermissions,
    permissionsForPageLevels,
    sanitizePageLevels,
    type PageLevel,
} from '../../shared/pageCatalog';

/* ── ROLLENVORLAGEN (Einstellungen → Berechtigungen, 17.08.2026) ─────────────
 *
 * Hier werden die Rollen GEBAUT: eine Tabelle, Modul für Modul und Seite für
 * Seite, je Seite eine Stufe (1 ansehen / 2 bearbeiten / 3 löschen). Wer welche
 * Rolle bekommt, steht nicht mehr hier, sondern beim Personal
 * (/personnel/:id → Zugang).
 *
 * Gespeichert wird die Stufenkarte auf `Role.pageLevels`; daraus werden die
 * RolePermission-Zeilen und das Modulpaket ABGELEITET. So bleibt jede
 * bestehende `requirePermission`-Prüfung im Server die Autorität — die neue
 * Tabelle füttert das alte Rechtemodell, sie umgeht es nicht.
 *
 * Die Administratorrolle ist FEST (Vorgabe): alle Seiten, alle Rechte, nicht
 * änderbar und nicht löschbar. Sie wird beim ersten Aufruf am Stamm angelegt
 * und bei jedem Aufruf nachgezogen, damit ein erweiterter Katalog sie nicht
 * hinter sich lässt. Der IT-Bereich bleibt aussen vor: der hängt an einem
 * eigenen Kennwort, nicht an einem Recht.
 */

const router = Router();

const ADMIN_ROLE_NAME = 'Administrator';

const setsEqual = (a: Set<string>, b: Set<string>): boolean =>
    a.size === b.size && [...a].every((value) => b.has(value));

/**
 * Rechtenamen → ids. Fehlende Namen werden ANGELEGT statt still verworfen:
 * der Katalog ist die Autorität, und eine neue Seite darf nicht dadurch
 * wirkungslos bleiben, dass der Seed noch nicht durchgelaufen ist.
 */
const permissionIdsForNames = async (names: string[]): Promise<string[]> => {
    if (!names.length) return [];
    const existing = await prisma.permission.findMany({
        where: { permissionName: { in: names } },
        select: { id: true, permissionName: true },
    });
    const known = new Map(existing.map((row) => [row.permissionName, row.id]));
    const missing = names.filter((name) => !known.has(name));
    if (missing.length) {
        await prisma.permission.createMany({
            data: missing.map((permissionName) => ({ id: nanoid(8), permissionName })),
            skipDuplicates: true,
        });
        const created = await prisma.permission.findMany({
            where: { permissionName: { in: missing } },
            select: { id: true, permissionName: true },
        });
        for (const row of created) known.set(row.permissionName, row.id);
    }
    return names.map((name) => known.get(name)).filter((id): id is string => Boolean(id));
};

/** Rechtezeilen einer Rolle auf die Sollmenge bringen (nur bei Abweichung). */
const syncRolePermissions = async (roleId: string, permissionNames: string[]): Promise<boolean> => {
    const wantedIds = new Set(await permissionIdsForNames(permissionNames));
    const currentRows = await prisma.rolePermission.findMany({ where: { roleId }, select: { permissionId: true } });
    const currentIds = new Set(currentRows.map((row) => row.permissionId));
    if (setsEqual(currentIds, wantedIds)) return false;

    const toRemove = [...currentIds].filter((id) => !wantedIds.has(id));
    const toAdd = [...wantedIds].filter((id) => !currentIds.has(id));
    if (toRemove.length) {
        await prisma.rolePermission.deleteMany({ where: { roleId, permissionId: { in: toRemove } } });
    }
    if (toAdd.length) {
        await prisma.rolePermission.createMany({
            data: toAdd.map((permissionId) => ({ roleId, permissionId })),
            skipDuplicates: true,
        });
    }
    return true;
};

/**
 * Das Modulpaket gilt im GANZEN Baum: getMe zeigt einen Mandanten nur, wenn
 * die Rolle dort eine Konfigurationszeile hat. Darum eine Zeile je Firma.
 */
const syncRoleModuleConfigs = async (roleId: string, treeTenantIds: string[], moduleKeys: string[]) => {
    const configs = (prisma as any).roleModuleConfig;
    const existing: Array<{ tenantId: string; moduleKeys: unknown }> = await configs.findMany({
        where: { roleId },
        select: { tenantId: true, moduleKeys: true },
    });
    const byTenant = new Map(existing.map((row) => [row.tenantId, row.moduleKeys]));
    const wanted = new Set(moduleKeys);

    await Promise.all(treeTenantIds.map(async (tenantId) => {
        const current = byTenant.get(tenantId);
        const currentSet = new Set(Array.isArray(current) ? (current as string[]) : []);
        if (byTenant.has(tenantId) && setsEqual(currentSet, wanted)) return;
        await configs.upsert({
            where: { roleId_tenantId: { roleId, tenantId } },
            create: { roleId, tenantId, moduleKeys },
            update: { moduleKeys },
        });
    }));

    // Firmen, die nicht mehr zum Baum gehören, verlieren ihre Zeile.
    const stale = existing.map((row) => row.tenantId).filter((tenantId) => !treeTenantIds.includes(tenantId));
    if (stale.length) await configs.deleteMany({ where: { roleId, tenantId: { in: stale } } });
};

/**
 * Stufenkarte einer Rolle für die Anzeige. Reihenfolge der Wahrheit:
 * Administrator → alles; gespeicherte Karte → so wie gespeichert; Altrolle
 * ohne Karte → aus den Rechten zurückgerechnet.
 */
export const resolvePageLevels = (
    role: { isSystemAdmin?: boolean; pageLevels?: unknown },
    permissionNames: string[],
): Record<string, PageLevel> => {
    if (role.isSystemAdmin) return { ...ADMIN_PAGE_LEVELS };
    if (role.pageLevels && typeof role.pageLevels === 'object') return sanitizePageLevels(role.pageLevels);
    return pageLevelsFromPermissions(permissionNames);
};

/**
 * Die feste Administratorrolle des Baums holen — anlegen, falls sie fehlt, und
 * ihre Rechte/Module nachziehen, falls der Katalog gewachsen ist.
 */
export const ensureSystemAdminRole = async (rootTenantId: string, treeTenantIds: string[]) => {
    let role = await prisma.role.findFirst({
        where: { tenantId: rootTenantId, isSystemAdmin: true } as any,
        select: { id: true, roleName: true },
    });

    if (!role) {
        // Übernahme statt Zweitrolle: ein bestehender "Administrator" am Stamm
        // WIRD die feste Rolle, sonst stünden nach dem Aufspielen zwei gleich
        // benannte Rollen nebeneinander.
        const legacy = await prisma.role.findFirst({
            where: { tenantId: rootTenantId, roleName: ADMIN_ROLE_NAME },
            select: { id: true, roleName: true },
        });
        if (legacy) {
            await prisma.role.update({ where: { id: legacy.id }, data: { isSystemAdmin: true } as any });
            role = legacy;
        } else {
            const created = await prisma.role.create({
                data: { id: nanoid(8), tenantId: rootTenantId, roleName: ADMIN_ROLE_NAME, isSystemAdmin: true } as any,
                select: { id: true, roleName: true },
            });
            role = created;
        }
    }

    const changed = await syncRolePermissions(role.id, adminPermissionNames());
    await syncRoleModuleConfigs(role.id, treeTenantIds, adminModuleKeys());
    if (changed) await clearPermissionCacheForRole(role.id);
    return role;
};

/**
 * GET /role-templates — die Rollenliste der Berechtigungsseite: Name, Anzahl
 * zugewiesener Personen und die Stufenkarte je Rolle. Die Administratorrolle
 * steht immer zuoberst.
 */
router.get('/', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const treeTenantIds = await getCompanyTreeTenantIds(tenantId);
        const rootTenantId = (await findTenantRootIdCached(tenantId)) ?? tenantId;
        await ensureSystemAdminRole(rootTenantId, treeTenantIds);

        const roles = await prisma.role.findMany({
            where: { tenantId: { in: treeTenantIds } },
            orderBy: { roleName: 'asc' },
            select: {
                id: true,
                roleName: true,
                pageLevels: true,
                isSystemAdmin: true,
                permissions: { select: { permission: { select: { permissionName: true } } } },
                _count: { select: { employees: true } },
            } as any,
        }) as any[];

        const data = roles.map((role) => ({
            id: role.id,
            roleName: role.roleName,
            isSystemAdmin: Boolean(role.isSystemAdmin),
            userCount: role._count?.employees ?? 0,
            pageLevels: resolvePageLevels(
                role,
                role.permissions.map((entry: any) => entry.permission.permissionName),
            ),
        }));
        // Administrator zuoberst, der Rest alphabetisch (kommt schon so).
        data.sort((a, b) => Number(b.isSystemAdmin) - Number(a.isSystemAdmin));

        res.status(200).json({ data });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** GET /role-templates/catalog — der Seitenkatalog, damit die Tabelle nicht
    von einer zweiten Kopie im Browser abhängt, wenn sie auseinanderlaufen. */
router.get('/catalog', requireAuth, requirePermission('roles.manage'), (_req, res) => {
    res.status(200).json({
        modules: PAGE_MODULES.map((moduleDef) => ({
            key: moduleDef.key,
            labelKey: moduleDef.labelKey,
            pages: moduleDef.pages.map((page) => ({
                key: page.key,
                path: page.path,
                labelKey: page.labelKey,
                maxLevel: page.maxLevel,
            })),
        })),
    });
});

/** POST /role-templates — { roleName, pageLevels } → neue Rolle am Stamm. */
router.post('/', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const user = req.user!;
        const roleName = String(req.body?.roleName || '').trim();
        if (!roleName) return res.status(400).json({ error: 'Rollenname fehlt.' });
        if (roleName.toLowerCase() === ADMIN_ROLE_NAME.toLowerCase()) {
            return res.status(400).json({ error: 'Der Name "Administrator" ist für die feste Rolle reserviert.' });
        }

        const treeTenantIds = await getCompanyTreeTenantIds(user.tenantId);
        const rootTenantId = (await findTenantRootIdCached(user.tenantId)) ?? user.tenantId;

        const duplicate = await prisma.role.findFirst({
            where: { tenantId: { in: treeTenantIds }, roleName },
            select: { id: true },
        });
        if (duplicate) return res.status(400).json({ error: 'Eine Rolle mit diesem Namen besteht bereits.' });

        const pageLevels = sanitizePageLevels(req.body?.pageLevels);
        const role = await prisma.role.create({
            data: { id: nanoid(8), tenantId: rootTenantId, roleName, pageLevels } as any,
            select: { id: true, roleName: true },
        });
        await syncRolePermissions(role.id, permissionsForPageLevels(pageLevels));
        await syncRoleModuleConfigs(role.id, treeTenantIds, moduleKeysForPageLevels(pageLevels));

        auditLog.log({
            action: 'role.template.create',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'Role',
            entityId: role.id,
            ...auditLog.context(req),
        });

        res.status(201).json({ id: role.id, roleName: role.roleName, isSystemAdmin: false, userCount: 0, pageLevels });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** PUT /role-templates/:id — { roleName?, pageLevels? }. Die Administratorrolle
    ist fest und antwortet 403. */
router.put('/:id', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id || '');
        const treeTenantIds = await getCompanyTreeTenantIds(user.tenantId);
        const existing = await prisma.role.findFirst({
            where: { id, tenantId: { in: treeTenantIds } },
            select: { id: true, roleName: true, isSystemAdmin: true } as any,
        }) as any;
        if (!existing) return res.status(404).json({ error: 'Rolle nicht gefunden.' });
        if (existing.isSystemAdmin) {
            return res.status(403).json({ error: 'Die Administratorrolle ist fest und kann nicht geändert werden.' });
        }

        /* Selbstaussperrung verhindern (Vorfall 14.08.2026): wer die Rolle
           bearbeitet, die er selbst trägt, darf sich die Verwaltung nicht
           entziehen — sonst käme danach NIEMAND mehr auf diese Seite. Der
           Seitenkatalog kennt `roles.manage` gar nicht, also trägt nur die
           Administratorrolle es; eine andere Rolle zu tragen und zugleich zu
           bearbeiten heisst deshalb: Finger weg. */
        const ownRole = await prisma.employeeRole.findFirst({
            where: { employeeId: user.id, roleId: id },
            select: { roleId: true },
        });
        if (ownRole) {
            return res.status(400).json({
                error: 'Die eigene Rolle kann hier nicht bearbeitet werden — sonst entzieht sich das eigene Konto die Verwaltung.',
            });
        }

        const data: Record<string, unknown> = {};
        let pageLevels: Record<string, PageLevel> | null = null;

        if (req.body?.roleName !== undefined) {
            const roleName = String(req.body.roleName || '').trim();
            if (!roleName) return res.status(400).json({ error: 'Rollenname fehlt.' });
            if (roleName.toLowerCase() === ADMIN_ROLE_NAME.toLowerCase()) {
                return res.status(400).json({ error: 'Der Name "Administrator" ist für die feste Rolle reserviert.' });
            }
            if (roleName !== existing.roleName) {
                const duplicate = await prisma.role.findFirst({
                    where: { tenantId: { in: treeTenantIds }, roleName, id: { not: id } },
                    select: { id: true },
                });
                if (duplicate) return res.status(400).json({ error: 'Eine Rolle mit diesem Namen besteht bereits.' });
            }
            data.roleName = roleName;
        }

        if (req.body?.pageLevels !== undefined) {
            pageLevels = sanitizePageLevels(req.body.pageLevels);
            data.pageLevels = pageLevels;
        }

        if (Object.keys(data).length) await prisma.role.update({ where: { id }, data: data as any });

        if (pageLevels) {
            await syncRolePermissions(id, permissionsForPageLevels(pageLevels));
            await syncRoleModuleConfigs(id, treeTenantIds, moduleKeysForPageLevels(pageLevels));
            // Die Rechte der Trägerinnen und Träger stehen im Cache — ohne das
            // Leeren griffe die neue Stufe erst nach Ablauf der TTL.
            await clearPermissionCacheForRole(id);
        }

        auditLog.log({
            action: 'role.template.update',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'Role',
            entityId: id,
            ...auditLog.context(req),
        });

        res.status(200).json({
            id,
            roleName: (data.roleName as string) ?? existing.roleName,
            isSystemAdmin: false,
            pageLevels: pageLevels ?? undefined,
        });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** DELETE /role-templates/:id — nur unbenutzte Rollen; die Administratorrolle nie. */
router.delete('/:id', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id || '');
        const treeTenantIds = await getCompanyTreeTenantIds(user.tenantId);
        const existing = await prisma.role.findFirst({
            where: { id, tenantId: { in: treeTenantIds } },
            select: { id: true, isSystemAdmin: true, _count: { select: { employees: true } } } as any,
        }) as any;
        if (!existing) return res.status(404).json({ error: 'Rolle nicht gefunden.' });
        if (existing.isSystemAdmin) {
            return res.status(403).json({ error: 'Die Administratorrolle kann nicht gelöscht werden.' });
        }
        if ((existing._count?.employees ?? 0) > 0) {
            return res.status(400).json({
                error: 'Diese Rolle ist noch Personen zugewiesen — erst umhängen, dann löschen.',
            });
        }

        await prisma.rolePermission.deleteMany({ where: { roleId: id } });
        await (prisma as any).roleModuleConfig.deleteMany({ where: { roleId: id } });
        await prisma.role.delete({ where: { id } });

        auditLog.log({
            action: 'role.template.delete',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'Role',
            entityId: id,
            ...auditLog.context(req),
        });

        res.status(200).json({ ok: true });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** Anzahl Seiten im Katalog — die Liste zeigt „12 von 22 Seiten". */
export const TOTAL_PAGE_COUNT = ALL_PAGES.length;

export default router;
