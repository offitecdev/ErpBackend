import { Router } from 'express';
import { InventoryController } from '../controllers/InventoryController';
import { InventoryRepository } from '../../infrastructure/repositories/InventoryRepository';
import { ProcessStockMovementUseCase } from '../../application/use-cases/inventory/ProcessStockMovementUseCase';
import { ManagePurchaseProposalsUseCase } from '../../application/use-cases/inventory/ManagePurchaseProposalsUseCase';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { requireItGate } from '../middlewares/ItGateMiddleware';
import { auditLog } from '../../infrastructure/services/AuditLogService';
import prisma from '../../infrastructure/database/prisma.client';
import { SmtpMailService } from '../../infrastructure/services/SmtpMailService';
import { buildSignatureParts } from '../../infrastructure/services/mailSignature';
import { composeAddressSnapshot } from '../../shared/postalAddress';
import { parseArticleImage } from '../../shared/articleImage';
import { normalizeRichText } from '../../shared/richText';
// Mengeneinheiten: der Artikel traegt den kurzen Code als Text, gewaehlt wird
// aber aus der Liste des Mandanten (Einstellungen -> Module -> Lager).
import { listUnits, resolveUnit } from '../../application/services/measurementUnitCatalog';
import { nanoid } from 'nanoid';
import { getMailTenantId } from "../controllers/serviceTenantScope";

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
 *         schema: { type: string, enum: [PRODUCT, SERVICE] }
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

/**
 * Bir ürünün AÇIK sipariş adedi: henüz stoğa alınmamış satın alma
 * siparişlerindeki (PENDING | ORDERED | TO_BE_STOCKED) satır miktarlarının
 * toplamı. Sipariş satırları JSON snapshot olduğu için SQL ile toplanamaz;
 * bu yüzden yalnızca açık siparişlerin `items` kolonu çekilip taranır.
 * Siparişi olmayan ürün 0 döner.
 */
const openOrderQuantityFor = async (tenantId: string, articleId: string, articleCode: string): Promise<number> => {
    const orders = await (prisma as any).purchaseOrder.findMany({
        where: { tenantId, status: { in: ['PENDING', 'ORDERED', 'TO_BE_STOCKED'] } },
        select: { items: true },
    });
    let total = 0;
    for (const order of orders) {
        let lines: any[];
        try {
            lines = JSON.parse(order.items || '[]');
        } catch {
            continue; // Bozuk snapshot tek siparişi atlar, isteği düşürmez.
        }
        if (!Array.isArray(lines)) continue;
        for (const line of lines) {
            const matches = line?.articleId
                ? line.articleId === articleId
                : Boolean(articleCode) && String(line?.code || '') === articleCode;
            if (matches) total += Math.max(0, Number(line?.quantity) || 0);
        }
    }
    return total;
};

/**
 * Ürünün tedarikçi bazlı alım partileri — ortalama birim maliyetin TABANI.
 * İki kaynak birleştirilir: (1) ArticleSupplier alım partileri ve (2) tedarikçisi
 * işaretli stok GİRİŞ hareketleri. Aynı tedarikçinin partileri tek satırda
 * toplanır: `quantity` = alınan toplam adet, `totalCost` = adet × birim fiyat.
 * Ortalama = Σ(birim maliyet × adet) / Σ(adet) — kullanıcı formülünün birebir
 * karşılığı.
 */
const articleSupplierCostRows = async (tenantId: string, articleId: string) => {
    type SupplierCostRow = {
        supplierId: string;
        companyName: string;
        quantity: number;
        totalCost: number;
        averageUnitCost: number;
        lastPurchaseDate: Date | null;
    };

    // İki kaynağın bütün alım satırlarını Node'a taşımak yerine MySQL'de UNION
    // edip tedarikçi bazında topluyoruz. Yanıt büyüklüğü kayıt sayısına değil,
    // yalnızca ilgili ürünün tedarikçi sayısına bağlı kalır.
    const rawRows: any[] = await (prisma as any).$queryRawUnsafe(
        `SELECT s.\`id\` AS supplierId,
                s.\`companyName\` AS companyName,
                SUM(p.quantity) AS quantity,
                SUM(p.totalCost) AS totalCost,
                MAX(p.lastPurchaseDate) AS lastPurchaseDate
         FROM (
             SELECT \`supplierId\`,
                    GREATEST(\`quantity\`, 0) AS quantity,
                    GREATEST(\`quantity\`, 0) * GREATEST(\`purchasePrice\`, 0) AS totalCost,
                    \`lastPurchaseDate\` AS lastPurchaseDate
             FROM \`ArticleSupplier\`
             WHERE \`tenantId\` = ? AND \`articleId\` = ?
             UNION ALL
             SELECT \`supplierId\`,
                    \`quantity\` AS quantity,
                    \`quantity\` * GREATEST(COALESCE(\`unitCost\`, 0), 0) AS totalCost,
                    \`transactionDate\` AS lastPurchaseDate
             FROM \`StockMovement\`
             WHERE \`tenantId\` = ? AND \`articleId\` = ?
               AND \`supplierId\` IS NOT NULL AND \`movementType\` = 'IN' AND \`quantity\` > 0
         ) p
         INNER JOIN \`Supplier\` s ON s.\`id\` = p.supplierId
         WHERE s.\`tenantId\` = ?
         GROUP BY s.\`id\`, s.\`companyName\``,
        tenantId, articleId, tenantId, articleId, tenantId,
    );

    const rows: SupplierCostRow[] = rawRows.map((row) => {
        const quantity = Math.max(0, Number(row.quantity) || 0);
        const totalCost = Math.max(0, Number(row.totalCost) || 0);
        return {
            supplierId: String(row.supplierId),
            companyName: String(row.companyName || ''),
            quantity,
            totalCost,
            averageUnitCost: quantity > 0 ? totalCost / quantity : 0,
            lastPurchaseDate: row.lastPurchaseDate ? new Date(row.lastPurchaseDate) : null,
        };
    });
    rows.sort((a, b) => b.quantity - a.quantity || a.companyName.localeCompare(b.companyName));

    const quantity = rows.reduce((sum, row) => sum + row.quantity, 0);
    const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0);
    return { rows, quantity, totalCost, averageUnitCost: quantity > 0 ? totalCost / quantity : 0 };
};

/**
 * Detay ekranının ilk yüklemesinde tedarikçi adları/tarihleri gerekmez. Bu hafif
 * özet yalnızca hesabın ihtiyaç duyduğu kolonları okur; popup açıldığında üstteki
 * ayrıntılı sorgu ayrıca çalışır.
 */
const articleCostSummary = async (tenantId: string, articleId: string) => {
    const [links, movements] = await Promise.all([
        (prisma as any).articleSupplier.findMany({
            where: { tenantId, articleId },
            select: { supplierId: true, quantity: true, purchasePrice: true },
        }),
        (prisma as any).stockMovement.findMany({
            where: { tenantId, articleId, supplierId: { not: null }, movementType: 'IN', quantity: { gt: 0 } },
            select: { supplierId: true, quantity: true, unitCost: true },
        }),
    ]);

    let quantity = 0;
    let totalCost = 0;
    const supplierIds = new Set<string>();
    const add = (supplierId: unknown, rawQuantity: unknown, rawUnitCost: unknown) => {
        const rowQuantity = Math.max(0, Number(rawQuantity) || 0);
        const unitCost = Math.max(0, Number(rawUnitCost) || 0);
        quantity += rowQuantity;
        totalCost += rowQuantity * unitCost;
        if (supplierId) supplierIds.add(String(supplierId));
    };

    for (const link of links) add(link.supplierId, link.quantity, link.purchasePrice);
    for (const movement of movements) add(movement.supplierId, movement.quantity, movement.unitCost);

    return {
        averageUnitCost: quantity > 0 ? totalCost / quantity : 0,
        supplierCount: supplierIds.size,
    };
};

/**
 * Ürün detay ekranının kritik AÇILIŞ verisi. Büyük LONGTEXT görseli, açık
 * sipariş JSON'ları ve maliyet hareketleri bu sorguya bilinçli olarak girmez;
 * ekran bu küçük yanıtla açılır, diğerleri paralel uçlardan tamamlanır.
 *
 * Hem GET hem de kaydetme (PATCH) aynı gövdeyi döndürsün diye tek yerde
 * durur — ekran kaydettikten sonra yanıttan tazelenir.
 */
const buildArticleDetail = async (tenantId: string, id: string) => {
    const article = await (prisma as any).article.findFirst({
        where: { id, tenantId, deletedAt: null },
        select: {
            id: true,
            articleCode: true,
            name: true,
            unit: true,
            description: true,
            salePrice: true,
            itemType: true,
            updatedAt: true,
            stockBalances: { select: { currentQuantity: true } },
        },
    });
    if (!article) return null;

    return {
        id: article.id,
        articleCode: article.articleCode,
        name: article.name,
        unit: article.unit,
        description: article.description,
        salePrice: article.salePrice ?? 0,
        itemType: article.itemType ?? 'PRODUCT',
        // Görsel değişince Article.updatedAt değişir. Frontend bu sürümü URL'ye
        // eklediği için eski binary güvenle uzun süre önbellekte kalabilir.
        imageVersion: article.updatedAt.toISOString(),
        totalQuantity: article.stockBalances.reduce(
            (sum: number, balance: any) => sum + (Number(balance.currentQuantity) || 0),
            0,
        ),
    };
};

/**
 * @swagger
 * /inventory/articles/{id}/detail:
 *   get:
 *     tags: [Inventory]
 *     summary: Ürün detay ekranının BAŞLIK tablosu — yalnızca ekranda görünen alanlar
 *     description: >
 *       Görsel, tedarikçi listesi ve hareket geçmişi ÇEKİLMEZ; onlar kendi
 *       uçlarından yalnızca kullanıcı ilgili düğmeye bastığında yüklenir.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 */
router.get(
    '/articles/:id/detail',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const detail = await buildArticleDetail(req.user!.tenantId, String(req.params.id));
            if (!detail) return res.status(404).json({ error: 'Ürün bulunamadı.' });
            return res.status(200).json(detail);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/** Hesaplanan alanlar ana detay isteğini bekletmeden paralel yüklenir. */
router.get(
    '/articles/:id/detail-stats',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);
            const article = await (prisma as any).article.findFirst({
                where: { id, tenantId, deletedAt: null },
                select: { articleCode: true },
            });
            if (!article) return res.status(404).json({ error: 'Ürün bulunamadı.' });

            const [cost, openOrderQuantity] = await Promise.all([
                articleCostSummary(tenantId, id),
                openOrderQuantityFor(tenantId, id, article.articleCode),
            ]);
            return res.status(200).json({ ...cost, openOrderQuantity });
        } catch (error: any) {
            return res.status(400).json({ error: error.message });
        }
    }
);

/**
 * Base64 veriyi JSON'a gömmek yerine gerçek görsel baytlarını döndürür. Sürüm
 * query parametresi değişmez URL üretir; tarayıcı aynı görseli tekrar indirmez.
 */
