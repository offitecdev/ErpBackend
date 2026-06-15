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
const nanoid_1 = require("nanoid");
const router = (0, express_1.Router)();
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
        const locationId = req.body.locationId ? String(req.body.locationId) : null;
        const purchaseDate = req.body.lastPurchaseDate ? new Date(req.body.lastPurchaseDate) : new Date();
        if (purchasePrice < 0)
            return res.status(400).json({ error: 'Birim alış fiyatı negatif olamaz.' });
        if (quantity <= 0)
            return res.status(400).json({ error: 'Eklenecek miktar 0’dan büyük olmalıdır.' });
        if (!locationId)
            return res.status(400).json({ error: 'Stoğa eklenecek depo/lokasyon zorunludur.' });
        const location = await prisma_client_1.default.location.findFirst({ where: { id: locationId, tenantId } });
        if (!location)
            return res.status(404).json({ error: 'Depo/lokasyon bulunamadı.' });
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
        const imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : null;
        if (!name)
            return res.status(400).json({ error: 'Malzeme adi zorunludur.' });
        if (!serialId)
            return res.status(400).json({ error: 'Seri kodu zorunludur.' });
        if (unitCost < 0 || stockQuantity < 0)
            return res.status(400).json({ error: 'Fiyat ve stok negatif olamaz.' });
        const material = await materialRepo.createMaterial(req.user.tenantId, name, serialId, unitCost, stockQuantity, imageUrl);
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
exports.default = router;
//# sourceMappingURL=inventory.routes.js.map