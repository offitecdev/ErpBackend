"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const TenantController_1 = require("../controllers/TenantController");
const CreateTenantUseCase_1 = require("../../application/use-cases/tenant/CreateTenantUseCase");
const UpdateTenantUseCase_1 = require("../../application/use-cases/tenant/UpdateTenantUseCase");
const TenantRepository_1 = require("../../infrastructure/repositories/TenantRepository");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const router = (0, express_1.Router)();
const tenantRepository = new TenantRepository_1.TenantRepository();
const createTenantUseCase = new CreateTenantUseCase_1.CreateTenantUseCase(tenantRepository);
const updateTenantUseCase = new UpdateTenantUseCase_1.UpdateTenantUseCase(tenantRepository);
const tenantController = new TenantController_1.TenantController(createTenantUseCase, updateTenantUseCase);
router.get('/', AuthMiddleware_1.requireAuth, (req, res) => tenantController.list(req, res));
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
router.post('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenants.create'), (req, res) => tenantController.create(req, res));
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
router.patch('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenants.update'), (req, res) => tenantController.update(req, res));
exports.default = router;
//# sourceMappingURL=tenant.routes.js.map