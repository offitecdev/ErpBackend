"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const nanoid_1 = require("nanoid");
const moduleCatalog_1 = require("../../shared/moduleCatalog");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
const router = (0, express_1.Router)();
// A company mapped to a ModuleProfile ("Numara" category) may only put the
// permissions of its enabled modules into roles. Permissions the catalog does
// not cover stay assignable everywhere. Throws on violation.
const assertPermissionsAllowedForTenant = async (tenantId, permissionIds) => {
    if (!permissionIds.length)
        return;
    const tenant = await prisma_client_1.default.tenant.findUnique({
        where: { id: tenantId },
        select: { moduleProfile: { select: { moduleKeys: true } } },
    });
    const moduleKeys = tenant?.moduleProfile?.moduleKeys;
    if (!Array.isArray(moduleKeys))
        return; // no category -> unrestricted
    const allowed = (0, moduleCatalog_1.permissionsForModules)(moduleKeys);
    const selected = await prisma_client_1.default.permission.findMany({ where: { id: { in: permissionIds } } });
    const blocked = selected
        .filter((perm) => moduleCatalog_1.CATALOG_PERMISSION_NAMES.has(perm.permissionName) && !allowed.has(perm.permissionName))
        .map((perm) => perm.permissionName);
    if (blocked.length) {
        throw new Error(`Bu şirketin kategorisine dahil olmayan modül yetkileri role eklenemez: ${blocked.join(', ')}`);
    }
};
// The role's module package may only contain modules the company's category
// enables (always-available modules stay assignable everywhere).
const assertModulesAllowedForTenant = async (tenantId, moduleKeys) => {
    if (!moduleKeys.length)
        return;
    const tenant = await prisma_client_1.default.tenant.findUnique({
        where: { id: tenantId },
        select: { moduleProfile: { select: { moduleKeys: true } } },
    });
    const profileKeys = tenant?.moduleProfile?.moduleKeys;
    if (!Array.isArray(profileKeys))
        return; // no category -> unrestricted
    const allowed = new Set(profileKeys);
    const blocked = moduleKeys.filter((key) => {
        const moduleDef = moduleCatalog_1.MODULE_CATALOG.find((m) => m.key === key);
        return !moduleDef?.alwaysAvailable && !allowed.has(key);
    });
    if (blocked.length) {
        throw new Error(`Bu şirketin kategorisine dahil olmayan modüller role eklenemez: ${blocked.join(', ')}`);
    }
};
/** undefined = leave untouched; empty/invalid selection = null (no restriction). */
const normalizeRoleModuleKeys = (input) => {
    if (input === undefined)
        return undefined;
    const keys = (0, moduleCatalog_1.sanitizeModuleKeys)(input);
    return keys.length ? keys : null;
};
/** Package of a role in the SELECTED entity (RoleModuleConfig row or null). */
const configKeysForTenant = (role, tenantId) => {
    const config = (role.moduleConfigs || []).find((row) => row.tenantId === tenantId);
    return config && Array.isArray(config.moduleKeys) ? config.moduleKeys : null;
};
router.get('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        // Roles are shared across the company tree: the same list shows under
        // the main tenant and every sub-tenant. Only the module package
        // (moduleKeys) is entity-specific — it is reported for the SELECTED
        // company, and editing it only touches that company's config.
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId);
        const scopeTenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(tenantId);
        const roles = await prisma_client_1.default.role.findMany({
            where: { tenantId: { in: treeTenantIds } },
            orderBy: { roleName: 'asc' },
            include: {
                permissions: { include: { permission: true } },
                // Die Rolle ist baumweit, die KOPFZAHL nicht — gezählt wird,
                // wer sie in der ausgewählten Firma trägt.
                employees: { where: { employee: { tenantId: { in: scopeTenantIds } } } },
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
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// YETKİLERİ LİSTELEME
router.get('/permissions', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (_req, res) => {
    try {
        const permissions = await prisma_client_1.default.permission.findMany({ orderBy: { permissionName: 'asc' } });
        res.status(200).json(permissions);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// OLUŞTURMA (TRANSACTION İLE HATASIZ)
router.post('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const { roleName, permissionIds } = req.body;
        if (!roleName)
            return res.status(400).json({ error: 'Rol adı gereklidir.' });
        await assertPermissionsAllowedForTenant(tenantId, permissionIds || []);
        const moduleKeys = normalizeRoleModuleKeys(req.body.moduleKeys);
        if (Array.isArray(moduleKeys))
            await assertModulesAllowedForTenant(tenantId, moduleKeys);
        // Shared role: created under the ROOT so the whole tree sees it. The
        // module package sent along applies to the SELECTED entity only.
        const rootTenantId = await (0, AuthMiddleware_1.findTenantRootId)(tenantId);
        if (!rootTenantId)
            return res.status(400).json({ error: 'Şirket bulunamadı.' });
        const role = await prisma_client_1.default.role.create({
            data: {
                id: (0, nanoid_1.nanoid)(8),
                tenantId: rootTenantId,
                roleName,
                // İlişkili tabloya aynı anda yazım yapıyoruz
                permissions: {
                    create: (permissionIds || []).map((permId) => ({
                        permissionId: permId
                    }))
                },
                ...(Array.isArray(moduleKeys)
                    ? { moduleConfigs: { create: { tenantId, moduleKeys } } }
                    : {}),
            }
        });
        res.status(201).json(role);
    }
    catch (error) {
        res.status(400).json({ error: error?.message || 'Kayıt işlemi başarısız. Veri bütünlüğünü kontrol edin.' });
    }
});
// GÜNCELLEME (MEVCUTLARI SİLİP YENİLERİ EKLİYORUZ)
router.patch('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const id = req.params.id;
        const { roleName, permissionIds } = req.body;
        const tenantId = req.user.tenantId;
        // Ownership: a role id from another company TREE answers 404 (IDOR
        // guard) — roles are shared across the caller's tree.
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId);
        const existing = await prisma_client_1.default.role.findFirst({ where: { id, tenantId: { in: treeTenantIds } } });
        if (!existing)
            return res.status(404).json({ error: 'Rol bulunamadı.' });
        if (permissionIds)
            await assertPermissionsAllowedForTenant(tenantId, permissionIds);
        const moduleKeys = normalizeRoleModuleKeys(req.body.moduleKeys);
        if (Array.isArray(moduleKeys))
            await assertModulesAllowedForTenant(tenantId, moduleKeys);
        // Name and permissions belong to the shared role (tree-wide); the
        // module package only touches the SELECTED entity's config row.
        const dataToUpdate = {};
        if (roleName !== undefined)
            Object.assign(dataToUpdate, { roleName });
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
                    create: permissionIds.map((permId) => ({
                        permissionId: permId
                    }))
                }
            });
        }
        const updatedRole = await prisma_client_1.default.role.update({
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
            permissions: updatedRole.permissions.map((rp) => rp.permission.permissionName),
            moduleKeys: configKeysForTenant(updatedRole, tenantId),
        });
    }
    catch (error) {
        res.status(400).json({ error: error?.message || 'Güncelleme başarısız.' });
    }
});
// SİLME
router.delete('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const id = req.params.id;
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(req.user.tenantId);
        const existing = await prisma_client_1.default.role.findFirst({ where: { id, tenantId: { in: treeTenantIds } } });
        if (!existing)
            return res.status(404).json({ error: 'Rol bulunamadı.' });
        await prisma_client_1.default.rolePermission.deleteMany({ where: { roleId: id } });
        await prisma_client_1.default.employeeRole.deleteMany({ where: { roleId: id } });
        await prisma_client_1.default.roleModuleConfig.deleteMany({ where: { roleId: id } });
        await prisma_client_1.default.role.delete({ where: { id } });
        res.status(200).json({ message: 'Rol başarıyla silindi.' });
    }
    catch (error) {
        res.status(400).json({ error: 'Rol silinemedi. Bu role atanmış personeller olabilir.' });
    }
});
exports.default = router;
//# sourceMappingURL=role.routes.js.map