import { Router } from 'express';
import { ArticleController } from '../controllers/ArticleController';
import { ArticleRepository } from '../../infrastructure/repositories/ArticleRepository';
import { InventoryRepository } from '../../infrastructure/repositories/InventoryRepository';
import { TenderActivityLogRepository } from '../../infrastructure/repositories/TenderActivityLogRepository';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';

const router = Router();
const articleRepo = new ArticleRepository();
const inventoryRepo = new InventoryRepository();
const tenderLogRepo = new TenderActivityLogRepository();
const controller = new ArticleController(articleRepo, inventoryRepo, tenderLogRepo);

/**
 * @swagger
 * /articles:
 *   get:
 *     tags: [Articles]
 *     summary: Ürün/Malzeme listesini getir (search, kategori, stok özetli)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: onlyActive
 *         schema: { type: boolean }
 *       - in: query
 *         name: includeStock
 *         schema: { type: boolean, description: "Stok bakiyelerini de döndür" }
 */
router.get(
    '/',
    requireAuth,
    requirePermission('inventory.view'),
    (req, res) => controller.list(req, res)
);

/**
 * @swagger
 * /articles/lookup/{code}:
 *   get:
 *     tags: [Articles]
 *     summary: Stok kodu veya barkod ile ürünü getir (Barkod tarayıcı)
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/lookup/:code',
    requireAuth,
    requirePermission('inventory.view'),
    (req, res) => controller.lookupByCode(req, res)
);

/**
 * @swagger
 * /articles/{id}:
 *   get:
 *     tags: [Articles]
 *     summary: Ürün detayı
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/:id',
    requireAuth,
    requirePermission('inventory.view'),
    (req, res) => controller.getById(req, res)
);

/**
 * @swagger
 * /articles:
 *   post:
 *     tags: [Articles]
 *     summary: Yeni ürün/malzeme oluştur
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/',
    requireAuth,
    requirePermission('inventory.articles.create'),
    (req, res) => controller.create(req, res)
);

/**
 * @swagger
 * /articles/{id}:
 *   patch:
 *     tags: [Articles]
 *     summary: Ürünü güncelle
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/:id',
    requireAuth,
    requirePermission('inventory.articles.update'),
    (req, res) => controller.update(req, res)
);

/**
 * @swagger
 * /articles/{id}:
 *   delete:
 *     tags: [Articles]
 *     summary: Ürünü sil
 *     security:
 *       - bearerAuth: []
 */
router.delete(
    '/:id',
    requireAuth,
    requirePermission('inventory.articles.delete'),
    (req, res) => controller.remove(req, res)
);

export default router;
