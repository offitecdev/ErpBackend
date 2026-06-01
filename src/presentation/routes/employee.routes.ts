import { Router } from 'express';
import { EmployeeController } from '../controllers/EmployeeController';
import { CreateEmployeeUseCase } from '../../application/use-cases/employee/CreateEmployeeUseCase';
import { GetEmployeeUseCase } from '../../application/use-cases/employee/GetEmployeeUseCase';
import { UpdateEmployeeUseCase } from '../../application/use-cases/employee/UpdateEmployeeUseCase';
import { EmployeeRepository } from '../../infrastructure/repositories/EmployeeRepository';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
import { BcryptCryptoService } from '../../infrastructure/services/BcryptCryptoService';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';

const router = Router();

const employeeRepo          = new EmployeeRepository();
const roleRepo              = new RoleRepository();
const cryptoService         = new BcryptCryptoService();
const createEmployeeUseCase = new CreateEmployeeUseCase(employeeRepo, cryptoService);
const getEmployeeUseCase    = new GetEmployeeUseCase(employeeRepo);
const updateEmployeeUseCase = new UpdateEmployeeUseCase(employeeRepo);
const employeeController    = new EmployeeController(
    createEmployeeUseCase, 
    getEmployeeUseCase, 
    updateEmployeeUseCase,
    employeeRepo,
    roleRepo,
    cryptoService
);

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
router.post(
    '/',
    requireAuth,
    requirePermission('employees.create'),
    (req, res) => employeeController.create(req, res),
);

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
router.get(
    '/',
    requireAuth,
    requirePermission('employees.view'),
    (req, res) => employeeController.list(req, res),
);

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
router.get(
    '/:id',
    requireAuth,
    requirePermission('employees.view'),
    (req, res) => employeeController.getById(req, res),
);

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
router.patch(
    '/:id',
    requireAuth,
    requirePermission('employees.update'),
    (req, res) => employeeController.update(req, res),
);


/**
 * @swagger
 * /employees/{id}/deactivate:
 *   patch:
 *     tags: [Employees]
 *     summary: Personeli Pasife Alır (Soft Delete)
 */
router.patch(
    '/:id/deactivate',
    requireAuth,
    requirePermission('employees.delete'),
    async (req, res) => {
        try {
            // Repoyu kullanarak kişiyi pasife çekiyoruz
            const id = req.params.id as string;
            const updated = await employeeRepo.update(id, { isActive: false, terminationDate: new Date() });
            res.status(200).json({ message: 'Personel pasife alındı.', data: updated });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

export default router;
