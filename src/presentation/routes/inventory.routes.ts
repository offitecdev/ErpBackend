import { Router } from 'express';
import { InventoryController } from '../controllers/InventoryController';
import { InventoryRepository } from '../../infrastructure/repositories/InventoryRepository';
import { ProcessStockMovementUseCase } from '../../application/use-cases/inventory/ProcessStockMovementUseCase';
import { ManagePurchaseProposalsUseCase } from '../../application/use-cases/inventory/ManagePurchaseProposalsUseCase';
import { MaterialRepository } from '../../infrastructure/repositories/MaterialRepository';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import prisma from '../../infrastructure/database/prisma.client';
import { SmtpMailService } from '../../infrastructure/services/SmtpMailService';
import { buildSignatureParts } from '../../infrastructure/services/mailSignature';
import { composeAddressSnapshot } from '../../shared/postalAddress';
import { nanoid } from 'nanoid';

/** Tedarikçi adresinin ayrı bileşenleri (tek serbest metin alanı yoktur). */
const SUPPLIER_ADDRESS_FIELDS = ['address', 'addressSupplement', 'postalCode', 'city', 'state', 'country'] as const;

/** Kayıttaki bileşenler → PDF/ekran için 2 satırlık snapshot metni. */
const supplierAddressSnapshot = (supplier: any): string | null => composeAddressSnapshot({
    street: supplier?.address,
    addressSupplement: supplier?.addressSupplement,
    postalCode: supplier?.postalCode,
    city: supplier?.city,
    state: supplier?.state,
    country: supplier?.country,
});

const router = Router();
const smtp = new SmtpMailService();

const repository = new InventoryRepository();
const processMovementUseCase = new ProcessStockMovementUseCase(repository);
const proposalsUseCase = new ManagePurchaseProposalsUseCase(repository);
const controller = new InventoryController(repository, processMovementUseCase, proposalsUseCase);
const materialRepo = new MaterialRepository();

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
} as const;

