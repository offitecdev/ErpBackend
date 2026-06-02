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
const router = (0, express_1.Router)();
router.get('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const roles = await prisma_client_1.default.role.findMany({
            where: { tenantId },
            include: {
                permissions: { include: { permission: true } },
                employees: true,
            }
        });
        const result = roles.map(role => ({
            id: role.id,
            roleName: role.roleName,
            tenantId: role.tenantId,
            userCount: role.employees.length,
            permissions: role.permissions.map(rp => rp.permission.permissionName),
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
        const role = await prisma_client_1.default.role.create({
            data: {
                id: (0, nanoid_1.nanoid)(8),
                tenantId,
                roleName,
                // İlişkili tabloya aynı anda yazım yapıyoruz
                permissions: {
                    create: (permissionIds || []).map((permId) => ({
                        permissionId: permId
                    }))
                }
            }
        });
        res.status(201).json(role);
    }
    catch (error) {
        res.status(400).json({ error: 'Kayıt işlemi başarısız. Veri bütünlüğünü kontrol edin.' });
    }
});
// GÜNCELLEME (MEVCUTLARI SİLİP YENİLERİ EKLİYORUZ)
router.patch('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const id = req.params.id;
        const { roleName, permissionIds } = req.body;
        const dataToUpdate = {};
        if (roleName !== undefined)
            Object.assign(dataToUpdate, { roleName });
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
            }
        });
        res.status(200).json({
            id: updatedRole.id,
            roleName: updatedRole.roleName,
            userCount: updatedRole.employees.length,
            permissions: updatedRole.permissions.map((rp) => rp.permission.permissionName),
        });
    }
    catch (error) {
        res.status(400).json({ error: 'Güncelleme başarısız.' });
    }
});
// SİLME
router.delete('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const id = req.params.id;
        await prisma_client_1.default.rolePermission.deleteMany({ where: { roleId: id } });
        await prisma_client_1.default.employeeRole.deleteMany({ where: { roleId: id } });
        await prisma_client_1.default.role.delete({ where: { id } });
        res.status(200).json({ message: 'Rol başarıyla silindi.' });
    }
    catch (error) {
        res.status(400).json({ error: 'Rol silinemedi. Bu role atanmış personeller olabilir.' });
    }
});
exports.default = router;
//# sourceMappingURL=role.routes.js.map