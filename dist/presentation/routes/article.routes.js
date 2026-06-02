"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const ArticleController_1 = require("../controllers/ArticleController");
const ArticleRepository_1 = require("../../infrastructure/repositories/ArticleRepository");
const InventoryRepository_1 = require("../../infrastructure/repositories/InventoryRepository");
const TenderActivityLogRepository_1 = require("../../infrastructure/repositories/TenderActivityLogRepository");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const router = (0, express_1.Router)();
const articleRepo = new ArticleRepository_1.ArticleRepository();
const inventoryRepo = new InventoryRepository_1.InventoryRepository();
const tenderLogRepo = new TenderActivityLogRepository_1.TenderActivityLogRepository();
const controller = new ArticleController_1.ArticleController(articleRepo, inventoryRepo, tenderLogRepo);
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
router.get('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (req, res) => controller.list(req, res));
/**
 * @swagger
 * /articles/lookup/{code}:
 *   get:
 *     tags: [Articles]
 *     summary: Stok kodu veya barkod ile ürünü getir (Barkod tarayıcı)
 *     security:
 *       - bearerAuth: []
 */
router.get('/lookup/:code', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (req, res) => controller.lookupByCode(req, res));
/**
 * @swagger
 * /articles/{id}:
 *   get:
 *     tags: [Articles]
 *     summary: Ürün detayı
 *     security:
 *       - bearerAuth: []
 */
router.get('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (req, res) => controller.getById(req, res));
/**
 * @swagger
 * /articles:
 *   post:
 *     tags: [Articles]
 *     summary: Yeni ürün/malzeme oluştur
 *     security:
 *       - bearerAuth: []
 */
router.post('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.create'), (req, res) => controller.create(req, res));
/**
 * @swagger
 * /articles/{id}:
 *   patch:
 *     tags: [Articles]
 *     summary: Ürünü güncelle
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.update'), (req, res) => controller.update(req, res));
/**
 * @swagger
 * /articles/{id}:
 *   delete:
 *     tags: [Articles]
 *     summary: Ürünü sil
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.delete'), (req, res) => controller.remove(req, res));
exports.default = router;
//# sourceMappingURL=article.routes.js.map