const supplierWithStats = (supplier: any) => {
    const rows = supplier.articleSuppliers || [];
    const totalPurchaseAmount = rows.reduce((sum: number, row: any) => sum + (Number(row.purchasePrice || 0) * Number(row.quantity || 0)), 0);
    const totalPurchaseQuantity = rows.reduce((sum: number, row: any) => sum + Number(row.quantity || 0), 0);
    const articleCount = new Set(rows.map((row: any) => row.articleId)).size;
    const latestPurchaseDate = rows
        .map((row: any) => row.lastPurchaseDate)
        .filter(Boolean)
        .sort((a: Date, b: Date) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
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
 *       - in: query
 *         name: code
 *         schema: { type: string }
 *         description: Stok kodu kolonunda daraltma (contains)
 *       - in: query
 *         name: name
 *         schema: { type: string }
 *         description: Ürün adı kolonunda daraltma (contains)
 *       - in: query
 *         name: barcode
 *         schema: { type: string }
 *         description: Sistem/tedarikçi barkodu kolonunda daraltma (contains)
 */
router.get(
    '/articles/summary/paged',
    requireAuth,
    requirePermission('inventory.view'),
    (req, res) => controller.getArticleStockSummaryPaged(req, res)
);

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
router.get(
    '/articles/:id/stock',
    requireAuth,
    requirePermission('inventory.view'),
    (req, res) => controller.getArticleStockInfo(req, res)
);

router.get(
    '/suppliers',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const suppliers = await (prisma as any).supplier.findMany({
                where: { tenantId: req.user!.tenantId },
                // The list page only renders supplier fields and the relation
                // count. Loading every ArticleSupplier plus article images made
                // this small list take seconds and returned a large nested body.
                select: {
                    id: true,
                    tenantId: true,
                    companyName: true,
                    contactName: true,
                    email: true,
                    phone: true,
                    address: true,
                    addressSupplement: true,
                    postalCode: true,
                    city: true,
                    state: true,
                    country: true,
                    notes: true,
                    isActive: true,
                    createdAt: true,
                    updatedAt: true,
                    _count: { select: { articleSuppliers: true } },
                },
                orderBy: { companyName: 'asc' },
            });
            res.status(200).json(suppliers.map(({ _count, ...supplier }: any) => ({
                ...supplier,
                articleCount: _count.articleSuppliers,
                purchaseCount: _count.articleSuppliers,
            })));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/suppliers/search:
 *   get:
 *     tags: [Inventory]
 *     summary: Tedarikçi seçici için yalın arama (varsayılan ilk 10 kayıt)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 */
router.get(
    '/suppliers/search',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const q = req.query.q ? String(req.query.q).trim() : '';
            const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
            const suppliers = await (prisma as any).supplier.findMany({
                where: {
                    tenantId,
                    isActive: true,
                    ...(q ? { OR: [{ companyName: { contains: q } }, { contactName: { contains: q } }] } : {}),
                },
                select: {
                    id: true,
                    companyName: true,
                    contactName: true,
                    email: true,
                    phone: true,
                    _count: { select: { articleSuppliers: true } },
                },
                orderBy: { companyName: 'asc' },
                take: limit,
            });
            res.status(200).json(suppliers.map((s: any) => ({
                id: s.id,
                companyName: s.companyName,
                contactName: s.contactName,
                email: s.email,
                phone: s.phone,
                purchaseCount: s._count?.articleSuppliers ?? 0,
            })));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.post(
    '/suppliers',
    requireAuth,
    requirePermission('inventory.articles.create'),
    async (req, res) => {
        try {
            const companyName = String(req.body.companyName || '').trim();
            if (!companyName) return res.status(400).json({ error: 'Tedarikçi şirket adı zorunludur.' });
            const supplier = await (prisma as any).supplier.create({
                data: {
                    id: nanoid(10),
                    tenantId: req.user!.tenantId,
                    companyName,
                    contactName: req.body.contactName ? String(req.body.contactName).trim() : null,
                    email: req.body.email ? String(req.body.email).trim() : null,
                    phone: req.body.phone ? String(req.body.phone).trim() : null,
                    // Adres bileşenleri tek tek gelir (birleşik "adres" alanı yok).
                    ...Object.fromEntries(SUPPLIER_ADDRESS_FIELDS.map((field) => [
                        field,
                        req.body[field] ? String(req.body[field]).trim() : null,
                    ])),
                    notes: req.body.notes ? String(req.body.notes).trim() : null,
                    isActive: req.body.isActive ?? true,
                },
                include: supplierInclude,
            });
            res.status(201).json(supplierWithStats(supplier));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.get(
    '/suppliers/:supplierId',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const supplier = await (prisma as any).supplier.findFirst({
                where: { id: req.params.supplierId, tenantId: req.user!.tenantId },
                include: supplierInclude,
            });
            if (!supplier) return res.status(404).json({ error: 'Tedarikçi bulunamadı.' });
            res.status(200).json(supplierWithStats(supplier));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.patch(
    '/suppliers/:supplierId',
    requireAuth,
    requirePermission('inventory.articles.update'),
    async (req, res) => {
        try {
            const existing = await (prisma as any).supplier.findFirst({
                where: { id: req.params.supplierId, tenantId: req.user!.tenantId },
            });
            if (!existing) return res.status(404).json({ error: 'Tedarikçi bulunamadı.' });
            const patch: any = {};
            ['companyName', 'contactName', 'email', 'phone', ...SUPPLIER_ADDRESS_FIELDS, 'notes'].forEach((field) => {
                if (req.body[field] !== undefined) patch[field] = req.body[field] ? String(req.body[field]).trim() : null;
            });
            if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);
            if (patch.companyName === '') return res.status(400).json({ error: 'Tedarikçi şirket adı zorunludur.' });
            const supplier = await (prisma as any).supplier.update({
                where: { id: existing.id },
                data: patch,
                include: supplierInclude,
            });
            res.status(200).json(supplierWithStats(supplier));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.get(
    '/articles/:articleId/suppliers',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const rows = await (prisma as any).articleSupplier.findMany({
                where: { tenantId: req.user!.tenantId, articleId: req.params.articleId },
                include: {
                    supplier: true,
                    location: { select: { id: true, locationName: true, locationType: true } },
                },
                orderBy: [{ isPreferred: 'desc' }, { lastPurchaseDate: 'desc' }, { updatedAt: 'desc' }],
            });
            res.status(200).json(rows);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.post(
    '/articles/:articleId/suppliers',
    requireAuth,
    requirePermission('inventory.articles.update'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const article = await (prisma as any).article.findFirst({ where: { id: req.params.articleId, tenantId } });
            if (!article) return res.status(404).json({ error: 'Ürün bulunamadı.' });

            let supplierId = req.body.supplierId ? String(req.body.supplierId) : '';
            if (!supplierId) {
                const companyName = String(req.body.companyName || '').trim();
                if (!companyName) return res.status(400).json({ error: 'Tedarikçi seçin veya şirket adı girin.' });
                const supplier = await (prisma as any).supplier.upsert({
                    where: { tenantId_companyName: { tenantId, companyName } },
                    update: {
                        contactName: req.body.contactName ? String(req.body.contactName).trim() : undefined,
                        email: req.body.email ? String(req.body.email).trim() : undefined,
                        phone: req.body.phone ? String(req.body.phone).trim() : undefined,
                        address: req.body.address ? String(req.body.address).trim() : undefined,
                    },
                    create: {
                        id: nanoid(10),
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

            const supplier = await (prisma as any).supplier.findFirst({ where: { id: supplierId, tenantId } });
            if (!supplier) return res.status(404).json({ error: 'Tedarikçi bulunamadı.' });

            const purchasePrice = Number(req.body.purchasePrice ?? 0);
            const quantity = Number(req.body.quantity ?? 0);
            const purchaseDate = req.body.lastPurchaseDate ? new Date(req.body.lastPurchaseDate) : new Date();
            if (purchasePrice < 0) return res.status(400).json({ error: 'Birim alış fiyatı negatif olamaz.' });
            if (quantity <= 0) return res.status(400).json({ error: 'Eklenecek miktar 0’dan büyük olmalıdır.' });

            // Lokasyon UI'dan kaldırıldı: gönderilmezse tek global ana depo kullanılır.
            let locationId = req.body.locationId ? String(req.body.locationId) : null;
            if (locationId) {
                const location = await (prisma as any).location.findFirst({ where: { id: locationId, tenantId } });
                if (!location) return res.status(404).json({ error: 'Depo/lokasyon bulunamadı.' });
            } else {
                locationId = (await repository.ensureDefaultLocation(tenantId)).id;
            }

            const row = await (prisma as any).$transaction(async (tx: any) => {
                await tx.articleSupplier.updateMany({
                    where: { tenantId, articleId: article.id },
                    data: { isPreferred: false },
                });

                let saved = await tx.articleSupplier.create({
                    data: {
                        id: nanoid(10),
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
                    create: { id: nanoid(10), tenantId, articleId: article.id, locationId, currentQuantity: quantity },
                });

                const movement = await tx.stockMovement.create({
                    data: {
                        id: nanoid(12),
                        tenantId,
                        articleId: article.id,
                        movementType: 'IN',
                        quantity,
                        sourceLocationId: null,
                        destinationLocationId: locationId,
                        employeeId: req.user!.id,
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.patch(
    '/articles/:articleId/suppliers/:linkId',
    requireAuth,
    requirePermission('inventory.articles.update'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const row = await (prisma as any).articleSupplier.findFirst({
                where: { id: req.params.linkId, articleId: req.params.articleId, tenantId },
                include: { supplier: true },
            });
            if (!row) return res.status(404).json({ error: 'Ürün tedarik kaydı bulunamadı.' });

            const purchasePrice = req.body.purchasePrice !== undefined ? Number(req.body.purchasePrice) : Number(row.purchasePrice || 0);
            const quantity = req.body.quantity !== undefined ? Number(req.body.quantity) : Number(row.quantity || 0);
            const locationId = req.body.locationId !== undefined
                ? (req.body.locationId ? String(req.body.locationId) : null)
                : row.locationId;
            const purchaseDate = req.body.lastPurchaseDate !== undefined
                ? (req.body.lastPurchaseDate ? new Date(req.body.lastPurchaseDate) : null)
                : row.lastPurchaseDate;
            const isPreferred = req.body.isPreferred !== undefined ? Boolean(req.body.isPreferred) : Boolean(row.isPreferred);

            if (purchasePrice < 0) return res.status(400).json({ error: 'Birim alış fiyatı negatif olamaz.' });
            if (quantity <= 0) return res.status(400).json({ error: 'Eklenecek miktar 0’dan büyük olmalıdır.' });
            if (!locationId) return res.status(400).json({ error: 'Stoğa eklenecek depo/lokasyon zorunludur.' });

            const location = await (prisma as any).location.findFirst({ where: { id: locationId, tenantId } });
            if (!location) return res.status(404).json({ error: 'Depo/lokasyon bulunamadı.' });

            const updated = await (prisma as any).$transaction(async (tx: any) => {
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
                        create: { id: nanoid(10), tenantId, articleId: row.articleId, locationId, currentQuantity: quantity },
                    });
                    await tx.stockMovement.create({
                        data: {
                            id: nanoid(12),
                            tenantId,
                            articleId: row.articleId,
                            movementType: 'ADJUSTMENT',
                            quantity,
                            sourceLocationId: null,
                            destinationLocationId: locationId,
                            employeeId: req.user!.id,
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.delete(
    '/articles/:articleId/suppliers/:linkId',
    requireAuth,
    requirePermission('inventory.articles.update'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const row = await (prisma as any).articleSupplier.findFirst({
                where: { id: req.params.linkId, articleId: req.params.articleId, tenantId },
            });
            if (!row) return res.status(404).json({ error: 'Ürün tedarik kaydı bulunamadı.' });
            await (prisma as any).$transaction(async (tx: any) => {
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
                    } else {
                        await tx.article.update({
                            where: { id: row.articleId },
                            data: { defaultSupplierId: null, lastPurchaseDate: null },
                        });
                    }
                }
            });
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.get(
    '/materials',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const materials = await materialRepo.list(req.user!.tenantId);
            res.status(200).json(materials);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.post(
    '/materials',
    requireAuth,
    requirePermission('inventory.articles.create'),
    async (req, res) => {
        try {
            const name = String(req.body.name || '').trim();
            const serialId = String(req.body.serialId || '').trim();
            const unitCost = Number(req.body.unitCost || 0);
            const stockQuantity = Number(req.body.stockQuantity || 0);
            const minStockLevel = Number(req.body.minStockLevel || 0);
            const criticalStockLevel = Number(req.body.criticalStockLevel || 0);
            const imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : null;

            if (!name) return res.status(400).json({ error: 'Malzeme adi zorunludur.' });
            if (!serialId) return res.status(400).json({ error: 'Seri kodu zorunludur.' });
            if (unitCost < 0 || stockQuantity < 0) return res.status(400).json({ error: 'Fiyat ve stok negatif olamaz.' });
            if (minStockLevel < 0 || criticalStockLevel < 0) return res.status(400).json({ error: 'Minimum ve kritik seviye negatif olamaz.' });

            const material = await materialRepo.createMaterial(req.user!.tenantId, name, serialId, unitCost, stockQuantity, imageUrl, minStockLevel, criticalStockLevel);
            res.status(201).json(material);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.patch(
    '/materials/:materialId',
    requireAuth,
    requirePermission('inventory.articles.update'),
    async (req, res) => {
        try {
            const material = await materialRepo.findById(req.params.materialId as string);
            if (!material || (material as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: 'Malzeme bulunamadi.' });
            }

            const patch: any = {};
            if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
            if (req.body.serialId !== undefined) patch.serialId = String(req.body.serialId).trim();
            if (req.body.unitCost !== undefined) patch.unitCost = Number(req.body.unitCost);
            if (req.body.stockQuantity !== undefined) patch.stockQuantity = Number(req.body.stockQuantity);
            if (req.body.minStockLevel !== undefined) patch.minStockLevel = Number(req.body.minStockLevel);
            if (req.body.criticalStockLevel !== undefined) patch.criticalStockLevel = Number(req.body.criticalStockLevel);
            if (req.body.imageUrl !== undefined) patch.imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : null;
            if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);

            if (patch.name === '') return res.status(400).json({ error: 'Malzeme adi zorunludur.' });
            if (patch.serialId === '') return res.status(400).json({ error: 'Seri kodu zorunludur.' });
            if (patch.unitCost < 0 || patch.stockQuantity < 0) return res.status(400).json({ error: 'Fiyat ve stok negatif olamaz.' });

            const updated = await materialRepo.updateMaterial(material.id, patch);
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

router.delete(
    '/materials/:materialId',
    requireAuth,
    requirePermission('inventory.articles.delete'),
    async (req, res) => {
        try {
            const material = await materialRepo.findById(req.params.materialId as string);
            if (!material || (material as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: 'Malzeme bulunamadi.' });
            }

            await materialRepo.softDeleteMaterial(material.id);
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

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
router.get(
    '/search-items',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const q = String(req.query.q || '').trim();
            if (!q) return res.status(200).json([]);

            const [articles, materials] = await Promise.all([
                (prisma as any).article.findMany({
                    where: {
                        tenantId,
                        deletedAt: null,
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
                prisma.material.findMany({
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

            const productItems = articles.map((a: any) => ({
                kind: 'PRODUCT' as const,
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

            const materialItems = materials.map((m: any) => ({
                kind: 'MATERIAL' as const,
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
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

// ===========================================================================
// YENİ TABLO TABANLI ENVANTER UÇLARI
// Global hareket listesi + toplu ürün / toplu stok hareketi kayıtları.
// "Tanım" (DEFINITION) hareketi: quantity=0 olan IN kaydı — ürün ilk tanımlanırken
// tedarikçiyi hareket geçmişine yazmak için kullanılır (enum migrasyonu gerekmez).
// ===========================================================================

/**
 * Toplu uçlarda satır başına tedarikçi sorgusu atılmasın diye istek ömrü boyunca
 * yaşayan önbellek: aynı ad/kimlik ikinci satırda tekrar sorgulanmaz.
 */
type SupplierCache = Map<string, { id: string; companyName: string } | null>;

/**
 * Toplu uçlarda tedarikçiler satırlar işlenmeden ÖNCE, sabit sayıda sorguyla çözülür:
 * tüm ad/kimlikler beraber okunur ve satır döngüsü tamamen bellekte kalır.
 * Çözülemeyen tedarikçi kimlikleri döner; ilgili satır kendi hatasını alır.
 */
const warmSupplierCache = async (tenantId: string, items: any[], cache: SupplierCache): Promise<Set<string>> => {
    const requestedIds = Array.from(new Set(
        items
            .map((item) => item?.supplierId ? String(item.supplierId) : '')
            .filter(Boolean),
    ));
    const requestedNames = new Map<string, string>();
    items.forEach((item) => {
        if (item?.supplierId) return;
        const companyName = item?.supplierName ? String(item.supplierName).trim() : '';
        if (companyName) requestedNames.set(companyName.toLowerCase(), companyName);
    });

    // Serbest yazılan tedarikçi adlarını tek INSERT ile oluştur. Eş zamanlı başka
    // bir istek aynı adı oluşturursa unique anahtar + skipDuplicates güvenli kalır.
    if (requestedNames.size) {
        await (prisma as any).supplier.createMany({
            data: Array.from(requestedNames.values()).map((companyName) => ({
                id: nanoid(10),
                tenantId,
                companyName,
            })),
            skipDuplicates: true,
        });
    }

    const suppliers: any[] = requestedIds.length || requestedNames.size
        ? await (prisma as any).supplier.findMany({
            where: {
                tenantId,
                OR: [
                    ...(requestedIds.length ? [{ id: { in: requestedIds } }] : []),
                    ...(requestedNames.size ? [{ companyName: { in: Array.from(requestedNames.values()) } }] : []),
                ],
            },
            select: { id: true, companyName: true },
        })
        : [];

    suppliers.forEach((supplier) => {
        const value = { id: supplier.id, companyName: supplier.companyName };
        cache.set(`id:${supplier.id}`, value);
        cache.set(`name:${supplier.companyName.trim().toLowerCase()}`, value);
    });

    const foundIds = new Set(suppliers.map((supplier) => supplier.id));
    const invalidSupplierIds = new Set(requestedIds.filter((id) => !foundIds.has(id)));
    invalidSupplierIds.forEach((id) => cache.set(`id:${id}`, null));
    return invalidSupplierIds;
};

/**
 * Tüm stok farklarını MariaDB'nin çoklu INSERT + ON DUPLICATE KEY deyimiyle
 * tek sorguda uygular. Prisma upsert dizisi ürün sayısı kadar DB turu oluşturur.
 */
const bulkApplyStockBalanceDeltas = async (
    tx: any,
    tenantId: string,
    locationId: string,
    deltaByArticle: Map<string, number>,
): Promise<void> => {
    const deltas = Array.from(deltaByArticle.entries());
    if (!deltas.length) return;

    const valuesSql = deltas.map(() => '(?, ?, ?, ?, ?, 0, NOW(3))').join(', ');
    const parameters = deltas.flatMap(([articleId, delta]) => [
        nanoid(10),
        tenantId,
        articleId,
        locationId,
        delta,
    ]);
    await tx.$executeRawUnsafe(
        `INSERT INTO \`StockBalance\` (` +
        `\`id\`, \`tenantId\`, \`articleId\`, \`locationId\`, \`currentQuantity\`, \`reservedQuantity\`, \`updatedAt\`` +
        `) VALUES ${valuesSql} ON DUPLICATE KEY UPDATE ` +
        `\`currentQuantity\` = \`currentQuantity\` + VALUES(\`currentQuantity\`), \`updatedAt\` = NOW(3)`,
        ...parameters,
    );
};

/** Giriş yapılan ürünlerin son maliyet/tedarikçi alanlarını tek UPDATE ile yeniler. */
const bulkUpdateArticlePurchases = async (
    tx: any,
    tenantId: string,
    preferredByArticle: Map<string, { supplierId: string; purchasePrice: number }>,
): Promise<void> => {
    const updates = Array.from(preferredByArticle.entries());
    if (!updates.length) return;

    const supplierCases = updates.map(() => 'WHEN ? THEN ?').join(' ');
    const costUpdates = updates.filter(([, info]) => info.purchasePrice > 0);
    const assignments = [
        `\`defaultSupplierId\` = CASE \`id\` ${supplierCases} ELSE \`defaultSupplierId\` END`,
        '`lastPurchaseDate` = NOW(3)',
        '`updatedAt` = NOW(3)',
    ];
    const parameters: any[] = updates.flatMap(([articleId, info]) => [articleId, info.supplierId]);
    if (costUpdates.length) {
        assignments.unshift(
            `\`baseCost\` = CASE \`id\` ${costUpdates.map(() => 'WHEN ? THEN ?').join(' ')} ELSE \`baseCost\` END`,
        );
        parameters.unshift(...costUpdates.flatMap(([articleId, info]) => [articleId, info.purchasePrice]));
    }

    const articleIds = updates.map(([articleId]) => articleId);
    parameters.push(tenantId, ...articleIds);
    await tx.$executeRawUnsafe(
        `UPDATE \`Article\` SET ${assignments.join(', ')} ` +
        `WHERE \`tenantId\` = ? AND \`id\` IN (${articleIds.map(() => '?').join(', ')})`,
        ...parameters,
    );
};

/**
 * @swagger
 * /inventory/movements:
 *   get:
 *     tags: [Inventory]
 *     summary: Tüm stok hareketlerini sayfalı listele (genel arama + kolon filtreleri)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Ürün kodu / adı / açıklama üzerinde genel arama
 *       - in: query
 *         name: code
 *         schema: { type: string }
 *       - in: query
 *         name: name
 *         schema: { type: string }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [IN, OUT, DEFINITION, TRANSFER, RETURN, ADJUSTMENT] }
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date }
 */
router.get(
    '/movements',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const page = Math.max(1, Number(req.query.page) || 1);
            const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
            const toStr = (v: unknown) => (v ? String(v).trim() : '');
            const search = toStr(req.query.search);
            const code = toStr(req.query.code);
            const name = toStr(req.query.name);
            const description = toStr(req.query.description);
            const type = toStr(req.query.type).toUpperCase();

            const parseDate = (value: unknown, endOfDay: boolean): Date | null => {
                const raw = toStr(value);
                if (!raw) return null;
                const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}` : raw;
                const date = new Date(iso);
                return Number.isNaN(date.getTime()) ? null : date;
            };
            const dateFrom = parseDate(req.query.dateFrom, false);
            const dateTo = parseDate(req.query.dateTo, true);

            const and: any[] = [];
            if (search) {
                and.push({
                    OR: [
                        { article: { articleCode: { contains: search } } },
                        { article: { name: { contains: search } } },
                        { description: { contains: search } },
                        { supplier: { companyName: { contains: search } } },
                    ],
                });
            }
            if (code) and.push({ article: { articleCode: { contains: code } } });
            if (name) and.push({ article: { name: { contains: name } } });
            if (description) and.push({ description: { contains: description } });
            if (type === 'DEFINITION') and.push({ movementType: 'IN', quantity: 0 });
            else if (type === 'IN') and.push({ movementType: 'IN', quantity: { gt: 0 } });
            else if (type) and.push({ movementType: type });
            if (dateFrom) and.push({ transactionDate: { gte: dateFrom } });
            if (dateTo) and.push({ transactionDate: { lte: dateTo } });

            const where: any = { tenantId, ...(and.length ? { AND: and } : {}) };

            const [total, rows] = await Promise.all([
                (prisma as any).stockMovement.count({ where }),
                (prisma as any).stockMovement.findMany({
                    where,
                    include: {
                        article: { select: { id: true, articleCode: true, name: true, unit: true } },
                        supplier: { select: { id: true, companyName: true } },
                        employee: { select: { firstName: true, lastName: true } },
                    },
                    orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }],
                    skip: (page - 1) * pageSize,
                    take: pageSize,
                }),
            ]);

            res.status(200).json({
                items: rows.map((row: any) => ({
                    id: row.id,
                    transactionDate: row.transactionDate,
                    movementType: row.movementType,
                    // Tanım hareketi: quantity=0 IN kaydı.
                    movementKind: row.movementType === 'IN' && Number(row.quantity) === 0 ? 'DEFINITION' : row.movementType,
                    quantity: row.quantity,
                    unitCost: row.unitCost,
                    totalCost: Number(row.quantity || 0) * Number(row.unitCost || 0),
                    description: row.description,
                    referenceId: row.referenceId,
                    article: row.article,
                    supplier: row.supplier,
                    employee: row.employee,
                })),
                total,
                page,
                pageSize,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/articles/bulk:
 *   post:
 *     tags: [Inventory]
 *     summary: Toplu ürün ekle (tablo/Excel içe aktarımı) — mükerrer ürün kodları satır bazında reddedilir
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     articleCode: { type: string }
 *                     name: { type: string }
 *                     salePrice: { type: number }
 *                     quantity: { type: number, description: "0 girilirse tanım (DEFINITION) hareketi yazılır" }
 *                     purchasePrice: { type: number }
 *                     supplierId: { type: string, nullable: true }
 *                     supplierName: { type: string, nullable: true, description: "Elle girilen tedarikçi adı (yoksa oluşturulur)" }
 *                     unit: { type: string, nullable: true }
 *                     itemType: { type: string, enum: [PRODUCT, MATERIAL], description: "Satır bazında; verilmezse gövdedeki itemType, o da yoksa PRODUCT" }
 *               itemType:
 *                 type: string
 *                 enum: [PRODUCT, MATERIAL]
 *                 description: "Tüm satırlar için varsayılan tür (ürün / malzeme ekranı)"
 */
router.post(
    '/articles/bulk',
    requireAuth,
    requirePermission('inventory.articles.create'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const items: any[] = Array.isArray(req.body.items) ? req.body.items : [];
            if (!items.length) return res.status(400).json({ error: 'Eklenecek satır yok.' });
            if (items.length > 500) return res.status(400).json({ error: 'Tek seferde en fazla 500 satır eklenebilir.' });
            // Ürün ve malzeme aynı tabloyu (Article) paylaşır; ekran türü gövdeden gelir.
            const defaultItemType = req.body.itemType === 'MATERIAL' ? 'MATERIAL' : 'PRODUCT';

            const errors: Array<{ index: number; articleCode: string; error: string }> = [];
            const created: any[] = [];

            // Yük içi mükerrer kod kontrolü
            const seenCodes = new Map<string, number>();
            items.forEach((item, index) => {
                const codeValue = String(item.articleCode || '').trim();
                if (codeValue) {
                    if (seenCodes.has(codeValue)) {
                        errors.push({ index, articleCode: codeValue, error: 'Aynı ürün kodu listede birden fazla kez var.' });
                    } else {
                        seenCodes.set(codeValue, index);
                    }
                }
            });
            const duplicateIndexes = new Set(errors.map((e) => e.index));

            // Birbirinden bağımsız hazırlık sorguları aynı anda çalışır. Uzak DB'de
            // bunları art arda beklemek toplu kayda gereksiz üç ağ turu ekliyordu.
            const supplierCache: SupplierCache = new Map();
            const [existing, defaultLocation, invalidSupplierIds] = await Promise.all([
                (prisma as any).article.findMany({
                    where: { tenantId, articleCode: { in: [...seenCodes.keys()] } },
                    select: { articleCode: true, deletedAt: true, itemType: true },
                }),
                repository.ensureDefaultLocation(tenantId),
                warmSupplierCache(tenantId, items, supplierCache),
            ]);
            // Kod havuzu ürün ve malzeme için ORTAK: aynı kod ikisinde birden
            // olamaz, bu yüzden hata hangi türde durduğunu söyler.
            const existingCodes = new Map<string, { deleted: boolean; itemType: string }>(
                existing.map((row: any) => [row.articleCode, { deleted: Boolean(row.deletedAt), itemType: row.itemType || 'PRODUCT' }]),
            );
            const clashMessage = (info: { deleted: boolean; itemType: string }) => {
                const kind = info.itemType === 'MATERIAL' ? 'malzemede' : 'üründe';
                return info.deleted ? `Bu kod çöpteki bir ${kind} kayıtlı.` : `Bu kod zaten bir ${kind} kayıtlı.`;
            };

            // Satır başına INSERT + transaction yerine: her şey bellekte hazırlanır,
            // sonra tek transaction içinde toplu INSERT'lerle yazılır. Yeni ürünler
            // olduğu için bakiye/parti satırlarının çakışma ihtimali yok.
            const articleCreates: any[] = [];
            const balanceCreates: any[] = [];
            const movementCreates: any[] = [];
            const lotCreates: any[] = [];

            items.forEach((item, index) => {
                if (duplicateIndexes.has(index)) return;
                const articleCode = String(item.articleCode || '').trim();
                const name = String(item.name || '').trim();
                try {
                    if (!articleCode) throw new Error('Ürün kodu zorunludur.');
                    if (!name) throw new Error('Ürün adı zorunludur.');
                    const clash = existingCodes.get(articleCode);
                    if (clash) throw new Error(clashMessage(clash));
                    const quantity = Math.max(0, Number(item.quantity) || 0);
                    const purchasePrice = Math.max(0, Number(item.purchasePrice) || 0);
                    const salePrice = Math.max(0, Number(item.salePrice) || 0);
                    if (item.supplierId && invalidSupplierIds.has(String(item.supplierId))) throw new Error('Tedarikçi bulunamadı.');
                    // Tedarikçiler yukarıda toplu çözüldü; burada yalnızca okunur.
                    const supplier = supplierCache.get(item.supplierId
                        ? `id:${String(item.supplierId)}`
                        : `name:${item.supplierName ? String(item.supplierName).trim().toLowerCase() : ''}`) || null;

                    const articleId = nanoid(10);
                    const movementId = nanoid(12);

                    articleCreates.push({
                        id: articleId,
                        tenantId,
                        articleCode,
                        name,
                        unit: item.unit ? String(item.unit).trim() : 'Adet',
                        baseCost: purchasePrice,
                        salePrice,
                        defaultSupplierId: supplier?.id || null,
                        itemType: item.itemType === 'MATERIAL' || item.itemType === 'PRODUCT' ? item.itemType : defaultItemType,
                        status: 'ACTIVE',
                        isActive: true,
                        ...(quantity > 0 ? { lastPurchaseDate: new Date() } : {}),
                    });

                    if (quantity > 0) {
                        balanceCreates.push({
                            id: nanoid(10),
                            tenantId,
                            articleId,
                            locationId: defaultLocation.id,
                            currentQuantity: quantity,
                        });
                    }

                    // Tanım (quantity=0) hareketi de yazılır ki tedarikçi geçmişe işlensin.
                    movementCreates.push({
                        id: movementId,
                        tenantId,
                        articleId,
                        movementType: 'IN',
                        quantity,
                        unitCost: quantity > 0 && purchasePrice > 0 ? purchasePrice : null,
                        sourceLocationId: null,
                        destinationLocationId: quantity > 0 ? defaultLocation.id : null,
                        employeeId,
                        supplierId: supplier?.id || null,
                        description: item.description
                            ? String(item.description).trim()
                            : (quantity > 0 ? 'Toplu ürün girişi' : 'Ürün tanımı'),
                    });

                    if (supplier) {
                        // Yeni ürünün başka partisi olmadığı için "önceki tercihleri
                        // kapat" adımına gerek yok; ürünün varsayılan tedarikçisi ve
                        // maliyeti zaten create içinde yazılıyor.
                        lotCreates.push({
                            id: nanoid(10),
                            tenantId,
                            articleId,
                            supplierId: supplier.id,
                            locationId: defaultLocation.id,
                            purchasePrice,
                            quantity,
                            remainingQuantity: quantity,
                            lastPurchaseDate: new Date(),
                            stockMovementId: movementId,
                            isPreferred: true,
                        });
                    }

                    existingCodes.set(articleCode, { deleted: false, itemType: item.itemType === 'MATERIAL' || item.itemType === 'PRODUCT' ? item.itemType : defaultItemType });
                    created.push({ id: articleId, articleCode, name });
                } catch (error: any) {
                    errors.push({ index, articleCode, error: error.message });
                }
            });

            if (articleCreates.length) {
                const writes: any[] = [(prisma as any).article.createMany({ data: articleCreates })];
                if (balanceCreates.length) writes.push((prisma as any).stockBalance.createMany({ data: balanceCreates }));
                if (movementCreates.length) writes.push((prisma as any).stockMovement.createMany({ data: movementCreates }));
                if (lotCreates.length) writes.push((prisma as any).articleSupplier.createMany({ data: lotCreates }));
                await (prisma as any).$transaction(writes);
            }
            errors.sort((a, b) => a.index - b.index);

            res.status(errors.length && !created.length ? 400 : 201).json({
                createdCount: created.length,
                created,
                errors,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/movements/bulk:
 *   post:
 *     tags: [Inventory]
 *     summary: Toplu stok hareketi kaydet (giriş/çıkış) — satır bazında hata döner
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     articleId: { type: string, nullable: true }
 *                     articleCode: { type: string, nullable: true }
 *                     movementType: { type: string, enum: [IN, OUT] }
 *                     quantity: { type: number }
 *                     unitCost: { type: number, nullable: true }
 *                     supplierId: { type: string, nullable: true }
 *                     supplierName: { type: string, nullable: true }
 *                     description: { type: string, nullable: true }
 */
router.post(
    '/movements/bulk',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const items: any[] = Array.isArray(req.body.items) ? req.body.items : [];
            if (!items.length) return res.status(400).json({ error: 'Kaydedilecek satır yok.' });
            if (items.length > 500) return res.status(400).json({ error: 'Tek seferde en fazla 500 satır kaydedilebilir.' });

            const errors: Array<{ index: number; articleCode: string; error: string }> = [];
            const movements: any[] = [];

            // Satırların ürünleri tek sorguda okunur. Ürün, depo ve tedarikçi
            // hazırlıkları birbirinden bağımsız olduğu için paralel başlatılır.
            const requestedIds = items.map((item) => (item.articleId ? String(item.articleId) : null)).filter(Boolean) as string[];
            const requestedCodes = items.map((item) => String(item.articleCode || '').trim()).filter(Boolean);
            const supplierCache: SupplierCache = new Map();
            const [defaultLocation, invalidSupplierIds, articleRows] = await Promise.all([
                repository.ensureDefaultLocation(tenantId),
                warmSupplierCache(tenantId, items, supplierCache),
                requestedIds.length || requestedCodes.length
                    ? (prisma as any).article.findMany({
                        where: {
                            tenantId,
                            deletedAt: null,
                            OR: [
                                ...(requestedIds.length ? [{ id: { in: requestedIds } }] : []),
                                ...(requestedCodes.length ? [{ articleCode: { in: requestedCodes } }] : []),
                            ],
                        },
                        select: { id: true, articleCode: true, criticalStockLevel: true },
                    })
                    : Promise.resolve([]),
            ]) as [any, Set<string>, any[]];
            const articleById = new Map<string, any>(articleRows.map((row: any) => [row.id, row]));
            const articleByCode = new Map<string, any>(articleRows.map((row: any) => [row.articleCode, row]));

            // Bakiyeler tek sorguda okunur: çıkış kontrolü ve yeni miktarlar
            // bellekte hesaplanır, satır başına SELECT atılmaz.
            const involvedIds = Array.from(new Set(articleRows.map((row: any) => row.id)));
            const balanceRows: any[] = involvedIds.length
                ? await (prisma as any).stockBalance.findMany({
                    where: { tenantId, locationId: defaultLocation.id, articleId: { in: involvedIds } },
                    select: { articleId: true, currentQuantity: true },
                })
                : [];
            const balanceByArticle = new Map<string, number>(balanceRows.map((row: any) => [row.articleId, row.currentQuantity || 0]));

            const movementCreates: any[] = [];
            const deltaByArticle = new Map<string, number>();
            const lotCreates: any[] = [];
            // Ürün başına son parti tercih edilen olur (aynı ürün birden çok satırdaysa).
            const preferredByArticle = new Map<string, { supplierId: string; purchasePrice: number }>();
            const outArticleIds = new Set<string>();

            items.forEach((item, index) => {
                const movementType = String(item.movementType || '').toUpperCase();
                let articleCode = String(item.articleCode || '').trim();
                try {
                    if (movementType !== 'IN' && movementType !== 'OUT') throw new Error('Hareket tipi IN veya OUT olmalıdır.');
                    const quantity = Number(item.quantity);
                    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Miktar 0'dan büyük olmalıdır.");

                    const article = item.articleId ? articleById.get(String(item.articleId)) : articleByCode.get(articleCode);
                    if (!article) throw new Error(`Ürün bulunamadı: ${articleCode || item.articleId || ''}`);
                    articleCode = article.articleCode;

                    const pending = deltaByArticle.get(article.id) ?? 0;
                    const available = (balanceByArticle.get(article.id) ?? 0) + pending;
                    if (movementType === 'OUT' && available < quantity) {
                        throw new Error(`Kaynak lokasyonda yeterli stok yok. Mevcut: ${available}, İstenen: ${quantity}`);
                    }

                    const unitCost = item.unitCost === null || item.unitCost === undefined || item.unitCost === ''
                        ? null
                        : Number(item.unitCost);
                    if (item.supplierId && invalidSupplierIds.has(String(item.supplierId))) throw new Error('Tedarikçi bulunamadı.');
                    // Tedarikçiler yukarıda çözüldü; burada yalnızca okunur.
                    const supplier = movementType === 'IN'
                        ? (supplierCache.get(item.supplierId
                            ? `id:${String(item.supplierId)}`
                            : `name:${item.supplierName ? String(item.supplierName).trim().toLowerCase() : ''}`) || null)
                        : null;

                    const movementId = nanoid(12);
                    movementCreates.push({
                        id: movementId,
                        tenantId,
                        articleId: article.id,
                        movementType,
                        quantity,
                        // Birim maliyet yalnızca girişlerde anlamlıdır (ağırlıklı ortalama).
                        unitCost: movementType === 'IN' && unitCost !== null && unitCost > 0 ? unitCost : null,
                        sourceLocationId: movementType === 'OUT' ? defaultLocation.id : null,
                        destinationLocationId: movementType === 'OUT' ? null : defaultLocation.id,
                        employeeId,
                        supplierId: supplier?.id || null,
                        referenceId: item.referenceId ? String(item.referenceId) : null,
                        description: item.description ? String(item.description).trim() : null,
                    });

                    deltaByArticle.set(article.id, pending + (movementType === 'OUT' ? -quantity : quantity));
                    if (movementType === 'OUT') outArticleIds.add(article.id);

                    if (supplier) {
                        const purchasePrice = unitCost && unitCost > 0 ? unitCost : 0;
                        lotCreates.push({
                            id: nanoid(10),
                            tenantId,
                            articleId: article.id,
                            supplierId: supplier.id,
                            locationId: defaultLocation.id,
                            purchasePrice,
                            quantity,
                            remainingQuantity: quantity,
                            lastPurchaseDate: new Date(),
                            stockMovementId: movementId,
                            isPreferred: true,
                        });
                        preferredByArticle.set(article.id, { supplierId: supplier.id, purchasePrice });
                    }

                    movements.push({ id: movementId, articleId: article.id, articleCode: article.articleCode, movementType, quantity });
                } catch (error: any) {
                    errors.push({ index, articleCode, error: error.message });
                }
            });

            // Tek transaction, sabit sayıda toplu ifade: bakiye farklarının tamamı
            // tek MariaDB upsert'ine katlanır; ürün sayısı sorgu sayısını artırmaz.
            if (movementCreates.length) {
                await (prisma as any).$transaction(async (tx: any) => {
                    await tx.stockMovement.createMany({ data: movementCreates });
                    await bulkApplyStockBalanceDeltas(tx, tenantId, defaultLocation.id, deltaByArticle);

                    if (!lotCreates.length) return;
                    // Önceki partilerin tercih işareti kapatılır, sonra yenileri yazılır.
                    await tx.articleSupplier.updateMany({
                        where: { tenantId, articleId: { in: Array.from(preferredByArticle.keys()) } },
                        data: { isPreferred: false },
                    });
                    await tx.articleSupplier.createMany({ data: lotCreates });
                    await bulkUpdateArticlePurchases(tx, tenantId, preferredByArticle);
                });
            }

            // Kritik stok önerileri: satır başına değil, çıkış yapılan ürünler için
            // toplu olarak (üç sorgu, satır sayısından bağımsız).
            if (outArticleIds.size) {
                const criticalCandidates = articleRows.filter((row: any) => outArticleIds.has(row.id) && (row.criticalStockLevel || 0) > 0);
                if (criticalCandidates.length) {
                    const candidateIds = criticalCandidates.map((row: any) => row.id);
                    const totals = await (prisma as any).stockBalance.groupBy({
                        by: ['articleId'],
                        where: { tenantId, articleId: { in: candidateIds } },
                        _sum: { currentQuantity: true },
                    });
                    const totalByArticle = new Map<string, number>(totals.map((row: any) => [row.articleId, row._sum.currentQuantity || 0]));
                    const belowCritical = criticalCandidates.filter((row: any) => (totalByArticle.get(row.id) ?? 0) <= (row.criticalStockLevel || 0));
                    if (belowCritical.length) {
                        const pendingRows = await (prisma as any).purchaseProposal.findMany({
                            where: { tenantId, status: 'PENDING', articleId: { in: belowCritical.map((row: any) => row.id) } },
                            select: { articleId: true },
                        });
                        const hasPending = new Set(pendingRows.map((row: any) => row.articleId));
                        const proposals = belowCritical
                            .filter((row: any) => !hasPending.has(row.id))
                            .map((row: any) => ({
                                id: nanoid(10),
                                tenantId,
                                articleId: row.id,
                                proposedQuantity: Math.max((row.minStockLevel || 0) - (totalByArticle.get(row.id) ?? 0), 1),
                                status: 'PENDING',
                            }));
                        if (proposals.length) await (prisma as any).purchaseProposal.createMany({ data: proposals });
                    }
                }
            }
            errors.sort((a, b) => a.index - b.index);

            res.status(errors.length && !movements.length ? 400 : 201).json({
                processedCount: movements.length,
                movements,
                errors,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
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

// ===========================================================================
// TEDARİK TALEPLERİ (Supply Requests)
// Minimum/kritik stoğa düşen ürün ve malzemeler, tedarikçiye direkt talep,
// bekleyen/alınan talepler. Tüm uçlar YALNIZCA ilgili kaydı çeker (aşırı veri yok).
// ===========================================================================

// Ortak: bir kalemi (ürün/malzeme) tek satırlık düşük stok objesine indirger.
const mapLowStock = (kind: 'PRODUCT' | 'MATERIAL', id: string, code: string, name: string, unit: string, qty: number, min: number, critical: number) => {
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
router.get(
    '/supply/low-stock',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            // Yalnızca bir eşik tanımlı olan kalemleri çek — tüm katalog değil.
            const [articles, materials] = await Promise.all([
                (prisma as any).article.findMany({
                    where: {
                        tenantId,
                        deletedAt: null,
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
                prisma.material.findMany({
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
                ...articles.map((a: any) => {
                    const qty = (a.stockBalances || []).reduce((s: number, b: any) => s + (b.currentQuantity || 0), 0);
                    return mapLowStock('PRODUCT', a.id, a.articleCode, a.name, a.unit, qty, a.minStockLevel || 0, a.criticalStockLevel || 0);
                }),
                ...materials.map((m: any) =>
                    mapLowStock('MATERIAL', m.id, m.serialId, m.name, 'adet', m.stockQuantity || 0, m.minStockLevel || 0, m.criticalStockLevel || 0),
                ),
            ];

            // Kritik: kritik eşiğin altında. Minimum: min eşiğin altında AMA henüz kritik değil.
            const critical = rows.filter((r) => r.isCritical);
            const minimum = rows.filter((r) => r.isBelowMin && !r.isCritical);
            res.status(200).json({ minimum, critical });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/supply/item/{kind}/{id}/suppliers:
 *   get:
 *     tags: [Inventory]
 *     summary: Bir kalemin daha önce alım yaptığı tedarikçileri + son alım bilgisini getir
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/supply/item/:kind/:id/suppliers',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const kind = String(req.params.kind || '').toUpperCase();
            const id = String(req.params.id);

            if (kind === 'PRODUCT') {
                const article = await (prisma as any).article.findFirst({
                    where: { id, tenantId, deletedAt: null },
                    select: { id: true, articleCode: true, name: true, unit: true },
                });
                if (!article) return res.status(404).json({ error: 'Ürün bulunamadı.' });

                // Tedarikçileri İKİ kaynaktan topla: (1) ürün-tedarikçi alım partileri
                // (ArticleSupplier) ve (2) tedarikçisi olan stok GİRİŞ hareketleri
                // (StockMovement.supplierId). Böylece stok kaydı hangi yoldan girilmiş
                // olursa olsun ilgili tedarikçi(ler) talep panelinde görünür.
                const [links, movements] = await Promise.all([
                    (prisma as any).articleSupplier.findMany({
                        where: { tenantId, articleId: id },
                        include: { supplier: { select: { id: true, companyName: true, email: true, phone: true } } },
                        orderBy: [{ lastPurchaseDate: 'desc' }, { updatedAt: 'desc' }],
                    }),
                    (prisma as any).stockMovement.findMany({
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
                const bySupplier = new Map<string, any>();
                for (const l of links) {
                    if (!l.supplier) continue;
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
                    } else {
                        bySupplier.get(key).purchaseCount += 1;
                    }
                }
                for (const m of movements) {
                    if (!m.supplier) continue;
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
                    } else {
                        bySupplier.get(key).purchaseCount += 1;
                    }
                }

                let suppliers = Array.from(bySupplier.values());
                // Geçmiş alım yoksa, e-postası tanımlı aktif tedarikçilere düş — panel
                // hiçbir zaman boş kalmasın, kullanıcı yine de talep açabilsin.
                if (suppliers.length === 0) {
                    const all = await (prisma as any).supplier.findMany({
                        where: { tenantId, isActive: true, NOT: { email: null } },
                        select: { id: true, companyName: true, email: true, phone: true },
                        orderBy: { companyName: 'asc' },
                        take: 50,
                    });
                    suppliers = all.map((s: any) => ({
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
            const material = await prisma.material.findFirst({
                where: { id, tenantId },
                select: { id: true, serialId: true, name: true },
            });
            if (!material) return res.status(404).json({ error: 'Malzeme bulunamadı.' });

            const suppliers = await (prisma as any).supplier.findMany({
                where: { tenantId, isActive: true, NOT: { email: null } },
                select: { id: true, companyName: true, email: true, phone: true },
                orderBy: { companyName: 'asc' },
                take: 50,
            });

            return res.status(200).json({
                item: { kind: 'MATERIAL', id: material.id, code: material.serialId, name: material.name, unit: 'adet' },
                suppliers: suppliers.map((s: any) => ({
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

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
router.get(
    '/supply/requests',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const status = req.query.status ? String(req.query.status).toUpperCase() : 'PENDING';
            const rows = await (prisma as any).supplyRequest.findMany({
                where: { tenantId, status },
                orderBy: { createdAt: 'desc' },
                take: 200,
            });
            res.status(200).json(rows);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/supply/requests:
 *   post:
 *     tags: [Inventory]
 *     summary: Tedarik talebi oluştur (miktarı kaydeder, opsiyonel olarak tedarikçiye e-posta atar)
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/supply/requests',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const b = req.body || {};
            const itemType = b.itemType === 'MATERIAL' ? 'MATERIAL' : 'PRODUCT';
            const itemName = String(b.itemName || '').trim();
            const requestedQuantity = Number(b.requestedQuantity || 0);
            const supplierEmail = b.supplierEmail ? String(b.supplierEmail).trim() : null;
            const sendEmail = Boolean(b.sendEmail);

            if (!itemName) return res.status(400).json({ error: 'Kalem adı zorunludur.' });
            if (!(requestedQuantity > 0)) return res.status(400).json({ error: 'Talep miktarı 0’dan büyük olmalıdır.' });
            if (sendEmail && !supplierEmail) return res.status(400).json({ error: 'E-posta göndermek için tedarikçi e-postası gereklidir.' });

            const subject = b.emailSubject ? String(b.emailSubject) : `Tedarik Talebi: ${itemName}`;
            const bodyText = b.emailBody ? String(b.emailBody) : '';

            let emailSent = false;
            if (sendEmail && supplierEmail) {
                const settings = await prisma.mailSetting.findUnique({ where: { tenantId } });
                const result = await smtp.send(settings || {}, {
                    fromEmail: settings?.fromEmail || req.user!.email,
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

            const created = await (prisma as any).supplyRequest.create({
                data: {
                    id: nanoid(12),
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
                    createdByEmpId: req.user!.id,
                },
            });

            res.status(201).json({ ...created, emailSent, emailPreview: sendEmail && !emailSent });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/supply/requests/{id}/receive:
 *   patch:
 *     tags: [Inventory]
 *     summary: Bekleyen tedarik talebini "alındı" olarak işaretle
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/supply/requests/:id/receive',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await (prisma as any).supplyRequest.findFirst({ where: { id: req.params.id, tenantId } });
            if (!existing) return res.status(404).json({ error: 'Tedarik talebi bulunamadı.' });
            const updated = await (prisma as any).supplyRequest.update({
                where: { id: existing.id },
                data: { status: 'RECEIVED', receivedAt: new Date(), receivedByEmpId: req.user!.id },
            });
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/supply/requests/{id}:
 *   delete:
 *     tags: [Inventory]
 *     summary: Tedarik talebini sil (iptal)
 *     security:
 *       - bearerAuth: []
 */
router.delete(
    '/supply/requests/:id',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await (prisma as any).supplyRequest.findFirst({ where: { id: req.params.id, tenantId } });
            if (!existing) return res.status(404).json({ error: 'Tedarik talebi bulunamadı.' });
            await (prisma as any).supplyRequest.delete({ where: { id: existing.id } });
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

// ── Satın Alma Siparişleri (Purchase Orders) ─────────────────────────────────
// Tek sipariş = tek tedarikçi; ürün satırları JSON snapshot olarak `items`
// kolonunda saklanır (SupplyRequest emsali — listeleme join'siz). Mail
// göndermek durumu DEĞİŞTİRMEZ; TO_BE_STOCKED popup'tan elle işaretlenir,
// stoğa ekleme mark-stocked ile COMPLETED yapar. Mail gönderildikten sonra
// ürün/tedarikçi değişikliği UPDATED + revision+1 üretir; sipariş ADI
// değişikliği durumu asla etkilemez (kullanıcı kararı, 2026-07-29).

const PO_STATUSES = new Set(['PENDING', 'TO_BE_STOCKED', 'COMPLETED', 'UPDATED']);
const PO_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// CR/LF temizliği: SMTP başlığına yerleşen değer ek başlık enjekte edemesin.
const poStripHeader = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
const poEscapeHtml = (value: string) =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/** Yüzde alanı: 0–100 aralığına kırpılır (geçersiz değer 0 sayılır). */
const poPercent = (value: unknown): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.round(Math.min(100, Math.max(0, parsed)) * 100) / 100;
};

// Satır doğrulama + toplamların sunucu tarafında hesaplanması (frontend'e
// güvenilmez). Miktar verilmezse 1 varsayılır — sipariş stok yönetimi değildir.
//
// İNDİRİMLER: discount / discount2 / discount3 SIRAYLA uygulanır (teklifin
// directDiscount + extraDiscount deseniyle birebir: 100 → −20% → 80 → −10% → 72),
// net birim fiyatın üzerine iner ve `lineTotal` indirimli NET tutardır.
// KDV satır düzeyindedir (`vatRate`); `lineVat` net tutar üzerinden hesaplanır.
const normalizePurchaseOrderItems = (raw: unknown) => {
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('Sipariş için en az bir ürün satırı gereklidir.');
    if (raw.length > 500) throw new Error('Bir siparişe en fazla 500 satır eklenebilir.');
    const items = raw.map((r: any, index: number) => {
        const name = String(r?.name || '').trim();
        if (!name) throw new Error(`Satır ${index + 1}: ürün adı zorunludur.`);
        const rawQty = Number(r?.quantity);
        const quantity = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
        // Tek fiyat verildiyse ikisi de o kabul edilir (brüt ≥ net varsayımı bozulmasın).
        const grossPrice = Number(r?.grossPrice) || Number(r?.netPrice) || 0;
        const netPrice = Number(r?.netPrice) || Number(r?.grossPrice) || 0;
        const discount = poPercent(r?.discount);
        const discount2 = poPercent(r?.discount2);
        const discount3 = poPercent(r?.discount3);
        const vatRate = poPercent(r?.vatRate);
        // Üç indirim sırayla çarpılır; sonuç satırın net tutarıdır.
        const discountFactor = (1 - discount / 100) * (1 - discount2 / 100) * (1 - discount3 / 100);
        const lineTotal = Math.round(quantity * netPrice * discountFactor * 100) / 100;
        return {
            itemType: r?.itemType === 'MATERIAL' ? 'MATERIAL' : 'PRODUCT',
            articleId: r?.articleId ? String(r.articleId) : null,
            code: r?.code ? String(r.code).trim() : null,
            serialNumber: r?.serialNumber ? String(r.serialNumber).trim() : null,
            name,
            quantity,
            unit: r?.unit ? String(r.unit) : null,
            grossPrice,
            netPrice,
            discount,
            discount2,
            discount3,
            vatRate,
            lineTotal,
            lineVat: Math.round(lineTotal * (vatRate / 100) * 100) / 100,
        };
    });
    const totalNet = Math.round(items.reduce((sum, it) => sum + it.lineTotal, 0) * 100) / 100;
    const totalGross = Math.round(items.reduce((sum, it) => sum + it.quantity * it.grossPrice, 0) * 100) / 100;
    const totalVat = Math.round(items.reduce((sum, it) => sum + it.lineVat, 0) * 100) / 100;
    return { items, totalNet, totalGross, totalVat };
};

// DB satırı → API yanıtı: items JSON'u parse edilir, itemCount eklenir.
const parsePurchaseOrderRow = (row: any) => {
    let items: any[] = [];
    try { items = JSON.parse(row.items || '[]'); } catch { items = []; }
    return { ...row, items, itemCount: items.length };
};

// BE-{yıl}-{sıra} ("Auftrag") — tenant başına max-scan (MaintenanceRepository
// emsali). Yalnızca ÖNERİDİR: kullanıcı sipariş kodunu elle değiştirebilir
// (create ve patch gövdesinde `referenceNumber`), benzersizliği DB indeksi korur.
const PO_REFERENCE_PREFIX = 'BE-';
const nextPurchaseOrderReference = async (tenantId: string): Promise<string> => {
    const prefix = `${PO_REFERENCE_PREFIX}${new Date().getFullYear()}-`;
    const rows = await (prisma as any).purchaseOrder.findMany({
        where: { tenantId, referenceNumber: { startsWith: prefix } },
        select: { referenceNumber: true },
    });
    const max = rows.reduce((value: number, row: any) => {
        const m = /^BE-\d{4}-(\d+)$/.exec(row.referenceNumber || '');
        return m ? Math.max(value, Number(m[1]) || 0) : value;
    }, 0);
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
};

/** Elle girilen sipariş kodu: boş olamaz, 60 karakteri aşamaz. */
const normalizeReferenceNumber = (value: unknown): string => {
    const reference = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!reference) throw new Error('Sipariş kodu boş olamaz.');
    if (reference.length > 60) throw new Error('Sipariş kodu 60 karakteri aşamaz.');
    return reference;
};

// supplierId doğrulanır; yalnızca ad verildiyse tedarikçi upsert edilir
// (movements/bulk davranışıyla tutarlı). E-posta snapshot'ı kayıttan tamamlanır.
const resolvePurchaseOrderSupplier = async (
    tenantId: string,
    input: { supplierId?: unknown; supplierName?: unknown; supplierEmail?: unknown },
) => {
    const supplierName = String(input.supplierName || '').trim();
    let supplierId = input.supplierId ? String(input.supplierId) : null;
    let supplierEmail = input.supplierEmail ? String(input.supplierEmail).trim() : null;
    if (supplierId) {
        const supplier = await (prisma as any).supplier.findFirst({ where: { id: supplierId, tenantId } });
        if (!supplier) throw new Error('Tedarikçi bulunamadı.');
        if (!supplierEmail && supplier.email) supplierEmail = supplier.email;
        // Adres bileşenleri PDF alıcı bloğu için 2 satıra indirgenip snapshot'lanır
        // (tedarikçi sonradan değişse de gönderilmiş sipariş kendi anındaki adresi
        // taşır).
        return {
            supplierId,
            supplierName: supplierName || supplier.companyName,
            supplierEmail,
            supplierAddress: supplierAddressSnapshot(supplier),
        };
    }
    if (!supplierName) throw new Error('Tedarikçi adı zorunludur.');
    const supplier = await (prisma as any).supplier.upsert({
        where: { tenantId_companyName: { tenantId, companyName: supplierName } },
        update: {},
        create: { id: nanoid(10), tenantId, companyName: supplierName, email: supplierEmail },
    });
    if (!supplierEmail && supplier.email) supplierEmail = supplier.email;
    return {
        supplierId: supplier.id as string,
        supplierName,
        supplierEmail,
        supplierAddress: supplierAddressSnapshot(supplier),
    };
};

/**
 * @swagger
 * /inventory/purchase-orders:
 *   get:
 *     tags: [Inventory]
 *     summary: Satın alma siparişlerini listele (sayfalı; durum/tedarikçi/tarih filtreli)
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/purchase-orders',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const page = Math.max(1, Number(req.query.page) || 1);
            const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

            const where: any = { tenantId };
            const status = req.query.status ? String(req.query.status).toUpperCase() : '';
            if (status && PO_STATUSES.has(status)) where.status = status;
            if (req.query.supplierId) where.supplierId = String(req.query.supplierId);
            const search = String(req.query.search || '').trim();
            if (search) {
                where.OR = [
                    { referenceNumber: { contains: search } },
                    { quoteNumber: { contains: search } },
                    { projectName: { contains: search } },
                    { supplierName: { contains: search } },
                ];
            }
            const reference = String(req.query.reference || '').trim();
            if (reference) where.referenceNumber = { contains: reference };
            const quote = String(req.query.quote || '').trim();
            if (quote) where.quoteNumber = { contains: quote };
            const project = String(req.query.project || '').trim();
            if (project) where.projectName = { contains: project };
            const supplier = String(req.query.supplier || '').trim();
            if (supplier) where.supplierName = { contains: supplier };
            const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : null;
            const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : null;
            if ((dateFrom && !isNaN(dateFrom.getTime())) || (dateTo && !isNaN(dateTo.getTime()))) {
                where.createdAt = {};
                if (dateFrom && !isNaN(dateFrom.getTime())) where.createdAt.gte = dateFrom;
                if (dateTo && !isNaN(dateTo.getTime())) {
                    const end = new Date(dateTo);
                    end.setHours(23, 59, 59, 999);
                    where.createdAt.lte = end;
                }
            }

            const [total, rows] = await Promise.all([
                (prisma as any).purchaseOrder.count({ where }),
                (prisma as any).purchaseOrder.findMany({
                    where,
                    orderBy: { createdAt: 'desc' },
                    skip: (page - 1) * pageSize,
                    take: pageSize,
                }),
            ]);
            res.status(200).json({ items: rows.map(parsePurchaseOrderRow), total, page, pageSize });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/purchase-orders/{id}:
 *   get:
 *     tags: [Inventory]
 *     summary: Satın alma siparişi detayı
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/purchase-orders/:id',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const row = await (prisma as any).purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
            if (!row) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
            res.status(200).json(parsePurchaseOrderRow(row));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/purchase-orders:
 *   post:
 *     tags: [Inventory]
 *     summary: Satın alma siparişi oluştur (çoklu tedarikçi seçiminde tedarikçi başına bir sipariş)
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/purchase-orders',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const rawOrders = Array.isArray(req.body?.orders) ? req.body.orders : [req.body || {}];
            if (!rawOrders.length) return res.status(400).json({ error: 'En az bir sipariş gereklidir.' });
            if (rawOrders.length > 20) return res.status(400).json({ error: 'Tek istekte en fazla 20 sipariş oluşturulabilir.' });

            // İki faz: önce TÜM siparişler doğrulanır (kısmî yazma olmasın), sonra yazılır.
            const prepared = [] as Array<{
                referenceNumber: string | null;
                quoteNumber: string | null;
                orderedByName: string | null;
                projectName: string | null;
                currency: string;
                supplierId: string | null;
                supplierName: string;
                supplierEmail: string | null;
                supplierAddress: string | null;
                items: any[];
                totalNet: number;
                totalGross: number;
                totalVat: number;
            }>;
            for (const raw of rawOrders) {
                const { items, totalNet, totalGross, totalVat } = normalizePurchaseOrderItems(raw?.items);
                const supplier = await resolvePurchaseOrderSupplier(tenantId, raw || {});
                prepared.push({
                    // Boş bırakılırsa sunucu BE-{yıl}-{sıra} üretir.
                    referenceNumber: raw?.referenceNumber ? normalizeReferenceNumber(raw.referenceNumber) : null,
                    quoteNumber: raw?.quoteNumber ? String(raw.quoteNumber).trim() || null : null,
                    orderedByName: raw?.orderedByName ? String(raw.orderedByName).trim() || null : null,
                    projectName: raw?.projectName ? String(raw.projectName).trim() || null : null,
                    currency: raw?.currency ? String(raw.currency) : 'CHF',
                    ...supplier,
                    items,
                    totalNet,
                    totalGross,
                    totalVat,
                });
            }

            const created: any[] = [];
            for (const order of prepared) {
                let row: any = null;
                // Numara benzersiz indeksle korunur. Kullanıcı kod verdiyse çakışma
                // hatadır; otomatik numarada yeniden taranıp denenir.
                for (let attempt = 0; attempt < 3 && !row; attempt++) {
                    const referenceNumber = order.referenceNumber ?? await nextPurchaseOrderReference(tenantId);
                    try {
                        row = await (prisma as any).purchaseOrder.create({
                            data: {
                                id: nanoid(12),
                                tenantId,
                                referenceNumber,
                                quoteNumber: order.quoteNumber,
                                orderedByName: order.orderedByName,
                                projectName: order.projectName,
                                status: 'PENDING',
                                supplierId: order.supplierId,
                                supplierName: order.supplierName,
                                supplierEmail: order.supplierEmail,
                                supplierAddress: order.supplierAddress,
                                items: JSON.stringify(order.items),
                                currency: order.currency,
                                totalNet: order.totalNet,
                                totalGross: order.totalGross,
                                totalVat: order.totalVat,
                                createdByEmpId: req.user!.id,
                            },
                        });
                    } catch (err: any) {
                        if (err?.code !== 'P2002') throw err;
                        if (order.referenceNumber) {
                            return res.status(400).json({ error: `"${order.referenceNumber}" sipariş kodu zaten kullanılıyor.` });
                        }
                    }
                }
                if (!row) throw new Error('Sipariş numarası üretilemedi, lütfen tekrar deneyin.');
                created.push(parsePurchaseOrderRow(row));
            }
            res.status(201).json({ createdCount: created.length, orders: created });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/purchase-orders/{id}:
 *   patch:
 *     tags: [Inventory]
 *     summary: Siparişi düzenle (ad değişikliği durumu etkilemez; mail sonrası içerik değişikliği UPDATED yapar)
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/purchase-orders/:id',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await (prisma as any).purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
            if (!existing) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

            const b = req.body || {};
            const data: any = {};
            let contentChanged = false;

            // Üstbilgi alanları (kod, teklif no, Auftrag, proje) durumu ETKİLEMEZ —
            // tedarikçiye giden ürün listesi değişmediği sürece "güncellendi" yok.
            if (b.referenceNumber !== undefined) {
                data.referenceNumber = normalizeReferenceNumber(b.referenceNumber);
            }
            if (b.quoteNumber !== undefined) {
                data.quoteNumber = b.quoteNumber === null ? null : String(b.quoteNumber).trim() || null;
            }
            if (b.orderedByName !== undefined) {
                data.orderedByName = b.orderedByName === null ? null : String(b.orderedByName).trim() || null;
            }
            if (b.projectName !== undefined) {
                data.projectName = b.projectName === null ? null : String(b.projectName).trim() || null;
            }
            const wantsContentChange = b.items !== undefined || b.currency !== undefined
                || b.supplierId !== undefined || b.supplierName !== undefined || b.supplierEmail !== undefined;
            if (wantsContentChange && existing.status === 'COMPLETED') {
                return res.status(400).json({ error: 'Tamamlanmış (stoğa eklenmiş) sipariş düzenlenemez.' });
            }
            if (b.items !== undefined) {
                const { items, totalNet, totalGross, totalVat } = normalizePurchaseOrderItems(b.items);
                data.items = JSON.stringify(items);
                data.totalNet = totalNet;
                data.totalGross = totalGross;
                data.totalVat = totalVat;
                contentChanged = true;
            }
            if (b.currency !== undefined) {
                data.currency = String(b.currency || 'CHF');
                contentChanged = true;
            }
            if (b.supplierId !== undefined || b.supplierName !== undefined || b.supplierEmail !== undefined) {
                const supplier = await resolvePurchaseOrderSupplier(tenantId, {
                    supplierId: b.supplierId !== undefined ? b.supplierId : existing.supplierId,
                    supplierName: b.supplierName !== undefined ? b.supplierName : existing.supplierName,
                    supplierEmail: b.supplierEmail !== undefined ? b.supplierEmail : existing.supplierEmail,
                });
                data.supplierId = supplier.supplierId;
                data.supplierName = supplier.supplierName;
                data.supplierEmail = supplier.supplierEmail;
                data.supplierAddress = supplier.supplierAddress;
                contentChanged = true;
            }
            if (!Object.keys(data).length) return res.status(400).json({ error: 'Güncellenecek alan yok.' });

            // "Güncellendi" yalnızca mail atılmış (tedarikçinin elindeki PDF eskimiş)
            // siparişlerde anlamlıdır; ad değişikliği bu bloğa hiç girmez.
            if (contentChanged && existing.emailSentAt) {
                data.status = 'UPDATED';
                data.revision = (existing.revision || 0) + 1;
            }

            try {
                const updated = await (prisma as any).purchaseOrder.update({ where: { id: existing.id }, data });
                res.status(200).json(parsePurchaseOrderRow(updated));
            } catch (err: any) {
                if (err?.code === 'P2002') {
                    return res.status(400).json({ error: `"${data.referenceNumber}" sipariş kodu zaten kullanılıyor.` });
                }
                throw err;
            }
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/purchase-orders/{id}/status:
 *   patch:
 *     tags: [Inventory]
 *     summary: Sipariş durumunu elle değiştir (PENDING ↔ TO_BE_STOCKED)
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/purchase-orders/:id/status',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await (prisma as any).purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
            if (!existing) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
            const status = String(req.body?.status || '').toUpperCase();
            if (status !== 'PENDING' && status !== 'TO_BE_STOCKED') {
                return res.status(400).json({ error: 'Geçersiz durum. Yalnızca PENDING veya TO_BE_STOCKED seçilebilir.' });
            }
            if (existing.status === 'COMPLETED') {
                return res.status(400).json({ error: 'Tamamlanmış siparişin durumu değiştirilemez.' });
            }
            const updated = await (prisma as any).purchaseOrder.update({ where: { id: existing.id }, data: { status } });
            res.status(200).json(parsePurchaseOrderRow(updated));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/purchase-orders/{id}/mark-stocked:
 *   post:
 *     tags: [Inventory]
 *     summary: Siparişi stoğa eklendi olarak işaretle (COMPLETED)
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/purchase-orders/:id/mark-stocked',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await (prisma as any).purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
            if (!existing) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
            const updated = await (prisma as any).purchaseOrder.update({
                where: { id: existing.id },
                data: { status: 'COMPLETED', stockedAt: new Date() },
            });
            res.status(200).json(parsePurchaseOrderRow(updated));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/purchase-orders/{id}/send-mail:
 *   post:
 *     tags: [Inventory]
 *     summary: Sipariş PDF'ini tedarikçiye e-posta ile gönder
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/purchase-orders/:id/send-mail',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await (prisma as any).purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
            if (!existing) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

            const settings = await prisma.mailSetting.findUnique({ where: { tenantId } });

            // Alıcı beyaz listesi: sipariş snapshot'ındaki e-posta + tedarikçi
            // kaydındaki e-posta. Keyfî adrese gönderim yok (açık relay engeli).
            const allowedRecipients = new Map<string, string>();
            const registerEmail = (value: unknown) => {
                const trimmed = String(value || '').trim();
                if (trimmed && PO_EMAIL_RE.test(trimmed)) allowedRecipients.set(trimmed.toLowerCase(), trimmed);
            };
            registerEmail(existing.supplierEmail);
            if (existing.supplierId) {
                const supplier = await (prisma as any).supplier.findFirst({
                    where: { id: existing.supplierId, tenantId },
                    select: { email: true },
                });
                registerEmail(supplier?.email);
            }
            if (allowedRecipients.size === 0) {
                return res.status(400).json({ error: 'Bu tedarikçi için tanımlı geçerli bir e-posta adresi yok.' });
            }
            let to = allowedRecipients.get(String(existing.supplierEmail || '').trim().toLowerCase())
                || Array.from(allowedRecipients.values())[0]!;
            if (req.body?.to !== undefined && String(req.body.to).trim() !== '') {
                const canonical = allowedRecipients.get(poStripHeader(String(req.body.to)).toLowerCase());
                if (!canonical) {
                    return res.status(403).json({ error: 'Alıcı yalnızca siparişin tedarikçisine ait bir e-posta adresi olabilir.' });
                }
                to = canonical;
            }

            // Gönderici her zaman tenant MailSetting'inden (gövdeden asla).
            const fromEmail = poStripHeader(String(settings?.fromEmail || req.user!.email || ''));
            if (!fromEmail || !PO_EMAIL_RE.test(fromEmail)) {
                return res.status(400).json({ error: 'Gönderici e-posta adresi yapılandırılmamış.' });
            }
            const fromName = poStripHeader(String(settings?.fromName || 'Offitec ERP')).slice(0, 100) || 'Offitec ERP';

            const subject = poStripHeader(String(req.body?.subject || `Bestellung ${existing.referenceNumber}`));
            if (!subject) return res.status(400).json({ error: 'Konu boş olamaz.' });
            if (subject.length > 200) return res.status(400).json({ error: 'Konu 200 karakteri aşamaz.' });

            const message = String(req.body?.message || '').trim();
            if (message.length > 5000) return res.status(400).json({ error: 'Mesaj çok uzun.' });

            // Ekler: yalnızca gövde içi PDF/PNG/JPG, adet + boyut sınırlı (tender emsali).
            const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
            if (rawAttachments.length > 5) return res.status(400).json({ error: 'En fazla 5 ek dosya gönderilebilir.' });
            const allowedAttachmentTypes = new Set(['application/pdf', 'image/png', 'image/jpeg']);
            let totalAttachmentBytes = 0;
            const attachments: Array<{ filename: string; contentType: string; contentBase64: string }> = [];
            for (const item of rawAttachments) {
                if (!item || typeof item !== 'object') return res.status(400).json({ error: 'Geçersiz ek dosya.' });
                const contentType = String((item as any).contentType || '').trim().toLowerCase();
                const contentBase64 = typeof (item as any).contentBase64 === 'string' ? (item as any).contentBase64 : '';
                const rawName = String((item as any).filename || '').trim();
                if (!rawName || !contentBase64) return res.status(400).json({ error: 'Ek dosya adı ve içeriği zorunludur.' });
                if (!allowedAttachmentTypes.has(contentType)) {
                    return res.status(400).json({ error: 'Sadece PDF, PNG veya JPG ek gönderilebilir.' });
                }
                const filename = rawName.replace(/[\\/\r\n"]+/g, '_').slice(0, 120);
                totalAttachmentBytes += Math.floor(contentBase64.replace(/\s+/g, '').length * 3 / 4);
                attachments.push({ filename, contentType, contentBase64 });
            }
            if (totalAttachmentBytes > 15 * 1024 * 1024) {
                return res.status(400).json({ error: 'Eklerin toplam boyutu 15 MB sınırını aşıyor.' });
            }

            const signature = buildSignatureParts(settings);
            const html = `
                <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
                    <p>${poEscapeHtml(message).replace(/\n/g, '<br />')}</p>
                    ${signature.html}
                </div>
            `;

            const result = await smtp.send(settings || {}, {
                fromEmail,
                fromName,
                to,
                subject,
                text: `${message}${signature.text}`,
                html,
                replyTo: settings?.replyTo || null,
                attachments,
                inlineImages: signature.inlineImages,
            });

            // preview = SMTP yapılandırılmamış, gerçek gönderim yok → emailSentAt
            // damgalanmaz; UPDATED/revizyon mantığı gerçek gönderime bağlıdır.
            let order = existing;
            if (!result.preview) {
                order = await (prisma as any).purchaseOrder.update({
                    where: { id: existing.id },
                    data: { emailSentAt: new Date(), emailRecipient: to },
                });
            }

            res.status(200).json({
                message: result.preview
                    ? 'SMTP ayarı olmadığı için sipariş maili önizleme olarak hazırlandı.'
                    : 'Sipariş maili gönderildi.',
                ...result,
                order: parsePurchaseOrderRow(order),
            });
        } catch (error: any) {
            if (typeof error?.message === 'string' && error.message.startsWith('SMTP')) {
                return res.status(502).json({ error: 'E-posta gönderilemedi: SMTP sunucusuna bağlanılamadı veya kullanıcı adı/parola hatalı. Lütfen mail ayarlarını kontrol edin.' });
            }
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/purchase-orders/{id}:
 *   delete:
 *     tags: [Inventory]
 *     summary: Satın alma siparişini sil
 *     security:
 *       - bearerAuth: []
 */
router.delete(
    '/purchase-orders/:id',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const existing = await (prisma as any).purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
            if (!existing) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
            await (prisma as any).purchaseOrder.delete({ where: { id: existing.id } });
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

export default router;
