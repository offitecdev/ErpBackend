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
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
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
router.post('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('employees.create'), (req, res) => employeeController.create(req, res));
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
router.patch('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('employees.update'), (req, res) => employeeController.update(req, res));
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
        const updated = await employeeRepo.update(id, { isActive: false, terminationDate: new Date() });
        res.status(200).json({ message: 'Personel pasife alındı.', data: updated });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=employee.routes.js.map