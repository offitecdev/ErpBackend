"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const InventoryController_1 = require("../controllers/InventoryController");
const InventoryRepository_1 = require("../../infrastructure/repositories/InventoryRepository");
const ProcessStockMovementUseCase_1 = require("../../application/use-cases/inventory/ProcessStockMovementUseCase");
const ManagePurchaseProposalsUseCase_1 = require("../../application/use-cases/inventory/ManagePurchaseProposalsUseCase");
const MaterialRepository_1 = require("../../infrastructure/repositories/MaterialRepository");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const SmtpMailService_1 = require("../../infrastructure/services/SmtpMailService");
const nanoid_1 = require("nanoid");
const router = (0, express_1.Router)();
const smtp = new SmtpMailService_1.SmtpMailService();
const repository = new InventoryRepository_1.InventoryRepository();
const processMovementUseCase = new ProcessStockMovementUseCase_1.ProcessStockMovementUseCase(repository);
const proposalsUseCase = new ManagePurchaseProposalsUseCase_1.ManagePurchaseProposalsUseCase(repository);
const controller = new InventoryController_1.InventoryController(repository, processMovementUseCase, proposalsUseCase);
const materialRepo = new MaterialRepository_1.MaterialRepository();
const supplierInclude = {
    articleSuppliers: {
        include: {
            article: {
                select: {
                    id: true,
                    articleCode: true,
                    name: true,
                    unit: true,
                    baseCost: true,
                    imageUrl: true,
                },
            },
            location: {
                select: {
                    id: true,
                    locationName: true,
                    locationType: true,
                },
            },
        },
        orderBy: [{ lastPurchaseDate: 'desc' }, { updatedAt: 'desc' }],
    },
};
const supplierWithStats = (supplier) => {
    const rows = supplier.articleSuppliers || [];
    const totalPurchaseAmount = rows.reduce((sum, row) => sum + (Number(row.purchasePrice || 0) * Number(row.quantity || 0)), 0);
    const totalPurchaseQuantity = rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const articleCount = new Set(rows.map((row) => row.articleId)).size;
    const latestPurchaseDate = rows
        .map((row) => row.lastPurchaseDate)
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
    return {
        ...supplier,
        articleCount,
        purchaseCount: rows.length,
        totalPurchaseQuantity,
        totalPurchaseAmount,
        latestPurchaseDate,
    };
};
/**
 * @swagger
 * /inventory/locations:
 *   get:
 *     tags: [Inventory]
 *     summary: Tüm depoları ve lokasyonları listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/locations', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (req, res) => controller.listLocations(req, res));
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
router.post('/locations', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.manage'), (req, res) => controller.createLocation(req, res));
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
router.get('/balances', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (req, res) => controller.getBalances(req, res));
/**
 * @swagger
 * /inventory/dashboard:
 *   get:
 *     tags: [Inventory]
 *     summary: Stok dashboard (KPI, kritik stok, satın alma önerileri, lokasyonlar)
 *     security:
 *       - bearerAuth: []
 */
router.get('/dashboard', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (req, res) => controller.getDashboard(req, res));
/**
 * @swagger
 * /inventory/articles/summary:
 *   get:
 *     tags: [Inventory]
 *     summary: Ürünleri stok bakiyeleri ile birlikte özet olarak getir
 *     security:
 *       - bearerAuth: []
 */
router.get('/articles/summary', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (req, res) => controller.getArticleStockSummary(req, res));
/**
 * @swagger
 * /inventory/articles/summary/paged:
 *   get:
 *     tags: [Inventory]
 *     summary: Ürünleri sayfa sayfa (varsayılan 15) getir — arama/durum/kalem tipi filtreli
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 15 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: itemType
 *         schema: { type: string, enum: [PRODUCT, MATERIAL] }
 */