router.get(
    '/articles/:id/image',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const article = await (prisma as any).article.findFirst({
                where: { id: String(req.params.id), tenantId: req.user!.tenantId, deletedAt: null },
                select: { imageUrl: true },
            });
            if (!article) return res.status(404).json({ error: 'Ürün bulunamadı.' });

            res.removeHeader('Pragma');
            res.removeHeader('Expires');
            res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
            if (!article.imageUrl) return res.status(204).end();

            const parsed = parseArticleImage(article.imageUrl);
            if (!parsed) return res.status(404).json({ error: 'Geçerli ürün görseli bulunamadı.' });

            const separator = parsed.imageUrl.indexOf(',');
            const bytes = Buffer.from(parsed.imageUrl.slice(separator + 1), 'base64');
            res.setHeader('Content-Type', parsed.contentType);
            res.setHeader('Content-Length', String(bytes.length));
            return res.status(200).send(bytes);
        } catch (error: any) {
            return res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/articles/{id}/detail:
 *   patch:
 *     tags: [Inventory]
 *     summary: Ürün detayını TEK istekte kaydet — alanlar, açıklama ve görsel birlikte
 *     description: >
 *       Ekrandaki "Kaydet" düğmesinin tek ucu. Alanlar, biçimli açıklama ve
 *       görsel aynı transaction içinde yazılır; biri reddedilirse hiçbiri
 *       yazılmaz (alanları kaydedip görseli düşüren yarım kayıt oluşmaz).
 *       `imageUrl` gönderilmezse görsel DEĞİŞMEZ, `null` gönderilirse silinir.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               articleCode: { type: string }
 *               name: { type: string }
 *               unit: { type: string }
 *               salePrice: { type: number }
 *               itemType: { type: string, enum: [PRODUCT, SERVICE] }
 *               description: { type: string, nullable: true }
 *               imageUrl: { type: string, nullable: true, description: "data:image/...;base64,... | null = sil" }
 */
router.patch(
    '/articles/:id/detail',
    requireAuth,
    requirePermission('inventory.articles.update'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);
            const body = req.body ?? {};

            const current = await (prisma as any).article.findFirst({
                where: { id, tenantId, deletedAt: null },
                select: { id: true },
            });
            if (!current) return res.status(404).json({ error: 'Ürün bulunamadı.' });

            const data: any = {};

            if (body.articleCode !== undefined) {
                const articleCode = String(body.articleCode).trim();
                if (!articleCode) return res.status(400).json({ error: 'Ürün kodu zorunludur.' });
                // Kod kiracı içinde benzersizdir; çakışmayı Prisma hatasına
                // bırakmak yerine anlaşılır bir mesajla döneriz.
                const clash = await (prisma as any).article.findFirst({
                    where: { tenantId, articleCode, deletedAt: null, NOT: { id } },
                    select: { name: true },
                });
                if (clash) {
                    return res.status(400).json({ error: `"${articleCode}" kodu zaten kullanılıyor: ${clash.name}` });
                }
                data.articleCode = articleCode;
            }

            if (body.name !== undefined) {
                const name = String(body.name).trim();
                if (!name) return res.status(400).json({ error: 'Ürün adı zorunludur.' });
                data.name = name;
            }

            if (body.unit !== undefined) {
                const unit = String(body.unit).trim();
                if (!unit) return res.status(400).json({ error: 'Birim zorunludur.' });
                // Die Liste entscheidet ueber die Schreibweise: "stk" wird zu "Stk",
                // damit derselbe Bestand nicht in mehreren Einheiten auseinanderlaeuft.
                data.unit = resolveUnit(unit, await listUnits(tenantId));
            }

            if (body.salePrice !== undefined) {
                const salePrice = Number(body.salePrice);
                if (!Number.isFinite(salePrice) || salePrice < 0) {
                    return res.status(400).json({ error: 'Satış fiyatı geçersiz.' });
                }
                data.salePrice = salePrice;
            }

            // Ürün/hizmet sınıflandırması — detay ekranındaki tek anahtar.
            if (body.itemType !== undefined) {
                const itemType = String(body.itemType).toUpperCase();
                if (itemType !== 'PRODUCT' && itemType !== 'SERVICE') {
                    return res.status(400).json({ error: 'Tür yalnızca ürün veya hizmet olabilir.' });
                }
                data.itemType = itemType;
            }

            // Açıklama biçimli metindir — dar beyaz listeden geçer.
            if (body.description !== undefined) data.description = normalizeRichText(body.description);

            // Görsel: alan yoksa dokunulmaz, null ise silinir, doluysa doğrulanır.
            if (body.imageUrl !== undefined) {
                if (body.imageUrl === null || body.imageUrl === '') {
                    data.imageUrl = null;
                } else {
                    const parsed = parseArticleImage(body.imageUrl);
                    if (!parsed) {
                        return res.status(400).json({ error: 'Görsel geçersiz. En fazla 2 MB PNG, JPG, GIF veya WebP yükleyin.' });
                    }
                    data.imageUrl = parsed.imageUrl;
                }
            }

            if (Object.keys(data).length) {
                await (prisma as any).article.update({ where: { id }, data });
            }

            const detail = await buildArticleDetail(tenantId, id);
            return res.status(200).json(detail);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/articles/{id}/suppliers-summary:
 *   get:
 *     tags: [Inventory]
 *     summary: Ürün detayındaki tedarikçi POPUP'ı — yalnızca açıldığında çağrılır
 *     description: Tedarikçi başına alınan adet, ödenen toplam ve ortalama birim maliyet.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 */
router.get(
    '/articles/:id/suppliers-summary',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);
            // Varlık kontrolü ile maliyet toplamını aynı DB turunda paralel başlat.
            const [exists, cost] = await Promise.all([
                (prisma as any).article.count({ where: { id, tenantId, deletedAt: null } }),
                articleSupplierCostRows(tenantId, id),
            ]);
            if (!exists) return res.status(404).json({ error: 'Ürün bulunamadı.' });

            return res.status(200).json({
                suppliers: cost.rows,
                totalQuantity: cost.quantity,
                totalCost: cost.totalCost,
                averageUnitCost: cost.averageUnitCost,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
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

// Malzeme/ürün birleşmesi (2026-08-14): /inventory/materials CRUD uçları
// kaldırıldı — ayrı Material tablosu yok, her şey Article.

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

            // Tek kaynak: Article (malzeme/ürün birleşmesi 2026-08-14).
            const articles = await (prisma as any).article.findMany({
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
            });

            res.status(200).json(articles.map((a: any) => ({
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
            })));
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
 *         name: articleId
 *         schema: { type: string }
 *         description: Tek bir ürünün hareketleri (ürün detay ekranı)
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
            // Ürün detayındaki "bu ürünün hareketleri" görünümü — tek ürüne daraltır.
            const articleId = toStr(req.query.articleId);

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
            if (articleId) and.push({ articleId });
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
                    // Ürün detay sekmesi articleId'yi zaten bilir; o görünümde
                    // Article ve Employee ilişkilerini yüklemiyoruz. Genel liste
                    // için de yalnızca tabloda gösterilen alanlar seçilir.
                    select: {
                        id: true,
                        transactionDate: true,
                        movementType: true,
                        quantity: true,
                        unitCost: true,
                        description: true,
                        ...(!articleId ? {
                            article: { select: { articleCode: true, name: true } },
                        } : {}),
                        supplier: { select: { companyName: true } },
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
                    ...(!articleId ? { article: row.article } : {}),
                    supplier: row.supplier,
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
 *                     description: { type: string, nullable: true, description: "Ürün açıklaması (biçimli metin) — kartın Açıklama alanına yazılır" }
 *                     imageUrl: { type: string, nullable: true, description: "data:image/...;base64,... — ürün görseli (en fazla 2 MB)" }
 *                     itemType: { type: string, enum: [PRODUCT, SERVICE], description: "Satır bazında; verilmezse gövdedeki itemType, o da yoksa PRODUCT" }
 *               itemType:
 *                 type: string
 *                 enum: [PRODUCT, SERVICE]
 *                 description: "Tüm satırlar için varsayılan tür (ürün / malzeme ekranı)"
 *               overwrite:
 *                 type: boolean
 *                 description: "true: kodu zaten kayıtlı satır hata yerine mevcut ürünü GÜNCELLER (dosya kazanır)"
 */
/** Kayıtları bir alana göre öbekle (toplu yazma düştüğünde satır satır dener). */
const groupBy = <T extends Record<string, any>>(rows: T[], key: string): Map<any, T[]> => {
    const groups = new Map<any, T[]>();
    for (const row of rows) {
        const bucket = groups.get(row[key]);
        if (bucket) bucket.push(row);
        else groups.set(row[key], [row]);
    }
    return groups;
};

/** Satır hatasını KOD'uyla birlikte fırlat — arayüz kodu çevirebilsin. */
const rowError = (code: string, message: string): Error =>
    Object.assign(new Error(message), { rowCode: code });

/**
 * Veritabanı hatasını satır listesine sığan tek cümleye indirger.
 *
 * Prisma'nın ham metni ekranlarca uzundur (çağrının kaynak kodunu da basar);
 * satır tablosuna olduğu gibi konulursa okunmaz. `code` alanı arayüzün hatayı
 * KULLANICININ dilinde göstermesini sağlar; metin yalnızca yedektir.
 */
const rowWriteFailure = (error: any): { code: string; message: string } => {
    const raw = String(error?.message || '');
    // Sütun adı Prisma'nın `meta`sında gelir; sürücü üzerinden gelen hatalarda
    // orası boş kalıp yalnızca metinde ("… Column: name") durabiliyor.
    const column = error?.meta?.column_name || error?.meta?.column || /Column:\s*(\w+)/.exec(raw)?.[1] || '';
    if (error?.code === 'P2000' || /too long for the column/i.test(raw)) {
        return { code: 'VALUE_TOO_LONG', message: column ? `Alan sütun sınırını aşıyor: ${column}.` : 'Bir alan sütun sınırını aşıyor.' };
    }
    if (error?.code === 'P2002') return { code: 'CODE_TAKEN', message: 'Bu kod zaten bir üründe kayıtlı.' };
    return { code: 'WRITE_FAILED', message: 'Satır yazılamadı.' };
};

/**
 * Toplu ürün yazma gövdesi — İKİ uç aynı işi yapar:
 *   POST /inventory/articles/bulk    (tablo/Excel; `inventory.articles.create`)
 *   POST /inventory/articles/import  (IT'nin CSV yüklemesi; IT kennwortu)
 * `forceZeroStock` yalnızca ikincisinde açıktır: dosyada ne yazarsa yazsın
 * miktar 0 kabul edilir, böylece içe aktarılan ürün STOKSUZ tanımlanır
 * (bakiye satırı yazılmaz, yalnızca tanım hareketi düşer).
 */
const bulkCreateArticlesHandler = (options: { forceZeroStock?: boolean } = {}) =>
    async (req: any, res: any) => {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const items: any[] = Array.isArray(req.body.items) ? req.body.items : [];
            if (!items.length) return res.status(400).json({ error: 'Eklenecek satır yok.' });
            if (items.length > 500) return res.status(400).json({ error: 'Tek seferde en fazla 500 satır eklenebilir.' });
            // itemType = ürün/hizmet sınıflandırması (PRODUCT | SERVICE);
            // varsayılan üründür, detay ekranından hizmete çevrilebilir.
            const defaultItemType = req.body.itemType === 'SERVICE' ? 'SERVICE' : 'PRODUCT';
            // ÜZERİNE YAZMA (kullanıcı isteği 2026-08-02, sipariş Excel aktarımı):
            // kodu zaten kayıtlı satır hata VERMEZ, mevcut ürün dosyadaki değerlerle
            // güncellenir (ad/birim/fiyatlar; çöpteyse geri alınır). Stok DOKUNULMAZ —
            // güncellenen ürün için hareket/bakiye/parti yazılmaz.
            const overwrite = req.body.overwrite === true;

            // `code`: arayüz sık görülen hatayı kendi dilinde gösterebilsin.
            const errors: Array<{ index: number; articleCode: string; error: string; code?: string }> = [];
            const created: any[] = [];

            // Yük içi mükerrer kod kontrolü
            const seenCodes = new Map<string, number>();
            items.forEach((item, index) => {
                const codeValue = String(item.articleCode || '').trim();
                if (codeValue) {
                    if (seenCodes.has(codeValue)) {
                        errors.push({ index, articleCode: codeValue, error: 'Aynı ürün kodu listede birden fazla kez var.', code: 'DUPLICATE_IN_FILE' });
                    } else {
                        seenCodes.set(codeValue, index);
                    }
                }
            });
            const duplicateIndexes = new Set(errors.map((e) => e.index));

            // Birbirinden bağımsız hazırlık sorguları aynı anda çalışır. Uzak DB'de
            // bunları art arda beklemek toplu kayda gereksiz üç ağ turu ekliyordu.
            const supplierCache: SupplierCache = new Map();
            const [existing, defaultLocation, invalidSupplierIds, units] = await Promise.all([
                (prisma as any).article.findMany({
                    where: { tenantId, articleCode: { in: [...seenCodes.keys()] } },
                    select: { id: true, articleCode: true, deletedAt: true, itemType: true },
                }),
                repository.ensureDefaultLocation(tenantId),
                warmSupplierCache(tenantId, items, supplierCache),
                // Die Einheitenliste des Mandanten: sie gibt die Schreibweise vor
                // und liefert die Vorgabe fuer Zeilen ohne eigene Einheit.
                listUnits(tenantId),
            ]);
            const existingCodes = new Map<string, { id: string; deleted: boolean; itemType: string }>(
                existing.map((row: any) => [row.articleCode, { id: row.id, deleted: Boolean(row.deletedAt), itemType: row.itemType || 'PRODUCT' }]),
            );
            const clashMessage = (info: { deleted: boolean; itemType: string }) =>
                info.deleted ? 'Bu kod çöpteki bir üründe kayıtlı.' : 'Bu kod zaten bir üründe kayıtlı.';

            // Satır başına INSERT + transaction yerine: her şey bellekte hazırlanır,
            // sonra tek transaction içinde toplu INSERT'lerle yazılır. Yeni ürünler
            // olduğu için bakiye/parti satırlarının çakışma ihtimali yok.
            const articleCreates: any[] = [];
            /** Hangi ürün hangi SATIRDAN geldi — toplu yazma düşerse gerekir. */
            const createGroups: Array<{ index: number; articleCode: string; articleId: string }> = [];
            const articleUpdates: Array<{ id: string; index: number; articleCode: string; data: any }> = [];
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
                    if (clash && !overwrite) throw rowError('CODE_TAKEN', clashMessage(clash));
                    // IT içe aktarımında miktar tartışmaya kapalıdır: 0.
                    const quantity = options.forceZeroStock ? 0 : Math.max(0, Number(item.quantity) || 0);
                    const purchasePrice = Math.max(0, Number(item.purchasePrice) || 0);
                    const salePrice = Math.max(0, Number(item.salePrice) || 0);
                    // Açıklama ve görsel ürün KARTINA yazılır (hareket notu değil) —
                    // detay ekranındaki PATCH ile aynı doğrulamalardan geçer.
                    const description = item.description ? normalizeRichText(String(item.description)) : null;
                    let imageUrl: string | null = null;
                    if (item.imageUrl) {
                        const parsedImage = parseArticleImage(item.imageUrl);
                        if (!parsedImage) throw new Error('Görsel geçersiz. En fazla 2 MB PNG, JPG, GIF veya WebP yükleyin.');
                        imageUrl = parsedImage.imageUrl;
                    }
                    if (item.supplierId && invalidSupplierIds.has(String(item.supplierId))) throw new Error('Tedarikçi bulunamadı.');
                    // Tedarikçiler yukarıda toplu çözüldü; burada yalnızca okunur.
                    const supplier = supplierCache.get(item.supplierId
                        ? `id:${String(item.supplierId)}`
                        : `name:${item.supplierName ? String(item.supplierName).trim().toLowerCase() : ''}`) || null;

                    // ÜZERİNE YAZMA: kodu kayıtlı ürün DOSYADAKİ değerlerle güncellenir
                    // (ad her zaman; birim/fiyat/tedarikçi doluysa), çöpteyse geri
                    // alınır. Stok DOKUNULMAZ — sipariş akışı stok hareketi değildir.
                    if (clash) {
                        articleUpdates.push({
                            id: clash.id,
                            index,
                            articleCode,
                            data: {
                                name,
                                ...(item.unit ? { unit: resolveUnit(item.unit, units) } : {}),
                                ...(purchasePrice > 0 ? { baseCost: purchasePrice } : {}),
                                ...(salePrice > 0 ? { salePrice } : {}),
                                ...(supplier ? { defaultSupplierId: supplier.id } : {}),
                                ...(description ? { description } : {}),
                                ...(imageUrl ? { imageUrl } : {}),
                                deletedAt: null,
                                isActive: true,
                                status: 'ACTIVE',
                            },
                        });
                        // Güncellenen ürün de `created` listesinde döner: çağıran taraf
                        // satırı aynı yolla (kod eşleşmesiyle) bu id'ye bağlar.
                        created.push({ id: clash.id, articleCode, name });
                        return;
                    }

                    const articleId = nanoid(10);
                    const movementId = nanoid(12);

                    articleCreates.push({
                        id: articleId,
                        tenantId,
                        articleCode,
                        name,
                        // Ohne eigene Angabe: die Vorgabe des Mandanten (frueher
                        // stand hier fest "Adet" -- tuerkisch und nicht waehlbar).
                        unit: resolveUnit(item.unit, units),
                        baseCost: purchasePrice,
                        salePrice,
                        defaultSupplierId: supplier?.id || null,
                        ...(description ? { description } : {}),
                        ...(imageUrl ? { imageUrl } : {}),
                        itemType: item.itemType === 'SERVICE' || item.itemType === 'PRODUCT' ? item.itemType : defaultItemType,
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
                        // `item.description` artık ürün KARTININ açıklamasıdır (biçimli
                        // metin) — hareket notuna sızdırılmaz.
                        description: quantity > 0 ? 'Toplu ürün girişi' : 'Ürün tanımı',
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

                    existingCodes.set(articleCode, { id: articleId, deleted: false, itemType: item.itemType === 'SERVICE' || item.itemType === 'PRODUCT' ? item.itemType : defaultItemType });
                    created.push({ id: articleId, articleCode, name });
                    // Satırı id'siyle eşle: toplu yazma düşerse tek tek yeniden
                    // denenecek ve hata SATIRINA yazılacak (aşağıya bakınız).
                    createGroups.push({ index, articleCode, articleId });
                } catch (error: any) {
                    errors.push({ index, articleCode, error: error.message, ...(error?.rowCode ? { code: error.rowCode } : {}) });
                }
            });

            // YENİ kayıtlar tek transaction içinde toplu INSERT'lerle yazılır:
            // ürün kartı, bakiye, hareket ve parti satırları birbirini tutar.
            const failedCreateIds = new Set<string>();
            if (articleCreates.length) {
                try {
                    await (prisma as any).$transaction(async (tx: any) => {
                        await tx.article.createMany({ data: articleCreates });
                        if (balanceCreates.length) await tx.stockBalance.createMany({ data: balanceCreates });
                        if (movementCreates.length) await tx.stockMovement.createMany({ data: movementCreates });
                        if (lotCreates.length) await tx.articleSupplier.createMany({ data: lotCreates });
                    });
                } catch {
                    /* TOPLU YAZMA TEK BİR SATIR YÜZÜNDEN DÜŞEBİLİR. `createMany`
                       paketi TEK ifadedir: örneğin adı VARCHAR(191)'e sığmayan
                       bir ürün, aynı paketteki 199 sağlam ürünü de götürüyordu
                       (17.08.2026, IT yüklemesinde 4 uzun ad 600 satırı
                       düşürdü). Bu yüzden düşen paket satır satır yeniden
                       denenir: yalnızca gerçekten hatalı olanlar hata döner,
                       komşuları yazılır. Yavaş yol bilerek yavaştır — sadece
                       hata durumunda çalışır. */
                    const balancesByArticle = groupBy(balanceCreates, 'articleId');
                    const movementsByArticle = groupBy(movementCreates, 'articleId');
                    const lotsByArticle = groupBy(lotCreates, 'articleId');

                    for (const article of articleCreates) {
                        const group = createGroups.find((entry) => entry.articleId === article.id);
                        try {
                            await (prisma as any).$transaction(async (tx: any) => {
                                await tx.article.create({ data: article });
                                const balances = balancesByArticle.get(article.id) ?? [];
                                const movements = movementsByArticle.get(article.id) ?? [];
                                const lots = lotsByArticle.get(article.id) ?? [];
                                if (balances.length) await tx.stockBalance.createMany({ data: balances });
                                if (movements.length) await tx.stockMovement.createMany({ data: movements });
                                if (lots.length) await tx.articleSupplier.createMany({ data: lots });
                            });
                        } catch (error: any) {
                            const failure = rowWriteFailure(error);
                            failedCreateIds.add(article.id);
                            errors.push({
                                index: group?.index ?? -1,
                                articleCode: group?.articleCode ?? String(article.articleCode ?? ''),
                                error: failure.message,
                                code: failure.code,
                            });
                        }
                    }
                }
            }

            /* ÜZERİNE YAZMA transaction DIŞINDA kalır. Her satır BAŞKA bir ürünü
               günceller; aralarında tutarlılık bağı yoktur, tek satırlık UPDATE
               kendi başına zaten atomiktir. İçeride bırakmak iki şeyi bozuyordu:
               Prisma'nın etkileşimli transaction'ı 5 sn sonra kapanır ve uzak
               veritabanında ~60 ms süren 200 UPDATE bunu kolayca aşıyordu
               (P2028); dahası tek bir satırın hatası, aynı pakette BAŞARIYLA
               yazılmış yeni ürünleri de geri alıyordu. Artık hatalı satır kendi
               hatasını döner, komşuları yazılmış kalır.
               Eşzamanlılık havuzun (10) altında tutulur. */
            const UPDATE_CONCURRENCY = 8;
            const failedUpdateIds = new Set<string>();
            for (let start = 0; start < articleUpdates.length; start += UPDATE_CONCURRENCY) {
                await Promise.all(articleUpdates.slice(start, start + UPDATE_CONCURRENCY).map(async (update) => {
                    try {
                        await (prisma as any).article.update({ where: { id: update.id }, data: update.data });
                    } catch (error: any) {
                        failedUpdateIds.add(update.id);
                        errors.push({ index: update.index, articleCode: update.articleCode, error: error.message });
                    }
                }));
            }

            // Yazılamayan satırlar (yeni ya da güncelleme) `created` listesinden
            // düşer — çağıran taraf oradaki id'ye satır bağlar, olmayan bir
            // kayda bağlamamalı.
            const writtenRows = failedUpdateIds.size || failedCreateIds.size
                ? created.filter((row) => !failedUpdateIds.has(row.id) && !failedCreateIds.has(row.id))
                : created;
            errors.sort((a, b) => a.index - b.index);

            res.status(errors.length && !writtenRows.length ? 400 : 201).json({
                createdCount: writtenRows.length,
                updatedCount: articleUpdates.length - failedUpdateIds.size,
                created: writtenRows,
                errors,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    };

router.post(
    '/articles/bulk',
    requireAuth,
    requirePermission('inventory.articles.create'),
    bulkCreateArticlesHandler(),
);

/**
 * @swagger
 * /inventory/articles/import:
 *   post:
 *     tags: [Inventory]
 *     summary: IT-Produktupload — Stammdaten aus CSV/Excel, IMMER mit Bestand 0
 *     description: >
 *       Gleicher Rumpf wie `/inventory/articles/bulk`, aber hinter der
 *       IT-Schleuse statt hinter dem Lagerrecht (Kopf `x-it-gate`, Ausweis von
 *       `/settings/it-gate/verify`) — und die Menge der Datei wird verworfen:
 *       jede angelegte Ware startet mit Bestand 0. Ein bereits vorhandener
 *       Artikel wird bei `overwrite` in seinen Stammdaten aktualisiert, sein
 *       BESTAND bleibt dabei unberührt.
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
 *                     articleCode: { type: string, description: "Interne Referenz aus der Datei" }
 *                     name: { type: string }
 *                     salePrice: { type: number }
 *                     purchasePrice: { type: number, description: "Kosten / durchschnittlicher Stückpreis" }
 *                     unit: { type: string, nullable: true }
 *                     imageUrl: { type: string, nullable: true, description: "data:image/...;base64,... (max. 2 MB)" }
 *               overwrite:
 *                 type: boolean
 *                 description: "true: vorhandene Artikelnummer wird aktualisiert statt abgewiesen"
 */
router.post(
    '/articles/import',
    requireAuth,
    requireItGate,
    bulkCreateArticlesHandler({ forceZeroStock: true }),
);

/**
 * @swagger
 * /inventory/articles/purge:
 *   post:
 *     tags: [Inventory]
 *     summary: Produktliste der gewählten Firma zurücksetzen (alles in den Papierkorb)
 *     description: >
 *       Die Schranke ist die IT-SCHLEUSE — und nur sie (Vorgabe 17.08.2026): das
 *       IT-Kennwort wird einmal je Sitzung eingegeben, danach genügt der
 *       getippte Satz im Fenster. Das persönliche Kennwort, das eine Löschung in
 *       der Produktliste verlangt, wird hier ausdrücklich NICHT gefordert.
 *       Löscht nicht endgültig: jede Karte wandert in den Papierkorb
 *       (`deletedAt`), Bestandshistorie und Verweise bleiben stehen. Betroffen
 *       ist ausschliesslich die Firma, die im Aufruf gewählt ist.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               confirm:
 *                 type: string
 *                 description: "Muss wörtlich RESET_PRODUCTS sein (der getippte Satz im Fenster ist die Anzeige davon)"
 *     responses:
 *       200: { description: "Anzahl der in den Papierkorb verschobenen Karten" }
 *       400: { description: "Bestätigung fehlt (code=CONFIRM_REQUIRED)" }
 *       403: { description: "IT-Schleuse zu bzw. abgelaufen" }
 */
router.post(
    '/articles/purge',
    requireAuth,
    requireItGate,
    async (req: any, res: any) => {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;

            // Der getippte Satz steht im Fenster in der Sprache des Anwenders und
            // kann deshalb nicht die Prüfung des Servers sein; hierher kommt das
            // feste Wort dahinter. So scheitert ein Aufruf "aus Versehen" auch
            // dann, wenn jemand die Oberfläche umgeht.
            if (String(req.body?.confirm || '') !== 'RESET_PRODUCTS') {
                return res.status(400).json({ error: 'Bestätigung fehlt.', code: 'CONFIRM_REQUIRED' });
            }

            // KEIN persönliches Kennwort hier (anders als beim Löschen einzelner
            // Karten): die Schranke dieser Fläche ist das IT-Kennwort, und das
            // steht schon in `requireItGate` oben.
            const result = await (prisma as any).article.updateMany({
                where: { tenantId, deletedAt: null },
                data: { deletedAt: new Date(), status: 'INACTIVE', isActive: false },
            });

            auditLog.log({
                action: 'inventory.article.purge',
                tenantId,
                employeeId,
                entityType: 'Article',
                metadata: { deleted: result.count },
                ...auditLog.context(req),
            });
            res.status(200).json({ deleted: result.count });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    },
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

// Ortak: bir ürünü tek satırlık düşük stok objesine indirger.
const mapLowStock = (kind: 'PRODUCT', id: string, code: string, name: string, unit: string, qty: number, min: number, critical: number) => {
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
            const articles = await (prisma as any).article.findMany({
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
            });

            const rows: Array<ReturnType<typeof mapLowStock>> = articles.map((a: any) => {
                const qty = (a.stockBalances || []).reduce((s: number, b: any) => s + (b.currentQuantity || 0), 0);
                return mapLowStock('PRODUCT', a.id, a.articleCode, a.name, a.unit, qty, a.minStockLevel || 0, a.criticalStockLevel || 0);
            });

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
            // `:kind` yalnızca yol uyumluluğu için duruyor — malzeme/ürün
            // birleşmesinden (2026-08-14) beri her kalem Article'dır.
            const id = String(req.params.id);

            {
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
                const settings = await prisma.mailSetting.findUnique({ where: { tenantId: await getMailTenantId(tenantId) } });
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
                    itemType: 'PRODUCT',
                    articleId: b.articleId ? String(b.articleId) : null,
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
// kolonunda saklanır (SupplyRequest emsali — listeleme join'siz).
//
// YAŞAM DÖNGÜSÜ (2026-08-01 genişletildi, 2026-08-02 ORDER_DRAFT eklendi,
// 2026-08-03 ORDERED eklendi / UPDATED + AWAITING_CONFIRMATION kaldırıldı):
//   DRAFT → PRICE_REQUEST ┐
//   ORDER_DRAFT ──────────┴→ PENDING → ORDERED → TO_BE_STOCKED → COMPLETED
//   - ORDER_DRAFT: SİPARİŞ TASLAĞI — fiyatlı, kaydedilmiş ama ONAYLANMAMIŞ
//     sipariş. "Kaydet" bunu yazar; sipariş ancak "Onayla" ile resmîleşir
//     (kullanıcı isteği 2026-08-02) ve o andan sonra düzenlenemez.
//   - DRAFT: TALEP TASLAĞI — fiyatsız, kaydedilmiş ama HENÜZ GÖNDERİLMEMİŞ
//     fiyat talebi.
//   - PRICE_REQUEST: GÖNDERİLMİŞ fiyat talebi — fiyatsız satırlar (seri no + ad
//     + miktar) tedarikçiye soruldu. Talep maili GERÇEKTEN gönderilince taslak
//     kendiliğinden buraya ilerler. "Onay bekleniyor" AYRI BİR DURUM DEĞİLDİR
//     (kullanıcı isteği 2026-08-03: sipariş taslağıyla aynı şeyi anlatıyordu).
//   - PENDING: SİPARİŞ ONAYLANDI — kayıt resmîleşti ve kilitlendi, ama tedarikçiye
//     MAİL HENÜZ GİTMEDİ (kullanıcı isteği 2026-08-03). Mal kabul bu aşamada da
//     açılabilir, arayüz önce "mail gönderilmedi" uyarısı sorar.
//   - ORDERED: SİPARİŞ VERİLDİ — sipariş maili tedarikçiye GERÇEKTEN gönderildi
//     (mail gönderimi PENDING → ORDERED yapar; preview gönderim saymaz).
//   - TO_BE_STOCKED: mal kabul — satırlar receive endpoint'iyle tek tek/toplu stoğa
//     gönderilir; sipariş maili göndermek bu durumu DEĞİŞTİRMEZ.
//   - COMPLETED: stoğa aktarıldı (receive `complete` ya da mark-stocked).
// UPDATED durumu KALDIRILDI (kullanıcı isteği 2026-08-03): mail sonrası içerik
// değişikliği artık yalnızca `revision`ı artırır, durumu geri almaz.

const PO_STATUSES = new Set(['DRAFT', 'ORDER_DRAFT', 'PRICE_REQUEST', 'PENDING', 'ORDERED', 'TO_BE_STOCKED', 'COMPLETED']);
// Yeni sipariş bu durumlardan biriyle açılabilir: fiyat talebi taslağı,
// SİPARİŞ TASLAĞI (kaydet) ya da doğrudan resmî sipariş (onayla).
const PO_INITIAL_STATUSES = new Set(['DRAFT', 'ORDER_DRAFT', 'PRICE_REQUEST', 'PENDING']);
// FİYAT TALEBİ AŞAMALARI — satırlar fiyatsızdır, belge "Preisanfrage"dir.
// Frontend eşi: `utils/orderStatus.ts` → `isPriceRequestStage`.
const PO_PRICE_REQUEST_STATUSES = new Set(['DRAFT', 'PRICE_REQUEST']);
// Satır hesap kipleri: AUTO hesaplar, DIRECT gönderileni saklar (eski directCopy),
// SUPPLIER tedarikçi hesabından gelen SABİT net birim fiyatla çarpar (indirim kilitli).
const PO_CALC_MODES = new Set(['AUTO', 'DIRECT', 'SUPPLIER']);
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
// HESAP SIRASI (kullanıcı isteği 2026-07-30 — eski davranış HATALIYDI):
//   1. brüt birim fiyat × miktar   → BRÜT satır tutarı
//   2. − indirim                   → ilk indirim BRÜT tutarın üzerine iner
//   3. − indirim 2 / 3             → her ek indirim zaten indirimli tutara iner
//   4. net tutar × KDV oranı       → satır KDV'si
// Eskiden indirimler GÖNDERİLEN net fiyatın üzerine inerdi (brüt 100 / net 90 /
// indirim %20 → 72; doğrusu 80). Artık **brüt fiyat tek fiyat girişidir** ve
// `netPrice` indirimlerden TÜRETİLİR — istekte ne gelirse gelsin yeniden
// hesaplanır, yalnızca brüt fiyat boşsa taban olarak kullanılır (eski kayıtlar
// ve tek fiyat taşıyan içe aktarımlar).
//
// HESAP KİPLERİ (`calcMode`, 2026-08-01 — `directCopy` bayrağının genellemesi):
//   AUTO     → yukarıdaki hesap: brüt fiyat tek giriştir, net TÜRETİLİR.
//   DIRECT   → hesap ATLANIR: net birim fiyat ve satır tutarı gönderildiği gibi
//              saklanır, 2 haneye bile YUVARLANMAZ (tedarikçi listeleri 3 ondalık
//              kullanabilir). Gönderilen bir net fiyat ZATEN indirimlidir, bu
//              yüzden yüzdeler onun üzerine İNMEZ — belgeden gelen nottur.
//              YALNIZCA net fiyat hiç gelmemişse (brüt fiyat + indirim girilmiş
//              satır) fiyat indirimden türetilir, aksi hâlde satır 0 kaydedilirdi.
//              Eski `directCopy: true` bayrağı bu kipe eşlenir ve geriye
//              uyumluluk için snapshot'ta da korunur.
//   SUPPLIER → tedarikçi hesabı: NET BİRİM FİYAT SABİTTİR (tedarikçi kartındaki
//              son alış fiyatı), indirim kilitlidir ve tutarı etkilemez; satır
//              tutarı miktarla ORANTILI büyür (miktar × sabit net fiyat).
// Satır KDV'si her kipte tek türetilen değerdir (tutar × oran) — KDV sütunu ORAN
// taşır. Kip anlık görüntüde saklanır ki düzenlemede tablo aynı kiple açılsın.
//
// MAL KABUL: `receivedQuantity` / `receivedAt` receive endpoint'inin yazdığı
// alanlardır; düzenleme sırasında gönderilen değerler AYNEN korunur ki bir
// PATCH kabul geçmişini silmesin (kırpma: 0 ≤ received ≤ miktar).
//
// ⚠ Frontend eşi: `pages/inventory/utils/orderPricing.ts` → `computeOrderLine`
// ve `OrderCreatePage.tsx` → `rowFigures` (kip dalları).
const normalizePurchaseOrderItems = (raw: unknown) => {
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('Sipariş için en az bir ürün satırı gereklidir.');
    if (raw.length > 500) throw new Error('Bir siparişe en fazla 500 satır eklenebilir.');
    const items = raw.map((r: any, index: number) => {
        const name = String(r?.name || '').trim();
        if (!name) throw new Error(`Satır ${index + 1}: ürün adı zorunludur.`);
        const rawQty = Number(r?.quantity);
        const quantity = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
        // Brüt fiyat satırın TEK fiyat girişidir; yalnızca boşsa net fiyat taban olur.
        const grossPrice = Number(r?.grossPrice) || Number(r?.netPrice) || 0;
        const discount = poPercent(r?.discount);
        const discount2 = poPercent(r?.discount2);
        const discount3 = poPercent(r?.discount3);
        const vatRate = poPercent(r?.vatRate);
        const requestedMode = String(r?.calcMode || '').toUpperCase();
        const calcMode = PO_CALC_MODES.has(requestedMode)
            ? requestedMode
            : (r?.directCopy === true ? 'DIRECT' : 'AUTO');
        // Üç indirim sırayla çarpılır ve BRÜT tutarın üzerine iner (yalnızca AUTO).
        const discountFactor = (1 - discount / 100) * (1 - discount2 / 100) * (1 - discount3 / 100);
        const sentNet = Number.isFinite(Number(r?.netPrice)) ? Number(r?.netPrice) : 0;
        let netPrice: number;
        let lineTotal: number;
        if (calcMode === 'DIRECT') {
            // Net fiyat GÖNDERİLMEMİŞSE (yalnızca brüt fiyat + indirim girilmiş
            // satır) fiyat İNDİRİMDEN TÜRETİLİR — eskiden 0 kaydediliyordu ve
            // girilen indirim tutara hiç yansımıyordu (kullanıcı hatası
            // 2026-08-02: "indirimli fiyatlar kaydedilmiyor"). Net fiyat
            // gönderilmişse o fiyat zaten indirimlidir: indirim İKİNCİ KEZ
            // uygulanmaz, değer aynen saklanır.
            // ⚠ Frontend eşi: `utils/orderRowMode.ts` → `draftRowFigures` DIRECT dalı.
            netPrice = sentNet || Math.round(grossPrice * discountFactor * 100) / 100;
            lineTotal = Number.isFinite(Number(r?.lineTotal))
                ? Number(r?.lineTotal)
                : Math.round(quantity * netPrice * 100) / 100;
        } else if (calcMode === 'SUPPLIER') {
            // Sabit net birim fiyat; miktar değişince tutar orantılı ölçeklenir.
            // ⚠ Birim fiyat YUVARLANMAZ (2026-08-02): 3 ondalıklı tedarikçi fiyatı
            // aynen saklanır, yalnızca satır TUTARI para olarak yuvarlanır —
            // frontend `computeOrderLine` SUPPLIER dalıyla birebir aynı kural.
            netPrice = sentNet;
            lineTotal = Math.round(quantity * sentNet * 100) / 100;
        } else {
            // AUTO: net birim fiyat TÜRETİLİR — gönderilen değer yok sayılır.
            netPrice = Math.round(grossPrice * discountFactor * 100) / 100;
            lineTotal = Math.round(quantity * grossPrice * discountFactor * 100) / 100;
        }
        // GÖSTERİLEN NET FİYAT (kullanıcı isteği 2026-08-02): tedarikçi kipinde
        // ekranda ve belgelerde TEDARİKÇİ LİSTESİNDEKİ / Excel'den gelen fiyat
        // görünür (ör. 18.98), oysa satır tutarı belgedeki tutardır (56.93) ve
        // tam duyarlıklı birim (18.9766…) ile hesaplanır — Excel'in kendi
        // yuvarlaması yüzünden ikisi birbirini tutmayabilir. `netPrice` HESABIN
        // tabanıdır, bu alan yalnızca GÖSTERİMDİR; hiçbir tutarı etkilemez.
        const rawDisplayNet = Number(r?.displayNetPrice);
        const displayNetPrice = Number.isFinite(rawDisplayNet) && rawDisplayNet > 0 ? rawDisplayNet : null;
        // Mal kabul durumu düzenlemelerde kaybolmasın diye aynen taşınır.
        const rawReceived = Number(r?.receivedQuantity);
        const receivedQuantity = Number.isFinite(rawReceived)
            ? Math.min(quantity, Math.max(0, rawReceived))
            : 0;
        const receivedAt = r?.receivedAt && !isNaN(new Date(r.receivedAt).getTime())
            ? new Date(r.receivedAt).toISOString()
            : null;
        return {
            itemType: 'PRODUCT',
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
            calcMode,
            ...(displayNetPrice !== null ? { displayNetPrice } : {}),
            ...(receivedQuantity > 0 ? { receivedQuantity, receivedAt } : {}),
            // Eski bayrak geriye uyumluluk için korunur (eski frontend sürümleri
            // ve mevcut snapshot okuyucuları DIRECT kipini bundan tanır).
            ...(calcMode === 'DIRECT' ? { directCopy: true } : {}),
        };
    });
    const totalNet = Math.round(items.reduce((sum, it) => sum + it.lineTotal, 0) * 100) / 100;
    const totalGross = Math.round(items.reduce((sum, it) => sum + it.quantity * it.grossPrice, 0) * 100) / 100;
    const totalVat = Math.round(items.reduce((sum, it) => sum + it.lineVat, 0) * 100) / 100;
    return { items, totalNet, totalGross, totalVat };
};

/**
 * Sipariş düzeyi KDV kipi: LINE = satır KDV'lerinin toplamı (eski davranış),
 * TOTAL = tek oran genel toplam üzerinden — KDV ayarları penceresinden ülke +
 * oran seçilir ve `totalVat = (totalNet + totalFees) × oran` olarak hesaplanır.
 *
 * ⚠ Frontend eşi: `orderPricing.ts` → `orderVatTotal` — birlikte güncellenmelidir.
 */
const normalizePurchaseOrderVat = (input: { vatMode?: unknown; orderVatRate?: unknown; orderVatCountry?: unknown }) => {
    const vatMode = String(input.vatMode || 'LINE').toUpperCase() === 'TOTAL' ? 'TOTAL' : 'LINE';
    const orderVatRate = poPercent(input.orderVatRate);
    const orderVatCountry = input.orderVatCountry ? String(input.orderVatCountry).trim().slice(0, 80) || null : null;
    return { vatMode, orderVatRate, orderVatCountry };
};

/**
 * TOTAL kipinde sipariş KDV'si — HESAP SIRASI (kullanıcı isteği 2026-08-02):
 *   satır tutarları toplamı + ek ücretler = MATRAH → matrah × oran = KDV.
 * Matrah da sonuç da iki ondalığa yuvarlanır (43'721.34768 → 43'721.35).
 *
 * ⚠ Frontend eşi: `orderPricing.ts` → `computeOrderTotals` / `orderVatTotal`.
 */
const purchaseOrderTotalVat = (
    vat: { vatMode: string; orderVatRate: number },
    totalNet: number,
    totalFees: number,
    lineVatSum: number,
): number => {
    if (vat.vatMode !== 'TOTAL') return lineVatSum;
    const base = Math.round((totalNet + totalFees) * 100) / 100;
    return Math.round(base * (vat.orderVatRate / 100) * 100) / 100;
};

/**
 * EK ÜCRETLER (nakliye, ambalaj, montaj…) — sipariş düzeyinde ad + tutar.
 * Kalem DEĞİLDİR: miktarı, indirimi ve KDV oranı yoktur; tutar NET kabul edilir
 * ve genel toplama olduğu gibi eklenir (`totalFees`).
 *
 * ⚠ Frontend eşi: `ErpFront/offitec-frontend/src/pages/inventory/utils/orderPricing.ts`
 * (`sumOrderFees` / `orderGrandTotal`) — ikisi birlikte güncellenmelidir.
 *
 * Adı da tutarı da boş olan satırlar (ekranda açık duran boş taslaklar) sessizce
 * atılır; tutarı olup adı olmayan satır hatadır.
 */
const normalizePurchaseOrderFees = (raw: unknown) => {
    if (raw === null || raw === undefined) return { fees: [] as Array<{ name: string; amount: number }>, totalFees: 0 };
    if (!Array.isArray(raw)) throw new Error('Ek ücretler liste olmalıdır.');
    if (raw.length > 20) throw new Error('Bir siparişe en fazla 20 ek ücret eklenebilir.');
    const fees: Array<{ name: string; amount: number }> = [];
    raw.forEach((r: any, index: number) => {
        const name = String(r?.name ?? '').trim().replace(/\s+/g, ' ');
        const rawAmount = Number(r?.amount);
        const amount = Number.isFinite(rawAmount) ? Math.round(rawAmount * 100) / 100 : 0;
        if (!name && !amount) return;
        if (!name) throw new Error(`Ek ücret ${index + 1}: ücret adı zorunludur.`);
        if (name.length > 80) throw new Error(`Ek ücret ${index + 1}: ücret adı 80 karakteri aşamaz.`);
        fees.push({ name, amount });
    });
    const totalFees = Math.round(fees.reduce((sum, fee) => sum + fee.amount, 0) * 100) / 100;
    return { fees, totalFees };
};

// DB satırı → API yanıtı: items ve ek ücret JSON'u parse edilir, itemCount eklenir.
const parsePurchaseOrderRow = (row: any) => {
    let items: any[] = [];
    try { items = JSON.parse(row.items || '[]'); } catch { items = []; }
    let additionalFees: any[] = [];
    try { additionalFees = JSON.parse(row.additionalFees || '[]'); } catch { additionalFees = []; }
    if (!Array.isArray(additionalFees)) additionalFees = [];
    return { ...row, items, additionalFees, itemCount: items.length };
};

/**
 * SİPARİŞ KODU: **BE-{yıl}-{sıra3}** — BE-2026-001, BE-2026-002 … (kullanıcı
 * isteği 2026-08-03: belge "Bestellung"dur, kod da BE- önekini taşır; arada
 * denenen AU- öneki geri alındı). Tenant başına max-scan (MaintenanceRepository
 * emsali). Yalnızca ÖNERİDİR: kullanıcı sipariş kodunu elle değiştirebilir
 * (create ve patch gövdesinde `referenceNumber`), benzersizliği DB indeksi korur.
 *
 * ⚠ TARAMA HER İKİ ÖNEKİ DE OKUR (BE- ve eski AU-), YAZMA yalnızca BE- yapar:
 * böylece AU-2026-004'ten sonraki sipariş BE-2026-005 olur — kullanıcının daha
 * önce gördüğü bir sıra numarası ikinci kez dağıtılmaz. Eski dört haneli
 * BE-2026-0001 kayıtları da sayısal olarak taranır (0001 → sıra 1).
 * ⚠ `PO_REFERENCE_PREFIX`, `PO_REFERENCE_SEQ_PAD` ve `PO_REFERENCE_SCAN_RE`
 * BİRLİKTE değişmelidir — regex öneki bulamazsa sıra her seferinde 1'e döner
 * ve P2002 çakışmasıyla kaydetme başarısız olur.
 */
const PO_REFERENCE_PREFIX = 'BE-';
const PO_REFERENCE_SEQ_PAD = 3;
const PO_REFERENCE_SCAN_RE = /^(?:BE|AU)-\d{4}-(\d+)$/;
const nextPurchaseOrderReference = async (tenantId: string): Promise<string> => {
    const year = new Date().getFullYear();
    const prefix = `${PO_REFERENCE_PREFIX}${year}-`;
    const rows = await (prisma as any).purchaseOrder.findMany({
        where: {
            tenantId,
            OR: [
                { referenceNumber: { startsWith: prefix } },
                { referenceNumber: { startsWith: `AU-${year}-` } },
            ],
        },
        select: { referenceNumber: true },
    });
    const max = rows.reduce((value: number, row: any) => {
        const m = PO_REFERENCE_SCAN_RE.exec(row.referenceNumber || '');
        return m ? Math.max(value, Number(m[1]) || 0) : value;
    }, 0);
    // 999'dan sonra doğal olarak dört haneye taşar (BE-2026-1000).
    return `${prefix}${String(max + 1).padStart(PO_REFERENCE_SEQ_PAD, '0')}`;
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
 * ── ANSCHREIBEN (ön yazı) ───────────────────────────────────────────────────
 * PDF'in ilk sayfasında pozisyon tablosundan önce basılan hitap + giriş metni.
 * DÜZ METİNDİR: satır sonları korunur, HTML yorumlanmaz. Boş gönderilirse NULL
 * yazılır ve PDF şablonunun KENDİ standart metni basılır — "varsayılan metin"
 * belgede yaşar, kayıtta değil (kullanıcı isteği 2026-08-02).
 */
/**
 * ALICI ADI ("Empfänger" / z.Hd.) — opsiyonel, TEK SATIR. PDF'in alıcı bloğunda
 * firma adının altına küçük puntoyla basılır, bu yüzden kısa tutulur: satır
 * sonları boşluğa iner ve 120 karakterde kesilir.
 */
const poRecipientName = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const name = String(value).replace(/[\r\n]+/g, ' ').trim().replace(/\s+/g, ' ');
    return name ? name.slice(0, 120) : null;
};

const PO_COVER_LETTER_MAX = 4000;
const poCoverLetter = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    // Yalnızca satır sonu bırakan boşluklar temizlenir; iç girinti korunur.
    const text = String(value).replace(/\r\n/g, '\n').trim();
    if (!text) return null;
    return text.slice(0, PO_COVER_LETTER_MAX);
};

// ── Ön yazı TASLAKLARI (tenant geneli) ──────────────────────────────────────
// Teklif tarafındaki `TenderTextTemplate` emsali: kayıt siparişe değil TENANT'a
// bağlıdır, her siparişin detay penceresinden seçilip uygulanabilir. Liste
// sayfalıdır (arayüz 15'erli gösterir) — sayfalama sunucuda yapılır ki taslak
// sayısı büyüdükçe pencere yavaşlamasın.
//
// ⚠ Sıra önemli: bu yollar `/purchase-orders/:id` GET'inden ÖNCE tanımlanmalıdır,
// aksi hâlde "text-templates" bir sipariş kimliği sanılır.

/**
 * @swagger
 * /inventory/purchase-orders/text-templates:
 *   get:
 *     tags: [Inventory]
 *     summary: Sipariş ön yazı taslakları (sayfalı)
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/purchase-orders/text-templates',
    requireAuth,
    requirePermission('inventory.view'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const page = Math.max(1, Number(req.query.page) || 1);
            const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 15));
            const [rows, total] = await Promise.all([
                (prisma as any).purchaseOrderTextTemplate.findMany({
                    where: { tenantId },
                    orderBy: { updatedAt: 'desc' },
                    skip: (page - 1) * pageSize,
                    take: pageSize,
                }),
                (prisma as any).purchaseOrderTextTemplate.count({ where: { tenantId } }),
            ]);
            res.status(200).json({ items: rows, total, page, pageSize });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/purchase-orders/text-templates:
 *   post:
 *     tags: [Inventory]
 *     summary: Ön yazı taslağı kaydet
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/purchase-orders/text-templates',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const title = String(req.body?.title ?? '').trim().slice(0, 191);
            if (!title) return res.status(400).json({ error: 'Taslak başlığı zorunludur.' });
            const content = poCoverLetter(req.body?.content);
            if (!content) return res.status(400).json({ error: 'Taslak metni boş olamaz.' });
            const template = await (prisma as any).purchaseOrderTextTemplate.create({
                data: { id: nanoid(12), tenantId, title, content, createdBy: req.user!.id || null },
            });
            res.status(201).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/purchase-orders/text-templates/{templateId}:
 *   patch:
 *     tags: [Inventory]
 *     summary: Ön yazı taslağını güncelle
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/purchase-orders/text-templates/:templateId',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const templateId = String(req.params.templateId);
            const existing = await (prisma as any).purchaseOrderTextTemplate.findFirst({
                where: { id: templateId, tenantId },
                select: { id: true },
            });
            if (!existing) return res.status(404).json({ error: 'Taslak bulunamadı.' });
            const data: any = {};
            if (req.body?.title !== undefined) {
                const title = String(req.body.title ?? '').trim().slice(0, 191);
                if (!title) return res.status(400).json({ error: 'Taslak başlığı zorunludur.' });
                data.title = title;
            }
            if (req.body?.content !== undefined) {
                const content = poCoverLetter(req.body.content);
                if (!content) return res.status(400).json({ error: 'Taslak metni boş olamaz.' });
                data.content = content;
            }
            if (!Object.keys(data).length) return res.status(400).json({ error: 'Güncellenecek alan yok.' });
            const template = await (prisma as any).purchaseOrderTextTemplate.update({ where: { id: templateId }, data });
            res.status(200).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);

/**
 * @swagger
 * /inventory/purchase-orders/text-templates/{templateId}:
 *   delete:
 *     tags: [Inventory]
 *     summary: Ön yazı taslağını sil
 *     security:
 *       - bearerAuth: []
 */
router.delete(
    '/purchase-orders/text-templates/:templateId',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const templateId = String(req.params.templateId);
            const existing = await (prisma as any).purchaseOrderTextTemplate.findFirst({
                where: { id: templateId, tenantId },
                select: { id: true },
            });
            if (!existing) return res.status(404).json({ error: 'Taslak bulunamadı.' });
            await (prisma as any).purchaseOrderTextTemplate.delete({ where: { id: templateId } });
            res.status(200).json({ message: 'Taslak silindi.', templateId });
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
                recipientName: string | null;
                coverLetter: string | null;
                currency: string;
                status: string;
                vatMode: string;
                orderVatRate: number;
                orderVatCountry: string | null;
                supplierId: string | null;
                supplierName: string;
                supplierEmail: string | null;
                supplierAddress: string | null;
                items: any[];
                additionalFees: Array<{ name: string; amount: number }>;
                totalNet: number;
                totalGross: number;
                totalVat: number;
                totalFees: number;
            }>;
            for (const raw of rawOrders) {
                const { items, totalNet, totalGross, totalVat } = normalizePurchaseOrderItems(raw?.items);
                const { fees, totalFees } = normalizePurchaseOrderFees(raw?.additionalFees);
                const vat = normalizePurchaseOrderVat(raw || {});
                const supplier = await resolvePurchaseOrderSupplier(tenantId, raw || {});
                // Üç giriş yolu: taslak (DRAFT), fiyat talebi (PRICE_REQUEST — satırlar
                // fiyatsız olabilir), doğrudan sipariş (PENDING, varsayılan).
                const requestedStatus = String(raw?.status || 'PENDING').toUpperCase();
                if (!PO_INITIAL_STATUSES.has(requestedStatus)) {
                    throw new Error('Yeni sipariş yalnızca DRAFT, PRICE_REQUEST veya PENDING durumuyla açılabilir.');
                }
                prepared.push({
                    // Boş bırakılırsa sunucu BE-{yıl}-{sıra} üretir.
                    referenceNumber: raw?.referenceNumber ? normalizeReferenceNumber(raw.referenceNumber) : null,
                    quoteNumber: raw?.quoteNumber ? String(raw.quoteNumber).trim() || null : null,
                    orderedByName: raw?.orderedByName ? String(raw.orderedByName).trim() || null : null,
                    projectName: raw?.projectName ? String(raw.projectName).trim() || null : null,
                    // Alıcı adı opsiyoneldir; boşsa PDF bloğu bugünkü hâlinde kalır.
                    recipientName: poRecipientName(raw?.recipientName),
                    // Boş ön yazı NULL yazılır: PDF standart metnine döner.
                    coverLetter: poCoverLetter(raw?.coverLetter),
                    currency: raw?.currency ? String(raw.currency) : 'CHF',
                    status: requestedStatus,
                    ...vat,
                    ...supplier,
                    items,
                    additionalFees: fees,
                    totalNet,
                    totalGross,
                    totalVat: purchaseOrderTotalVat(vat, totalNet, totalFees, totalVat),
                    totalFees,
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
                                recipientName: order.recipientName,
                                coverLetter: order.coverLetter,
                                status: order.status,
                                vatMode: order.vatMode,
                                orderVatRate: order.orderVatRate,
                                orderVatCountry: order.orderVatCountry,
                                supplierId: order.supplierId,
                                supplierName: order.supplierName,
                                supplierEmail: order.supplierEmail,
                                supplierAddress: order.supplierAddress,
                                items: JSON.stringify(order.items),
                                additionalFees: JSON.stringify(order.additionalFees),
                                currency: order.currency,
                                totalNet: order.totalNet,
                                totalGross: order.totalGross,
                                totalVat: order.totalVat,
                                totalFees: order.totalFees,
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
 *     summary: Siparişi düzenle (ad değişikliği durumu etkilemez; mail sonrası içerik değişikliği revizyonu artırır)
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

            // Üstbilgi alanları (kod, teklif no, Bestellung, proje) durumu ETKİLEMEZ —
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
            // Alıcı adı da üstbilgi alanıdır (PDF'te görünür, tutarı etkilemez).
            if (b.recipientName !== undefined) {
                data.recipientName = poRecipientName(b.recipientName);
            }
            // ÖN YAZI da üstbilgi alanıdır: proje adı gibi PDF'te görünür ama
            // tedarikçinin ödeyeceği tutarı değiştirmediği için siparişi
            // "güncellendi" durumuna DÜŞÜRMEZ.
            if (b.coverLetter !== undefined) {
                data.coverLetter = poCoverLetter(b.coverLetter);
            }
            const vatChanged = b.vatMode !== undefined || b.orderVatRate !== undefined || b.orderVatCountry !== undefined;
            const wantsContentChange = b.items !== undefined || b.currency !== undefined
                || b.additionalFees !== undefined || vatChanged
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
            // Ek ücretler tedarikçinin ödeyeceği tutarı değiştirir → içerik değişikliği.
            if (b.additionalFees !== undefined) {
                const { fees, totalFees } = normalizePurchaseOrderFees(b.additionalFees);
                data.additionalFees = JSON.stringify(fees);
                data.totalFees = totalFees;
                contentChanged = true;
            }
            // KDV kipi / oranı / ülkesi — tedarikçinin ödeyeceği tutarı değiştirir.
            if (vatChanged) {
                const vat = normalizePurchaseOrderVat({
                    vatMode: b.vatMode !== undefined ? b.vatMode : existing.vatMode,
                    orderVatRate: b.orderVatRate !== undefined ? b.orderVatRate : existing.orderVatRate,
                    orderVatCountry: b.orderVatCountry !== undefined ? b.orderVatCountry : existing.orderVatCountry,
                });
                data.vatMode = vat.vatMode;
                data.orderVatRate = vat.orderVatRate;
                data.orderVatCountry = vat.orderVatCountry;
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
            // KDV toplamı üç girdinin fonksiyonu (satırlar, ek ücretler, KDV ayarı) —
            // hangisi değişirse değişsin efektif değerlerle yeniden hesaplanır.
            // TOTAL kipinde satır KDV toplamı yerine (net + ücretler) × oran yazılır.
            if (vatChanged || b.items !== undefined || b.additionalFees !== undefined) {
                let lineVatSum: number;
                if (b.items !== undefined) {
                    lineVatSum = data.totalVat;
                } else {
                    let parsedItems: any[] = [];
                    try { parsedItems = JSON.parse(existing.items || '[]'); } catch { parsedItems = []; }
                    lineVatSum = Math.round(parsedItems.reduce((sum, it) => sum + (Number(it?.lineVat) || 0), 0) * 100) / 100;
                }
                data.totalVat = purchaseOrderTotalVat(
                    {
                        vatMode: data.vatMode ?? existing.vatMode ?? 'LINE',
                        orderVatRate: data.orderVatRate ?? existing.orderVatRate ?? 0,
                    },
                    data.totalNet ?? existing.totalNet ?? 0,
                    data.totalFees ?? existing.totalFees ?? 0,
                    lineVatSum,
                );
            }
            if (!Object.keys(data).length) return res.status(400).json({ error: 'Güncellenecek alan yok.' });

            // REVİZYON: mail atılmış (tedarikçinin elindeki PDF eskimiş) ve HENÜZ
            // MAL KABULE GEÇMEMİŞ siparişlerde içerik değişikliği `revision`ı
            // artırır — sonraki mail "güncellendi" etiketi taşır. Ad değişikliği
            // bu bloğa hiç girmez. DURUM ARTIK DEĞİŞMEZ: "Aktualisiert" (UPDATED)
            // durumu kaldırıldı (kullanıcı isteği 2026-08-03), sipariş verilmiş
            // olarak (ORDERED) kalır. Fiyat talebi aşamasındaki ve TO_BE_STOCKED'daki
            // değişiklikler revizyon da üretmez (kullanıcı akışı 2026-08-02).
            const stageTakesRevision = existing.status === 'PENDING' || existing.status === 'ORDERED';
            if (contentChanged && existing.emailSentAt && stageTakesRevision) {
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
 *     summary: Sipariş durumunu elle değiştir (COMPLETED dışındaki durumlar arasında serbest geçiş)
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
            // COMPLETED yalnızca mal kabul (receive) / mark-stocked ile yazılır; buradan
            // ne COMPLETED'a geçilebilir ne de COMPLETED'dan çıkılabilir. Diğer durumlar
            // arasında geçiş serbesttir (onay = ORDER_DRAFT → PENDING; geri alma
            // dahil — kullanıcı akışı yönetir).
            if (!PO_STATUSES.has(status) || status === 'COMPLETED') {
                return res.status(400).json({ error: 'Geçersiz durum.' });
            }
            if (existing.status === 'COMPLETED') {
                return res.status(400).json({ error: 'Tamamlanmış siparişin durumu değiştirilemez.' });
            }
            // FİYAT TALEBİNDEN DOĞRUDAN RESMÎ SİPARİŞE GEÇİLEMEZ (kullanıcı isteği
            // 2026-08-02): talep fiyatsızdır ve onaylanan sipariş kilitlendiği için
            // fiyatı bir daha girilemezdi. Yol: talep → ORDER_DRAFT (siparişe
            // dönüştür, fiyat + KDV girilir) → PENDING (siparişi oluştur).
            if ((status === 'PENDING' || status === 'ORDERED') && PO_PRICE_REQUEST_STATUSES.has(existing.status)) {
                return res.status(400).json({
                    error: 'Fiyat talebi doğrudan siparişe çevrilemez: önce sipariş taslağına dönüştürün ve fiyatları girin.',
                });
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
 * /inventory/purchase-orders/{id}/receive:
 *   post:
 *     tags: [Inventory]
 *     summary: Mal kabul — sipariş satırlarını stoğa aktar (tek satır, seçili satırlar ya da tamamı)
 *     security:
 *       - bearerAuth: []
 */
// Mal kabul (goods receipt, 2026-08-01). Satır stoğa TEK İSTEKTE atomik aktarılır:
// stok hareketi (IN, referenceId = sipariş id'si — hareket dökümünde siparişin
// parçası olarak görünür) + bakiye + tedarikçi partisi + siparişin
// `receivedQuantity` alanı birlikte yazılır; movements/bulk + ayrı durum PATCH'i
// ikilisi yarıda kalıp stok ile sipariş kabul durumunu ayrıştırabilirdi.
//
// Gövde: { lines?: [{ index, quantity?, unitCost? }], complete?: boolean }
//   - lines: satır indeksleri (tek ok = 1 satır, seçili gönder = n satır).
//     quantity verilmezse satırın KALAN miktarı aktarılır.
//   - complete: "mal kabulü tamamla" — lines yok sayılır, kalan TÜM satırlar
//     aktarılır ve sipariş doğrudan COMPLETED (stoğa aktarıldı) olur.
// Sipariş kartında olmayan ürünler (kod eşleşmedi) otomatik ürün olarak açılır
// (kodsuz satır hata verir — kod ürün kimliğidir). Tüm satırlar aktarılınca
// durum kendiliğinden COMPLETED + stockedAt olur, aksi halde TO_BE_STOCKED kalır.
router.post(
    '/purchase-orders/:id/receive',
    requireAuth,
    requirePermission('inventory.transfer'),
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const existing = await (prisma as any).purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
            if (!existing) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
            if (existing.status === 'COMPLETED') {
                return res.status(400).json({ error: 'Sipariş zaten stoğa aktarılmış.' });
            }

            let items: any[] = [];
            try { items = JSON.parse(existing.items || '[]'); } catch { items = []; }
            if (!items.length) return res.status(400).json({ error: 'Siparişte aktarılacak satır yok.' });

            const complete = req.body?.complete === true;
            const rawLines: any[] = Array.isArray(req.body?.lines) ? req.body.lines : [];
            if (!complete && !rawLines.length) return res.status(400).json({ error: 'Aktarılacak satır seçilmedi.' });

            const remainingOf = (item: any) => Math.max(0, (Number(item.quantity) || 0) - (Number(item.receivedQuantity) || 0));

            // Plan: satır indeksi → aktarılacak miktar (+ opsiyonel birim maliyet).
            const plan = new Map<number, { quantity: number; unitCost: number | null }>();
            if (complete) {
                items.forEach((item, index) => {
                    const remaining = remainingOf(item);
                    if (remaining > 0) plan.set(index, { quantity: remaining, unitCost: null });
                });
                if (!plan.size) return res.status(400).json({ error: 'Tüm satırlar zaten stoğa aktarılmış.' });
            } else {
                for (const line of rawLines) {
                    const index = Number(line?.index);
                    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
                        return res.status(400).json({ error: `Geçersiz satır indeksi: ${line?.index}` });
                    }
                    const remaining = remainingOf(items[index]);
                    if (remaining <= 0) continue; // zaten aktarılmış satır sessizce atlanır
                    const requested = Number(line?.quantity);
                    const quantity = Number.isFinite(requested) && requested > 0 ? Math.min(requested, remaining) : remaining;
                    const rawCost = Number(line?.unitCost);
                    plan.set(index, { quantity, unitCost: Number.isFinite(rawCost) && rawCost > 0 ? rawCost : null });
                }
                if (!plan.size) return res.status(400).json({ error: 'Seçilen satırların tamamı zaten stoğa aktarılmış.' });
            }

            // Ürün çözümü: önce articleId, sonra kod. Bulunamayan KODLU satırlar
            // otomatik ürün olarak açılır; kodsuz satır aktarılamaz (kod = kimlik).
            const planItems = Array.from(plan.keys()).map((index) => items[index]);
            const wantedIds = planItems.map((it) => (it.articleId ? String(it.articleId) : null)).filter(Boolean) as string[];
            const wantedCodes = planItems.map((it) => String(it.code || '').trim()).filter(Boolean);
            const [defaultLocation, articleRows, supplierRow] = await Promise.all([
                repository.ensureDefaultLocation(tenantId),
                wantedIds.length || wantedCodes.length
                    ? (prisma as any).article.findMany({
                        where: {
                            tenantId,
                            deletedAt: null,
                            OR: [
                                ...(wantedIds.length ? [{ id: { in: wantedIds } }] : []),
                                ...(wantedCodes.length ? [{ articleCode: { in: wantedCodes } }] : []),
                            ],
                        },
                        select: { id: true, articleCode: true },
                    })
                    : Promise.resolve([]),
                existing.supplierId
                    ? (prisma as any).supplier.findFirst({ where: { id: existing.supplierId, tenantId }, select: { id: true } })
                    : Promise.resolve(null),
            ]) as [any, any[], any];
            const articleById = new Map<string, any>(articleRows.map((row: any) => [row.id, row]));
            const articleByCode = new Map<string, any>(articleRows.map((row: any) => [row.articleCode, row]));
            const supplierId = supplierRow?.id || null;

            const errors: Array<{ index: number; error: string }> = [];
            const articleCreates: any[] = [];
            const movementCreates: any[] = [];
            const lotCreates: any[] = [];
            const deltaByArticle = new Map<string, number>();
            const preferredByArticle = new Map<string, { supplierId: string; purchasePrice: number }>();
            const received: Array<{ index: number; quantity: number }> = [];
            const now = new Date();

            for (const [index, entry] of plan) {
                const item = items[index];
                const code = String(item.code || '').trim();
                let article = item.articleId ? articleById.get(String(item.articleId)) : undefined;
                if (!article && code) article = articleByCode.get(code);
                if (!article) {
                    if (!code) {
                        errors.push({ index, error: 'Satırın ürün kodu yok; stoğa aktarılamaz.' });
                        continue;
                    }
                    // Otomatik ürün açılışı (mal kabulden gelen tanım) — bulk ürün
                    // girişindeki alan seti, miktar hareketi aşağıda ayrıca yazılır.
                    article = { id: nanoid(10), articleCode: code };
                    articleCreates.push({
                        id: article.id,
                        tenantId,
                        articleCode: code,
                        name: String(item.name || code),
                        unit: item.unit ? String(item.unit) : 'Adet',
                        baseCost: entry.unitCost ?? (Number(item.netPrice) > 0 ? Number(item.netPrice) : 0),
                        salePrice: 0,
                        defaultSupplierId: supplierId,
                        itemType: 'PRODUCT',
                        status: 'ACTIVE',
                        isActive: true,
                        lastPurchaseDate: now,
                    });
                    articleByCode.set(code, article);
                }
                // Birim maliyet: satırdan gelmezse siparişteki NET birim fiyat
                // (ağırlıklı ortalama maliyeti sipariş gerçeğiyle besler).
                const unitCost = entry.unitCost ?? (Number(item.netPrice) > 0 ? Number(item.netPrice) : null);
                const movementId = nanoid(12);
                movementCreates.push({
                    id: movementId,
                    tenantId,
                    articleId: article.id,
                    movementType: 'IN',
                    quantity: entry.quantity,
                    unitCost,
                    sourceLocationId: null,
                    destinationLocationId: defaultLocation.id,
                    employeeId,
                    supplierId,
                    // Hareket dökümünde siparişin parçası olarak görünür.
                    referenceId: existing.id,
                    // AÇIKLAMA = YALNIZCA TEDARİKÇİ ADI (kullanıcı isteği
                    // 2026-08-02): stok hareketleri listesinde "malı kimden
                    // aldık" okunur olsun. Sipariş bağlantısı `referenceId` ile
                    // zaten duruyor, bu yüzden "Wareneingang {Bestellung}" metni
                    // kaldırıldı; tedarikçi adı yoksa alan boş bırakılır.
                    description: existing.supplierName ? String(existing.supplierName).trim() || null : null,
                    transactionDate: now,
                });
                deltaByArticle.set(article.id, (deltaByArticle.get(article.id) ?? 0) + entry.quantity);
                if (supplierId) {
                    const purchasePrice = unitCost && unitCost > 0 ? unitCost : 0;
                    lotCreates.push({
                        id: nanoid(10),
                        tenantId,
                        articleId: article.id,
                        supplierId,
                        locationId: defaultLocation.id,
                        purchasePrice,
                        quantity: entry.quantity,
                        remainingQuantity: entry.quantity,
                        lastPurchaseDate: now,
                        stockMovementId: movementId,
                        isPreferred: true,
                    });
                    preferredByArticle.set(article.id, { supplierId, purchasePrice });
                }
                item.articleId = article.id;
                item.receivedQuantity = Math.min(Number(item.quantity) || 0, (Number(item.receivedQuantity) || 0) + entry.quantity);
                item.receivedAt = now.toISOString();
                received.push({ index, quantity: entry.quantity });
            }

            if (!movementCreates.length) {
                return res.status(400).json({ error: errors[0]?.error || 'Aktarılabilecek satır yok.', errors });
            }

            const allReceived = items.every((item) => remainingOf(item) <= 0);
            const updated = await (prisma as any).$transaction(async (tx: any) => {
                if (articleCreates.length) await tx.article.createMany({ data: articleCreates });
                await tx.stockMovement.createMany({ data: movementCreates });
                await bulkApplyStockBalanceDeltas(tx, tenantId, defaultLocation.id, deltaByArticle);
                if (lotCreates.length) {
                    await tx.articleSupplier.updateMany({
                        where: { tenantId, articleId: { in: Array.from(preferredByArticle.keys()) } },
                        data: { isPreferred: false },
                    });
                    await tx.articleSupplier.createMany({ data: lotCreates });
                    await bulkUpdateArticlePurchases(tx, tenantId, preferredByArticle);
                }
                return tx.purchaseOrder.update({
                    where: { id: existing.id },
                    data: {
                        items: JSON.stringify(items),
                        // Kısmî kabul siparişi "mal kabul" aşamasında tutar; son satır
                        // da aktarılınca sipariş kendiliğinden stoğa aktarıldı olur.
                        status: allReceived ? 'COMPLETED' : 'TO_BE_STOCKED',
                        ...(allReceived ? { stockedAt: now } : {}),
                    },
                });
            });

            res.status(200).json({
                processedCount: received.length,
                received,
                errors,
                order: parsePurchaseOrderRow(updated),
            });
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

            const settings = await prisma.mailSetting.findUnique({ where: { tenantId: await getMailTenantId(tenantId) } });

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

            // Fiyat talebi aşamasındaki siparişin maili "Preisanfrage" konusuyla
            // çıkar. DRAFT da bu aşamadadır (kaydedilmiş fiyat talebi taslağı);
            // ORDER_DRAFT ise FİYATLI bir sipariş taslağıdır → normal sipariş maili.
            const isPriceRequestMail = existing.status === 'DRAFT'
                || existing.status === 'PRICE_REQUEST';
            // Almanca belge adı "Bestellung"dur (kullanıcı isteği 2026-08-03;
            // önceki "Auftrag" geri alındı) — PDF başlığıyla ve arayüzdeki
            // sözlükle aynı kelime.
            const defaultSubject = `${isPriceRequestMail ? 'Preisanfrage' : 'Bestellung'} ${existing.referenceNumber}`;
            const subject = poStripHeader(String(req.body?.subject || defaultSubject));
            if (!subject) return res.status(400).json({ error: 'Konu boş olamaz.' });
            if (subject.length > 200) return res.status(400).json({ error: 'Konu 200 karakteri aşamaz.' });

            const message = String(req.body?.message || '').trim();
            if (message.length > 5000) return res.status(400).json({ error: 'Mesaj çok uzun.' });

            // ── CC (kullanıcı isteği 2026-08-02) ─────────────────────────────
            // ALICI (`to`) tedarikçinin adresiyle SINIRLIDIR (açık relay engeli);
            // CC ise serbesttir — takvim tarafındaki `sanitizeCcEmails` emsali:
            // kullanıcı kendi ekibinden birini ya da tedarikçinin ikinci bir
            // adresini kopyaya alabilir. Sertleştirme: başlık kırpma (CRLF
            // enjeksiyonu), biçim denetimi, ALICININ KENDİSİ elenir (aynı adrese
            // iki kopya gitmesin), tekrarlar atılır ve liste 10 adresle sınırlıdır.
            const ccSeen = new Set<string>([to.toLowerCase()]);
            const ccEmails: string[] = [];
            const rawCc = Array.isArray(req.body?.ccEmails)
                ? req.body.ccEmails
                : String(req.body?.ccEmails ?? '').split(',');
            for (const value of rawCc) {
                const email = poStripHeader(String(value ?? ''));
                if (!email || !PO_EMAIL_RE.test(email)) continue;
                const key = email.toLowerCase();
                if (ccSeen.has(key)) continue;
                ccSeen.add(key);
                ccEmails.push(email);
            }
            if (ccEmails.length > 10) return res.status(400).json({ error: 'En fazla 10 CC adresi eklenebilir.' });

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
                cc: ccEmails,
                subject,
                text: `${message}${signature.text}`,
                html,
                replyTo: settings?.replyTo || null,
                attachments,
                inlineImages: signature.inlineImages,
            });

            // preview = SMTP yapılandırılmamış, gerçek gönderim yok → emailSentAt
            // damgalanmaz; revizyon mantığı gerçek gönderime bağlıdır.
            // TALEP TASLAĞI (DRAFT) gerçekten gönderilince FİYAT TALEBİ
            // (PRICE_REQUEST) olur — "onay bekleniyor" durumu kaldırıldığı için
            // (kullanıcı isteği 2026-08-03) gönderilmiş talep artık budur.
            // ONAYLANMIŞ SİPARİŞ (PENDING) ise mail gidince "SİPARİŞ VERİLDİ"
            // (ORDERED) olur — sipariş ancak tedarikçiye mail gittiğinde
            // verilmiş sayılır.
            const statusAfterSend = existing.status === 'DRAFT'
                ? 'PRICE_REQUEST'
                : existing.status === 'PENDING'
                    ? 'ORDERED'
                    : null;
            let order = existing;
            if (!result.preview) {
                order = await (prisma as any).purchaseOrder.update({
                    where: { id: existing.id },
                    data: {
                        emailSentAt: new Date(),
                        emailRecipient: to,
                        ...(statusAfterSend ? { status: statusAfterSend } : {}),
                    },
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
