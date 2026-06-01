import { Router } from 'express';
import { InventoryController } from '../controllers/InventoryController';
import { InventoryRepository } from '../../infrastructure/repositories/InventoryRepository';
import { ProcessStockMovementUseCase } from '../../application/use-cases/inventory/ProcessStockMovementUseCase';
import { ManagePurchaseProposalsUseCase } from '../../application/use-cases/inventory/ManagePurchaseProposalsUseCase';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';

const router = Router();

const repository = new InventoryRepository();
const processMovementUseCase = new ProcessStockMovementUseCase(repository);
const proposalsUseCase = new ManagePurchaseProposalsUseCase(repository);
const controller = new InventoryController(repository, processMovementUseCase, proposalsUseCase);

/**
 * @swagger
 * /inventory/locations:
 *   get:
 *     tags: [Inventory]
 *     summary: Tüm depoları ve lokasyonları listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/locations',
    requireAuth,
    requirePermission('inventory.view'),
    (req, res) => controller.listLocations(req, res)
);

/**
 * @swagger
 * /inventory/locations:
 *   post:
 *     tags: [Inventory]
 *     summary: Yeni bir lokasyon (Depo/İstasyon) oluştur
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               locationName: { type: string }
 *               locationType: { type: string, enum: [MAIN_WAREHOUSE, SUB_WAREHOUSE, STATION_BUFFER, PROJECT_RESERVE] }
 *               parentLocationId: { type: string, nullable: true }
 */
router.post(
    '/locations',
    requireAuth,
    requirePermission('inventory.manage'),
    (req, res) => controller.createLocation(req, res)
);

/**
 * @swagger
 * /inventory/balances:
 *   get:
 *     tags: [Inventory]
 *     summary: Anlık stok durumunu ve bakiyeleri getir
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: locationId
 *         schema: { type: string }
 */
router.get(
    '/balances',
    requireAuth,
    requirePermission('inventory.view'),
    (req, res) => controller.getBalances(req, res)
);

/**
 * @swagger
 * /inventory/dashboard:
 *   get:
 *     tags: [Inventory]
 *     summary: Stok dashboard (KPI, kritik stok, satın alma önerileri, lokasyonlar)
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/dashboard',
    requireAuth,
    requirePermission('inventory.view'),
    (req, res) => controller.getDashboard(req, res)
);

/**
 * @swagger
 * /inventory/articles/summary:
 *   get:
 *     tags: [Inventory]
 *     summary: Ürünleri stok bakiyeleri ile birlikte özet olarak getir
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/articles/summary',
    requireAuth,
    requirePermission('inventory.view'),
    (req, res) => controller.getArticleStockSummary(req, res)
);

/**
 * @swagger
 * /inventory/movements/scan:
 *   post:
 *     tags: [Inventory]
 *     summary: Barkod / Ürün kodu ile stok hareketi (Giriş/Çıkış/Transfer) kaydet (Sistemin Kalbi)
 *     description: Bu endpoint okutulan barkodu kontrol eder, yetkisiz işlemi veya eksi bakiyeyi engeller. Kritik stoğa düşerse otomatik satın alma talebi fırlatır.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               codeOrBarcode: { type: string, description: "Okutulan barkod veya stok kodu" }
 *               movementType: { type: string, enum: [IN, OUT, TRANSFER, RETURN, ADJUSTMENT] }
 *               quantity: { type: number }
 *               sourceLocationId: { type: string, nullable: true }
 *               destLocationId: { type: string, nullable: true }
 *               referenceId: { type: string, nullable: true, description: "Proje veya Üretim Emri ID" }
 *               description: { type: string, nullable: true }
 */
router.post(
    '/movements/scan',
    requireAuth,
    requirePermission('inventory.transfer'),
    (req, res) => controller.scanMovement(req, res)
);

/**
 * @swagger
 * /inventory/movements/{articleId}:
 *   get:
 *     tags: [Inventory]
 *     summary: Bir ürüne ait tüm denetim izini (Audit Ledger / Hareket geçmişi) getir
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/movements/:articleId',
    requireAuth,
    requirePermission('inventory.view'),
    (req, res) => controller.getMovements(req, res)
);

/**
 * @swagger
 * /inventory/proposals:
 *   get:
 *     tags: [Inventory]
 *     summary: Kritik stok seviyesi nedeniyle otomatik oluşan satın alma önerilerini listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/proposals',
    requireAuth,
    requirePermission('inventory.proposals.manage'),
    (req, res) => controller.listProposals(req, res)
);

/**
 * @swagger
 * /inventory/proposals/{id}/resolve:
 *   patch:
 *     tags: [Inventory]
 *     summary: Satın alma önerisini onayla veya reddet
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               isApproved: { type: boolean }
 */
router.patch(
    '/proposals/:id/resolve',
    requireAuth,
    requirePermission('inventory.proposals.manage'),
    (req, res) => controller.resolveProposal(req, res)
);

export default router;