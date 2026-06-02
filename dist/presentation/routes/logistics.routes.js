"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const LogisticsController_1 = require("../controllers/LogisticsController");
const ShipmentRepository_1 = require("../../infrastructure/repositories/ShipmentRepository");
const CreateShipmentUseCase_1 = require("../../application/use-cases/logistics/CreateShipmentUseCase");
const UpdateShipmentUseCase_1 = require("../../application/use-cases/logistics/UpdateShipmentUseCase");
const CheckDelayedShipmentsUseCase_1 = require("../../application/use-cases/logistics/CheckDelayedShipmentsUseCase");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const router = (0, express_1.Router)();
// Bağımlılıkların (Dependencies) oluşturulması
const shipmentRepo = new ShipmentRepository_1.ShipmentRepository();
const createUseCase = new CreateShipmentUseCase_1.CreateShipmentUseCase(shipmentRepo);
const updateUseCase = new UpdateShipmentUseCase_1.UpdateShipmentUseCase(shipmentRepo);
const checkDelayedUseCase = new CheckDelayedShipmentsUseCase_1.CheckDelayedShipmentsUseCase(shipmentRepo);
const controller = new LogisticsController_1.LogisticsController(createUseCase, updateUseCase, checkDelayedUseCase, shipmentRepo);
/**
 * @swagger
 * /logistics/shipments:
 *   get:
 *     tags: [Logistics]
 *     summary: Sevkiyat (Lojistik) kayıtlarını listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/shipments', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('logistics.view'), (req, res) => controller.list(req, res));
/**
 * @swagger
 * /logistics/shipments/{id}:
 *   get:
 *     tags: [Logistics]
 *     summary: Tekil sevkiyat kartını getir
 *     security:
 *       - bearerAuth: []
 */
router.get('/shipments/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('logistics.view'), (req, res) => controller.getById(req, res));
/**
 * @swagger
 * /logistics/shipments:
 *   post:
 *     tags: [Logistics]
 *     summary: Yeni bir Sevkiyat Kartı oluştur
 *     security:
 *       - bearerAuth: []
 */
router.post('/shipments', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('logistics.manage'), (req, res) => controller.create(req, res));
/**
 * @swagger
 * /logistics/shipments/{id}:
 *   patch:
 *     tags: [Logistics]
 *     summary: Sevkiyat kartını güncelle (Fatura yükleme vb.)
 *     security:
 *       - bearerAuth: []
 */
router.patch('/shipments/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('logistics.manage'), (req, res) => controller.update(req, res));
/**
 * @swagger
 * /logistics/shipments/{id}:
 *   delete:
 *     tags: [Logistics]
 *     summary: Sevkiyat kartını sil
 *     security:
 *       - bearerAuth: []
 */
router.delete('/shipments/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('logistics.manage'), (req, res) => controller.delete(req, res));
/**
 * @swagger
 * /logistics/shipments/trigger/check-delayed:
 *   post:
 *     tags: [Logistics]
 *     summary: ETA'sı geçmiş teslimatları otomatik olarak "Gecikti" statüsüne çeker
 *     security:
 *       - bearerAuth: []
 */
router.post('/shipments/trigger/check-delayed', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('logistics.manage'), (req, res) => controller.autoCheckDelayed(req, res));
exports.default = router;
//# sourceMappingURL=logistics.routes.js.map