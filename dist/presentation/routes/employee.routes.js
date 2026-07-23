"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const EmployeeController_1 = require("../controllers/EmployeeController");
const CreateEmployeeUseCase_1 = require("../../application/use-cases/employee/CreateEmployeeUseCase");
const GetEmployeeUseCase_1 = require("../../application/use-cases/employee/GetEmployeeUseCase");
const UpdateEmployeeUseCase_1 = require("../../application/use-cases/employee/UpdateEmployeeUseCase");
const EmployeeRepository_1 = require("../../infrastructure/repositories/EmployeeRepository");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const BcryptCryptoService_1 = require("../../infrastructure/services/BcryptCryptoService");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const ValidationMiddleware_1 = require("../middlewares/ValidationMiddleware");
const employeeSchemas_1 = require("../validation/employeeSchemas");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const router = (0, express_1.Router)();
const employeeRepo = new EmployeeRepository_1.EmployeeRepository();
const roleRepo = new RoleRepository_1.RoleRepository();
const cryptoService = new BcryptCryptoService_1.BcryptCryptoService();
const createEmployeeUseCase = new CreateEmployeeUseCase_1.CreateEmployeeUseCase(employeeRepo, cryptoService);
const getEmployeeUseCase = new GetEmployeeUseCase_1.GetEmployeeUseCase(employeeRepo);
const updateEmployeeUseCase = new UpdateEmployeeUseCase_1.UpdateEmployeeUseCase(employeeRepo);
const employeeController = new EmployeeController_1.EmployeeController(createEmployeeUseCase, getEmployeeUseCase, updateEmployeeUseCase, employeeRepo, roleRepo, cryptoService);
/**
 * @swagger
 * /employees:
 *   post:
 *     tags: [Employees]
 *     summary: Yeni çalışan oluştur
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateEmployeeRequest'
 *     responses:
 *       201:
 *         description: Çalışan oluşturuldu
 *       400:
 *         description: Geçersiz veri
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Yetkisiz
 *       403:
 *         description: Erişim reddedildi
 */
router.post('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('employees.create'), (0, ValidationMiddleware_1.validate)({ body: employeeSchemas_1.employeeCreateSchema }), (req, res) => employeeController.create(req, res));
/**
 * @swagger
 * /employees:
 *   get:
 *     tags: [Employees]
 *     summary: Çalışan listesini getir
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: isActive
 *         schema:
 *           type: boolean
 *         description: Aktif / pasif filtresi
 *       - in: query
 *         name: departmentId
 *         schema:
 *           type: string
 *         description: Departman ID
 *       - in: query
 *         name: roleName
 *         schema:
 *           type: string
 *         description: Rol filtresi
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Ad/soyad/e-posta arama
 *     responses:
 *       200:
 *         description: Çalışan listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       401:
 *         description: Yetkisiz
 *       403:
 *         description: Erişim reddedildi
 */
router.get('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('employees.view'), (req, res) => employeeController.list(req, res));
/**
 * @swagger
 * /employees/{id}:
 *   get:
 *     tags: [Employees]
 *     summary: Personel detayını getir
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Personel ID
 *     responses:
 *       200:
 *         description: Personel detayı
 *       404:
 *         description: Personel bulunamadı
 */
router.get('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('employees.view'), (req, res) => employeeController.getById(req, res));
/**
 * @swagger
 * /employees/{id}:
 *   patch:
 *     tags: [Employees]
 *     summary: Personel bilgilerini güncelle
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Personel ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateEmployeeRequest'
 *     responses:
 *       200:
 *         description: Personel güncellendi
 *       400:
 *         description: Geçersiz veri
 *       404:
 *         description: Personel bulunamadı
 */
router.patch('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('employees.update'), (0, ValidationMiddleware_1.validate)({ body: employeeSchemas_1.employeeUpdateSchema }), (req, res) => employeeController.update(req, res));
/**
 * @swagger
 * /employees/{id}/deactivate:
 *   patch:
 *     tags: [Employees]
 *     summary: Personeli Pasife Alır (Soft Delete)
 */
router.patch('/:id/deactivate', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('employees.delete'), async (req, res) => {
    try {
        // Repoyu kullanarak kişiyi pasife çekiyoruz
        const id = req.params.id;
        // Ownership check: only employees of the caller's tenant can be deactivated.
        const existing = await employeeRepo.findById(id);
        if (!existing || existing.tenantId !== req.user.tenantId) {
            return res.status(404).json({ error: 'Personel bulunamadı.' });
        }
        const updated = await employeeRepo.update(id, { isActive: false, terminationDate: new Date() });
        AuditLogService_1.auditLog.log({
            action: 'employee.deactivate',
            tenantId: req.user.tenantId,
            employeeId: req.user.id,
            entityType: 'Employee',
            entityId: id,
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json({ message: 'Personel pasife alındı.', data: updated });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /employees/{id}/restore:
 *   patch:
 *     tags: [Employees]
 *     summary: Silinmiş hesabı geri yükler (silinmeden itibaren 30 gün içinde)
 */
router.patch('/:id/restore', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('employees.delete'), async (req, res) => {
    try {
        const id = req.params.id;
        const existing = await employeeRepo.findById(id);
        if (!existing || existing.tenantId !== req.user.tenantId) {
            return res.status(404).json({ error: 'Personel bulunamadı.' });
        }
        if (existing.bannedAt) {
            return res.status(403).json({ error: 'Engellenmiş hesap geri yüklenemez.' });
        }
        if (!existing.deletedAt) {
            return res.status(400).json({ error: 'Hesap silinmiş durumda değil.' });
        }
        const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
        if (Date.now() - existing.deletedAt.getTime() > RECOVERY_WINDOW_MS) {
            return res.status(410).json({ error: 'Kurtarma süresi (30 gün) dolmuş; hesap geri yüklenemez.' });
        }
        const updated = await employeeRepo.update(id, { deletedAt: null, isActive: true });
        AuditLogService_1.auditLog.log({
            action: 'employee.restore',
            tenantId: req.user.tenantId,
            employeeId: req.user.id,
            entityType: 'Employee',
            entityId: id,
            ...AuditLogService_1.auditLog.context(req),
        });
        const { passwordHash, ...safe } = updated;
        res.status(200).json({ message: 'Hesap geri yüklendi.', data: safe });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /employees/{id}/ban:
 *   patch:
 *     tags: [Employees]
 *     summary: Hesabı kalıcı olarak engeller (giriş, geri yükleme ve aynı e-posta ile yeniden kayıt kapanır)
 */
router.patch('/:id/ban', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('employees.delete'), async (req, res) => {
    try {
        const id = req.params.id;
        const existing = await employeeRepo.findById(id);
        if (!existing || existing.tenantId !== req.user.tenantId) {
            return res.status(404).json({ error: 'Personel bulunamadı.' });
        }
        if (id === req.user.id) {
            return res.status(400).json({ error: 'Kendi hesabınızı engelleyemezsiniz.' });
        }
        if (existing.bannedAt) {
            return res.status(200).json({ message: 'Hesap zaten engelli.' });
        }
        await employeeRepo.update(id, { bannedAt: new Date(), isActive: false });
        AuditLogService_1.auditLog.log({
            action: 'employee.ban',
            tenantId: req.user.tenantId,
            employeeId: req.user.id,
            entityType: 'Employee',
            entityId: id,
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json({ message: 'Hesap engellendi.' });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=employee.routes.js.map