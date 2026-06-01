import {Router} from 'express';
import {TenantController} from '../controllers/TenantController';
import {CreateTenantUseCase} from '../../application/use-cases/tenant/CreateTenantUseCase';
import {UpdateTenantUseCase} from '../../application/use-cases/tenant/UpdateTenantUseCase';
import {TenantRepository} from '../../infrastructure/repositories/TenantRepository';
import {requireAuth} from '../middlewares/AuthMiddleware';
import {requirePermission} from '../middlewares/RbacMiddleware';

const router = Router();

const tenantRepository = new TenantRepository();
const createTenantUseCase = new CreateTenantUseCase(tenantRepository);
const updateTenantUseCase = new UpdateTenantUseCase(tenantRepository);
const tenantController = new TenantController(createTenantUseCase, updateTenantUseCase);

router.get('/', requireAuth, (req, res) => tenantController.list(req, res));

/**
 * @swagger
 * /tenants:
 *   post:
 *     tags: [Tenants]
 *     summary: Yeni Şirket (Tenant) veya Şube (Sub-Tenant) oluşturur
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TenantCreateRequest'
 *     responses:
 *       201:
 *         description: Başarıyla oluşturuldu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TenantResponse'
 *       400:
 *         description: Hata durumu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/', requireAuth, requirePermission('tenants.create'), (req, res) => tenantController.create(req, res));

/**
 * @swagger
 * /tenants/{id}:
 *   patch:
 *     tags: [Tenants]
 *     summary: Şirket / Şube bilgilerini günceller
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Güncellenecek Tenant ID'si
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TenantUpdateRequest'
 *     responses:
 *       200:
 *         description: Başarıyla güncellendi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TenantResponse'
 *       400:
 *         description: Geçersiz istek
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.patch('/:id', requireAuth, requirePermission('tenants.update'), (req, res) => tenantController.update(req, res));

export default router;