router.get('/articles/summary/paged', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (req, res) => controller.getArticleStockSummaryPaged(req, res));
/**
 * @swagger
 * /inventory/articles/{id}/stock:
 *   get:
 *     tags: [Inventory]
 *     summary: Tek bir ürünün yalın stok bilgisi (toplam adet + ortalama maliyet) — depo/lokasyon çekmeden
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 */
router.get('/articles/:id/stock', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (req, res) => controller.getArticleStockInfo(req, res));
router.get('/suppliers', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const suppliers = await prisma_client_1.default.supplier.findMany({
            where: { tenantId: req.user.tenantId },
            include: supplierInclude,
            orderBy: { companyName: 'asc' },
        });
        res.status(200).json(suppliers.map(supplierWithStats));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.post('/suppliers', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.create'), async (req, res) => {
    try {
        const companyName = String(req.body.companyName || '').trim();
        if (!companyName)
            return res.status(400).json({ error: 'Tedarikçi şirket adı zorunludur.' });
        const supplier = await prisma_client_1.default.supplier.create({
            data: {
                id: (0, nanoid_1.nanoid)(10),
                tenantId: req.user.tenantId,
                companyName,
                contactName: req.body.contactName ? String(req.body.contactName).trim() : null,
                email: req.body.email ? String(req.body.email).trim() : null,
                phone: req.body.phone ? String(req.body.phone).trim() : null,
                address: req.body.address ? String(req.body.address).trim() : null,
                notes: req.body.notes ? String(req.body.notes).trim() : null,
                isActive: req.body.isActive ?? true,
            },
            include: supplierInclude,
        });
        res.status(201).json(supplierWithStats(supplier));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.get('/suppliers/:supplierId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const supplier = await prisma_client_1.default.supplier.findFirst({
            where: { id: req.params.supplierId, tenantId: req.user.tenantId },
            include: supplierInclude,
        });
        if (!supplier)
            return res.status(404).json({ error: 'Tedarikçi bulunamadı.' });
        res.status(200).json(supplierWithStats(supplier));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.patch('/suppliers/:supplierId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.update'), async (req, res) => {
    try {
        const existing = await prisma_client_1.default.supplier.findFirst({
            where: { id: req.params.supplierId, tenantId: req.user.tenantId },
        });
        if (!existing)
            return res.status(404).json({ error: 'Tedarikçi bulunamadı.' });
        const patch = {};
        ['companyName', 'contactName', 'email', 'phone', 'address', 'notes'].forEach((field) => {
            if (req.body[field] !== undefined)
                patch[field] = req.body[field] ? String(req.body[field]).trim() : null;
        });
        if (req.body.isActive !== undefined)
            patch.isActive = Boolean(req.body.isActive);
        if (patch.companyName === '')
            return res.status(400).json({ error: 'Tedarikçi şirket adı zorunludur.' });
        const supplier = await prisma_client_1.default.supplier.update({
            where: { id: existing.id },
            data: patch,
            include: supplierInclude,
        });
        res.status(200).json(supplierWithStats(supplier));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.get('/articles/:articleId/suppliers', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const rows = await prisma_client_1.default.articleSupplier.findMany({
            where: { tenantId: req.user.tenantId, articleId: req.params.articleId },
            include: {
                supplier: true,
                location: { select: { id: true, locationName: true, locationType: true } },
            },
            orderBy: [{ isPreferred: 'desc' }, { lastPurchaseDate: 'desc' }, { updatedAt: 'desc' }],
        });
        res.status(200).json(rows);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.post('/articles/:articleId/suppliers', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.update'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const article = await prisma_client_1.default.article.findFirst({ where: { id: req.params.articleId, tenantId } });
        if (!article)
            return res.status(404).json({ error: 'Ürün bulunamadı.' });
        let supplierId = req.body.supplierId ? String(req.body.supplierId) : '';
        if (!supplierId) {
            const companyName = String(req.body.companyName || '').trim();
            if (!companyName)
                return res.status(400).json({ error: 'Tedarikçi seçin veya şirket adı girin.' });
            const supplier = await prisma_client_1.default.supplier.upsert({
                where: { tenantId_companyName: { tenantId, companyName } },
                update: {
                    contactName: req.body.contactName ? String(req.body.contactName).trim() : undefined,
                    email: req.body.email ? String(req.body.email).trim() : undefined,
                    phone: req.body.phone ? String(req.body.phone).trim() : undefined,
                    address: req.body.address ? String(req.body.address).trim() : undefined,
                },
                create: {
                    id: (0, nanoid_1.nanoid)(10),
                    tenantId,
                    companyName,
                    contactName: req.body.contactName ? String(req.body.contactName).trim() : null,
                    email: req.body.email ? String(req.body.email).trim() : null,
                    phone: req.body.phone ? String(req.body.phone).trim() : null,
                    address: req.body.address ? String(req.body.address).trim() : null,
                },
            });
            supplierId = supplier.id;
        }
        const supplier = await prisma_client_1.default.supplier.findFirst({ where: { id: supplierId, tenantId } });
        if (!supplier)
            return res.status(404).json({ error: 'Tedarikçi bulunamadı.' });
        const purchasePrice = Number(req.body.purchasePrice ?? 0);
        const quantity = Number(req.body.quantity ?? 0);
        const purchaseDate = req.body.lastPurchaseDate ? new Date(req.body.lastPurchaseDate) : new Date();
        if (purchasePrice < 0)
            return res.status(400).json({ error: 'Birim alış fiyatı negatif olamaz.' });
        if (quantity <= 0)
            return res.status(400).json({ error: 'Eklenecek miktar 0’dan büyük olmalıdır.' });
        // Lokasyon UI'dan kaldırıldı: gönderilmezse tek global ana depo kullanılır.
        let locationId = req.body.locationId ? String(req.body.locationId) : null;
        if (locationId) {
            const location = await prisma_client_1.default.location.findFirst({ where: { id: locationId, tenantId } });
            if (!location)
                return res.status(404).json({ error: 'Depo/lokasyon bulunamadı.' });
        }
        else {
            locationId = (await repository.ensureDefaultLocation(tenantId)).id;
        }
        const row = await prisma_client_1.default.$transaction(async (tx) => {
            await tx.articleSupplier.updateMany({
                where: { tenantId, articleId: article.id },
                data: { isPreferred: false },
            });
            let saved = await tx.articleSupplier.create({
                data: {
                    id: (0, nanoid_1.nanoid)(10),
                    tenantId,
                    articleId: article.id,
                    supplierId,
                    locationId,
                    supplierSku: req.body.supplierSku ? String(req.body.supplierSku).trim() : null,
                    purchasePrice,
                    quantity,
                    remainingQuantity: quantity,
                    currency: req.body.currency ? String(req.body.currency).trim() : 'CHF',
                    lastPurchaseDate: purchaseDate,
                    notes: req.body.notes ? String(req.body.notes).trim() : null,
                    isPreferred: true,
                },
                include: { supplier: true, location: true },
            });
            await tx.stockBalance.upsert({
                where: { articleId_locationId: { articleId: article.id, locationId } },
                update: { currentQuantity: { increment: quantity } },
                create: { id: (0, nanoid_1.nanoid)(10), tenantId, articleId: article.id, locationId, currentQuantity: quantity },
            });
            const movement = await tx.stockMovement.create({
                data: {
                    id: (0, nanoid_1.nanoid)(12),
                    tenantId,
                    articleId: article.id,
                    movementType: 'IN',
                    quantity,
                    sourceLocationId: null,
                    destinationLocationId: locationId,
                    employeeId: req.user.id,
                    referenceId: saved.id,
                    description: `Tedarik girişi: ${supplier.companyName}`,
                },
            });
            saved = await tx.articleSupplier.update({
                where: { id: saved.id },
                data: { stockMovementId: movement.id },
                include: { supplier: true, location: true },
            });
            await tx.article.update({
                where: { id: article.id },
                data: {
                    baseCost: purchasePrice,
                    defaultSupplierId: supplierId,
                    lastPurchaseDate: purchaseDate,
                },
            });
            return saved;
        });
        res.status(201).json(row);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.patch('/articles/:articleId/suppliers/:linkId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.update'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const row = await prisma_client_1.default.articleSupplier.findFirst({
            where: { id: req.params.linkId, articleId: req.params.articleId, tenantId },
            include: { supplier: true },
        });
        if (!row)
            return res.status(404).json({ error: 'Ürün tedarik kaydı bulunamadı.' });
        const purchasePrice = req.body.purchasePrice !== undefined ? Number(req.body.purchasePrice) : Number(row.purchasePrice || 0);
        const quantity = req.body.quantity !== undefined ? Number(req.body.quantity) : Number(row.quantity || 0);
        const locationId = req.body.locationId !== undefined
            ? (req.body.locationId ? String(req.body.locationId) : null)
            : row.locationId;
        const purchaseDate = req.body.lastPurchaseDate !== undefined
            ? (req.body.lastPurchaseDate ? new Date(req.body.lastPurchaseDate) : null)
            : row.lastPurchaseDate;
        const isPreferred = req.body.isPreferred !== undefined ? Boolean(req.body.isPreferred) : Boolean(row.isPreferred);
        if (purchasePrice < 0)
            return res.status(400).json({ error: 'Birim alış fiyatı negatif olamaz.' });
        if (quantity <= 0)
            return res.status(400).json({ error: 'Eklenecek miktar 0’dan büyük olmalıdır.' });
        if (!locationId)
            return res.status(400).json({ error: 'Stoğa eklenecek depo/lokasyon zorunludur.' });
        const location = await prisma_client_1.default.location.findFirst({ where: { id: locationId, tenantId } });
        if (!location)
            return res.status(404).json({ error: 'Depo/lokasyon bulunamadı.' });
        const updated = await prisma_client_1.default.$transaction(async (tx) => {
            const locationChanged = locationId !== row.locationId;
            const quantityChanged = quantity !== Number(row.quantity || 0);
            if (locationChanged || quantityChanged) {
                if (row.locationId && Number(row.quantity || 0) > 0) {
                    const existingBalance = await tx.stockBalance.findUnique({
                        where: { articleId_locationId: { articleId: row.articleId, locationId: row.locationId } },
                    });
                    if (existingBalance) {
                        await tx.stockBalance.update({
                            where: { articleId_locationId: { articleId: row.articleId, locationId: row.locationId } },
                            data: { currentQuantity: { decrement: Number(row.quantity || 0) } },
                        });
                    }
                }
                await tx.stockBalance.upsert({
                    where: { articleId_locationId: { articleId: row.articleId, locationId } },
                    update: { currentQuantity: { increment: quantity } },
                    create: { id: (0, nanoid_1.nanoid)(10), tenantId, articleId: row.articleId, locationId, currentQuantity: quantity },
                });
                await tx.stockMovement.create({
                    data: {
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId,
                        articleId: row.articleId,
                        movementType: 'ADJUSTMENT',
                        quantity,
                        sourceLocationId: null,
                        destinationLocationId: locationId,
                        employeeId: req.user.id,
                        referenceId: row.id,
                        description: `Tedarik kaydı düzenlendi: ${row.supplier?.companyName || row.supplierId}`,
                    },
                });
            }
            if (isPreferred) {
                await tx.articleSupplier.updateMany({
                    where: { tenantId, articleId: row.articleId },
                    data: { isPreferred: false },
                });
            }
            const saved = await tx.articleSupplier.update({
                where: { id: row.id },
                data: {
                    locationId,
                    supplierSku: req.body.supplierSku !== undefined ? (req.body.supplierSku ? String(req.body.supplierSku).trim() : null) : row.supplierSku,
                    purchasePrice,
                    quantity,
                    remainingQuantity: quantity,
                    currency: req.body.currency !== undefined ? (req.body.currency ? String(req.body.currency).trim() : 'CHF') : row.currency,
                    lastPurchaseDate: purchaseDate,
                    notes: req.body.notes !== undefined ? (req.body.notes ? String(req.body.notes).trim() : null) : row.notes,
                    isPreferred,
                },
                include: { supplier: true, location: true },
            });
            if (isPreferred) {
                await tx.article.update({
                    where: { id: row.articleId },
                    data: {
                        baseCost: purchasePrice,
                        defaultSupplierId: row.supplierId,
                        lastPurchaseDate: purchaseDate,
                    },
                });
            }
            return saved;
        });
        res.status(200).json(updated);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.delete('/articles/:articleId/suppliers/:linkId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.update'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const row = await prisma_client_1.default.articleSupplier.findFirst({
            where: { id: req.params.linkId, articleId: req.params.articleId, tenantId },
        });
        if (!row)
            return res.status(404).json({ error: 'Ürün tedarik kaydı bulunamadı.' });
        await prisma_client_1.default.$transaction(async (tx) => {
            if (row.locationId && Number(row.quantity || 0) > 0) {
                const balance = await tx.stockBalance.findUnique({
                    where: { articleId_locationId: { articleId: row.articleId, locationId: row.locationId } },
                });
                if (balance) {
                    await tx.stockBalance.update({
                        where: { articleId_locationId: { articleId: row.articleId, locationId: row.locationId } },
                        data: { currentQuantity: { decrement: Number(row.quantity || 0) } },
                    });
                }
            }
            await tx.articleSupplier.delete({ where: { id: row.id } });
            if (row.isPreferred) {
                const nextRow = await tx.articleSupplier.findFirst({
                    where: { tenantId, articleId: row.articleId },
                    orderBy: [{ lastPurchaseDate: 'desc' }, { updatedAt: 'desc' }],
                });
                if (nextRow) {
                    await tx.articleSupplier.update({ where: { id: nextRow.id }, data: { isPreferred: true } });
                    await tx.article.update({
                        where: { id: row.articleId },
                        data: {
                            baseCost: nextRow.purchasePrice,
                            defaultSupplierId: nextRow.supplierId,
                            lastPurchaseDate: nextRow.lastPurchaseDate,
                        },
                    });
                }
                else {
                    await tx.article.update({
                        where: { id: row.articleId },
                        data: { defaultSupplierId: null, lastPurchaseDate: null },
                    });
                }
            }
        });
        res.status(204).send();
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.get('/materials', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const materials = await materialRepo.list(req.user.tenantId);
        res.status(200).json(materials);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.post('/materials', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.create'), async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        const serialId = String(req.body.serialId || '').trim();
        const unitCost = Number(req.body.unitCost || 0);
        const stockQuantity = Number(req.body.stockQuantity || 0);
        const minStockLevel = Number(req.body.minStockLevel || 0);
        const criticalStockLevel = Number(req.body.criticalStockLevel || 0);
        const imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : null;
        if (!name)
            return res.status(400).json({ error: 'Malzeme adi zorunludur.' });
        if (!serialId)
            return res.status(400).json({ error: 'Seri kodu zorunludur.' });
        if (unitCost < 0 || stockQuantity < 0)
            return res.status(400).json({ error: 'Fiyat ve stok negatif olamaz.' });
        if (minStockLevel < 0 || criticalStockLevel < 0)
            return res.status(400).json({ error: 'Minimum ve kritik seviye negatif olamaz.' });
        const material = await materialRepo.createMaterial(req.user.tenantId, name, serialId, unitCost, stockQuantity, imageUrl, minStockLevel, criticalStockLevel);
        res.status(201).json(material);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.patch('/materials/:materialId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.update'), async (req, res) => {
    try {
        const material = await materialRepo.findById(req.params.materialId);
        if (!material || material.tenantId !== req.user.tenantId) {
            return res.status(404).json({ error: 'Malzeme bulunamadi.' });
        }
        const patch = {};
        if (req.body.name !== undefined)
            patch.name = String(req.body.name).trim();
        if (req.body.serialId !== undefined)
            patch.serialId = String(req.body.serialId).trim();
        if (req.body.unitCost !== undefined)
            patch.unitCost = Number(req.body.unitCost);
        if (req.body.stockQuantity !== undefined)
            patch.stockQuantity = Number(req.body.stockQuantity);
        if (req.body.minStockLevel !== undefined)
            patch.minStockLevel = Number(req.body.minStockLevel);
        if (req.body.criticalStockLevel !== undefined)
            patch.criticalStockLevel = Number(req.body.criticalStockLevel);
        if (req.body.imageUrl !== undefined)
            patch.imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : null;
        if (req.body.isActive !== undefined)
            patch.isActive = Boolean(req.body.isActive);
        if (patch.name === '')
            return res.status(400).json({ error: 'Malzeme adi zorunludur.' });
        if (patch.serialId === '')
            return res.status(400).json({ error: 'Seri kodu zorunludur.' });
        if (patch.unitCost < 0 || patch.stockQuantity < 0)
            return res.status(400).json({ error: 'Fiyat ve stok negatif olamaz.' });
        const updated = await materialRepo.updateMaterial(material.id, patch);
        res.status(200).json(updated);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.delete('/materials/:materialId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.delete'), async (req, res) => {
    try {
        const material = await materialRepo.findById(req.params.materialId);
        if (!material || material.tenantId !== req.user.tenantId) {
            return res.status(404).json({ error: 'Malzeme bulunamadi.' });
        }
        await materialRepo.softDeleteMaterial(material.id);
        res.status(204).send();
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/search-items:
 *   get:
 *     tags: [Inventory]
 *     summary: Ürün ve malzemeleri birlikte arar (stok hareketi seçimi için otomatik tamamlama)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 */
router.get('/search-items', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const q = String(req.query.q || '').trim();
        if (!q)
            return res.status(200).json([]);
        const [articles, materials] = await Promise.all([
            prisma_client_1.default.article.findMany({
                where: {
                    tenantId,
                    OR: [
                        { name: { contains: q } },
                        { articleCode: { contains: q } },
                        { systemBarcode: { contains: q } },
                        { supplierBarcode: { contains: q } },
                    ],
                },
                take: 12,
                orderBy: { name: 'asc' },
            }),
            prisma_client_1.default.material.findMany({
                where: {
                    tenantId,
                    isActive: true,
                    OR: [
                        { name: { contains: q } },
                        { serialId: { contains: q } },
                    ],
                },
                take: 12,
                orderBy: { name: 'asc' },
            }),
        ]);
        const productItems = articles.map((a) => ({
            kind: 'PRODUCT',
            id: a.id,
            code: a.articleCode,
            name: a.name,
            barcode: a.systemBarcode || a.supplierBarcode || null,
            unit: a.unit,
            salePrice: a.salePrice ?? 0,
            baseCost: a.baseCost ?? 0,
            imageUrl: a.imageUrl || null,
            itemType: a.itemType ?? 'PRODUCT',
            minStockLevel: a.minStockLevel ?? 0,
            criticalStockLevel: a.criticalStockLevel ?? 0,
            maxStockLevel: a.maxStockLevel ?? null,
        }));
        const materialItems = materials.map((m) => ({
            kind: 'MATERIAL',
            id: m.id,
            code: m.serialId,
            name: m.name,
            barcode: null,
            unit: 'adet',
            salePrice: m.unitCost ?? 0,
            imageUrl: m.imageUrl || null,
            stockQuantity: m.stockQuantity ?? 0,
            minStockLevel: m.minStockLevel ?? 0,
            criticalStockLevel: m.criticalStockLevel ?? 0,
        }));
        res.status(200).json([...productItems, ...materialItems]);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
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
router.post('/movements/scan', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), (req, res) => controller.scanMovement(req, res));
/**
 * @swagger
 * /inventory/movements/{articleId}:
 *   get:
 *     tags: [Inventory]
 *     summary: Bir ürüne ait tüm denetim izini (Audit Ledger / Hareket geçmişi) getir
 *     security:
 *       - bearerAuth: []
 */
router.get('/movements/:articleId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (req, res) => controller.getMovements(req, res));
/**
 * @swagger
 * /inventory/proposals:
 *   get:
 *     tags: [Inventory]
 *     summary: Kritik stok seviyesi nedeniyle otomatik oluşan satın alma önerilerini listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/proposals', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.proposals.manage'), (req, res) => controller.listProposals(req, res));
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
router.patch('/proposals/:id/resolve', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.proposals.manage'), (req, res) => controller.resolveProposal(req, res));
// ===========================================================================
// TEDARİK TALEPLERİ (Supply Requests)
// Minimum/kritik stoğa düşen ürün ve malzemeler, tedarikçiye direkt talep,
// bekleyen/alınan talepler. Tüm uçlar YALNIZCA ilgili kaydı çeker (aşırı veri yok).
// ===========================================================================
// Ortak: bir kalemi (ürün/malzeme) tek satırlık düşük stok objesine indirger.
const mapLowStock = (kind, id, code, name, unit, qty, min, critical) => {
    const isCritical = critical > 0 && qty <= critical;
    const isBelowMin = min > 0 && qty <= min;
    return { kind, id, code, name, unit, totalQuantity: qty, minStockLevel: min, criticalStockLevel: critical, isCritical, isBelowMin };
};
/**
 * @swagger
 * /inventory/supply/low-stock:
 *   get:
 *     tags: [Inventory]
 *     summary: Minimum/kritik seviyeye düşen ürün ve malzemeleri getir (yalnızca eşiği olanlar)
 *     security:
 *       - bearerAuth: []
 */
router.get('/supply/low-stock', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        // Yalnızca bir eşik tanımlı olan kalemleri çek — tüm katalog değil.
        const [articles, materials] = await Promise.all([
            prisma_client_1.default.article.findMany({
                where: {
                    tenantId,
                    isActive: true,
                    OR: [{ minStockLevel: { gt: 0 } }, { criticalStockLevel: { gt: 0 } }],
                },
                select: {
                    id: true,
                    articleCode: true,
                    name: true,
                    unit: true,
                    minStockLevel: true,
                    criticalStockLevel: true,
                    stockBalances: { select: { currentQuantity: true } },
                },
            }),
            prisma_client_1.default.material.findMany({
                where: {
                    tenantId,
                    isActive: true,
                    OR: [{ minStockLevel: { gt: 0 } }, { criticalStockLevel: { gt: 0 } }],
                },
                select: {
                    id: true,
                    serialId: true,
                    name: true,
                    stockQuantity: true,
                    minStockLevel: true,
                    criticalStockLevel: true,
                },
            }),
        ]);
        const rows = [
            ...articles.map((a) => {
                const qty = (a.stockBalances || []).reduce((s, b) => s + (b.currentQuantity || 0), 0);
                return mapLowStock('PRODUCT', a.id, a.articleCode, a.name, a.unit, qty, a.minStockLevel || 0, a.criticalStockLevel || 0);
            }),
            ...materials.map((m) => mapLowStock('MATERIAL', m.id, m.serialId, m.name, 'adet', m.stockQuantity || 0, m.minStockLevel || 0, m.criticalStockLevel || 0)),
        ];
        // Kritik: kritik eşiğin altında. Minimum: min eşiğin altında AMA henüz kritik değil.
        const critical = rows.filter((r) => r.isCritical);
        const minimum = rows.filter((r) => r.isBelowMin && !r.isCritical);
        res.status(200).json({ minimum, critical });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/supply/item/{kind}/{id}/suppliers:
 *   get:
 *     tags: [Inventory]
 *     summary: Bir kalemin daha önce alım yaptığı tedarikçileri + son alım bilgisini getir
 *     security:
 *       - bearerAuth: []
 */
router.get('/supply/item/:kind/:id/suppliers', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const kind = String(req.params.kind || '').toUpperCase();
        const id = String(req.params.id);
        if (kind === 'PRODUCT') {
            const article = await prisma_client_1.default.article.findFirst({
                where: { id, tenantId },
                select: { id: true, articleCode: true, name: true, unit: true },
            });
            if (!article)
                return res.status(404).json({ error: 'Ürün bulunamadı.' });
            // Tedarikçileri İKİ kaynaktan topla: (1) ürün-tedarikçi alım partileri
            // (ArticleSupplier) ve (2) tedarikçisi olan stok GİRİŞ hareketleri
            // (StockMovement.supplierId). Böylece stok kaydı hangi yoldan girilmiş
            // olursa olsun ilgili tedarikçi(ler) talep panelinde görünür.
            const [links, movements] = await Promise.all([
                prisma_client_1.default.articleSupplier.findMany({
                    where: { tenantId, articleId: id },
                    include: { supplier: { select: { id: true, companyName: true, email: true, phone: true } } },
                    orderBy: [{ lastPurchaseDate: 'desc' }, { updatedAt: 'desc' }],
                }),
                prisma_client_1.default.stockMovement.findMany({
                    where: { tenantId, articleId: id, supplierId: { not: null } },
                    select: {
                        supplierId: true,
                        unitCost: true,
                        quantity: true,
                        transactionDate: true,
                        supplier: { select: { id: true, companyName: true, email: true, phone: true } },
                    },
                    orderBy: { transactionDate: 'desc' },
                }),
            ]);
            // Tedarikçi başına en son alımı tek satıra indir.
            const bySupplier = new Map();
            for (const l of links) {
                if (!l.supplier)
                    continue;
                const key = l.supplierId;
                if (!bySupplier.has(key)) {
                    bySupplier.set(key, {
                        supplierId: l.supplier.id,
                        companyName: l.supplier.companyName,
                        email: l.supplier.email,
                        phone: l.supplier.phone,
                        lastPurchaseDate: l.lastPurchaseDate,
                        lastPurchasePrice: l.purchasePrice,
                        lastPurchaseQuantity: l.quantity,
                        currency: l.currency,
                        purchaseCount: 1,
                    });
                }
                else {
                    bySupplier.get(key).purchaseCount += 1;
                }
            }
            for (const m of movements) {
                if (!m.supplier)
                    continue;
                const key = m.supplierId;
                if (!bySupplier.has(key)) {
                    bySupplier.set(key, {
                        supplierId: m.supplier.id,
                        companyName: m.supplier.companyName,
                        email: m.supplier.email,
                        phone: m.supplier.phone,
                        lastPurchaseDate: m.transactionDate,
                        lastPurchasePrice: m.unitCost ?? null,
                        lastPurchaseQuantity: m.quantity ?? null,
                        currency: 'CHF',
                        purchaseCount: 1,
                    });
                }
                else {
                    bySupplier.get(key).purchaseCount += 1;
                }
            }
            let suppliers = Array.from(bySupplier.values());
            // Geçmiş alım yoksa, e-postası tanımlı aktif tedarikçilere düş — panel
            // hiçbir zaman boş kalmasın, kullanıcı yine de talep açabilsin.
            if (suppliers.length === 0) {
                const all = await prisma_client_1.default.supplier.findMany({
                    where: { tenantId, isActive: true, NOT: { email: null } },
                    select: { id: true, companyName: true, email: true, phone: true },
                    orderBy: { companyName: 'asc' },
                    take: 50,
                });
                suppliers = all.map((s) => ({
                    supplierId: s.id,
                    companyName: s.companyName,
                    email: s.email,
                    phone: s.phone,
                    lastPurchaseDate: null,
                    lastPurchasePrice: null,
                    lastPurchaseQuantity: null,
                    currency: null,
                    purchaseCount: 0,
                }));
            }
            return res.status(200).json({
                item: { kind: 'PRODUCT', id: article.id, code: article.articleCode, name: article.name, unit: article.unit },
                suppliers,
            });
        }
        // MALZEME: alım geçmişi modeli yok — e-posta atılabilsin diye e-postası olan
        // aktif tedarikçileri döneriz (son alım bilgisi olmadan).
        const material = await prisma_client_1.default.material.findFirst({
            where: { id, tenantId },
            select: { id: true, serialId: true, name: true },
        });
        if (!material)
            return res.status(404).json({ error: 'Malzeme bulunamadı.' });
        const suppliers = await prisma_client_1.default.supplier.findMany({
            where: { tenantId, isActive: true, NOT: { email: null } },
            select: { id: true, companyName: true, email: true, phone: true },
            orderBy: { companyName: 'asc' },
            take: 50,
        });
        return res.status(200).json({
            item: { kind: 'MATERIAL', id: material.id, code: material.serialId, name: material.name, unit: 'adet' },
            suppliers: suppliers.map((s) => ({
                supplierId: s.id,
                companyName: s.companyName,
                email: s.email,
                phone: s.phone,
                lastPurchaseDate: null,
                lastPurchasePrice: null,
                lastPurchaseQuantity: null,
                currency: null,
                purchaseCount: 0,
            })),
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/supply/requests:
 *   get:
 *     tags: [Inventory]
 *     summary: Tedarik taleplerini duruma göre listele (PENDING | RECEIVED)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, RECEIVED, CANCELLED] }
 */
router.get('/supply/requests', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const status = req.query.status ? String(req.query.status).toUpperCase() : 'PENDING';
        const rows = await prisma_client_1.default.supplyRequest.findMany({
            where: { tenantId, status },
            orderBy: { createdAt: 'desc' },
            take: 200,
        });
        res.status(200).json(rows);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/supply/requests:
 *   post:
 *     tags: [Inventory]
 *     summary: Tedarik talebi oluştur (miktarı kaydeder, opsiyonel olarak tedarikçiye e-posta atar)
 *     security:
 *       - bearerAuth: []
 */
router.post('/supply/requests', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const b = req.body || {};
        const itemType = b.itemType === 'MATERIAL' ? 'MATERIAL' : 'PRODUCT';
        const itemName = String(b.itemName || '').trim();
        const requestedQuantity = Number(b.requestedQuantity || 0);
        const supplierEmail = b.supplierEmail ? String(b.supplierEmail).trim() : null;
        const sendEmail = Boolean(b.sendEmail);
        if (!itemName)
            return res.status(400).json({ error: 'Kalem adı zorunludur.' });
        if (!(requestedQuantity > 0))
            return res.status(400).json({ error: 'Talep miktarı 0’dan büyük olmalıdır.' });
        if (sendEmail && !supplierEmail)
            return res.status(400).json({ error: 'E-posta göndermek için tedarikçi e-postası gereklidir.' });
        const subject = b.emailSubject ? String(b.emailSubject) : `Tedarik Talebi: ${itemName}`;
        const bodyText = b.emailBody ? String(b.emailBody) : '';
        let emailSent = false;
        if (sendEmail && supplierEmail) {
            const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId } });
            const result = await smtp.send(settings || {}, {
                fromEmail: settings?.fromEmail || req.user.email,
                fromName: settings?.fromName || 'Offitec ERP',
                to: supplierEmail,
                subject,
                text: bodyText,
                html: bodyText ? `<pre style="font-family:inherit;white-space:pre-wrap">${bodyText.replace(/</g, '&lt;')}</pre>` : null,
                replyTo: settings?.replyTo || null,
                attachments: [],
            });
            emailSent = !result.preview;
        }
        const created = await prisma_client_1.default.supplyRequest.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId,
                itemType,
                articleId: b.articleId ? String(b.articleId) : null,
                materialId: b.materialId ? String(b.materialId) : null,
                itemName,
                itemCode: b.itemCode ? String(b.itemCode) : null,
                unit: b.unit ? String(b.unit) : null,
                supplierId: b.supplierId ? String(b.supplierId) : null,
                supplierName: b.supplierName ? String(b.supplierName) : null,
                supplierEmail,
                requestedQuantity,
                emailSubject: subject,
                emailBody: bodyText || null,
                emailSent,
                status: 'PENDING',
                createdByEmpId: req.user.id,
            },
        });
        res.status(201).json({ ...created, emailSent, emailPreview: sendEmail && !emailSent });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/supply/requests/{id}/receive:
 *   patch:
 *     tags: [Inventory]
 *     summary: Bekleyen tedarik talebini "alındı" olarak işaretle
 *     security:
 *       - bearerAuth: []
 */
router.patch('/supply/requests/:id/receive', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.supplyRequest.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Tedarik talebi bulunamadı.' });
        const updated = await prisma_client_1.default.supplyRequest.update({
            where: { id: existing.id },
            data: { status: 'RECEIVED', receivedAt: new Date(), receivedByEmpId: req.user.id },
        });
        res.status(200).json(updated);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/supply/requests/{id}:
 *   delete:
 *     tags: [Inventory]
 *     summary: Tedarik talebini sil (iptal)
 *     security:
 *       - bearerAuth: []
 */
router.delete('/supply/requests/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.supplyRequest.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Tedarik talebi bulunamadı.' });
        await prisma_client_1.default.supplyRequest.delete({ where: { id: existing.id } });
        res.status(204).send();
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=inventory.routes.js.map