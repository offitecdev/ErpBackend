import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import prisma from '../../infrastructure/database/prisma.client';
import { nanoid } from 'nanoid';

const router = Router();

router.get('/', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const roles = await prisma.role.findMany({
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

        const role = await prisma.role.create({
            data: {
                id: nanoid(8),
                tenantId,
                roleName,
                // İlişkili tabloya aynı anda yazım yapıyoruz
                permissions: {
                    create: (permissionIds || []).map((permId: string) => ({
                        permissionId: permId
                    }))
                }
            }
        });

        res.status(201).json(role);
    } catch (error: any) {
        res.status(400).json({ error: 'Kayıt işlemi başarısız. Veri bütünlüğünü kontrol edin.' });
    }
});

// GÜNCELLEME (MEVCUTLARI SİLİP YENİLERİ EKLİYORUZ)
router.patch('/:id', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const id = req.params.id as string;
        const { roleName, permissionIds } = req.body;

        const dataToUpdate: any = {};
        if (roleName !== undefined) Object.assign(dataToUpdate, { roleName });
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
            }
        });

        res.status(200).json({
            id: updatedRole.id,
            roleName: updatedRole.roleName,
            userCount: updatedRole.employees.length,
            permissions: updatedRole.permissions.map((rp: any) => rp.permission.permissionName),
        });
    } catch (error: any) {
        res.status(400).json({ error: 'Güncelleme başarısız.' });
    }
});

// SİLME
router.delete('/:id', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const id = req.params.id as string;
        await prisma.rolePermission.deleteMany({ where: { roleId: id } });
        await prisma.employeeRole.deleteMany({ where: { roleId: id } });
        await prisma.role.delete({ where: { id } });
        res.status(200).json({ message: 'Rol başarıyla silindi.' });
    } catch (error: any) {
        res.status(400).json({ error: 'Rol silinemedi. Bu role atanmış personeller olabilir.' });
    }
});

export default router;