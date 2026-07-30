import { Router } from 'express';
import { findTenantRootId, requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import prisma from '../../infrastructure/database/prisma.client';
import { nanoid } from 'nanoid';
import { CATALOG_PERMISSION_NAMES, MODULE_CATALOG, permissionsForModules, sanitizeModuleKeys } from '../../shared/moduleCatalog';
import { getCompanyTreeTenantIds } from '../controllers/serviceTenantScope';

const router = Router();

// A company mapped to a ModuleProfile ("Numara" category) may only put the
// permissions of its enabled modules into roles. Permissions the catalog does
// not cover stay assignable everywhere. Throws on violation.
const assertPermissionsAllowedForTenant = async (tenantId: string, permissionIds: string[]) => {
    if (!permissionIds.length) return;
    const tenant = await (prisma as any).tenant.findUnique({
        where: { id: tenantId },
        select: { moduleProfile: { select: { moduleKeys: true } } },
    });
    const moduleKeys = tenant?.moduleProfile?.moduleKeys;
    if (!Array.isArray(moduleKeys)) return; // no category -> unrestricted
    const allowed = permissionsForModules(moduleKeys as string[]);
    const selected = await prisma.permission.findMany({ where: { id: { in: permissionIds } } });
    const blocked = selected
        .filter((perm) => CATALOG_PERMISSION_NAMES.has(perm.permissionName) && !allowed.has(perm.permissionName))
        .map((perm) => perm.permissionName);
    if (blocked.length) {
        throw new Error(`Bu şirketin kategorisine dahil olmayan modül yetkileri role eklenemez: ${blocked.join(', ')}`);
    }
};

// The role's module package may only contain modules the company's category
// enables (always-available modules stay assignable everywhere).
const assertModulesAllowedForTenant = async (tenantId: string, moduleKeys: string[]) => {
    if (!moduleKeys.length) return;
    const tenant = await (prisma as any).tenant.findUnique({
        where: { id: tenantId },
        select: { moduleProfile: { select: { moduleKeys: true } } },
    });
    const profileKeys = tenant?.moduleProfile?.moduleKeys;
    if (!Array.isArray(profileKeys)) return; // no category -> unrestricted
    const allowed = new Set(profileKeys as string[]);
    const blocked = moduleKeys.filter((key) => {
        const moduleDef = MODULE_CATALOG.find((m) => m.key === key);
        return !moduleDef?.alwaysAvailable && !allowed.has(key);
    });
    if (blocked.length) {
        throw new Error(`Bu şirketin kategorisine dahil olmayan modüller role eklenemez: ${blocked.join(', ')}`);
    }
};

/** undefined = leave untouched; empty/invalid selection = null (no restriction). */
const normalizeRoleModuleKeys = (input: unknown): string[] | null | undefined => {
    if (input === undefined) return undefined;
    const keys = sanitizeModuleKeys(input);
    return keys.length ? keys : null;
};

/** Package of a role in the SELECTED entity (RoleModuleConfig row or null). */
const configKeysForTenant = (role: any, tenantId: string): string[] | null => {
    const config = (role.moduleConfigs || []).find((row: any) => row.tenantId === tenantId);
    return config && Array.isArray(config.moduleKeys) ? config.moduleKeys : null;
};

router.get('/', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        // Roles are shared across the company tree: the same list shows under
        // the main tenant and every sub-tenant. Only the module package
        // (moduleKeys) is entity-specific — it is reported for the SELECTED
        // company, and editing it only touches that company's config.
        const treeTenantIds = await getCompanyTreeTenantIds(tenantId);
        const roles = await prisma.role.findMany({
            where: { tenantId: { in: treeTenantIds } },
            orderBy: { roleName: 'asc' },
            include: {
                permissions: { include: { permission: true } },
                employees: true,
                moduleConfigs: true,
            }
        });

        const result = roles.map(role => ({
            id: role.id,
            roleName: role.roleName,
            tenantId: role.tenantId,
            userCount: role.employees.length,
            permissions: role.permissions.map(rp => rp.permission.permissionName),
            moduleKeys: configKeysForTenant(role, tenantId),
        }));

        res.status(200).json(result);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// YETKİLERİ LİSTELEME
router.get('/permissions', requireAuth, requirePermission('roles.manage'), async (_req, res) => {
    try {
        const permissions = await prisma.permission.findMany({ orderBy: { permissionName: 'asc' } });
        res.status(200).json(permissions);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// OLUŞTURMA (TRANSACTION İLE HATASIZ)
router.post('/', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const { roleName, permissionIds } = req.body;

        if (!roleName) return res.status(400).json({ error: 'Rol adı gereklidir.' });

        await assertPermissionsAllowedForTenant(tenantId, permissionIds || []);
        const moduleKeys = normalizeRoleModuleKeys(req.body.moduleKeys);
        if (Array.isArray(moduleKeys)) await assertModulesAllowedForTenant(tenantId, moduleKeys);

        // Shared role: created under the ROOT so the whole tree sees it. The
        // module package sent along applies to the SELECTED entity only.
        const rootTenantId = await findTenantRootId(tenantId);
        if (!rootTenantId) return res.status(400).json({ error: 'Şirket bulunamadı.' });

        const role = await prisma.role.create({
            data: {
                id: nanoid(8),
                tenantId: rootTenantId,
                roleName,
                // İlişkili tabloya aynı anda yazım yapıyoruz
                permissions: {
                    create: (permissionIds || []).map((permId: string) => ({
                        permissionId: permId
                    }))
                },
                ...(Array.isArray(moduleKeys)
                    ? { moduleConfigs: { create: { tenantId, moduleKeys } } }
                    : {}),
            }
        });

        res.status(201).json(role);
    } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Kayıt işlemi başarısız. Veri bütünlüğünü kontrol edin.' });
    }
});

// GÜNCELLEME (MEVCUTLARI SİLİP YENİLERİ EKLİYORUZ)
router.patch('/:id', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const id = req.params.id as string;
        const { roleName, permissionIds } = req.body;
        const tenantId = req.user!.tenantId;

        // Ownership: a role id from another company TREE answers 404 (IDOR
        // guard) — roles are shared across the caller's tree.
        const treeTenantIds = await getCompanyTreeTenantIds(tenantId);
        const existing = await prisma.role.findFirst({ where: { id, tenantId: { in: treeTenantIds } } });
        if (!existing) return res.status(404).json({ error: 'Rol bulunamadı.' });

        if (permissionIds) await assertPermissionsAllowedForTenant(tenantId, permissionIds);

        const moduleKeys = normalizeRoleModuleKeys(req.body.moduleKeys);
        if (Array.isArray(moduleKeys)) await assertModulesAllowedForTenant(tenantId, moduleKeys);

        // Name and permissions belong to the shared role (tree-wide); the
        // module package only touches the SELECTED entity's config row.
        const dataToUpdate: any = {};
        if (roleName !== undefined) Object.assign(dataToUpdate, { roleName });
        if (moduleKeys !== undefined) {
            Object.assign(dataToUpdate, {
                moduleConfigs: moduleKeys === null
                    ? { deleteMany: { tenantId } }
                    : {
                        upsert: {
                            where: { roleId_tenantId: { roleId: id, tenantId } },
                            create: { tenantId, moduleKeys },
                            update: { moduleKeys },
                        },
                    },
            });
        }
        if (permissionIds) {
            Object.assign(dataToUpdate, {
                permissions: {
                    deleteMany: {},
                    create: permissionIds.map((permId: string) => ({
                        permissionId: permId
                    }))
                }
            });
        }

        const updatedRole = await prisma.role.update({
            where: { id },
            data: dataToUpdate,
            include: {
                permissions: { include: { permission: true } },
                employees: true,
                moduleConfigs: true,
            }
        });

        res.status(200).json({
            id: updatedRole.id,
            roleName: updatedRole.roleName,
            userCount: updatedRole.employees.length,
            permissions: updatedRole.permissions.map((rp: any) => rp.permission.permissionName),
            moduleKeys: configKeysForTenant(updatedRole, tenantId),
        });
    } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Güncelleme başarısız.' });
    }
});

// SİLME
router.delete('/:id', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const id = req.params.id as string;
        const treeTenantIds = await getCompanyTreeTenantIds(req.user!.tenantId);
        const existing = await prisma.role.findFirst({ where: { id, tenantId: { in: treeTenantIds } } });
        if (!existing) return res.status(404).json({ error: 'Rol bulunamadı.' });
        await prisma.rolePermission.deleteMany({ where: { roleId: id } });
        await prisma.employeeRole.deleteMany({ where: { roleId: id } });
        await (prisma as any).roleModuleConfig.deleteMany({ where: { roleId: id } });
        await prisma.role.delete({ where: { id } });
        res.status(200).json({ message: 'Rol başarıyla silindi.' });
    } catch (error: any) {
        res.status(400).json({ error: 'Rol silinemedi. Bu role atanmış personeller olabilir.' });
    }
});

export default router;