import { Router } from 'express';
import { LogisticsController } from '../controllers/LogisticsController';
import { ShipmentRepository } from '../../infrastructure/repositories/ShipmentRepository';
import { CreateShipmentUseCase } from '../../application/use-cases/logistics/CreateShipmentUseCase';
import { UpdateShipmentUseCase } from '../../application/use-cases/logistics/UpdateShipmentUseCase';
import { CheckDelayedShipmentsUseCase } from '../../application/use-cases/logistics/CheckDelayedShipmentsUseCase';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';

const router = Router();

// Bağımlılıkların (Dependencies) oluşturulması
const shipmentRepo = new ShipmentRepository();
const createUseCase = new CreateShipmentUseCase(shipmentRepo);
const updateUseCase = new UpdateShipmentUseCase(shipmentRepo);
const checkDelayedUseCase = new CheckDelayedShipmentsUseCase(shipmentRepo);

const controller = new LogisticsController(
    createUseCase,
    updateUseCase,
    checkDelayedUseCase,
    shipmentRepo
);

/**
 * @swagger
 * /logistics/shipments:
 *   get:
 *     tags: [Logistics]
 *     summary: Sevkiyat (Lojistik) kayıtlarını listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/shipments',
    requireAuth,
    requirePermission('logistics.view'),
    (req, res) => controller.list(req, res)
);

/**
 * @swagger
 * /logistics/shipments/{id}:
 *   get:
 *     tags: [Logistics]
 *     summary: Tekil sevkiyat kartını getir
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/shipments/:id',
    requireAuth,
    requirePermission('logistics.view'),
    (req, res) => controller.getById(req, res)
);

/**
 * @swagger
 * /logistics/shipments:
 *   post:
 *     tags: [Logistics]
 *     summary: Yeni bir Sevkiyat Kartı oluştur
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/shipments',
    requireAuth,
    requirePermission('logistics.manage'),
    (req, res) => controller.create(req, res)
);

/**
 * @swagger
 * /logistics/shipments/{id}:
 *   patch:
 *     tags: [Logistics]
 *     summary: Sevkiyat kartını güncelle (Fatura yükleme vb.)
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/shipments/:id',
    requireAuth,
    requirePermission('logistics.manage'),
    (req, res) => controller.update(req, res)
);

/**
 * @swagger
 * /logistics/shipments/{id}:
 *   delete:
 *     tags: [Logistics]
 *     summary: Sevkiyat kartını sil
 *     security:
 *       - bearerAuth: []
 */
router.delete(
    '/shipments/:id',
    requireAuth,
    requirePermission('logistics.manage'),
    (req, res) => controller.delete(req, res)
);

/**
 * @swagger
 * /logistics/shipments/trigger/check-delayed:
 *   post:
 *     tags: [Logistics]
 *     summary: ETA'sı geçmiş teslimatları otomatik olarak "Gecikti" statüsüne çeker
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/shipments/trigger/check-delayed',
    requireAuth,
    requirePermission('logistics.manage'),
    (req, res) => controller.autoCheckDelayed(req, res)
);

export default router;