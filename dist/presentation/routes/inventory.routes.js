"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextPurchaseReference = exports.parsePurchaseOrderRow = exports.purchaseOrderTotalVat = exports.normalizePurchaseOrderItems = exports.refreshProducerProduction = exports.poLineSource = exports.supplierAddressSnapshot = exports.sendPurchaseOrderError = void 0;
const express_1 = require("express");
const InventoryController_1 = require("../controllers/InventoryController");
const InventoryRepository_1 = require("../../infrastructure/repositories/InventoryRepository");
const ProcessStockMovementUseCase_1 = require("../../application/use-cases/inventory/ProcessStockMovementUseCase");
const ManagePurchaseProposalsUseCase_1 = require("../../application/use-cases/inventory/ManagePurchaseProposalsUseCase");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const quickAddStockUnit_1 = require("../../application/services/quickAddStockUnit");
const ItGateMiddleware_1 = require("../middlewares/ItGateMiddleware");
const ResponseCacheMiddleware_1 = require("../middlewares/ResponseCacheMiddleware");
// Schnellerfassung: der markierte Bildausschnitt geht ueber den Server zu
// Google Cloud Vision — der Schluessel bleibt hier, nie im Browser.
const ocrSpaceOcr_1 = require("../../infrastructure/services/ocrSpaceOcr");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const SmtpMailService_1 = require("../../infrastructure/services/SmtpMailService");
const mailSignature_1 = require("../../infrastructure/services/mailSignature");
const postalAddress_1 = require("../../shared/postalAddress");
const purchaseDocumentCode_1 = require("../../shared/purchaseDocumentCode");
const articleImage_1 = require("../../shared/articleImage");
// Produktbilder liegen in R2 und gehen ueber die eigene Domain am Eimer
// hinaus (assets.demo.offitec.ch) — dieselbe Adresse wie die
// Terminunterlagen im Kalender. Die Spalte traegt nur den Verweis.
const ImageStore_1 = require("../../infrastructure/services/ImageStore");
const richText_1 = require("../../shared/richText");
// Mengeneinheiten: der Artikel traegt den kurzen Code als Text, gewaehlt wird
// aber aus der Liste des Mandanten (Einstellungen -> Module -> Lager).
const measurementUnitCatalog_1 = require("../../application/services/measurementUnitCatalog");
// ERP-Codes aus den Nummernkreisen der Code-Einstellungen (10.09.2026) — und
// die vorläufigen AA-BB-Codes des Wareneingangs (19.09.2026).
const articleCodeCatalog_1 = require("../../application/services/articleCodeCatalog");
// Yeni ürün formu (23.09.2026): üçlü ürün türü ve şirket türüne bağlı
// zorunlu alanlar.
const articleKind_1 = require("../../shared/articleKind");
const companyType_1 = require("../../shared/companyType");
const nanoid_1 = require("nanoid");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
const purchaseOrderImport_routes_1 = require("./purchaseOrderImport.routes");
// Produktion (19.09.2026): Pflichtauswahl Projekt + Gerät, bestätigte Zeilen.
const productionModule_1 = require("../composition/productionModule");
const producerOrders_1 = require("../../shared/producerOrders");
const standardOrderTemplate_1 = require("../../shared/standardOrderTemplate");
const ProductionPurchaseLinkService_1 = require("../../application/use-cases/production/ProductionPurchaseLinkService");
const productionErrors_1 = require("../../application/use-cases/production/productionErrors");
const purchaseOrderApproval_1 = require("../../domain/services/purchaseOrderApproval");
/**
 * Fehlerantwort der Bestellwege: fachliche Fehler der Produktion und der
 * Bestätigung tragen eine Kennung (die Oberfläche übersetzt sie), alles
 * andere bleibt, wie es war (400 + Satz).
 */
const sendPurchaseOrderError = (res, error) => {
    if ((0, productionErrors_1.isProductionError)(error))
        return res.status(error.status).json((0, productionErrors_1.productionErrorBody)(error));
    return res.status(400).json({ error: error?.message || 'Error' });
};
exports.sendPurchaseOrderError = sendPurchaseOrderError;
/** Tedarikçi adresinin ayrı bileşenleri (tek serbest metin alanı yoktur). */
const SUPPLIER_ADDRESS_FIELDS = ['address', 'addressSupplement', 'postalCode', 'city', 'state', 'country'];
/** Kayıttaki bileşenler → PDF/ekran için 2 satırlık snapshot metni. */
const supplierAddressSnapshot = (supplier) => (0, postalAddress_1.composeAddressSnapshot)({
    street: supplier?.address,
    addressSupplement: supplier?.addressSupplement,
    postalCode: supplier?.postalCode,
    city: supplier?.city,
    state: supplier?.state,
    country: supplier?.country,
});
exports.supplierAddressSnapshot = supplierAddressSnapshot;
/**
 * Tedarikçinin KDV ayarı (24.09.2026). `vatLiable` üç hâllidir: null =
 * belirtilmedi, false = KDV yok, true = ülke + oran siparişe aktarılır.
 * Yalnızca gövdede gelen alanlar döner (PATCH kısmi kalır); KDV yoksa ülke
 * ve oran temizlenir.
 */
const readSupplierVat = (body) => {
    const patch = {};
    if (body.vatLiable !== undefined) {
        patch.vatLiable = body.vatLiable === null ? null : Boolean(body.vatLiable);
    }
    if (body.vatCountry !== undefined) {
        const country = body.vatCountry ? String(body.vatCountry).trim().slice(0, 80) : '';
        patch.vatCountry = country || null;
    }
    if (body.vatRate !== undefined) {
        const rate = body.vatRate === null || body.vatRate === '' ? NaN : Number(body.vatRate);
        patch.vatRate = Number.isFinite(rate) ? Math.min(100, Math.max(0, rate)) : null;
    }
    if (patch.vatLiable === false || patch.vatLiable === null) {
        patch.vatCountry = null;
        patch.vatRate = null;
    }
    return patch;
};
const router = (0, express_1.Router)();
const smtp = new SmtpMailService_1.SmtpMailService();
const repository = new InventoryRepository_1.InventoryRepository();
const processMovementUseCase = new ProcessStockMovementUseCase_1.ProcessStockMovementUseCase(repository);
const proposalsUseCase = new ManagePurchaseProposalsUseCase_1.ManagePurchaseProposalsUseCase(repository);
const controller = new InventoryController_1.InventoryController(repository, processMovementUseCase, proposalsUseCase);
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
const supplierWithStats = async (supplier) => {
    const rows = supplier.articleSuppliers || [];
    // Ürün görselleri satırın içindeki `article` alanında gelir; verweis ->
    // assets.demo.offitec.ch adresi (bkz. ImageStore).
    await (0, ImageStore_1.resolveArticleImagesInPlace)(rows, (row) => row.article);
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
router.get('/locations', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 120 }), (req, res) => controller.listLocations(req, res));
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
router.get('/balances', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), (req, res) => controller.getBalances(req, res));
/**
 * @swagger
 * /inventory/dashboard:
 *   get:
 *     tags: [Inventory]
 *     summary: Stok dashboard (KPI, kritik stok, satın alma önerileri, lokasyonlar)
 *     security:
 *       - bearerAuth: []
 */
router.get('/dashboard', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), (req, res) => controller.getDashboard(req, res));
/**
 * @swagger
 * /inventory/articles/summary:
 *   get:
 *     tags: [Inventory]
 *     summary: Ürünleri stok bakiyeleri ile birlikte özet olarak getir
 *     security:
 *       - bearerAuth: []
 */
router.get('/articles/summary', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), (req, res) => controller.getArticleStockSummary(req, res));
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
 *       - in: query
 *         name: includeDescription
 *         schema: { type: boolean, default: false }
 *         description: >
 *           true ise her satıra ürün kartının açıklaması (`description`)
 *           eklenir. İstenmedikçe alan yanıtta HİÇ yer almaz — liste ekranı
 *           göstermediği bir metni taşımasın diye.
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, default: createdAt }
 *         description: >
 *           Listenspalte, nach der geordnet wird. `nameNatural` ist die Ordnung
 *           des Produktwählers von Offerte, Rechnung und Nachtrag: erst
 *           alphabetisch (Namen mit führender Ziffer stehen dahinter), dann die
 *           Zahlen im Namen als Zahlen — DN15 vor DN100.
 *       - in: query
 *         name: sortDirection
 *         schema: { type: string, enum: [asc, desc], default: desc }
 */
router.get('/articles/summary/paged', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), 
// Produktwähler + Produktliste: Redis-Lesespeicher, ungültig bei jeder
// Schreibanfrage, die Artikel oder Bestand berührt (Bereich `catalog`).
(0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 120 }), (req, res) => controller.getArticleStockSummaryPaged(req, res));
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
router.get('/articles/:id/stock', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), (req, res) => controller.getArticleStockInfo(req, res));
/**
 * Bir ürünün AÇIK sipariş adedi: henüz stoğa alınmamış satın alma
 * siparişlerindeki (PENDING | ORDERED | TO_BE_STOCKED) satır miktarlarının
 * toplamı. Sipariş satırları JSON snapshot olduğu için SQL ile toplanamaz;
 * bu yüzden yalnızca açık siparişlerin `items` kolonu çekilip taranır.
 * Siparişi olmayan ürün 0 döner.
 */
const openOrderQuantityFor = async (tenantId, articleId, articleCode) => {
    const orders = await prisma_client_1.default.purchaseOrder.findMany({
        where: { tenantId, status: { in: ['PENDING', 'ORDERED', 'TO_BE_STOCKED'] } },
        select: { items: true },
    });
    let total = 0;
    for (const order of orders) {
        let lines;
        try {
            lines = JSON.parse(order.items || '[]');
        }
        catch {
            continue; // Bozuk snapshot tek siparişi atlar, isteği düşürmez.
        }
        if (!Array.isArray(lines))
            continue;
        for (const line of lines) {
            const matches = line?.articleId
                ? line.articleId === articleId
                : Boolean(articleCode) && String(line?.code || '') === articleCode;
            if (matches)
                total += Math.max(0, Number(line?.quantity) || 0);
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
const articleSupplierCostRows = async (tenantId, articleId) => {
    // İki kaynağın bütün alım satırlarını Node'a taşımak yerine MySQL'de UNION
    // edip tedarikçi bazında topluyoruz. Yanıt büyüklüğü kayıt sayısına değil,
    // yalnızca ilgili ürünün tedarikçi sayısına bağlı kalır.
    const rawRows = await prisma_client_1.default.$queryRawUnsafe(`SELECT s.\`id\` AS supplierId,
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
         GROUP BY s.\`id\`, s.\`companyName\``, tenantId, articleId, tenantId, articleId, tenantId);
    const rows = rawRows.map((row) => {
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
const articleCostSummary = async (tenantId, articleId) => {
    const [links, movements] = await Promise.all([
        prisma_client_1.default.articleSupplier.findMany({
            where: { tenantId, articleId },
            select: { supplierId: true, quantity: true, purchasePrice: true },
        }),
        prisma_client_1.default.stockMovement.findMany({
            where: { tenantId, articleId, supplierId: { not: null }, movementType: 'IN', quantity: { gt: 0 } },
            select: { supplierId: true, quantity: true, unitCost: true },
        }),
    ]);
    let quantity = 0;
    let totalCost = 0;
    const supplierIds = new Set();
    const add = (supplierId, rawQuantity, rawUnitCost) => {
        const rowQuantity = Math.max(0, Number(rawQuantity) || 0);
        const unitCost = Math.max(0, Number(rawUnitCost) || 0);
        quantity += rowQuantity;
        totalCost += rowQuantity * unitCost;
        if (supplierId)
            supplierIds.add(String(supplierId));
    };
    for (const link of links)
        add(link.supplierId, link.quantity, link.purchasePrice);
    for (const movement of movements)
        add(movement.supplierId, movement.quantity, movement.unitCost);
    return {
        averageUnitCost: quantity > 0 ? totalCost / quantity : 0,
        supplierCount: supplierIds.size,
    };
};
/**
 * ÜRÜNÜN TEDARİKÇİLERİ (23.09.2026) — detay formundaki çoklu seçimin kaynağı.
 * Üç yerden toplanır: alım partileri (ArticleSupplier), tedarikçisi işaretli
 * stok GİRİŞLERİ ve kartın varsayılan tedarikçisi. `locked` = alım geçmişi
 * var (adetli parti ya da giriş hareketi): formdan çıkarılamaz, geçmiş
 * silinmesin. Sıra: tercih edilen önce, sonra ilk bağlanan.
 */
const articleSupplierLinks = async (tenantId, articleId) => {
    const rows = await prisma_client_1.default.$queryRawUnsafe(`SELECT s.\`id\` AS supplierId,
                s.\`companyName\` AS companyName,
                MAX(p.preferred) AS preferred,
                MAX(p.history) AS history,
                MIN(p.firstAt) AS firstAt
         FROM (
             SELECT \`supplierId\`,
                    CASE WHEN \`isPreferred\` THEN 1 ELSE 0 END AS preferred,
                    CASE WHEN \`quantity\` > 0 OR \`remainingQuantity\` > 0 THEN 1 ELSE 0 END AS history,
                    \`createdAt\` AS firstAt
             FROM \`ArticleSupplier\`
             WHERE \`tenantId\` = ? AND \`articleId\` = ?
             UNION ALL
             SELECT \`supplierId\`, 0 AS preferred, 1 AS history, \`transactionDate\` AS firstAt
             FROM \`StockMovement\`
             WHERE \`tenantId\` = ? AND \`articleId\` = ?
               AND \`supplierId\` IS NOT NULL AND \`movementType\` = 'IN' AND \`quantity\` > 0
             UNION ALL
             SELECT \`defaultSupplierId\` AS supplierId, 1 AS preferred, 0 AS history, \`createdAt\` AS firstAt
             FROM \`Article\`
             WHERE \`tenantId\` = ? AND \`id\` = ? AND \`defaultSupplierId\` IS NOT NULL
         ) p
         INNER JOIN \`Supplier\` s ON s.\`id\` = p.supplierId
         WHERE s.\`tenantId\` = ?
         GROUP BY s.\`id\`, s.\`companyName\`
         ORDER BY preferred DESC, firstAt ASC, companyName ASC`, tenantId, articleId, tenantId, articleId, tenantId, articleId, tenantId);
    return rows.map((row) => ({
        supplierId: String(row.supplierId),
        companyName: String(row.companyName || ''),
        preferred: Number(row.preferred) > 0,
        locked: Number(row.history) > 0,
    }));
};
/** Formdan gelen tedarikçi listesi: kayıtlı olan kimliğiyle, yeni olan adıyla. */
const readSupplierRefs = (value) => (Array.isArray(value) ? value : [])
    .map((ref) => (ref?.supplierId
    ? { supplierId: String(ref.supplierId) }
    : { supplierName: String(ref?.supplierName ?? '').trim() }))
    .filter((ref) => ref.supplierId || ref.supplierName)
    .slice(0, 20);
/**
 * Detay formundaki tedarikçi listesini ürüne yazma PLANI (23.09.2026): yeni
 * gelenler miktarsız TANIM partisi olur; çıkarılanların yalnızca tanım
 * partileri silinir — alım geçmişi yerinde kalır. 24.09.2026'dan beri liste en
 * çok BİR tedarikçidir; o, kartın `defaultSupplierId`'si olur. Denetim önce,
 * yazma sonra: `apply(tx)` ürün alanlarıyla AYNI işlemde çalışır.
 */
const planArticleSupplierSync = async (tenantId, articleId, refs) => {
    const cache = new Map();
    const invalidIds = await warmSupplierCache(tenantId, refs, cache);
    if (refs.some((ref) => ref.supplierId && invalidIds.has(ref.supplierId))) {
        return { error: { status: 404, body: { error: 'Tedarikçi bulunamadı.' } } };
    }
    const desired = [...new Set(refs.map((ref) => cachedSupplier(cache, ref)?.id).filter((id) => Boolean(id)))];
    const [current, article] = await Promise.all([
        articleSupplierLinks(tenantId, articleId),
        prisma_client_1.default.article.findFirst({ where: { id: articleId, tenantId }, select: { baseCost: true, defaultSupplierId: true } }),
    ]);
    // Ürünün TEK tedarikçisi olur (Samet, 24.09.2026).
    if (desired.length > 1) {
        return { error: { status: 400, body: { error: 'Bir ürüne yalnızca bir tedarikçi atanabilir.', code: 'SUPPLIER_SINGLE' } } };
    }
    // Değiştirilen tedarikçinin yalnızca TANIM partisi silinir; alım geçmişi
    // (adetli partiler, giriş hareketleri) olduğu gibi kalır.
    const removed = current.filter((link) => !desired.includes(link.supplierId));
    const currentIds = new Set(current.map((link) => link.supplierId));
    const added = desired.filter((supplierId) => !currentIds.has(supplierId));
    const first = desired[0] ?? null;
    const preferredNow = current.find((link) => link.preferred)?.supplierId ?? null;
    const defaultChanges = (article?.defaultSupplierId ?? null) !== first;
    if (!added.length && !removed.length && first === preferredNow && !defaultChanges)
        return { apply: null };
    const location = added.length ? await repository.ensureDefaultLocation(tenantId) : null;
    return {
        apply: async (tx) => {
            if (removed.length) {
                await tx.articleSupplier.deleteMany({
                    where: {
                        tenantId,
                        articleId,
                        supplierId: { in: removed.map((link) => link.supplierId) },
                        quantity: 0,
                        remainingQuantity: 0,
                    },
                });
            }
            if (added.length) {
                await tx.articleSupplier.createMany({
                    data: added.map((supplierId) => ({
                        id: (0, nanoid_1.nanoid)(10),
                        tenantId,
                        articleId,
                        supplierId,
                        locationId: location?.id ?? null,
                        purchasePrice: Math.max(0, Number(article?.baseCost) || 0),
                        quantity: 0,
                        remainingQuantity: 0,
                        lastPurchaseDate: null,
                        stockMovementId: null,
                        isPreferred: false,
                    })),
                });
            }
            if (first !== preferredNow) {
                await tx.articleSupplier.updateMany({ where: { tenantId, articleId }, data: { isPreferred: false } });
                if (first) {
                    const lot = await tx.articleSupplier.findFirst({
                        where: { tenantId, articleId, supplierId: first },
                        orderBy: [{ lastPurchaseDate: 'desc' }, { updatedAt: 'desc' }],
                        select: { id: true },
                    });
                    if (lot)
                        await tx.articleSupplier.update({ where: { id: lot.id }, data: { isPreferred: true } });
                }
            }
            if (defaultChanges) {
                await tx.article.update({ where: { id: articleId }, data: { defaultSupplierId: first } });
            }
        },
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
const buildArticleDetail = async (tenantId, id) => {
    const [article, suppliers] = await Promise.all([
        prisma_client_1.default.article.findFirst({
            where: { id, tenantId, deletedAt: null },
            select: {
                id: true,
                articleCode: true,
                name: true,
                unit: true,
                description: true,
                salePrice: true,
                itemType: true,
                articleKind: true,
                imageUrl: true,
                updatedAt: true,
                modelNumber: true,
                serialNumber: true,
                supplierBarcode: true,
                systemBarcode: true,
                stockBalances: { select: { currentQuantity: true } },
            },
        }),
        // Detay formundaki tedarikçi seçimi (23.09.2026) — aynı anda okunur.
        articleSupplierLinks(tenantId, id),
    ]);
    if (!article)
        return null;
    return {
        id: article.id,
        articleCode: article.articleCode,
        name: article.name,
        unit: article.unit,
        // Reihenfolge im Detail (10.09.2026): ERP-Code, Bezeichnung,
        // Modellnummer, Seriennummer, Barcode.
        modelNumber: article.modelNumber ?? null,
        serialNumber: article.serialNumber ?? null,
        supplierBarcode: article.supplierBarcode ?? null,
        systemBarcode: article.systemBarcode ?? null,
        description: article.description,
        salePrice: article.salePrice ?? 0,
        itemType: article.itemType ?? 'PRODUCT',
        // Üçlü ürün türü (Üretilecek / Satılacak / Ek Hizmet); null = seçilmedi.
        articleKind: (0, articleKind_1.parseArticleKind)(article.articleKind),
        // TEK tedarikçi (24.09.2026): tercih edilen/varsayılan. Alım geçmişindeki
        // diğer tedarikçiler "Tedarikçiler" sekmesinde görünmeye devam eder.
        suppliers: suppliers.slice(0, 1).map(({ supplierId, companyName, locked }) => ({ supplierId, companyName, locked })),
        /* GÖRSELİN ADRESİ — base64 değil (01.09.2026).
         *
         * Dosya R2'de duruyor; sütun yalnızca `r2:...` verisini taşır, yani
         * birkaç düzine bayt. Buradan çıkan şey kalıcı, önbelleklenebilir bir
         * adrestir (assets.demo.offitec.ch) ve doğrudan <img src> içine girer —
         * ikinci bir istek yok, base64 şişmesi yok.
         *
         * Henüz taşınmamış eski bir satır (sütunda hâlâ data URI) `null` döner;
         * o satır aşağıdaki binary uçtan okunmaya devam eder. İki yol yan yana
         * çalışır, kesme tarihi yoktur. */
        imageUrl: await (0, ImageStore_1.articleImageAddress)(article.imageUrl),
        // Görsel değişince Article.updatedAt değişir. Frontend bu sürümü URL'ye
        // eklediği için eski binary güvenle uzun süre önbellekte kalabilir.
        imageVersion: article.updatedAt.toISOString(),
        totalQuantity: article.stockBalances.reduce((sum, balance) => sum + (Number(balance.currentQuantity) || 0), 0),
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
router.get('/articles/:id/detail', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), async (req, res) => {
    try {
        const detail = await buildArticleDetail(req.user.tenantId, String(req.params.id));
        if (!detail)
            return res.status(404).json({ error: 'Ürün bulunamadı.' });
        return res.status(200).json(detail);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/** Hesaplanan alanlar ana detay isteğini bekletmeden paralel yüklenir. */
router.get('/articles/:id/detail-stats', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const article = await prisma_client_1.default.article.findFirst({
            where: { id, tenantId, deletedAt: null },
            select: { articleCode: true },
        });
        if (!article)
            return res.status(404).json({ error: 'Ürün bulunamadı.' });
        const [cost, openOrderQuantity] = await Promise.all([
            articleCostSummary(tenantId, id),
            openOrderQuantityFor(tenantId, id, article.articleCode),
        ]);
        return res.status(200).json({ ...cost, openOrderQuantity });
    }
    catch (error) {
        return res.status(400).json({ error: error.message });
    }
});
/**
 * Base64 veriyi JSON'a gömmek yerine gerçek görsel baytlarını döndürür. Sürüm
 * query parametresi değişmez URL üretir; tarayıcı aynı görseli tekrar indirmez.
 */
router.get('/articles/:id/image', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const article = await prisma_client_1.default.article.findFirst({
            where: { id: String(req.params.id), tenantId: req.user.tenantId, deletedAt: null },
            select: { imageUrl: true },
        });
        if (!article)
            return res.status(404).json({ error: 'Ürün bulunamadı.' });
        res.removeHeader('Pragma');
        res.removeHeader('Expires');
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        if (!article.imageUrl)
            return res.status(204).end();
        /* DEPODAKİ DOSYA: baytları sunucu okur, YÖNLENDİRME YAPMAZ.
         *
         * Bu uç XHR ile (Authorization başlığıyla) çağrılıyor. 302 ile
         * assets.demo.offitec.ch'ye yönlendirmek tarayıcıda CORS ön
         * kontrolüne takılır — eimer CORS başlığı göndermiyor. Adresi
         * doğrudan <img src> içine koyan çağıran zaten buraya hiç uğramaz
         * (bkz. buildArticleDetail.imageUrl); burası eski satırların ve
         * doğrudan adres kullanamayan çağıranların yolu. */
        if ((0, ImageStore_1.isStoredReference)(article.imageUrl)) {
            const bytes = await ImageStore_1.articleImageStorage.read(article.imageUrl);
            const extension = String(article.imageUrl).split('.').pop()?.toLowerCase();
            res.setHeader('Content-Type', extension === 'png' ? 'image/png'
                : extension === 'webp' ? 'image/webp'
                    : extension === 'gif' ? 'image/gif'
                        : 'image/jpeg');
            res.setHeader('Content-Length', String(bytes.length));
            return res.status(200).send(bytes);
        }
        const parsed = (0, articleImage_1.parseArticleImage)(article.imageUrl);
        if (!parsed)
            return res.status(404).json({ error: 'Geçerli ürün görseli bulunamadı.' });
        const separator = parsed.imageUrl.indexOf(',');
        const bytes = Buffer.from(parsed.imageUrl.slice(separator + 1), 'base64');
        res.setHeader('Content-Type', parsed.contentType);
        res.setHeader('Content-Length', String(bytes.length));
        return res.status(200).send(bytes);
    }
    catch (error) {
        return res.status(400).json({ error: error.message });
    }
});
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
 *               articleKind: { type: string, nullable: true, enum: [MANUFACTURED, RESALE, SERVICE], description: "itemType'ı da belirler" }
 *               suppliers:
 *                 type: array
 *                 description: "En çok BİR tedarikçi (400 SUPPLIER_SINGLE); boş liste = tedarikçiyi kaldır. Eski tedarikçinin alım geçmişi korunur"
 *                 items:
 *                   type: object
 *                   properties:
 *                     supplierId: { type: string, nullable: true }
 *                     supplierName: { type: string, nullable: true }
 *               description: { type: string, nullable: true }
 *               imageUrl: { type: string, nullable: true, description: "data:image/...;base64,... | null = sil" }
 */
router.patch('/articles/:id/detail', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.update'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const body = req.body ?? {};
        const current = await prisma_client_1.default.article.findFirst({
            where: { id, tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!current)
            return res.status(404).json({ error: 'Ürün bulunamadı.' });
        const data = {};
        if (body.articleCode !== undefined) {
            const articleCode = String(body.articleCode).trim();
            if (!articleCode)
                return res.status(400).json({ error: 'Ürün kodu zorunludur.' });
            // Kod kiracı içinde benzersizdir; çakışmayı Prisma hatasına
            // bırakmak yerine anlaşılır bir mesajla döneriz.
            const clash = await prisma_client_1.default.article.findFirst({
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
            if (!name)
                return res.status(400).json({ error: 'Ürün adı zorunludur.' });
            data.name = name;
        }
        // Modellnummer, Seriennummer, Lieferantenbarcode (10.09.2026) — alle
        // freiwillig; die Seriennummer ist je Mandant eindeutig.
        if (body.modelNumber !== undefined)
            data.modelNumber = readTag(body.modelNumber);
        if (body.supplierBarcode !== undefined)
            data.supplierBarcode = readTag(body.supplierBarcode);
        if (body.serialNumber !== undefined) {
            const serialNumber = readTag(body.serialNumber);
            if (serialNumber) {
                const owner = await prisma_client_1.default.article.findFirst({
                    where: { tenantId, serialNumber, NOT: { id } },
                    select: { articleCode: true },
                });
                if (owner) {
                    return res.status(409).json({ error: `Die Seriennummer «${serialNumber}» trägt schon der Artikel ${owner.articleCode}.`, code: 'SERIAL_TAKEN' });
                }
            }
            data.serialNumber = serialNumber;
        }
        if (body.unit !== undefined) {
            const unit = String(body.unit).trim();
            if (!unit)
                return res.status(400).json({ error: 'Birim zorunludur.' });
            // Die Liste entscheidet ueber die Schreibweise: "stk" wird zu "Stk",
            // damit derselbe Bestand nicht in mehreren Einheiten auseinanderlaeuft.
            data.unit = (0, measurementUnitCatalog_1.resolveUnit)(unit, await (0, measurementUnitCatalog_1.listUnits)(tenantId));
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
        // Üçlü ürün türü (23.09.2026) — ürün/hizmet ayrımını da taşır:
        // seçilen tür `itemType`'ı belirler, boş değer yalnızca türü siler.
        if (body.articleKind !== undefined) {
            const cleared = body.articleKind === null || body.articleKind === '';
            const articleKind = cleared ? null : (0, articleKind_1.parseArticleKind)(body.articleKind);
            if (!cleared && !articleKind) {
                return res.status(400).json({ error: 'Ürün türü geçersiz.' });
            }
            data.articleKind = articleKind;
            if (articleKind)
                data.itemType = (0, articleKind_1.itemTypeForArticleKind)(articleKind);
        }
        // Tedarikçiler (23.09.2026): formdaki çoklu seçim, TAM liste olarak.
        const supplierRefs = body.suppliers !== undefined ? readSupplierRefs(body.suppliers) : null;
        // Proje/satış şirketinde tür ve tedarikçi zorunludur — boşaltılamaz.
        const clearsKind = body.articleKind !== undefined && !data.articleKind;
        const clearsSuppliers = supplierRefs !== null && !supplierRefs.length;
        if ((clearsKind || clearsSuppliers) && (0, companyType_1.companyRequiresArticleKindAndSupplier)(await (0, companyType_1.readTenantCompanyType)(tenantId))) {
            return clearsKind
                ? res.status(400).json({ error: 'Ürün türü zorunludur.', code: 'KIND_REQUIRED' })
                : res.status(400).json({ error: 'En az bir tedarikçi seçin.', code: 'SUPPLIER_REQUIRED' });
        }
        // Denetim görselden ÖNCE: reddedilen istek depoda sahipsiz dosya bırakmasın.
        let applySuppliers = null;
        if (supplierRefs) {
            const plan = await planArticleSupplierSync(tenantId, id, supplierRefs);
            if ('error' in plan)
                return res.status(plan.error.status).json(plan.error.body);
            applySuppliers = plan.apply;
        }
        // Açıklama biçimli metindir — dar beyaz listeden geçer.
        if (body.description !== undefined)
            data.description = (0, richText_1.normalizeRichText)(body.description);
        /* GÖRSEL: alan yoksa dokunulmaz, null ise silinir, doluysa doğrulanır.
         *
         * DÖNEN ADRES YAZILMAZ (01.09.2026). Görsel artık R2'de duruyor ve
         * okurken satıra `https://assets.demo.offitec.ch/article-image/...`
         * konuyor — tarayıcı bir sonraki kayıtta onu masumca geri gönderir.
         * Yazılsaydı sütunda dosyanın kendisi değil, adresi kalırdı. Bu yüzden
         * yalnızca YENİ bir data URI yazılır; geri gelen adres sütunu hiç
         * tutmaz (bkz. ImageStore.valueForWrite). */
        let previousImage = null;
        if (body.imageUrl !== undefined) {
            const incoming = body.imageUrl;
            if (incoming === null || incoming === '') {
                data.imageUrl = null;
            }
            else if ((0, ImageStore_1.isDataUri)(incoming)) {
                const parsed = (0, articleImage_1.parseArticleImage)(incoming);
                if (!parsed) {
                    return res.status(400).json({ error: 'Görsel geçersiz. En fazla 2 MB PNG, JPG, GIF veya WebP yükleyin.' });
                }
                data.imageUrl = await (0, ImageStore_1.storeArticleImage)(tenantId, parsed.imageUrl);
            }
            else if (!(0, ImageStore_1.isStoredReference)(incoming) && !ImageStore_1.articleImageStorage.isPublicReference(String(incoming))) {
                return res.status(400).json({ error: 'Görsel geçersiz. En fazla 2 MB PNG, JPG, GIF veya WebP yükleyin.' });
            }
            // Depodaki eski dosya yeni kayıttan sonra silinir — önce yazılır.
            if (data.imageUrl !== undefined) {
                const before = await prisma_client_1.default.article.findFirst({
                    where: { id, tenantId },
                    select: { imageUrl: true },
                });
                previousImage = before?.imageUrl ?? null;
            }
        }
        const fieldsChanged = Object.keys(data).length > 0;
        if (fieldsChanged && !applySuppliers) {
            await prisma_client_1.default.article.update({ where: { id }, data });
        }
        else if (applySuppliers) {
            // Alanlar ve tedarikçiler birlikte yazılır — yarım kayıt olmaz.
            const writeSuppliers = applySuppliers;
            await prisma_client_1.default.$transaction(async (tx) => {
                if (fieldsChanged)
                    await tx.article.update({ where: { id }, data });
                await writeSuppliers(tx);
            });
        }
        if (fieldsChanged)
            await (0, ImageStore_1.forgetArticleImage)(previousImage, data.imageUrl ?? null);
        const detail = await buildArticleDetail(tenantId, id);
        return res.status(200).json(detail);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
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
router.get('/articles/:id/suppliers-summary', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        // Varlık kontrolü ile maliyet toplamını aynı DB turunda paralel başlat.
        const [exists, cost] = await Promise.all([
            prisma_client_1.default.article.count({ where: { id, tenantId, deletedAt: null } }),
            articleSupplierCostRows(tenantId, id),
        ]);
        if (!exists)
            return res.status(404).json({ error: 'Ürün bulunamadı.' });
        return res.status(200).json({
            suppliers: cost.rows,
            totalQuantity: cost.quantity,
            totalCost: cost.totalCost,
            averageUnitCost: cost.averageUnitCost,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.get('/suppliers', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), async (req, res) => {
    try {
        const suppliers = await prisma_client_1.default.supplier.findMany({
            where: { tenantId: req.user.tenantId },
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
                vatLiable: true,
                vatCountry: true,
                vatRate: true,
                isActive: true,
                createdAt: true,
                updatedAt: true,
                _count: { select: { articleSuppliers: true } },
            },
            orderBy: { companyName: 'asc' },
        });
        res.status(200).json(suppliers.map(({ _count, ...supplier }) => ({
            ...supplier,
            articleCount: _count.articleSuppliers,
            purchaseCount: _count.articleSuppliers,
        })));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
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
router.get('/suppliers/search', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 120 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const q = req.query.q ? String(req.query.q).trim() : '';
        const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
        const suppliers = await prisma_client_1.default.supplier.findMany({
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
        res.status(200).json(suppliers.map((s) => ({
            id: s.id,
            companyName: s.companyName,
            contactName: s.contactName,
            email: s.email,
            phone: s.phone,
            purchaseCount: s._count?.articleSuppliers ?? 0,
        })));
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
                // Adres bileşenleri tek tek gelir (birleşik "adres" alanı yok).
                ...Object.fromEntries(SUPPLIER_ADDRESS_FIELDS.map((field) => [
                    field,
                    req.body[field] ? String(req.body[field]).trim() : null,
                ])),
                notes: req.body.notes ? String(req.body.notes).trim() : null,
                ...readSupplierVat(req.body),
                isActive: req.body.isActive ?? true,
            },
            include: supplierInclude,
        });
        res.status(201).json(await supplierWithStats(supplier));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.get('/suppliers/:supplierId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), async (req, res) => {
    try {
        const supplier = await prisma_client_1.default.supplier.findFirst({
            where: { id: req.params.supplierId, tenantId: req.user.tenantId },
            include: supplierInclude,
        });
        if (!supplier)
            return res.status(404).json({ error: 'Tedarikçi bulunamadı.' });
        res.status(200).json(await supplierWithStats(supplier));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * Sipariş ekranı tedarikçi seçilince yalnızca KDV ayarını ister — tam kayıt
 * (tüm ürün bağlantıları + görseller) burada gereksiz yüktür.
 */
router.get('/suppliers/:supplierId/vat', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), async (req, res) => {
    try {
        const supplier = await prisma_client_1.default.supplier.findFirst({
            where: { id: req.params.supplierId, tenantId: req.user.tenantId },
            select: { id: true, vatLiable: true, vatCountry: true, vatRate: true },
        });
        if (!supplier)
            return res.status(404).json({ error: 'Tedarikçi bulunamadı.' });
        res.status(200).json(supplier);
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
        ['companyName', 'contactName', 'email', 'phone', ...SUPPLIER_ADDRESS_FIELDS, 'notes'].forEach((field) => {
            if (req.body[field] !== undefined)
                patch[field] = req.body[field] ? String(req.body[field]).trim() : null;
        });
        if (req.body.isActive !== undefined)
            patch.isActive = Boolean(req.body.isActive);
        Object.assign(patch, readSupplierVat(req.body));
        if (patch.companyName === '')
            return res.status(400).json({ error: 'Tedarikçi şirket adı zorunludur.' });
        const supplier = await prisma_client_1.default.supplier.update({
            where: { id: existing.id },
            data: patch,
            include: supplierInclude,
        });
        res.status(200).json(await supplierWithStats(supplier));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.get('/articles/:articleId/suppliers', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), async (req, res) => {
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
router.get('/search-items', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const q = String(req.query.q || '').trim();
        if (!q)
            return res.status(200).json([]);
        // Tek kaynak: Article (malzeme/ürün birleşmesi 2026-08-14).
        const articles = await prisma_client_1.default.article.findMany({
            where: {
                tenantId,
                deletedAt: null,
                OR: [
                    { name: { contains: q } },
                    { articleCode: { contains: q } },
                    { systemBarcode: { contains: q } },
                    { supplierBarcode: { contains: q } },
                    // Modell und Serie (10.09.2026): die Schnellerfassung sucht den Zwilling auch darüber.
                    { modelNumber: { contains: q } },
                    { serialNumber: { contains: q } },
                ],
            },
            take: 12,
            orderBy: { name: 'asc' },
        });
        const rows = articles.map((a) => ({
            kind: 'PRODUCT',
            id: a.id,
            code: a.articleCode,
            name: a.name,
            barcode: a.systemBarcode || a.supplierBarcode || null,
            modelNumber: a.modelNumber || null,
            serialNumber: a.serialNumber || null,
            unit: a.unit,
            salePrice: a.salePrice ?? 0,
            baseCost: a.baseCost ?? 0,
            imageUrl: a.imageUrl || null,
            itemType: a.itemType ?? 'PRODUCT',
            minStockLevel: a.minStockLevel ?? 0,
            criticalStockLevel: a.criticalStockLevel ?? 0,
            maxStockLevel: a.maxStockLevel ?? null,
        }));
        await (0, ImageStore_1.resolveArticleImagesInPlace)(rows);
        res.status(200).json(rows);
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
router.get('/movements/:articleId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 30 }), (req, res) => controller.getMovements(req, res));
/**
 * EK TEDARİKÇİLER (23.09.2026) — yeni ürün formunda birden fazla tedarikçi
 * seçilebilir. İlki satırın `supplierId`/`supplierName` alanında gider (tercih
 * edilen parti); geri kalanlar `additionalSuppliers` dizisinde, aynı biçimde.
 */
const readAdditionalSuppliers = (item) => (Array.isArray(item?.additionalSuppliers) ? item.additionalSuppliers : [])
    .filter((ref) => ref && (ref.supplierId || String(ref.supplierName ?? '').trim()))
    .slice(0, 20);
/** Önbellekten tedarikçiyi okur — satırın kendi alanı da ek tedarikçi de. */
const cachedSupplier = (cache, ref) => cache.get(ref.supplierId
    ? `id:${String(ref.supplierId)}`
    : `name:${ref.supplierName ? String(ref.supplierName).trim().toLowerCase() : ''}`) || null;
/**
 * Toplu uçlarda tedarikçiler satırlar işlenmeden ÖNCE, sabit sayıda sorguyla çözülür:
 * tüm ad/kimlikler beraber okunur ve satır döngüsü tamamen bellekte kalır.
 * Çözülemeyen tedarikçi kimlikleri döner; ilgili satır kendi hatasını alır.
 */
const warmSupplierCache = async (tenantId, items, cache) => {
    // Satırın kendi tedarikçisi ve (yeni ürün formundan gelen) ek tedarikçileri
    // aynı `supplierId` / `supplierName` biçimini taşır — hepsi birlikte çözülür.
    const refs = items.flatMap((item) => [item, ...readAdditionalSuppliers(item)]);
    const requestedIds = Array.from(new Set(refs
        .map((item) => item?.supplierId ? String(item.supplierId) : '')
        .filter(Boolean)));
    const requestedNames = new Map();
    refs.forEach((item) => {
        if (item?.supplierId)
            return;
        const companyName = item?.supplierName ? String(item.supplierName).trim() : '';
        if (companyName)
            requestedNames.set(companyName.toLowerCase(), companyName);
    });
    // Serbest yazılan tedarikçi adlarını tek INSERT ile oluştur. Eş zamanlı başka
    // bir istek aynı adı oluşturursa unique anahtar + skipDuplicates güvenli kalır.
    if (requestedNames.size) {
        await prisma_client_1.default.supplier.createMany({
            data: Array.from(requestedNames.values()).map((companyName) => ({
                id: (0, nanoid_1.nanoid)(10),
                tenantId,
                companyName,
            })),
            skipDuplicates: true,
        });
    }
    const suppliers = requestedIds.length || requestedNames.size
        ? await prisma_client_1.default.supplier.findMany({
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
const bulkApplyStockBalanceDeltas = async (tx, tenantId, locationId, deltaByArticle) => {
    const deltas = Array.from(deltaByArticle.entries());
    if (!deltas.length)
        return;
    const valuesSql = deltas.map(() => '(?, ?, ?, ?, ?, 0, NOW(3))').join(', ');
    const parameters = deltas.flatMap(([articleId, delta]) => [
        (0, nanoid_1.nanoid)(10),
        tenantId,
        articleId,
        locationId,
        delta,
    ]);
    await tx.$executeRawUnsafe(`INSERT INTO \`StockBalance\` (` +
        `\`id\`, \`tenantId\`, \`articleId\`, \`locationId\`, \`currentQuantity\`, \`reservedQuantity\`, \`updatedAt\`` +
        `) VALUES ${valuesSql} ON DUPLICATE KEY UPDATE ` +
        `\`currentQuantity\` = \`currentQuantity\` + VALUES(\`currentQuantity\`), \`updatedAt\` = NOW(3)`, ...parameters);
};
/** Giriş yapılan ürünlerin son maliyet/tedarikçi alanlarını tek UPDATE ile yeniler. */
const bulkUpdateArticlePurchases = async (tx, tenantId, preferredByArticle) => {
    const updates = Array.from(preferredByArticle.entries());
    if (!updates.length)
        return;
    const supplierCases = updates.map(() => 'WHEN ? THEN ?').join(' ');
    const costUpdates = updates.filter(([, info]) => info.purchasePrice > 0);
    const assignments = [
        `\`defaultSupplierId\` = CASE \`id\` ${supplierCases} ELSE \`defaultSupplierId\` END`,
        '`lastPurchaseDate` = NOW(3)',
        '`updatedAt` = NOW(3)',
    ];
    const parameters = updates.flatMap(([articleId, info]) => [articleId, info.supplierId]);
    if (costUpdates.length) {
        assignments.unshift(`\`baseCost\` = CASE \`id\` ${costUpdates.map(() => 'WHEN ? THEN ?').join(' ')} ELSE \`baseCost\` END`);
        parameters.unshift(...costUpdates.flatMap(([articleId, info]) => [articleId, info.purchasePrice]));
    }
    const articleIds = updates.map(([articleId]) => articleId);
    parameters.push(tenantId, ...articleIds);
    await tx.$executeRawUnsafe(`UPDATE \`Article\` SET ${assignments.join(', ')} ` +
        `WHERE \`tenantId\` = ? AND \`id\` IN (${articleIds.map(() => '?').join(', ')})`, ...parameters);
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
router.get('/movements', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 30 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
        const toStr = (v) => (v ? String(v).trim() : '');
        const search = toStr(req.query.search);
        const code = toStr(req.query.code);
        const name = toStr(req.query.name);
        const description = toStr(req.query.description);
        const type = toStr(req.query.type).toUpperCase();
        // Herkunft (10.09.2026): QUICK_ADD | QUICK_DELETE | ORDER_RECEIPT |
        // REPORT | MANUAL. Altbestand ohne Herkunft zaehlt als MANUAL.
        const origin = toStr(req.query.origin).toUpperCase();
        // Ürün detayındaki "bu ürünün hareketleri" görünümü — tek ürüne daraltır.
        const articleId = toStr(req.query.articleId);
        const parseDate = (value, endOfDay) => {
            const raw = toStr(value);
            if (!raw)
                return null;
            const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}` : raw;
            const date = new Date(iso);
            return Number.isNaN(date.getTime()) ? null : date;
        };
        const dateFrom = parseDate(req.query.dateFrom, false);
        const dateTo = parseDate(req.query.dateTo, true);
        const and = [];
        if (articleId)
            and.push({ articleId });
        if (search) {
            and.push({
                // EIN Suchfeld ueber ERP-Code, Bezeichnung, Modell, Serie und
                // Barcode (Artikel wie Bewegung) — Vorgabe 10.09.2026.
                OR: [
                    { article: { articleCode: { contains: search } } },
                    { article: { name: { contains: search } } },
                    { article: { modelNumber: { contains: search } } },
                    { article: { serialNumber: { contains: search } } },
                    { article: { supplierBarcode: { contains: search } } },
                    { article: { systemBarcode: { contains: search } } },
                    { scannedBarcode: { contains: search } },
                    { serialNumber: { contains: search } },
                    { description: { contains: search } },
                    { supplier: { companyName: { contains: search } } },
                ],
            });
        }
        if (code)
            and.push({ article: { articleCode: { contains: code } } });
        if (name)
            and.push({ article: { name: { contains: name } } });
        if (description)
            and.push({ description: { contains: description } });
        if (type === 'DEFINITION')
            and.push({ movementType: 'IN', quantity: 0 });
        else if (type === 'IN')
            and.push({ movementType: 'IN', quantity: { gt: 0 } });
        else if (type)
            and.push({ movementType: type });
        if (origin === 'MANUAL')
            and.push({ OR: [{ origin: null }, { origin: 'MANUAL' }] });
        else if (origin)
            and.push({ origin });
        if (dateFrom)
            and.push({ transactionDate: { gte: dateFrom } });
        if (dateTo)
            and.push({ transactionDate: { lte: dateTo } });
        const where = { tenantId, ...(and.length ? { AND: and } : {}) };
        const [total, rows] = await Promise.all([
            prisma_client_1.default.stockMovement.count({ where }),
            prisma_client_1.default.stockMovement.findMany({
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
                    origin: true,
                    scannedBarcode: true,
                    serialNumber: true,
                    ...(!articleId ? {
                        article: { select: { articleCode: true, name: true, modelNumber: true, serialNumber: true, supplierBarcode: true, systemBarcode: true } },
                    } : {}),
                    supplier: { select: { companyName: true } },
                    employee: { select: { firstName: true, lastName: true } },
                    sourceLocation: { select: { locationName: true } },
                    destinationLocation: { select: { locationName: true } },
                },
                orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }],
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
        ]);
        res.status(200).json({
            items: rows.map((row) => ({
                id: row.id,
                transactionDate: row.transactionDate,
                movementType: row.movementType,
                // Tanım hareketi: quantity=0 IN kaydı.
                movementKind: row.movementType === 'IN' && Number(row.quantity) === 0 ? 'DEFINITION' : row.movementType,
                quantity: row.quantity,
                unitCost: row.unitCost,
                totalCost: Number(row.quantity || 0) * Number(row.unitCost || 0),
                description: row.description,
                origin: row.origin || 'MANUAL',
                scannedBarcode: row.scannedBarcode,
                serialNumber: row.serialNumber,
                ...(!articleId ? { article: row.article } : {}),
                supplier: row.supplier,
                employee: row.employee,
                // Das Lager, das die Bewegung betrifft: Ziel beim Zugang, Quelle beim Abgang.
                location: row.destinationLocation?.locationName || row.sourceLocation?.locationName || null,
            })),
            total,
            page,
            pageSize,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
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
const groupBy = (rows, key) => {
    const groups = new Map();
    for (const row of rows) {
        const bucket = groups.get(row[key]);
        if (bucket)
            bucket.push(row);
        else
            groups.set(row[key], [row]);
    }
    return groups;
};
/** Satır hatasını KOD'uyla birlikte fırlat — arayüz kodu çevirebilsin. */
const rowError = (code, message) => Object.assign(new Error(message), { rowCode: code });
/**
 * Veritabanı hatasını satır listesine sığan tek cümleye indirger.
 *
 * Prisma'nın ham metni ekranlarca uzundur (çağrının kaynak kodunu da basar);
 * satır tablosuna olduğu gibi konulursa okunmaz. `code` alanı arayüzün hatayı
 * KULLANICININ dilinde göstermesini sağlar; metin yalnızca yedektir.
 */
const rowWriteFailure = (error) => {
    const raw = String(error?.message || '');
    // Sütun adı Prisma'nın `meta`sında gelir; sürücü üzerinden gelen hatalarda
    // orası boş kalıp yalnızca metinde ("… Column: name") durabiliyor.
    const column = error?.meta?.column_name || error?.meta?.column || /Column:\s*(\w+)/.exec(raw)?.[1] || '';
    if (error?.code === 'P2000' || /too long for the column/i.test(raw)) {
        return { code: 'VALUE_TOO_LONG', message: column ? `Alan sütun sınırını aşıyor: ${column}.` : 'Bir alan sütun sınırını aşıyor.' };
    }
    if (error?.code === 'P2002') {
        // Zwei eindeutige Schluessel: der ERP-Code und (seit 10.09.2026) die
        // Seriennummer. Der Zielname sagt, welcher getroffen wurde.
        const target = String(error?.meta?.target ?? raw);
        if (/serialNumber/i.test(target))
            return { code: 'SERIAL_TAKEN', message: 'Diese Seriennummer trägt schon ein anderer Artikel.' };
        return { code: 'CODE_TAKEN', message: 'Bu kod zaten bir üründe kayıtlı.' };
    }
    return { code: 'WRITE_FAILED', message: 'Satır yazılamadı.' };
};
/** Herkunft einer Lagerbewegung — nur diese Werte kommen in die Spalte. */
const MOVEMENT_ORIGINS = ['QUICK_ADD', 'QUICK_DELETE', 'ORDER_RECEIPT', 'PRODUCTION', 'REPORT', 'MANUAL'];
const readOrigin = (value, fallback = 'MANUAL') => {
    const raw = String(value ?? '').toUpperCase();
    return MOVEMENT_ORIGINS.includes(raw) ? raw : fallback;
};
/** Freiwillige Kennung (Modell, Serie, Barcode): getrimmt, begrenzt, leer = null. */
const readTag = (value, max = 120) => {
    const text = String(value ?? '').trim().slice(0, max);
    return text || null;
};
/**
 * Der eigentliche Rumpf — ohne `res`. Er gibt Status und Antwort ZURÜCK, damit
 * ein dritter Aufrufer (die Schnellerfassung, `/articles/quick`) das Ergebnis
 * lesen und bei einer Nummernkollision mit frischen Nummern nachsetzen kann,
 * statt die Antwort schon auf dem Draht zu haben.
 */
const runBulkCreateArticles = async (req, options = {}) => {
    try {
        const tenantId = req.user.tenantId;
        const employeeId = req.user.id;
        const items = Array.isArray(req.body.items) ? req.body.items : [];
        if (!items.length)
            return { status: 400, body: { error: 'Eklenecek satır yok.' } };
        if (items.length > 500)
            return { status: 400, body: { error: 'Tek seferde en fazla 500 satır eklenebilir.' } };
        // itemType = ürün/hizmet sınıflandırması (PRODUCT | SERVICE);
        // varsayılan üründür, detay ekranından hizmete çevrilebilir.
        const defaultItemType = req.body.itemType === 'SERVICE' ? 'SERVICE' : 'PRODUCT';
        // ÜZERİNE YAZMA (kullanıcı isteği 2026-08-02, sipariş Excel aktarımı):
        // kodu zaten kayıtlı satır hata VERMEZ, mevcut ürün dosyadaki değerlerle
        // güncellenir (ad/birim/fiyatlar; çöpteyse geri alınır). Stok DOKUNULMAZ —
        // güncellenen ürün için hareket/bakiye/parti yazılmaz.
        const overwrite = req.body.overwrite === true;
        // `code`: arayüz sık görülen hatayı kendi dilinde gösterebilsin.
        const errors = [];
        const created = [];
        // Yük içi mükerrer kod kontrolü
        const seenCodes = new Map();
        items.forEach((item, index) => {
            const codeValue = String(item.articleCode || '').trim();
            if (codeValue) {
                if (seenCodes.has(codeValue)) {
                    errors.push({ index, articleCode: codeValue, error: 'Aynı ürün kodu listede birden fazla kez var.', code: 'DUPLICATE_IN_FILE' });
                }
                else {
                    seenCodes.set(codeValue, index);
                }
            }
        });
        // Seriennummern sind je Mandant eindeutig: doppelte in der Ladung und
        // schon vergebene fallen als Zeilenfehler, bevor etwas geschrieben wird.
        const seenSerials = new Map();
        items.forEach((item, index) => {
            const serial = readTag(item?.serialNumber);
            if (!serial)
                return;
            if (seenSerials.has(serial)) {
                errors.push({ index, articleCode: String(item.articleCode || '').trim(), error: 'Dieselbe Seriennummer steht mehrfach in der Liste.', code: 'DUPLICATE_IN_FILE' });
            }
            else {
                seenSerials.set(serial, index);
            }
        });
        const duplicateIndexes = new Set(errors.map((e) => e.index));
        // Birbirinden bağımsız hazırlık sorguları aynı anda çalışır. Uzak DB'de
        // bunları art arda beklemek toplu kayda gereksiz üç ağ turu ekliyordu.
        const supplierCache = new Map();
        const [existing, defaultLocation, invalidSupplierIds, units, serialOwners] = await Promise.all([
            prisma_client_1.default.article.findMany({
                where: { tenantId, articleCode: { in: [...seenCodes.keys()] } },
                select: { id: true, articleCode: true, deletedAt: true, itemType: true },
            }),
            repository.ensureDefaultLocation(tenantId),
            warmSupplierCache(tenantId, items, supplierCache),
            // Die Einheitenliste des Mandanten: sie gibt die Schreibweise vor
            // und liefert die Vorgabe fuer Zeilen ohne eigene Einheit.
            (0, measurementUnitCatalog_1.listUnits)(tenantId),
            seenSerials.size
                ? prisma_client_1.default.article.findMany({
                    where: { tenantId, serialNumber: { in: [...seenSerials.keys()] } },
                    select: { articleCode: true, serialNumber: true },
                })
                : Promise.resolve([]),
        ]);
        const serialTakenBy = new Map(serialOwners.map((row) => [String(row.serialNumber), String(row.articleCode)]));
        const movementOrigin = options.origin ?? 'MANUAL';
        const existingCodes = new Map(existing.map((row) => [row.articleCode, { id: row.id, deleted: Boolean(row.deletedAt), itemType: row.itemType || 'PRODUCT' }]));
        const clashMessage = (info) => info.deleted ? 'Bu kod çöpteki bir üründe kayıtlı.' : 'Bu kod zaten bir üründe kayıtlı.';
        // Satır başına INSERT + transaction yerine: her şey bellekte hazırlanır,
        // sonra tek transaction içinde toplu INSERT'lerle yazılır. Yeni ürünler
        // olduğu için bakiye/parti satırlarının çakışma ihtimali yok.
        const articleCreates = [];
        /** Hangi ürün hangi SATIRDAN geldi — toplu yazma düşerse gerekir. */
        const createGroups = [];
        const articleUpdates = [];
        const balanceCreates = [];
        const movementCreates = [];
        const lotCreates = [];
        /* GÖRSELLER ÖNCE DEPOYA, SONRA SATIR HAZIRLIĞI.
         *
         * Satırlar senkron bir döngüde kuruluyor; R2'ye yazmak ise ağ
         * işidir. Bu yüzden bütün görseller burada, TEK SEFERDE ve paralel
         * olarak yüklenir — 500 satırlık bir dosyada bu, 500 ardışık
         * yükleme yerine tek bir dalga demektir. Döngü aşağıda yalnızca
         * hazır `r2:` verisini okur.
         *
         * Doğrulama satır bazındadır: bozuk görselli satır kendi hatasını
         * alır, dosyanın geri kalanı yazılmaya devam eder. */
        const imageRefByIndex = new Map();
        const imageErrorByIndex = new Map();
        await Promise.all(items.map(async (item, index) => {
            if (duplicateIndexes.has(index) || !item.imageUrl)
                return;
            const parsedImage = (0, articleImage_1.parseArticleImage)(item.imageUrl);
            if (!parsedImage) {
                imageErrorByIndex.set(index, 'Görsel geçersiz. En fazla 2 MB PNG, JPG, GIF veya WebP yükleyin.');
                return;
            }
            try {
                const stored = await (0, ImageStore_1.storeArticleImage)(tenantId, parsedImage.imageUrl);
                if (stored)
                    imageRefByIndex.set(index, stored);
            }
            catch {
                imageErrorByIndex.set(index, 'Görsel yüklenemedi.');
            }
        }));
        items.forEach((item, index) => {
            if (duplicateIndexes.has(index))
                return;
            const articleCode = String(item.articleCode || '').trim();
            const name = String(item.name || '').trim();
            try {
                if (!articleCode)
                    throw new Error('Ürün kodu zorunludur.');
                if (!name)
                    throw new Error('Ürün adı zorunludur.');
                const clash = existingCodes.get(articleCode);
                if (clash && !overwrite)
                    throw rowError('CODE_TAKEN', clashMessage(clash));
                // Modell, Serie, Lieferantenbarcode (10.09.2026) — alle freiwillig.
                const modelNumber = readTag(item.modelNumber);
                const serialNumber = readTag(item.serialNumber);
                const supplierBarcode = readTag(item.supplierBarcode ?? item.barcode);
                const serialOwner = serialNumber ? serialTakenBy.get(serialNumber) : undefined;
                if (serialOwner && serialOwner !== articleCode) {
                    throw rowError('SERIAL_TAKEN', `Die Seriennummer «${serialNumber}» trägt schon der Artikel ${serialOwner}.`);
                }
                // IT içe aktarımında miktar tartışmaya kapalıdır: 0.
                const quantity = options.forceZeroStock ? 0 : Math.max(0, Number(item.quantity) || 0);
                const purchasePrice = Math.max(0, Number(item.purchasePrice) || 0);
                const salePrice = Math.max(0, Number(item.salePrice) || 0);
                // Açıklama ve görsel ürün KARTINA yazılır (hareket notu değil) —
                // detay ekranındaki PATCH ile aynı doğrulamalardan geçer.
                const description = item.description ? (0, richText_1.normalizeRichText)(String(item.description)) : null;
                const imageProblem = imageErrorByIndex.get(index);
                if (imageProblem)
                    throw new Error(imageProblem);
                // Yukarıda depoya yazıldı; sütuna yalnızca verweis girer.
                const imageUrl = imageRefByIndex.get(index) ?? null;
                const additionalRefs = readAdditionalSuppliers(item);
                if ([item, ...additionalRefs].some((ref) => ref.supplierId && invalidSupplierIds.has(String(ref.supplierId)))) {
                    throw new Error('Tedarikçi bulunamadı.');
                }
                // Tedarikçiler yukarıda toplu çözüldü; burada yalnızca okunur.
                const supplier = cachedSupplier(supplierCache, item);
                // Ek tedarikçiler: tekrarlar ve satırın kendi tedarikçisi düşer.
                const additionalSuppliers = additionalRefs
                    .map((ref) => cachedSupplier(supplierCache, ref))
                    .filter((entry, position, list) => Boolean(entry) && entry.id !== supplier?.id && list.findIndex((other) => other?.id === entry.id) === position);
                // Üçlü ürün türü seçildiyse ürün/hizmet ayrımı ondan türer.
                const articleKind = (0, articleKind_1.parseArticleKind)(item.articleKind);
                const itemType = articleKind
                    ? (0, articleKind_1.itemTypeForArticleKind)(articleKind)
                    : item.itemType === 'SERVICE' || item.itemType === 'PRODUCT' ? item.itemType : defaultItemType;
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
                            ...(item.unit ? { unit: (0, measurementUnitCatalog_1.resolveUnit)(item.unit, units) } : {}),
                            ...(purchasePrice > 0 ? { baseCost: purchasePrice } : {}),
                            ...(salePrice > 0 ? { salePrice } : {}),
                            ...(supplier ? { defaultSupplierId: supplier.id } : {}),
                            ...(description ? { description } : {}),
                            ...(imageUrl ? { imageUrl } : {}),
                            ...(modelNumber ? { modelNumber } : {}),
                            ...(serialNumber ? { serialNumber } : {}),
                            ...(supplierBarcode ? { supplierBarcode } : {}),
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
                const articleId = (0, nanoid_1.nanoid)(10);
                const movementId = (0, nanoid_1.nanoid)(12);
                articleCreates.push({
                    id: articleId,
                    tenantId,
                    articleCode,
                    name,
                    // Ohne eigene Angabe: die Vorgabe des Mandanten (frueher
                    // stand hier fest "Adet" -- tuerkisch und nicht waehlbar).
                    unit: (0, measurementUnitCatalog_1.resolveUnit)(item.unit, units),
                    baseCost: purchasePrice,
                    salePrice,
                    defaultSupplierId: supplier?.id || null,
                    ...(description ? { description } : {}),
                    ...(imageUrl ? { imageUrl } : {}),
                    modelNumber,
                    serialNumber,
                    supplierBarcode,
                    itemType,
                    ...(articleKind ? { articleKind } : {}),
                    status: 'ACTIVE',
                    isActive: true,
                    ...(quantity > 0 ? { lastPurchaseDate: new Date() } : {}),
                });
                if (quantity > 0) {
                    balanceCreates.push({
                        id: (0, nanoid_1.nanoid)(10),
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
                    // Herkunft + gescannte Kennungen (10.09.2026): die
                    // Lagerbewegungen filtern danach.
                    origin: movementOrigin,
                    scannedBarcode: supplierBarcode,
                    serialNumber,
                });
                if (supplier) {
                    // Yeni ürünün başka partisi olmadığı için "önceki tercihleri
                    // kapat" adımına gerek yok; ürünün varsayılan tedarikçisi ve
                    // maliyeti zaten create içinde yazılıyor.
                    lotCreates.push({
                        id: (0, nanoid_1.nanoid)(10),
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
                // Ek tedarikçiler: MİKTARSIZ tanım partileri. Ürünün tedarikçi
                // listesinde görünürler ama maliyet ortalamasını ve stoğu
                // etkilemezler (0 adet); tercih edilen parti yukarıdakidir.
                additionalSuppliers.forEach((extra) => {
                    lotCreates.push({
                        id: (0, nanoid_1.nanoid)(10),
                        tenantId,
                        articleId,
                        supplierId: extra.id,
                        locationId: defaultLocation.id,
                        purchasePrice,
                        quantity: 0,
                        remainingQuantity: 0,
                        lastPurchaseDate: null,
                        stockMovementId: null,
                        isPreferred: false,
                    });
                });
                existingCodes.set(articleCode, { id: articleId, deleted: false, itemType });
                created.push({ id: articleId, articleCode, name });
                // Satırı id'siyle eşle: toplu yazma düşerse tek tek yeniden
                // denenecek ve hata SATIRINA yazılacak (aşağıya bakınız).
                createGroups.push({ index, articleCode, articleId });
            }
            catch (error) {
                errors.push({ index, articleCode, error: error.message, ...(error?.rowCode ? { code: error.rowCode } : {}) });
            }
        });
        /* HATALI SATIRIN GÖRSELİ DEPODA KALMAZ. Görseller döngüden önce
         * topluca yüklendi; o satır sonradan başka bir nedenle (ad boş,
         * kod çakıştı) elendiyse dosyanın artık sahibi yoktur. */
        await Promise.all(errors.map(({ index }) => {
            const orphan = imageRefByIndex.get(index);
            imageRefByIndex.delete(index);
            return orphan ? (0, ImageStore_1.forgetArticleImage)(orphan, null) : Promise.resolve();
        }));
        // YENİ kayıtlar tek transaction içinde toplu INSERT'lerle yazılır:
        // ürün kartı, bakiye, hareket ve parti satırları birbirini tutar.
        const failedCreateIds = new Set();
        if (articleCreates.length) {
            try {
                await prisma_client_1.default.$transaction(async (tx) => {
                    await tx.article.createMany({ data: articleCreates });
                    if (balanceCreates.length)
                        await tx.stockBalance.createMany({ data: balanceCreates });
                    if (movementCreates.length)
                        await tx.stockMovement.createMany({ data: movementCreates });
                    if (lotCreates.length)
                        await tx.articleSupplier.createMany({ data: lotCreates });
                });
            }
            catch {
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
                        await prisma_client_1.default.$transaction(async (tx) => {
                            await tx.article.create({ data: article });
                            const balances = balancesByArticle.get(article.id) ?? [];
                            const movements = movementsByArticle.get(article.id) ?? [];
                            const lots = lotsByArticle.get(article.id) ?? [];
                            if (balances.length)
                                await tx.stockBalance.createMany({ data: balances });
                            if (movements.length)
                                await tx.stockMovement.createMany({ data: movements });
                            if (lots.length)
                                await tx.articleSupplier.createMany({ data: lots });
                        });
                    }
                    catch (error) {
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
        const failedUpdateIds = new Set();
        for (let start = 0; start < articleUpdates.length; start += UPDATE_CONCURRENCY) {
            await Promise.all(articleUpdates.slice(start, start + UPDATE_CONCURRENCY).map(async (update) => {
                try {
                    await prisma_client_1.default.article.update({ where: { id: update.id }, data: update.data });
                }
                catch (error) {
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
        return {
            status: errors.length && !writtenRows.length ? 400 : 201,
            body: {
                createdCount: writtenRows.length,
                updatedCount: articleUpdates.length - failedUpdateIds.size,
                created: writtenRows,
                errors,
            },
        };
    }
    catch (error) {
        return { status: 400, body: { error: error.message } };
    }
};
const bulkCreateArticlesHandler = (options = {}) => async (req, res) => {
    const outcome = await runBulkCreateArticles(req, options);
    res.status(outcome.status).json(outcome.body);
};
/* ═══════════════ SCHNELLERFASSUNG (10.09.2026) ═══════════════════════════
   Vorgabe Samet: Der Wareneingang läuft im Normalfall über die
   Schnellerfassung. Kategorie → Unterkategorie → Modus, dann je Gerät:
   Barcode (Kamera oder Handscanner), Modellnummer, Seriennummer, Bezeichnung.
   Jeder Speichervorgang ist EIN Stück; Codes vergibt das System aus dem
   gewählten, von der IT FREIGEGEBENEN Nummernkreis (ELK-PLC-00001, …).

   Die Foto-/Texterkennungs-Fassung vom 02.09.2026 (Nummern `ART-NNNNN` je
   Mandant) ist damit abgelöst: es gibt kein Foto und kein OCR-Viereck mehr.
   Die Zeile läuft weiterhin durch DENSELBEN Rumpf wie Tabelle und Import
   (Artikel + Bestand + Bewegung + Partie in einem Zug); der Tabellenweg
   (`/articles/bulk`) bleibt unverändert — dort ist der Code Pflicht.

   Gleichzeitige Erfassungen können nicht dieselbe Nummer ziehen (die
   Reservierung im Kreis ist atomar); trifft eine gezogene Nummer dennoch auf
   einen importierten Altcode, meldet der Rumpf `CODE_TAKEN`, und die Route
   setzt für genau diese Zeilen mit frischen Nummern nach (bis dreimal). */
const QUICK_MAX_ITEMS = 50;
/**
 * @swagger
 * /inventory/articles/quick:
 *   post:
 *     tags: [Inventory]
 *     summary: Schnellerfassung — neue Artikel mit ERP-Code aus einem freigegebenen Nummernkreis
 *     description: >
 *       Jede Zeile braucht den Nummernkreis (`schemeId`) und eine Bezeichnung;
 *       Modellnummer, Seriennummer und Barcode sind freiwillig. Die Menge ist
 *       1, wenn nichts anderes angegeben ist (ein Scan = ein Stück). Der
 *       ERP-Code `KAT-UNTER-NNNNN` wird aus dem Kreis gezogen und in
 *       `created[].articleCode` zurückgemeldet. Antwortform wie `/articles/bulk`.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               schemeId: { type: string, description: "Freigegebener Nummernkreis (ArticleCodeScheme)" }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name: { type: string }
 *                     modelNumber: { type: string, nullable: true }
 *                     serialNumber: { type: string, nullable: true, description: "je Mandant eindeutig" }
 *                     barcode: { type: string, nullable: true, description: "gescannter Lieferantenbarcode" }
 *                     quantity: { type: number, description: "Standard 1; 0 = nur Definition" }
 *                     unit: { type: string, nullable: true }
 *                     purchasePrice: { type: number, nullable: true }
 *                     salePrice: { type: number, nullable: true }
 *                     supplierId: { type: string, nullable: true }
 *                     supplierName: { type: string, nullable: true }
 *                     description: { type: string, nullable: true }
 *                     imageUrl: { type: string, nullable: true }
 */
router.post('/articles/quick', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.create'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const schemeId = String(req.body?.schemeId ?? '').trim();
        if (!schemeId)
            return res.status(400).json({ error: 'Bitte zuerst Kategorie und Unterkategorie wählen.', code: 'SCHEME_REQUIRED' });
        const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
        if (!rawItems.length)
            return res.status(400).json({ error: 'Eklenecek satır yok.' });
        if (rawItems.length > QUICK_MAX_ITEMS)
            return res.status(400).json({ error: `Tek seferde en fazla ${QUICK_MAX_ITEMS} satır eklenebilir.` });
        // Nur die erlaubten Felder reisen weiter — die Schnellerfassung darf
        // weder `overwrite` noch fremde Codes in den Rumpf schmuggeln.
        const items = rawItems.map((item) => ({
            name: String(item?.name ?? '').trim(),
            quantity: item?.quantity === undefined || item?.quantity === null || item?.quantity === ''
                ? 1
                : Math.max(0, Number(item.quantity) || 0),
            unit: item?.unit ? String(item.unit) : null,
            purchasePrice: Math.max(0, Number(item?.purchasePrice) || 0),
            salePrice: Math.max(0, Number(item?.salePrice) || 0),
            supplierId: item?.supplierId ? String(item.supplierId) : null,
            supplierName: item?.supplierName ? String(item.supplierName) : null,
            description: typeof item?.description === 'string' && item.description ? item.description : null,
            imageUrl: typeof item?.imageUrl === 'string' && item.imageUrl ? item.imageUrl : null,
            modelNumber: readTag(item?.modelNumber),
            serialNumber: readTag(item?.serialNumber),
            supplierBarcode: readTag(item?.barcode ?? item?.supplierBarcode),
            articleCode: '',
        }));
        let issue;
        try {
            issue = await (0, articleCodeCatalog_1.issueCodes)(tenantId, schemeId, items.length);
        }
        catch (error) {
            return res.status(error?.status || 400).json({ error: error.message, ...(error?.code ? { code: error.code } : {}) });
        }
        items.forEach((item, index) => { item.articleCode = issue.codes[index]; });
        // Der Rumpf liest nur `user` und `body` — mehr wird ihm auch nicht
        // gereicht: so kann keine Angabe aus dem echten Aufruf (etwa
        // `overwrite`) an der Prüfung oben vorbei in ihn hineinlaufen.
        const runFor = (subset) => runBulkCreateArticles({ user: req.user, body: { items: subset, itemType: 'PRODUCT' } }, { origin: 'QUICK_ADD' });
        const first = await runFor(items);
        let created = Array.isArray(first.body?.created) ? first.body.created : [];
        let errors = Array.isArray(first.body?.errors) ? first.body.errors : [];
        if (first.body?.error && !created.length && !errors.length) {
            return res.status(first.status).json(first.body);
        }
        // Kollision mit einem importierten Altcode: nur die betroffenen
        // Zeilen mit frischen Nummern noch einmal.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const clashed = errors.filter((e) => e?.code === 'CODE_TAKEN');
            if (!clashed.length)
                break;
            const retryIndexes = clashed
                .map((e) => Number(e.index))
                .filter((i) => Number.isInteger(i) && i >= 0 && i < items.length);
            if (!retryIndexes.length)
                break;
            const fresh = await (0, articleCodeCatalog_1.issueCodes)(tenantId, schemeId, retryIndexes.length);
            const subset = retryIndexes.map((originalIndex, k) => {
                items[originalIndex].articleCode = fresh.codes[k];
                return items[originalIndex];
            });
            const retry = await runFor(subset);
            const retryCreated = Array.isArray(retry.body?.created) ? retry.body.created : [];
            const retryErrors = Array.isArray(retry.body?.errors) ? retry.body.errors : [];
            created = created.concat(retryCreated);
            // Zeilenfehler tragen den Index des TEILAUFRUFS — zurück auf den
            // Index der ursprünglichen Liste, sonst zeigt der Client falsch.
            errors = errors
                .filter((e) => e?.code !== 'CODE_TAKEN')
                .concat(retryErrors.map((e) => ({ ...e, index: retryIndexes[Number(e.index)] ?? -1 })));
            if (retry.body?.error && !retryCreated.length && !retryErrors.length) {
                errors = errors.concat(retryIndexes.map((index) => ({
                    index,
                    articleCode: items[index].articleCode,
                    error: String(retry.body.error),
                })));
                break;
            }
        }
        errors.sort((a, b) => Number(a.index) - Number(b.index));
        res.status(errors.length && !created.length ? 400 : 201).json({
            createdCount: created.length,
            updatedCount: 0,
            created,
            errors,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/* ═══════════════ TEKLİ ÜRÜN — YENİ ÜRÜN FORMU (23.09.2026) ═══════════════
   Vorgabe Samet: ERP-Code-Feld «şimdilik» weg; Ürün adı Pflicht; Lieferant
   Pflicht und MEHRFACH wählbar; Typ Pflicht (Üretilecek / Satılacak / Ek
   Hizmet) — beides aber nur in Projekt- und Verkaufsfirmen. In einer
   Produktionsfirma (und in einer Firma ohne Typ) ist nur der Name Pflicht.

   Kein Code von Hand, keine Kategorie: der Artikel zieht den VORLÄUFIGEN
   Code AA-BB-NNNNNN des Wareneingangs (issueTemporaryReceiptCodes); die IT
   kann ihn später in einen echten ERP-Code ändern. Die Zeile läuft durch
   DENSELBEN Rumpf wie Tabelle und Schnellerfassung (Artikel + Bewegung +
   Partie + Bestand in einem Zug); weitere Lieferanten werden als mengenlose
   Definitionspartien geschrieben. */
/**
 * @swagger
 * /inventory/articles/single:
 *   post:
 *     tags: [Inventory]
 *     summary: Ein neuer Artikel aus dem Produktformular — ohne ERP-Code, mit mehreren Lieferanten
 *     description: >
 *       Name ist Pflicht. In Firmen vom Typ PROJECT oder SALES sind zusätzlich
 *       `articleKind` und mindestens ein Lieferant Pflicht (400 KIND_REQUIRED /
 *       SUPPLIER_REQUIRED). Der Code ist ein vorläufiger AA-BB-Code. Antwortform
 *       wie `/articles/bulk`, dazu `article` (derselbe Körper wie `/articles/:id/detail`).
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               articleKind: { type: string, nullable: true, enum: [MANUFACTURED, RESALE, SERVICE] }
 *               suppliers:
 *                 type: array
 *                 description: "Erster = bevorzugter Lieferant; bekannte mit supplierId, neue mit supplierName"
 *                 items:
 *                   type: object
 *                   properties:
 *                     supplierId: { type: string, nullable: true }
 *                     supplierName: { type: string, nullable: true }
 *               modelNumber: { type: string, nullable: true }
 *               serialNumber: { type: string, nullable: true }
 *               barcode: { type: string, nullable: true }
 *               quantity: { type: number, description: "Anfangsbestand, Standard 0" }
 *               unit: { type: string, nullable: true }
 *               purchasePrice: { type: number, nullable: true }
 *               salePrice: { type: number, nullable: true }
 *               description: { type: string, nullable: true }
 *               imageUrl: { type: string, nullable: true }
 */
router.post('/articles/single', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.create'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const body = req.body ?? {};
        const name = String(body.name ?? '').trim();
        if (!name)
            return res.status(400).json({ error: 'Ürün adı zorunludur.', code: 'NAME_REQUIRED' });
        const kindGiven = body.articleKind !== undefined && body.articleKind !== null && body.articleKind !== '';
        const articleKind = kindGiven ? (0, articleKind_1.parseArticleKind)(body.articleKind) : null;
        if (kindGiven && !articleKind)
            return res.status(400).json({ error: 'Ürün türü geçersiz.', code: 'KIND_INVALID' });
        // Kayıtlı tedarikçi kimliğiyle, formda yeni yazılan adıyla gelir.
        const supplierRefs = readSupplierRefs(body.suppliers);
        // Proje ve satış şirketinde tür ve en az bir tedarikçi şarttır —
        // form da aynısını ister, ama kural sunucuda da durur.
        if ((0, companyType_1.companyRequiresArticleKindAndSupplier)(await (0, companyType_1.readTenantCompanyType)(tenantId))) {
            if (!articleKind)
                return res.status(400).json({ error: 'Ürün türü zorunludur.', code: 'KIND_REQUIRED' });
            if (!supplierRefs.length)
                return res.status(400).json({ error: 'En az bir tedarikçi seçin.', code: 'SUPPLIER_REQUIRED' });
        }
        // Ürünün TEK tedarikçisi olur (24.09.2026).
        if (supplierRefs.length > 1) {
            return res.status(400).json({ error: 'Bir ürüne yalnızca bir tedarikçi atanabilir.', code: 'SUPPLIER_SINGLE' });
        }
        const [primary, ...additional] = supplierRefs;
        const itemType = articleKind ? (0, articleKind_1.itemTypeForArticleKind)(articleKind) : 'PRODUCT';
        const item = {
            name,
            // Başlangıç stoğu: boş = 0 (ürün yalnızca tanımlanır).
            quantity: Math.max(0, Number(body.quantity) || 0),
            unit: body.unit ? String(body.unit) : null,
            purchasePrice: Math.max(0, Number(body.purchasePrice) || 0),
            salePrice: Math.max(0, Number(body.salePrice) || 0),
            supplierId: primary?.supplierId ?? null,
            supplierName: primary?.supplierName ?? null,
            additionalSuppliers: additional,
            description: typeof body.description === 'string' && body.description ? body.description : null,
            imageUrl: typeof body.imageUrl === 'string' && body.imageUrl ? body.imageUrl : null,
            modelNumber: readTag(body.modelNumber),
            serialNumber: readTag(body.serialNumber),
            supplierBarcode: readTag(body.barcode ?? body.supplierBarcode),
            articleKind,
            itemType,
            articleCode: '',
        };
        // Çekilen numara içe aktarılmış eski bir koda denk gelirse taze
        // numarayla yeniden — Schnellerfassung ile aynı kural, en çok üç kez.
        let outcome = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const codes = await (0, articleCodeCatalog_1.issueTemporaryReceiptCodes)(tenantId, 1);
            item.articleCode = codes[0] ?? '';
            outcome = await runBulkCreateArticles({ user: req.user, body: { items: [item], itemType } }, { origin: 'MANUAL' });
            if (outcome.body?.errors?.[0]?.code !== 'CODE_TAKEN')
                break;
        }
        const createdRow = outcome?.body?.created?.[0];
        if (!outcome || !createdRow) {
            return res.status(outcome && outcome.status !== 201 ? outcome.status : 400)
                .json(outcome?.body ?? { error: 'Ürün kaydedilemedi.' });
        }
        // Teklif satırı yeni ürüne bu yanıtla bağlanır: birim, fiyat ve
        // açıklama sunucunun yazdığı hâliyle döner — ikinci istek gerekmez.
        res.status(201).json({ ...outcome.body, article: await buildArticleDetail(tenantId, createdRow.id) });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/articles/scan-lookup:
 *   get:
 *     tags: [Inventory]
 *     summary: Schnellerfassung — den gescannten Code einem Artikel zuordnen
 *     description: >
 *       Genauer Treffer auf Lieferantenbarcode, Systembarcode, Seriennummer oder
 *       ERP-Code (in dieser Reihenfolge). Antwortet `{found:false}` statt 404,
 *       damit die Schnellerfassung ohne Fehlerpfad zur Neuanlage weitergeht.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema: { type: string }
 */
router.get('/articles/scan-lookup', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const code = String(req.query.code ?? '').trim();
        if (!code)
            return res.status(400).json({ error: 'Kein Code erhalten.' });
        res.setHeader('Cache-Control', 'no-store');
        const stockUnit = await prisma_client_1.default.stockUnit.findFirst({
            where: { tenantId, OR: [{ barcode: code }, { serialNumber: code }] },
            include: { article: { select: quickAddStockUnit_1.quickScanArticleSelect } },
        });
        const rows = stockUnit ? [stockUnit.article] : await prisma_client_1.default.article.findMany({
            where: (0, quickAddStockUnit_1.quickScanArticleWhere)(tenantId, code),
            select: quickAddStockUnit_1.quickScanArticleSelect,
            take: 2,
        });
        if (!rows.length)
            return res.status(200).json({ found: false });
        if (rows.length > 1)
            return res.status(200).json({ found: false, ambiguous: true });
        const hit = rows[0];
        const matchedBy = hit.serialNumber === code ? 'serial' : hit.supplierBarcode === code || hit.systemBarcode === code ? 'barcode' : 'code';
        return res.status(200).json({
            found: true,
            matchedBy,
            stockUnit: stockUnit ? { id: stockUnit.id, barcode: stockUnit.barcode, serialNumber: stockUnit.serialNumber } : null,
            article: {
                id: hit.id,
                articleCode: hit.articleCode,
                name: hit.name,
                unit: hit.unit,
                modelNumber: hit.modelNumber,
                serialNumber: hit.serialNumber,
                supplierBarcode: hit.supplierBarcode,
                systemBarcode: hit.systemBarcode,
                totalQuantity: hit.stockBalances.reduce((sum, b) => sum + (Number(b.currentQuantity) || 0), 0),
            },
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// Exactly one device per request. No article is created without an explicit newArticle.
router.post('/stock-units/quick', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const barcode = String(req.body?.barcode ?? '').trim();
        const serialNumber = String(req.body?.serialNumber ?? '').trim() || null;
        const articleId = String(req.body?.articleId ?? '').trim() || undefined;
        if (!barcode || barcode.length > 120 || (serialNumber && serialNumber.length > 120)) {
            return res.status(400).json({ error: 'Ungültiger Barcode oder Seriennummer.', code: 'INVALID_BARCODE' });
        }
        let newArticle;
        if (req.body?.newArticle) {
            if (articleId)
                return res.status(400).json({ error: 'Nur einen Artikel angeben.' });
            if (!await (0, RbacMiddleware_1.userHasPermission)(req.user.id, 'inventory.articles.create')) {
                return res.status(403).json((0, RbacMiddleware_1.permissionDeniedBody)('inventory.articles.create'));
            }
            const name = String(req.body.newArticle.name ?? '').trim();
            const schemeId = String(req.body.newArticle.schemeId ?? '').trim();
            const modelNumber = String(req.body.newArticle.modelNumber ?? '').trim() || null;
            if (!name || !schemeId || (modelNumber && modelNumber.length > 120)) {
                return res.status(400).json({ error: 'Bezeichnung und Nummernkreis erforderlich.' });
            }
            const issue = await (0, articleCodeCatalog_1.issueCodes)(tenantId, schemeId, 1);
            newArticle = { name, modelNumber, articleCode: issue.codes[0], unit: (0, measurementUnitCatalog_1.resolveUnit)(null, await (0, measurementUnitCatalog_1.listUnits)(tenantId)) };
        }
        const location = await repository.ensureDefaultLocation(tenantId);
        const result = await prisma_client_1.default.$transaction((tx) => (0, quickAddStockUnit_1.receiveQuickStockUnit)(tx, {
            tenantId, employeeId: req.user.id, locationId: location.id,
            barcode, serialNumber, articleId, newArticle,
        }));
        return res.status(201).json(result);
    }
    catch (error) {
        if (error?.code === 'P2002') {
            const target = JSON.stringify(error.meta?.target ?? '');
            if (error.meta?.modelName === 'StockUnit' || /barcode|serialNumber/.test(target)) {
                return res.status(409).json({ code: 'STOCK_UNIT_EXISTS', error: 'Dieses Gerät wurde bereits erfasst.' });
            }
        }
        return res.status(error?.status || 400).json({ error: error.message, code: error?.code });
    }
});
/**
 * @swagger
 * /inventory/articles/{id}/barcodes:
 *   post:
 *     tags: [Inventory]
 *     summary: Schnellerfassung — einen weiteren Barcode an einen vorhandenen Artikel heften
 *     description: >
 *       Dasselbe Modell kann je Lieferant oder Charge ein anderes Etikett
 *       tragen. Hat der Artikel noch keinen Lieferantenbarcode, wird dieser
 *       sein Hauptbarcode; sonst kommt er als weiterer Barcode dazu. Ein
 *       Barcode gehört im Mandanten genau einem Artikel (409, wenn vergeben).
 *       Wer Bestand buchen darf, darf das — es ist Teil des Scan-Zugangs.
 *     security:
 *       - bearerAuth: []
 */
router.post('/articles/:id/barcodes', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['inventory.transfer', 'inventory.articles.update']), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const barcode = readTag(req.body?.barcode);
        if (!barcode)
            return res.status(400).json({ error: 'Kein Barcode erhalten.' });
        const article = await prisma_client_1.default.article.findFirst({
            where: { id, tenantId, deletedAt: null },
            select: { id: true, supplierBarcode: true, systemBarcode: true },
        });
        if (!article)
            return res.status(404).json({ error: 'Ürün bulunamadı.' });
        if (article.supplierBarcode === barcode || article.systemBarcode === barcode) {
            return res.status(200).json({ ok: true, primary: true });
        }
        // Gehört das Etikett schon einem anderen Artikel?
        const owner = await prisma_client_1.default.article.findFirst({
            where: { tenantId, deletedAt: null, NOT: { id }, OR: [{ supplierBarcode: barcode }, { systemBarcode: barcode }, { barcodes: { some: { barcode } } }] },
            select: { articleCode: true },
        });
        if (owner)
            return res.status(409).json({ error: `Dieser Barcode gehört schon zu ${owner.articleCode}.`, code: 'BARCODE_TAKEN' });
        if (!article.supplierBarcode) {
            await prisma_client_1.default.article.update({ where: { id }, data: { supplierBarcode: barcode } });
            return res.status(200).json({ ok: true, primary: true });
        }
        await prisma_client_1.default.articleBarcode.upsert({
            where: { tenantId_barcode: { tenantId, barcode } },
            update: {},
            create: { id: (0, nanoid_1.nanoid)(12), tenantId, articleId: id, barcode },
        });
        return res.status(200).json({ ok: true, primary: false });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * Ein SYSTEMBARCODE für einen Artikel ohne Barcode — nur auf Knopfdruck aus
 * den Artikeldetails, nie automatisch (Vorgabe 10.09.2026). Form: EAN-13 mit
 * Präfix 20 (Bereich für den internen Gebrauch), zehn Ziffern aus der Zeit
 * und dem Zufall, Prüfziffer. Der Schlüssel ist global eindeutig; ein
 * Zusammenstoss ist praktisch ausgeschlossen, wird aber trotzdem noch einmal
 * gezogen.
 */
const ean13CheckDigit = (twelve) => {
    let sum = 0;
    for (let i = 0; i < 12; i += 1)
        sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
    return String((10 - (sum % 10)) % 10);
};
const newSystemBarcode = () => {
    const stamp = String(Date.now()).slice(-7);
    const random = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    const twelve = `20${stamp}${random}`;
    return twelve + ean13CheckDigit(twelve);
};
/**
 * @swagger
 * /inventory/articles/{id}/barcode:
 *   post:
 *     tags: [Inventory]
 *     summary: Systembarcode erzeugen (nur für Artikel ohne Systembarcode, nur auf Knopfdruck)
 *     security:
 *       - bearerAuth: []
 */
router.post('/articles/:id/barcode', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.update'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const id = String(req.params.id);
        const article = await prisma_client_1.default.article.findFirst({ where: { id, tenantId, deletedAt: null }, select: { systemBarcode: true } });
        if (!article)
            return res.status(404).json({ error: 'Ürün bulunamadı.' });
        if (article.systemBarcode)
            return res.status(409).json({ error: 'Dieser Artikel hat schon einen Systembarcode.', code: 'BARCODE_EXISTS' });
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const candidate = newSystemBarcode();
            try {
                await prisma_client_1.default.article.update({ where: { id }, data: { systemBarcode: candidate } });
                const detail = await buildArticleDetail(tenantId, id);
                return res.status(200).json(detail);
            }
            catch (error) {
                if (error?.code !== 'P2002')
                    throw error;
            }
        }
        return res.status(500).json({ error: 'Es konnte kein freier Barcode gefunden werden.' });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.post('/articles/bulk', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.articles.create'), bulkCreateArticlesHandler());
/**
 * @swagger
 * /inventory/ocr/read:
 *   post:
 *     tags: [Inventory]
 *     summary: Schnellerfassung — den markierten Bildausschnitt lesen (OCR.space)
 *     description: >
 *       Die Schnellerfassung schickt NUR den Ausschnitt, den der Anwender auf
 *       dem Foto aufgezogen hat — nie das ganze Bild. Der Server reicht ihn an
 *       OCR.space weiter; der API-Schlüssel bleibt hier und kommt nie in das
 *       Browser-Bündel. Zurück kommen der zusammenhängende Text und die
 *       einzelnen Zeilen mit ihren Rahmen (in Pixeln des Ausschnitts), aus
 *       denen die Anwendung den Produktnamen ableitet.
 *       Ohne `OFFITEC_OCR_SPACE_API_KEY` antwortet die Route 503 mit
 *       `code: OCR_NOT_CONFIGURED`. Der Ausschnitt darf höchstens 1 MB
 *       gross sein (Grenze des kostenlosen Kontingents).
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               image:
 *                 type: string
 *                 description: "data:image/jpeg;base64,… oder der reine Base64-Inhalt (max. 4 MB)"
 */
router.post('/ocr/read', AuthMiddleware_1.requireAuth, 
// Lesen darf, wer damit auch etwas anfangen kann: neue Produkte anlegen
// oder einen Eingang buchen. Sonst wäre die Route ein offener Übersetzer
// auf unsere Rechnung.
(0, RbacMiddleware_1.requireAnyPermission)(['inventory.articles.create', 'inventory.transfer']), async (req, res) => {
    try {
        if (!(0, ocrSpaceOcr_1.ocrConfigured)()) {
            return res.status(503).json({
                error: 'Die Texterkennung ist nicht eingerichtet.',
                code: 'OCR_NOT_CONFIGURED',
            });
        }
        const raw = String(req.body?.image ?? '');
        // `data:image/jpeg;base64,…` und der nackte Inhalt sind beide erlaubt.
        const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
        if (!base64)
            return res.status(400).json({ error: 'Kein Bildausschnitt erhalten.' });
        // Base64 trägt 4 Zeichen je 3 Byte — so wird die Bildgrösse geprüft,
        // ohne den Puffer dafür anzulegen.
        if ((base64.length * 3) / 4 > ocrSpaceOcr_1.OCR_MAX_BYTES) {
            return res.status(413).json({ error: 'Der Bildausschnitt ist zu gross.' });
        }
        /* Der Kopf des Daten-URI sagt, was es ist; kam der nackte Inhalt,
           ist JPEG die verträglichste Annahme. */
        const mimeType = raw.startsWith('data:') ? raw.slice(5, raw.indexOf(';')) : 'image/jpeg';
        const result = await (0, ocrSpaceOcr_1.readTextWithOcr)(base64, mimeType || 'image/jpeg');
        return res.json({ text: result.text, lines: result.lines, engine: 'ocr-space' });
    }
    catch (error) {
        if (error instanceof ocrSpaceOcr_1.OcrError) {
            // `detail` ist der Wortlaut des Dienstes. Er steht NICHT auf dem
            // Bildschirm (dort steht der Satz oben), aber wer die
            // Einrichtung macht, findet ihn so in der Antwort statt nur im
            // Serverprotokoll.
            return res.status(error.status).json({
                error: error.message,
                code: error.code,
                ...(error.detail ? { detail: error.detail } : {}),
            });
        }
        console.error('[inventory/ocr/read] unerwarteter Fehler:', error);
        return res.status(500).json({ error: 'Die Texterkennung ist fehlgeschlagen.' });
    }
});
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
 *                     description: { type: string, nullable: true, description: "Verkaufsbeschreibung der Datei — landet auf der Produktkarte, nicht in der Bestandsbuchung" }
 *                     imageUrl: { type: string, nullable: true, description: "data:image/...;base64,... (max. 2 MB)" }
 *               overwrite:
 *                 type: boolean
 *                 description: "true: vorhandene Artikelnummer wird aktualisiert statt abgewiesen"
 */
router.post('/articles/import', AuthMiddleware_1.requireAuth, ItGateMiddleware_1.requireItGate, bulkCreateArticlesHandler({ forceZeroStock: true }));
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
router.post('/articles/purge', AuthMiddleware_1.requireAuth, ItGateMiddleware_1.requireItGate, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const employeeId = req.user.id;
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
        const result = await prisma_client_1.default.article.updateMany({
            where: { tenantId, deletedAt: null },
            data: { deletedAt: new Date(), status: 'INACTIVE', isActive: false },
        });
        AuditLogService_1.auditLog.log({
            action: 'inventory.article.purge',
            tenantId,
            employeeId,
            entityType: 'Article',
            metadata: { deleted: result.count },
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json({ deleted: result.count });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
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
router.post('/movements/bulk', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const employeeId = req.user.id;
        const items = Array.isArray(req.body.items) ? req.body.items : [];
        if (!items.length)
            return res.status(400).json({ error: 'Kaydedilecek satır yok.' });
        if (items.length > 500)
            return res.status(400).json({ error: 'Tek seferde en fazla 500 satır kaydedilebilir.' });
        const errors = [];
        const movements = [];
        // Satırların ürünleri tek sorguda okunur. Ürün, depo ve tedarikçi
        // hazırlıkları birbirinden bağımsız olduğu için paralel başlatılır.
        const requestedIds = items.map((item) => (item.articleId ? String(item.articleId) : null)).filter(Boolean);
        const requestedCodes = items.map((item) => String(item.articleCode || '').trim()).filter(Boolean);
        const supplierCache = new Map();
        const [defaultLocation, invalidSupplierIds, articleRows] = await Promise.all([
            repository.ensureDefaultLocation(tenantId),
            warmSupplierCache(tenantId, items, supplierCache),
            requestedIds.length || requestedCodes.length
                ? prisma_client_1.default.article.findMany({
                    where: {
                        tenantId,
                        deletedAt: null,
                        OR: [
                            ...(requestedIds.length ? [{ id: { in: requestedIds } }] : []),
                            ...(requestedCodes.length ? [{ articleCode: { in: requestedCodes } }] : []),
                        ],
                    },
                    select: { id: true, articleCode: true, criticalStockLevel: true, serialNumber: true },
                })
                : Promise.resolve([]),
        ]);
        const articleById = new Map(articleRows.map((row) => [row.id, row]));
        const articleByCode = new Map(articleRows.map((row) => [row.articleCode, row]));
        // Bakiyeler tek sorguda okunur: çıkış kontrolü ve yeni miktarlar
        // bellekte hesaplanır, satır başına SELECT atılmaz.
        const involvedIds = Array.from(new Set(articleRows.map((row) => row.id)));
        const balanceRows = involvedIds.length
            ? await prisma_client_1.default.stockBalance.findMany({
                where: { tenantId, locationId: defaultLocation.id, articleId: { in: involvedIds } },
                select: { articleId: true, currentQuantity: true },
            })
            : [];
        const balanceByArticle = new Map(balanceRows.map((row) => [row.articleId, row.currentQuantity || 0]));
        const movementCreates = [];
        const deltaByArticle = new Map();
        const lotCreates = [];
        // Ürün başına son parti tercih edilen olur (aynı ürün birden çok satırdaysa).
        const preferredByArticle = new Map();
        const outArticleIds = new Set();
        items.forEach((item, index) => {
            const movementType = String(item.movementType || '').toUpperCase();
            let articleCode = String(item.articleCode || '').trim();
            try {
                if (movementType !== 'IN' && movementType !== 'OUT')
                    throw new Error('Hareket tipi IN veya OUT olmalıdır.');
                const quantity = Number(item.quantity);
                if (!Number.isFinite(quantity) || quantity <= 0)
                    throw new Error("Miktar 0'dan büyük olmalıdır.");
                const article = item.articleId ? articleById.get(String(item.articleId)) : articleByCode.get(articleCode);
                if (!article)
                    throw new Error(`Ürün bulunamadı: ${articleCode || item.articleId || ''}`);
                articleCode = article.articleCode;
                const pending = deltaByArticle.get(article.id) ?? 0;
                const available = (balanceByArticle.get(article.id) ?? 0) + pending;
                if (movementType === 'OUT' && available < quantity) {
                    throw new Error(`Kaynak lokasyonda yeterli stok yok. Mevcut: ${available}, İstenen: ${quantity}`);
                }
                const unitCost = item.unitCost === null || item.unitCost === undefined || item.unitCost === ''
                    ? null
                    : Number(item.unitCost);
                if (item.supplierId && invalidSupplierIds.has(String(item.supplierId)))
                    throw new Error('Tedarikçi bulunamadı.');
                // Tedarikçiler yukarıda çözüldü; burada yalnızca okunur.
                const supplier = movementType === 'IN'
                    ? (supplierCache.get(item.supplierId
                        ? `id:${String(item.supplierId)}`
                        : `name:${item.supplierName ? String(item.supplierName).trim().toLowerCase() : ''}`) || null)
                    : null;
                const movementId = (0, nanoid_1.nanoid)(12);
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
                    // Herkunft und gescannte Kennungen (Schnellerfassung 10.09.2026);
                    // von Hand gebuchte Zeilen bleiben MANUAL.
                    origin: readOrigin(item.origin),
                    scannedBarcode: readTag(item.scannedBarcode),
                    serialNumber: readTag(item.serialNumber) ?? article.serialNumber ?? null,
                });
                deltaByArticle.set(article.id, pending + (movementType === 'OUT' ? -quantity : quantity));
                if (movementType === 'OUT')
                    outArticleIds.add(article.id);
                if (supplier) {
                    const purchasePrice = unitCost && unitCost > 0 ? unitCost : 0;
                    lotCreates.push({
                        id: (0, nanoid_1.nanoid)(10),
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
            }
            catch (error) {
                errors.push({ index, articleCode, error: error.message });
            }
        });
        // Tek transaction, sabit sayıda toplu ifade: bakiye farklarının tamamı
        // tek MariaDB upsert'ine katlanır; ürün sayısı sorgu sayısını artırmaz.
        if (movementCreates.length) {
            await prisma_client_1.default.$transaction(async (tx) => {
                await tx.stockMovement.createMany({ data: movementCreates });
                await bulkApplyStockBalanceDeltas(tx, tenantId, defaultLocation.id, deltaByArticle);
                if (!lotCreates.length)
                    return;
                // Önceki partilerin tercih işareti kapatılır, sonra yenileri yazılır.
                await tx.articleSupplier.updateMany({
                    where: { tenantId, articleId: { in: Array.from(preferredByArticle.keys()) } },
                    data: { isPreferred: false },
                });
                await tx.articleSupplier.createMany({ data: lotCreates });
                await bulkUpdateArticlePurchases(tx, tenantId, preferredByArticle);
            });
        }
        if (outArticleIds.size) {
            const criticalCandidates = articleRows.filter((row) => outArticleIds.has(row.id) && (row.criticalStockLevel || 0) > 0);
            if (criticalCandidates.length) {
                const candidateIds = criticalCandidates.map((row) => row.id);
                const totals = await prisma_client_1.default.stockBalance.groupBy({
                    by: ['articleId'],
                    where: { tenantId, articleId: { in: candidateIds } },
                    _sum: { currentQuantity: true },
                });
                const totalByArticle = new Map(totals.map((row) => [row.articleId, row._sum.currentQuantity || 0]));
                const belowCritical = criticalCandidates.filter((row) => (totalByArticle.get(row.id) ?? 0) <= (row.criticalStockLevel || 0));
                if (belowCritical.length) {
                    const pendingRows = await prisma_client_1.default.purchaseProposal.findMany({
                        where: { tenantId, status: 'PENDING', articleId: { in: belowCritical.map((row) => row.id) } },
                        select: { articleId: true },
                    });
                    const hasPending = new Set(pendingRows.map((row) => row.articleId));
                    const proposals = belowCritical
                        .filter((row) => !hasPending.has(row.id))
                        .map((row) => ({
                        id: (0, nanoid_1.nanoid)(10),
                        tenantId,
                        articleId: row.id,
                        proposedQuantity: Math.max((row.minStockLevel || 0) - (totalByArticle.get(row.id) ?? 0), 1),
                        status: 'PENDING',
                    }));
                    if (proposals.length)
                        await prisma_client_1.default.purchaseProposal.createMany({ data: proposals });
                }
            }
        }
        errors.sort((a, b) => a.index - b.index);
        res.status(errors.length && !movements.length ? 400 : 201).json({
            processedCount: movements.length,
            movements,
            errors,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/proposals:
 *   get:
 *     tags: [Inventory]
 *     summary: Kritik stok seviyesi nedeniyle otomatik oluşan satın alma önerilerini listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/proposals', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.proposals.manage'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 30 }), (req, res) => controller.listProposals(req, res));
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
// Ortak: bir ürünü tek satırlık düşük stok objesine indirger.
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
router.get('/supply/low-stock', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        // Yalnızca bir eşik tanımlı olan kalemleri çek — tüm katalog değil.
        const articles = await prisma_client_1.default.article.findMany({
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
        const rows = articles.map((a) => {
            const qty = (a.stockBalances || []).reduce((s, b) => s + (b.currentQuantity || 0), 0);
            return mapLowStock('PRODUCT', a.id, a.articleCode, a.name, a.unit, qty, a.minStockLevel || 0, a.criticalStockLevel || 0);
        });
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
router.get('/supply/item/:kind/:id/suppliers', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 60 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        // `:kind` yalnızca yol uyumluluğu için duruyor — malzeme/ürün
        // birleşmesinden (2026-08-14) beri her kalem Article'dır.
        const id = String(req.params.id);
        {
            const article = await prisma_client_1.default.article.findFirst({
                where: { id, tenantId, deletedAt: null },
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
router.get('/supply/requests', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 30 }), async (req, res) => {
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
            const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId: await (0, serviceTenantScope_1.getMailTenantId)(tenantId) } });
            const result = await smtp.send(settings || {}, {
                fromEmail: settings?.fromEmail || req.user.email,
                fromName: settings?.fromName || 'Offitec Control Center',
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
/**
 * ── İKİ AYRI MODÜL (Vorgabe Samet, 22.09.2026) ─────────────────────────────
 * «Fiyat modülü ile sipariş modülünü ayırman lazım, artık bir süreç değil.»
 * Bir kayıt ya FİYAT TALEBİDİR ya SİPARİŞTİR ve aşama atlamaz: talep siparişe
 * dönüştürülünce talep LİSTEDE KALIR, YENİ bir sipariş kaydı doğar
 * (`/purchase-orders/:id/convert-to-order`). Mal kabul artık ayrı bir aşama
 * değil, SİPARİŞİN KENDİ DURUMUDUR (TO_BE_STOCKED = «MAL KABULDE»).
 */
const PO_ORDER_STATUSES = new Set(['ORDER_DRAFT', 'PENDING', 'ORDERED', 'TO_BE_STOCKED', 'COMPLETED']);
// Satır hesap kipleri: AUTO hesaplar, DIRECT gönderileni saklar (eski directCopy),
// SUPPLIER tedarikçi hesabından gelen SABİT net birim fiyatla çarpar (indirim kilitli).
const PO_CALC_MODES = new Set(['AUTO', 'DIRECT', 'SUPPLIER']);
const PO_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// CR/LF temizliği: SMTP başlığına yerleşen değer ek başlık enjekte edemesin.
const poStripHeader = (value) => value.replace(/[\r\n]+/g, ' ').trim();
const poEscapeHtml = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
/** Yüzde alanı: 0–100 aralığına kırpılır (geçersiz değer 0 sayılır). */
const poPercent = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return 0;
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
/**
 * ── EIGENE SPALTEN AN DER POSITION (07.09.2026, Vorgabe Samet) ──────────────
 *
 * «Wir nehmen sie als feste Spalten RECHTS NEBEN den Produktnamen — nicht
 *  darunter —, insgesamt drei. Und ihre Reihenfolge muss sich ändern lassen,
 *  die Spaltenüberschriften wandern mit.»
 *
 * Jede Position trägt ihre eigenen Angaben deshalb ALS LISTE MIT NAMEN — nicht
 * als Zuordnung Schlüssel→Wert. Das hat zwei Gründe, und beide zeigen sich erst
 * später:
 *   · DIE REIHENFOLGE ist die Reihenfolge der Liste. Wer die Spalten umstellt,
 *     stellt die Liste um; ein Objekt hätte keine verlässliche Ordnung.
 *   · DIE ÜBERSCHRIFT REIST MIT. Eine Bestellung, die in einem Jahr geöffnet
 *     wird, weiss dann noch, wie ihre Spalten heissen — auch wenn die Vorlage
 *     inzwischen umbenannt oder gelöscht wurde.
 */
// Zwoelf freie Spalten je Vorlage (11.09.2026) — so viele darf eine Position tragen.
const PO_MAX_EXTRAS = 12;
const normalizePurchaseOrderExtras = (raw) => {
    if (!Array.isArray(raw))
        return [];
    const seen = new Set();
    const extras = [];
    for (const entry of raw) {
        const key = String(entry?.key ?? '').trim().slice(0, 16);
        const name = String(entry?.name ?? '').trim().slice(0, 60);
        // Ohne Schlüssel und ohne Überschrift ist es keine Spalte, sondern Müll.
        if (!key || !name || seen.has(key))
            continue;
        seen.add(key);
        const width = Math.round(Math.min(240, Math.max(80, Number(entry?.width) || 120)));
        extras.push({ key, name, value: String(entry?.value ?? '').trim().slice(0, 240), width });
        if (extras.length >= PO_MAX_EXTRAS)
            break;
    }
    return extras;
};
/**
 * Satırın proje kaynağı — `{ projectId, positionId, producerTenantId }`.
 * Projesiz kaynak kaynak değildir; alanlar kimlik gibi kırpılır.
 * `manual`: satır «Siparişlerim»de Türsüzler'den işaretlenip ELLE açılan
 * siparişe girdi (U1, U2 …) — düzenlemelerde kaybolmasın diye taşınır.
 */
const poLineSource = (raw) => {
    if (!raw || typeof raw !== 'object')
        return null;
    const clean = (value) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 64) : null;
    const projectId = clean(raw.projectId);
    if (!projectId)
        return null;
    return {
        projectId,
        positionId: clean(raw.positionId),
        producerTenantId: clean(raw.producerTenantId),
        ...(raw.manual === true ? { manual: true } : {}),
    };
};
exports.poLineSource = poLineSource;
/**
 * ÜRETİM EMRİ (24.09.2026): proje şirketinin üretim şirketine verdiği sipariş
 * onaylanınca (ya da onay geri alınınca / değişince / silinince) üretim
 * şirketinin projeleri HEMEN yeniden kurulur — cihaz ancak onaylı sipariş
 * satırıyla projeye girer (bkz. SyncProductionProjectsUseCase). Hangi
 * siparişin üretime gittiğini shared/producerOrders.ts söyler: satırdaki
 * `producerTenantId` YA DA tedarikçisi üretim şirketinin kendisi olan
 * sipariş. Arka planda çalışır: sipariş cevabını bekletmez, hata siparişi
 * bozmaz.
 */
const refreshProducerProduction = (order) => {
    void (0, producerOrders_1.producerTenantIdsForOrder)(order)
        .then((producerIds) => {
        for (const producerId of producerIds) {
            void productionModule_1.productionModule.sync.execute(producerId, { force: true }).catch((error) => {
                console.warn('[production] producer sync failed', producerId, error?.message);
            });
        }
    })
        .catch((error) => console.warn('[production] producer lookup failed', error?.message));
};
exports.refreshProducerProduction = refreshProducerProduction;
const normalizePurchaseOrderItems = (raw) => {
    if (!Array.isArray(raw) || raw.length === 0)
        throw new Error('Sipariş için en az bir ürün satırı gereklidir.');
    if (raw.length > 500)
        throw new Error('Bir siparişe en fazla 500 satır eklenebilir.');
    const items = raw.map((r, index) => {
        const name = String(r?.name || '').trim();
        /* ── EINE ZEILE OHNE BEZEICHNUNG IST EINE ZEILE ──────────────────
           Vorgabe Samet (08.09.2026): «Es koennen leere Zellen dabei sein
           oder Zeilen, die trotzdem mit muessen.» Auf einem Beleg steht
           nicht in jeder Zeile ein Text — eine Position kann sich allein
           ueber ihren Bezeichner ausweisen, und eine erfundene Bezeichnung
           waere schlimmer als eine leere.

           Was BLEIBT, ist die Forderung nach einer Identitaet: ganz ohne
           Bezeichnung UND ohne Bezeichner ist die Zeile nichts, und dann
           sagt die Meldung auch, welche es war. */
        const identifier = String(r?.code || '').trim();
        if (!name && !identifier) {
            throw new Error(`Satır ${index + 1}: ürün adı veya ürün kodu zorunludur.`);
        }
        const rawQty = Number(r?.quantity);
        const quantity = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
        /* Brüt fiyat satırın TEK fiyat girişidir; yalnızca BOŞSA net fiyat
           taban olur.

           ⚠ «Boş» ile «sıfır» aynı şey değildir (Samet, 08.09.2026: «alan
           ondalık olduğu için değerleri reddediyor olabilir, 0.00 olsa bile
           kabul etmeli»). Burada `Number(x) || Number(y)` yazıyordu ve
           JavaScript'te 0 yanlış sayıldığı için, belgede AÇIKÇA 0.00 yazan
           bir brüt fiyat sessizce net fiyata düşüyordu. */
        const decimalOrNull = (value) => {
            if (value === null || value === undefined || value === '')
                return null;
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        };
        const grossPrice = decimalOrNull(r?.grossPrice) ?? decimalOrNull(r?.netPrice) ?? 0;
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
        let netPrice;
        let lineTotal;
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
        }
        else if (calcMode === 'SUPPLIER') {
            // Sabit net birim fiyat; miktar değişince tutar orantılı ölçeklenir.
            // ⚠ Birim fiyat YUVARLANMAZ (2026-08-02): 3 ondalıklı tedarikçi fiyatı
            // aynen saklanır, yalnızca satır TUTARI para olarak yuvarlanır —
            // frontend `computeOrderLine` SUPPLIER dalıyla birebir aynı kural.
            // RABATTE WIRKEN MIT (19.09.2026, Vorgabe Samet: «girilen indirimler
            // tedarikçi hesaplamalarına ve satır toplamlarına yansımalı»):
            // `netPrice` bleibt der Preis des Lieferanten VOR den Zeilenrabatten
            // (so lädt die Maske ihn wieder als Basis), der Betrag trägt sie.
            // Ohne Rabatt ist der Faktor 1 — alte Bestellungen rechnen gleich.
            netPrice = sentNet;
            lineTotal = Math.round(quantity * sentNet * discountFactor * 100) / 100;
        }
        else {
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
        // Das Gerät des Produktionsprojekts, für das die Zeile bestellt wird
        // (19.09.2026). Geprüft wird es gegen die Auswahl der Bestellung im
        // ProductionPurchaseLinkService — hier nur gereinigt.
        const productionItemId = typeof r?.productionItemId === 'string' && r.productionItemId.trim()
            ? r.productionItemId.trim().slice(0, 64)
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
            // Die eigenen Spalten der Vorlage — leer heisst: gar nicht erst
            // mitschreiben, damit alte Bestellungen unverändert aussehen.
            ...(() => {
                const extras = normalizePurchaseOrderExtras(r?.extras);
                return extras.length ? { extras } : {};
            })(),
            ...(displayNetPrice !== null ? { displayNetPrice } : {}),
            ...(receivedQuantity > 0 ? { receivedQuantity, receivedAt } : {}),
            ...(productionItemId ? { productionItemId } : {}),
            // PROJE KAYNAĞI (24.09.2026): satır bir projenin pozisyonundan
            // «Siparişe Git» ile geldiyse proje/pozisyon (ve üretimse üretim
            // şirketi) burada durur — birleştirme ve «Siparişlerim» bunu okur.
            ...(() => {
                const source = (0, exports.poLineSource)(r?.source);
                return source ? { source } : {};
            })(),
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
exports.normalizePurchaseOrderItems = normalizePurchaseOrderItems;
/**
 * Sipariş düzeyi KDV kipi: LINE = satır KDV'lerinin toplamı (eski davranış),
 * TOTAL = tek oran genel toplam üzerinden — KDV ayarları penceresinden ülke +
 * oran seçilir ve `totalVat = (totalNet + totalFees) × oran` olarak hesaplanır.
 *
 * ⚠ Frontend eşi: `orderPricing.ts` → `orderVatTotal` — birlikte güncellenmelidir.
 */
const normalizePurchaseOrderVat = (input) => {
    const vatMode = String(input.vatMode || 'LINE').toUpperCase() === 'TOTAL' ? 'TOTAL' : 'LINE';
    const orderVatRate = poPercent(input.orderVatRate);
    const orderVatCountry = input.orderVatCountry ? String(input.orderVatCountry).trim().slice(0, 80) || null : null;
    return { vatMode, orderVatRate, orderVatCountry };
};
/**
 * DIE STEUER EINER BESTELLUNG IM TOTAL-MODUS (Vorgabe Samet, 07.09.2026):
 * «Die Mehrwertsteuer muss JE PRODUKT gerechnet und dann zusammengezählt
 * werden, mit dem Satz der gewählten Vorlage. Der Betrag der Zeile muss im PDF
 * genau so wiederkommen. Die Versandkosten kommen separat dazu.»
 *
 *   je Zeile: Betrag × Satz, auf zwei Stellen gerundet → addiert = Steuer.
 *
 * ZWEI ÄNDERUNGEN GEGENÜBER DEM STAND VOM 02.08.2026, beide gewollt:
 *   • Die ZUSATZKOSTEN sind NICHT mehr Teil der Grundlage. Sie sind keine
 *     Position, tragen darum keine Zeilensteuer und kommen separat zum Total.
 *   • Gerundet wird JE ZEILE, nicht auf die Summe. Wer das PDF nachrechnet,
 *     addiert Zeile für Zeile; auf die Gesamtsumme gerechnet kämen ein paar
 *     Rappen Unterschied heraus — und genau die waren die Klage.
 *
 * Fehlen die Zeilenbeträge (ältere Aufrufer), bleibt der Satz auf der
 * Nettosumme; das Ergebnis unterscheidet sich höchstens um Rappen.
 *
 * ⚠ Frontend-Zwilling: `orderPricing.ts` → `computeOrderTotals` / `orderVatTotal`.
 *   Beide zusammen ändern, sonst zeigt der Bildschirm etwas anderes als das
 *   gespeicherte Dokument.
 */
const purchaseOrderTotalVat = (vat, totalNet, _totalFees, lineVatSum, lineTotals) => {
    if (vat.vatMode !== 'TOTAL')
        return lineVatSum;
    const rate = vat.orderVatRate / 100;
    if (lineTotals && lineTotals.length) {
        const sum = lineTotals.reduce((acc, amount) => acc + Math.round((Number(amount) || 0) * rate * 100) / 100, 0);
        return Math.round(sum * 100) / 100;
    }
    return Math.round(Math.round(totalNet * 100) / 100 * rate * 100) / 100;
};
exports.purchaseOrderTotalVat = purchaseOrderTotalVat;
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
const normalizePurchaseOrderFees = (raw) => {
    if (raw === null || raw === undefined)
        return { fees: [], totalFees: 0 };
    if (!Array.isArray(raw))
        throw new Error('Ek ücretler liste olmalıdır.');
    if (raw.length > 20)
        throw new Error('Bir siparişe en fazla 20 ek ücret eklenebilir.');
    const fees = [];
    raw.forEach((r, index) => {
        const name = String(r?.name ?? '').trim().replace(/\s+/g, ' ');
        const rawAmount = Number(r?.amount);
        const amount = Number.isFinite(rawAmount) ? Math.round(rawAmount * 100) / 100 : 0;
        if (!name && !amount)
            return;
        if (!name)
            throw new Error(`Ek ücret ${index + 1}: ücret adı zorunludur.`);
        if (name.length > 80)
            throw new Error(`Ek ücret ${index + 1}: ücret adı 80 karakteri aşamaz.`);
        fees.push({ name, amount });
    });
    const totalFees = Math.round(fees.reduce((sum, fee) => sum + fee.amount, 0) * 100) / 100;
    return { fees, totalFees };
};
// DB satırı → API yanıtı: items ve ek ücret JSON'u parse edilir, itemCount eklenir.
const parsePurchaseOrderRow = (row) => {
    let items = [];
    try {
        items = JSON.parse(row.items || '[]');
    }
    catch {
        items = [];
    }
    let additionalFees = [];
    try {
        additionalFees = JSON.parse(row.additionalFees || '[]');
    }
    catch {
        additionalFees = [];
    }
    if (!Array.isArray(additionalFees))
        additionalFees = [];
    let hiddenColumnKeys = [];
    try {
        hiddenColumnKeys = JSON.parse(row.hiddenColumnKeys || '[]');
    }
    catch {
        hiddenColumnKeys = [];
    }
    if (!Array.isArray(hiddenColumnKeys))
        hiddenColumnKeys = [];
    // Der Schnappschuss der Vorlagenspalten: NULL (alte Bestellung) bleibt null,
    // damit das PDF weiss, dass es keine Vorlage gab.
    let tableColumns = null;
    try {
        tableColumns = row.tableColumns ? JSON.parse(row.tableColumns) : null;
    }
    catch {
        tableColumns = null;
    }
    if (!Array.isArray(tableColumns) || !tableColumns.length)
        tableColumns = null;
    // «Von Hand gesendet» steht als Vorsilbe in `emailRecipient` (siehe
    // PO_MANUAL_MAIL_PREFIX) — nach aussen geht die blanke Adresse plus der Merker.
    const rawRecipient = typeof row.emailRecipient === 'string' ? row.emailRecipient : null;
    const emailSentManually = Boolean(row.emailSentAt) && Boolean(rawRecipient?.startsWith(PO_MANUAL_MAIL_PREFIX));
    const emailRecipient = rawRecipient?.startsWith(PO_MANUAL_MAIL_PREFIX)
        ? (rawRecipient.slice(PO_MANUAL_MAIL_PREFIX.length) || null)
        : rawRecipient;
    /* WELCHE STUFEN SCHON EIN BLATT TRAGEN (21.09.2026): die Oberfläche zeigt
       es im Schrittband, ohne dass die ganzen Blattdaten mitreisen müssten —
       eine Liste mit 20 Aufträgen schleppte sonst 20 Positionslisten mit. */
    const stageDocs = (() => {
        try {
            const parsed = JSON.parse(String(row.stageDocuments || '{}'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return [];
            return Object.entries(parsed)
                .filter(([, doc]) => Array.isArray(doc?.items) && doc.items.length > 0)
                .map(([stage]) => Number(stage))
                .filter((stage) => stage >= 1 && stage <= 3);
        }
        catch {
            return [];
        }
    })();
    const currentStage = purchaseFlowStage(row.status);
    const documentStages = [...new Set([...stageDocs, ...(items.length ? [currentStage] : [])])].sort();
    const { stageDocuments: _stageDocuments, ...rest } = row;
    return {
        ...rest,
        requestSuppliers: poReadRequestSuppliers(row),
        items,
        additionalFees,
        hiddenColumnKeys,
        tableColumns,
        emailRecipient,
        emailSentManually,
        itemCount: items.length,
        documentStages,
    };
};
exports.parsePurchaseOrderRow = parsePurchaseOrderRow;
/**
 * MAIL VON HAND GESENDET (Vorgabe Samet, 14.09.2026): «Es gibt kein
 * automatisches Senden; auf der Auftragsseite steht ein Mailfenster, und ein
 * Häkchen ‹Mail manuell gesendet› schaltet das Etikett ‹gesendet› genauso ein.»
 *
 * Der Merker braucht KEINE eigene Spalte: `emailSentAt` sagt schon, DASS die
 * Mail draussen ist, und `emailRecipient` trägt dann `manual:` vor der Adresse.
 * Eine neue Spalte auf PurchaseOrder hätte jede Abfrage der Tabelle von einer
 * Wanderung auf der Remote-DB abhängig gemacht. `parsePurchaseOrderRow` zieht
 * die Vorsilbe wieder ab — kein Aufrufer sieht sie.
 */
const PO_MANUAL_MAIL_PREFIX = 'manual:';
/**
 * BELGE KODU: **FİYAT TALEBİ ve SİPARİŞ AYRI SAYAR** (kullanıcı isteği Samet,
 * 21.09.2026 — «fiyat talebi kısaltması ayrı olmalı, BE-2026-001 değil»).
 *
 *   Fiyat talebi → `PA-{yıl}-{sıra3}`   (ekranda tr FT- · en PR-)
 *   Sipariş      → `BE-{yıl}-{sıra3}`   (ekranda tr SP- · en PO-)
 *
 * Depoda hep ALMANCA yazım durur; dil yalnızca öneki değiştirir
 * (`shared/purchaseDocumentCode.ts`). Kaydın kodu AŞAMASIYLA değişir: talep
 * aşamasında `priceRequestNumber`, sipariş aşamasından itibaren `orderNumber`;
 * `referenceNumber` her zaman GÜNCEL belgenin kodudur ve tüm uygulama onu okur.
 *
 * ⚠ TARAMA TÜRÜN BÜTÜN YAZIMLARINI OKUR (BE-, eski AU-, başka bir dilde elle
 * girilmiş SP-/PO-), YAZMA yalnızca depo yazımını yapar — böylece kullanıcının
 * daha önce gördüğü bir sıra ikinci kez dağıtılmaz. Eski dört haneli
 * BE-2026-0001 kayıtları da sayısal taranır (0001 → sıra 1). Üretilen kod yalnızca
 * ÖNERİDİR: kullanıcı elle değiştirebilir, benzersizliği DB indeksi korur.
 */
const nextPurchaseReference = async (tenantId, kind) => {
    const year = new Date().getFullYear();
    const prefixes = (0, purchaseDocumentCode_1.purchasePrefixesOf)(kind);
    const rows = await prisma_client_1.default.purchaseOrder.findMany({
        where: {
            tenantId,
            OR: prefixes.flatMap((prefix) => [
                { referenceNumber: { startsWith: `${prefix}-${year}-` } },
                { priceRequestNumber: { startsWith: `${prefix}-${year}-` } },
                { orderNumber: { startsWith: `${prefix}-${year}-` } },
            ]),
        },
        select: { referenceNumber: true, priceRequestNumber: true, orderNumber: true },
    });
    const max = rows.reduce((value, row) => {
        for (const code of [row.referenceNumber, row.priceRequestNumber, row.orderNumber]) {
            const parsed = (0, purchaseDocumentCode_1.parsePurchaseCode)(code);
            if (parsed && parsed.kind === kind && parsed.year === year)
                value = Math.max(value, parsed.seq);
        }
        return value;
    }, 0);
    // 999'dan sonra doğal olarak dört haneye taşar (BE-2026-1000).
    return (0, purchaseDocumentCode_1.formatPurchaseCode)(kind, year, max + 1);
};
exports.nextPurchaseReference = nextPurchaseReference;
/** Bu durumdaki kayıt hangi belgeyi taşır? Talep aşaması → fiyat talebi. */
const purchaseKindOfStatus = (status) => PO_PRICE_REQUEST_STATUSES.has(String(status || '').toUpperCase()) ? 'PRICE_REQUEST' : 'ORDER';
/**
 * AŞAMANIN KODU — bir kez çekilir, bir daha değişmez. Sipariş bir aşama geri
 * alınıp tekrar ilerletilirse AYNI sipariş kodu geri gelir: numara yanmaz ve
 * tedarikçi iki farklı kod görmez.
 */
const purchaseStageCodePatch = async (tenantId, row, kind) => {
    const column = kind === 'PRICE_REQUEST' ? 'priceRequestNumber' : 'orderNumber';
    const code = row?.[column] ? String(row[column]) : await (0, exports.nextPurchaseReference)(tenantId, kind);
    return { referenceNumber: code, [column]: code };
};
/**
 * DIE STUFE DES ABLAUFS — drei, wie das Schrittband der Oberfläche sie zeigt:
 * 1 Preisanfrage (DRAFT · PRICE_REQUEST) → 2 Bestellung (ORDER_DRAFT · PENDING ·
 * ORDERED) → 3 Wareneingang (TO_BE_STOCKED · COMPLETED). `purchaseStageRank`
 * oben ist FEINER (fünf Ränge) und sagt, ob es vorwärts geht; hier geht es um
 * den BELEG, nicht um den Fortschritt.
 */
const PURCHASE_FLOW_STAGE = {
    DRAFT: 1, PRICE_REQUEST: 1,
    ORDER_DRAFT: 2, PENDING: 2, ORDERED: 2,
    TO_BE_STOCKED: 3, COMPLETED: 3,
};
const purchaseFlowStage = (status) => PURCHASE_FLOW_STAGE[String(status || '').toUpperCase()] ?? 1;
/**
 * ── BESTÄTIGEN NUR, WENN JEDE ZEILE VOLLSTÄNDIG IST (19.09.2026) ────────────
 * Produktname, Menge, Einzelpreis, Nettopreis und Zeilensumme sind Pflicht;
 * Rabatt und Rabatt 2 nicht (Vorgabe Samet). Die Antwort nennt je Zeile, was
 * fehlt — die Maske markiert genau diese Zellen.
 */
/**
 * ONAY BUTONU KALKTI (22.09.2026): bir sipariş doğduğu anda siparıştır, ayrıca
 * onaylanmaz. Bu küme bu yüzden SİPARİŞ TASLAĞINI da içerir — üretime giden
 * satırlar artık ilk kayıtta gider.
 */
const PO_APPROVED_STATUSES = new Set(['ORDER_DRAFT', 'PENDING', 'ORDERED', 'TO_BE_STOCKED', 'COMPLETED']);
/** Wie weit eine Bestellung im Ablauf ist — ein höherer Rang ist ein Schritt nach vorn. */
const purchaseStageRank = (status) => ({
    DRAFT: 1, PRICE_REQUEST: 1, ORDER_DRAFT: 2, PENDING: 3, ORDERED: 3, TO_BE_STOCKED: 4, COMPLETED: 5,
}[String(status).toUpperCase()] ?? 0);
const assertApprovable = (items) => {
    const gaps = (0, purchaseOrderApproval_1.missingApprovalFields)(items);
    if (!gaps.length)
        return;
    throw (0, productionErrors_1.productionError)('APPROVAL_FIELDS_MISSING', 'Die Bestellung ist unvollständig und kann nicht bestätigt werden.', {
        details: gaps.map((gap) => ({ row: gap.index + 1, fields: gap.fields })),
        params: { rows: gaps.map((gap) => gap.index + 1).join(', ') },
    });
};
/**
 * Elle girilen belge kodu: boş olamaz, 60 karakteri aşamaz ve DEPO YAZIMINA
 * çevrilir — Türkçe ekranda yazılan `FT-2026-007` depoda `PA-2026-007` olur,
 * ekranda yine `FT-2026-007` okunur. Tanınmayan serbest kodlar dokunulmadan
 * saklanır.
 */
const normalizeReferenceNumber = (value) => {
    const reference = String(value ?? '').trim().replace(/\s+/g, ' ');
    if (!reference)
        throw new Error('Sipariş kodu boş olamaz.');
    if (reference.length > 60)
        throw new Error('Sipariş kodu 60 karakteri aşamaz.');
    return (0, purchaseDocumentCode_1.canonicalPurchaseCode)(reference);
};
// supplierId doğrulanır; yalnızca ad verildiyse tedarikçi upsert edilir
// (movements/bulk davranışıyla tutarlı). E-posta snapshot'ı kayıttan tamamlanır.
const resolvePurchaseOrderSupplier = async (tenantId, input) => {
    const supplierName = String(input.supplierName || '').trim();
    let supplierId = input.supplierId ? String(input.supplierId) : null;
    let supplierEmail = input.supplierEmail ? String(input.supplierEmail).trim() : null;
    if (supplierId) {
        const supplier = await prisma_client_1.default.supplier.findFirst({ where: { id: supplierId, tenantId } });
        if (!supplier)
            throw new Error('Tedarikçi bulunamadı.');
        if (!supplierEmail && supplier.email)
            supplierEmail = supplier.email;
        // Adres bileşenleri PDF alıcı bloğu için 2 satıra indirgenip snapshot'lanır
        // (tedarikçi sonradan değişse de gönderilmiş sipariş kendi anındaki adresi
        // taşır).
        return {
            supplierId,
            supplierName: supplierName || supplier.companyName,
            supplierEmail,
            supplierAddress: (0, exports.supplierAddressSnapshot)(supplier),
        };
    }
    if (!supplierName)
        throw new Error('Tedarikçi adı zorunludur.');
    const supplier = await prisma_client_1.default.supplier.upsert({
        where: { tenantId_companyName: { tenantId, companyName: supplierName } },
        update: {},
        create: { id: (0, nanoid_1.nanoid)(10), tenantId, companyName: supplierName, email: supplierEmail },
    });
    if (!supplierEmail && supplier.email)
        supplierEmail = supplier.email;
    return {
        supplierId: supplier.id,
        supplierName,
        supplierEmail,
        supplierAddress: (0, exports.supplierAddressSnapshot)(supplier),
    };
};
const PO_REQUEST_SUPPLIERS_MAX = 10;
const PO_MULTI_SUPPLIER_ROLE_RE = /muhasebe|buchhalt|accounting/i;
const PO_NO_SUPPLIER = { supplierId: null, supplierName: '', supplierEmail: null, supplierAddress: null };
/** Administrator ya da muhasebe rolü: fiyat talebine tedarikçi(ler) seçebilir. */
const poCanPickRequestSuppliers = async (employeeId) => {
    const rows = await prisma_client_1.default.$queryRaw `
        SELECT r.roleName AS roleName, r.isSystemAdmin AS isSystemAdmin
        FROM EmployeeRole er JOIN Role r ON r.id = er.roleId
        WHERE er.employeeId = ${employeeId}
    `;
    return rows.some((row) => Boolean(Number(row.isSystemAdmin)) || PO_MULTI_SUPPLIER_ROLE_RE.test(String(row.roleName || '')));
};
const poSameSupplier = (a, b) => (a.supplierId && a.supplierId === b.supplierId)
    || (!a.supplierId && !b.supplierId && a.supplierName.trim().toLowerCase() === b.supplierName.trim().toLowerCase());
/** Kayıttaki tedarikçi listesi. Eski/tek tedarikçili talep, sütunlarından tek kayıtlık liste olur. */
const poReadRequestSuppliers = (row) => {
    let parsed = null;
    try {
        parsed = row?.requestSuppliers ? JSON.parse(row.requestSuppliers) : null;
    }
    catch {
        parsed = null;
    }
    if (Array.isArray(parsed) && parsed.length) {
        return parsed
            .filter((entry) => entry && (entry.supplierId || String(entry.supplierName ?? '').trim()))
            .map((entry) => ({
            supplierId: entry.supplierId ? String(entry.supplierId) : null,
            supplierName: String(entry.supplierName ?? ''),
            supplierEmail: entry.supplierEmail ? String(entry.supplierEmail) : null,
            supplierAddress: entry.supplierAddress ? String(entry.supplierAddress) : null,
            emailSentAt: entry.emailSentAt ? String(entry.emailSentAt) : null,
            emailRecipient: entry.emailRecipient ? String(entry.emailRecipient) : null,
        }));
    }
    if (!PO_PRICE_REQUEST_STATUSES.has(row?.status) || (!row?.supplierId && !String(row?.supplierName ?? '').trim()))
        return [];
    return [{
            supplierId: row.supplierId ?? null,
            supplierName: String(row.supplierName ?? ''),
            supplierEmail: row.supplierEmail ?? null,
            supplierAddress: row.supplierAddress ?? null,
            emailSentAt: row.emailSentAt ? new Date(row.emailSentAt).toISOString() : null,
            emailRecipient: row.emailRecipient ?? null,
        }];
};
/** Gelen listeyi çözer (bilinen: id, yeni: ad → upsert); aynı tedarikçinin mail damgası korunur. */
const poResolveRequestSuppliers = async (tenantId, raw, previous) => {
    const input = Array.isArray(raw) ? raw : [];
    if (input.length > PO_REQUEST_SUPPLIERS_MAX) {
        throw new Error(`Bir fiyat talebine en fazla ${PO_REQUEST_SUPPLIERS_MAX} tedarikçi eklenebilir.`);
    }
    const out = [];
    for (const entry of input) {
        if (!entry || (!entry.supplierId && !String(entry.supplierName ?? '').trim()))
            continue;
        const resolved = await resolvePurchaseOrderSupplier(tenantId, entry);
        if (out.some((known) => poSameSupplier(known, resolved)))
            continue;
        const before = previous.find((known) => poSameSupplier(known, resolved));
        out.push({
            ...resolved,
            supplierAddress: resolved.supplierAddress ?? null,
            emailSentAt: before?.emailSentAt ?? null,
            emailRecipient: before?.emailRecipient ?? null,
        });
    }
    return out;
};
/** Liste → sütunlar: JSON + ilk tedarikçinin aynası. */
const poRequestSupplierColumns = (list) => ({
    requestSuppliers: list.length ? JSON.stringify(list) : null,
    supplierId: list[0]?.supplierId ?? null,
    supplierName: list[0]?.supplierName ?? '',
    supplierEmail: list[0]?.supplierEmail ?? null,
    supplierAddress: list[0]?.supplierAddress ?? null,
});
/** Gövdedeki `supplierIndex` — listede yoksa null. */
const poSupplierIndex = (value, list) => {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index < list.length ? index : null;
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
router.get('/purchase-orders', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 30 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
        const where = { tenantId };
        const status = req.query.status ? String(req.query.status).toUpperCase() : '';
        if (status && PO_STATUSES.has(status))
            where.status = status;
        /* LİSTE İKİYE AYRILDI (22.09.2026): `kind=PRICE_REQUEST` yalnızca
           talepleri, `kind=ORDER` yalnızca siparişleri döner. Belirli bir
           durum süzgeci varsa o daha dardır ve üstün gelir. */
        const kind = String(req.query.kind || '').toUpperCase();
        if (!where.status && (kind === 'PRICE_REQUEST' || kind === 'ORDER')) {
            where.status = { in: [...(kind === 'PRICE_REQUEST' ? PO_PRICE_REQUEST_STATUSES : PO_ORDER_STATUSES)] };
        }
        if (req.query.supplierId)
            where.supplierId = String(req.query.supplierId);
        const search = String(req.query.search || '').trim();
        if (search) {
            // ARAMA DİLDEN BAĞIMSIZ: `FT-2026-001` de `PA-2026-001` de aynı
            // kaydı bulur — tanıdık bir önek varsa atılır, kuyruk aranır. Eski
            // (talepken taşınan) kod da aranır: tedarikçi onu yazıyor olabilir.
            const codeSearch = (0, purchaseDocumentCode_1.purchaseSearchTerm)(search);
            where.OR = [
                { referenceNumber: { contains: codeSearch } },
                { priceRequestNumber: { contains: codeSearch } },
                { orderNumber: { contains: codeSearch } },
                { quoteNumber: { contains: search } },
                { projectName: { contains: search } },
                { supplierName: { contains: search } },
            ];
        }
        const reference = String(req.query.reference || '').trim();
        if (reference) {
            const referenceSearch = (0, purchaseDocumentCode_1.purchaseSearchTerm)(reference);
            where.AND = [
                ...(Array.isArray(where.AND) ? where.AND : []),
                {
                    OR: [
                        { referenceNumber: { contains: referenceSearch } },
                        { priceRequestNumber: { contains: referenceSearch } },
                        { orderNumber: { contains: referenceSearch } },
                    ],
                },
            ];
        }
        const quote = String(req.query.quote || '').trim();
        if (quote)
            where.quoteNumber = { contains: quote };
        const project = String(req.query.project || '').trim();
        if (project)
            where.projectName = { contains: project };
        const supplier = String(req.query.supplier || '').trim();
        if (supplier)
            where.supplierName = { contains: supplier };
        const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : null;
        const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : null;
        if ((dateFrom && !isNaN(dateFrom.getTime())) || (dateTo && !isNaN(dateTo.getTime()))) {
            where.createdAt = {};
            if (dateFrom && !isNaN(dateFrom.getTime()))
                where.createdAt.gte = dateFrom;
            if (dateTo && !isNaN(dateTo.getTime())) {
                const end = new Date(dateTo);
                end.setHours(23, 59, 59, 999);
                where.createdAt.lte = end;
            }
        }
        const [total, rows] = await Promise.all([
            prisma_client_1.default.purchaseOrder.count({ where }),
            prisma_client_1.default.purchaseOrder.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
        ]);
        res.status(200).json({ items: rows.map(exports.parsePurchaseOrderRow), total, page, pageSize });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
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
const poRecipientName = (value) => {
    if (value === null || value === undefined)
        return null;
    const name = String(value).replace(/[\r\n]+/g, ' ').trim().replace(/\s+/g, ' ');
    return name ? name.slice(0, 120) : null;
};
/**
 * Die AUSGEBLENDETEN SPALTEN der Bestellung — derselbe Schluesselsatz wie in der
 * Vorlage (`hiddenColumnKeys` in purchaseOrderImport.routes.ts), dieselbe
 * Reinigung: nur Bezeichner, keine Doppelten, eine harte Obergrenze. Gespeichert
 * wird ein JSON-Array oder NULL, wenn nichts ausgeblendet ist — eine leere Liste
 * als Text waere nur Betrieb in der Zeile.
 */
const PO_HIDDEN_COLUMNS_MAX = 16;
const poHiddenColumnKeys = (value) => {
    if (!Array.isArray(value))
        return null;
    const keys = value
        .map((key) => String(key ?? '').trim())
        .filter((key, index, list) => /^[a-zA-Z][a-zA-Z0-9]{0,15}$/.test(key) && list.indexOf(key) === index)
        .slice(0, PO_HIDDEN_COLUMNS_MAX);
    return keys.length ? JSON.stringify(keys) : null;
};
/**
 * Die SPALTEN DER VORLAGE, mit der die Bestellung erfasst wurde — Schluessel,
 * Name, Zuordnung und Typ, in der Reihenfolge der Vorlage (Vorgabe Samet,
 * 11.09.2026: «tabloda böyleyse PDF'e de böyle aktarılmalı»). Das PDF wird
 * spaeter ohne die Vorlage gebaut und schreibt diese Namen als Spaltentitel.
 * Dieselbe Reinigung wie bei den eigenen Angaben; ungueltige Eintraege fallen
 * weg, gespeichert wird ein JSON-Array oder NULL.
 */
const PO_TABLE_COLUMNS_MAX = 13;
const PO_TABLE_LABELS = new Set(['productName', 'quantity', 'grossPrice', 'netPrice', 'discount', 'discount2', 'total']);
const poTableColumns = (value) => {
    if (!Array.isArray(value))
        return null;
    const seen = new Set();
    const columns = [];
    for (const entry of value) {
        const key = String(entry?.key ?? '').trim();
        const name = String(entry?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,15}$/.test(key) || !name || seen.has(key))
            continue;
        const rawLabel = entry?.label;
        const label = typeof rawLabel === 'string' && PO_TABLE_LABELS.has(rawLabel) ? rawLabel : null;
        seen.add(key);
        columns.push({ key, name, label, type: entry?.type === 'number' ? 'number' : 'text' });
        if (columns.length >= PO_TABLE_COLUMNS_MAX)
            break;
    }
    return columns.length ? JSON.stringify(columns) : null;
};
const PO_COVER_LETTER_MAX = 4000;
const poCoverLetter = (value) => {
    if (value === null || value === undefined)
        return null;
    // Yalnızca satır sonu bırakan boşluklar temizlenir; iç girinti korunur.
    const text = String(value).replace(/\r\n/g, '\n').trim();
    if (!text)
        return null;
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
router.get('/purchase-orders/text-templates', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog', 'settings'], ttlSec: 120 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 15));
        const [rows, total] = await Promise.all([
            prisma_client_1.default.purchaseOrderTextTemplate.findMany({
                where: { tenantId },
                orderBy: { updatedAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            prisma_client_1.default.purchaseOrderTextTemplate.count({ where: { tenantId } }),
        ]);
        res.status(200).json({ items: rows, total, page, pageSize });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/text-templates:
 *   post:
 *     tags: [Inventory]
 *     summary: Ön yazı taslağı kaydet
 *     security:
 *       - bearerAuth: []
 */
router.post('/purchase-orders/text-templates', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const title = String(req.body?.title ?? '').trim().slice(0, 191);
        if (!title)
            return res.status(400).json({ error: 'Taslak başlığı zorunludur.' });
        const content = poCoverLetter(req.body?.content);
        if (!content)
            return res.status(400).json({ error: 'Taslak metni boş olamaz.' });
        const template = await prisma_client_1.default.purchaseOrderTextTemplate.create({
            data: { id: (0, nanoid_1.nanoid)(12), tenantId, title, content, createdBy: req.user.id || null },
        });
        res.status(201).json(template);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/text-templates/{templateId}:
 *   patch:
 *     tags: [Inventory]
 *     summary: Ön yazı taslağını güncelle
 *     security:
 *       - bearerAuth: []
 */
router.patch('/purchase-orders/text-templates/:templateId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const templateId = String(req.params.templateId);
        const existing = await prisma_client_1.default.purchaseOrderTextTemplate.findFirst({
            where: { id: templateId, tenantId },
            select: { id: true },
        });
        if (!existing)
            return res.status(404).json({ error: 'Taslak bulunamadı.' });
        const data = {};
        if (req.body?.title !== undefined) {
            const title = String(req.body.title ?? '').trim().slice(0, 191);
            if (!title)
                return res.status(400).json({ error: 'Taslak başlığı zorunludur.' });
            data.title = title;
        }
        if (req.body?.content !== undefined) {
            const content = poCoverLetter(req.body.content);
            if (!content)
                return res.status(400).json({ error: 'Taslak metni boş olamaz.' });
            data.content = content;
        }
        if (!Object.keys(data).length)
            return res.status(400).json({ error: 'Güncellenecek alan yok.' });
        const template = await prisma_client_1.default.purchaseOrderTextTemplate.update({ where: { id: templateId }, data });
        res.status(200).json(template);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/text-templates/{templateId}:
 *   delete:
 *     tags: [Inventory]
 *     summary: Ön yazı taslağını sil
 *     security:
 *       - bearerAuth: []
 */
router.delete('/purchase-orders/text-templates/:templateId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const templateId = String(req.params.templateId);
        const existing = await prisma_client_1.default.purchaseOrderTextTemplate.findFirst({
            where: { id: templateId, tenantId },
            select: { id: true },
        });
        if (!existing)
            return res.status(404).json({ error: 'Taslak bulunamadı.' });
        await prisma_client_1.default.purchaseOrderTextTemplate.delete({ where: { id: templateId } });
        res.status(200).json({ message: 'Taslak silindi.', templateId });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/* BELEG-IMPORT DER BESTELLUNG (07.09.2026) — `ai-extract`, `ai-status` und die
   Rechenvorlagen je Lieferant liegen in einer eigenen Datei
   (`purchaseOrderImport.routes.ts`), weil sie ein geschlossenes Stück sind und
   sonst nichts im Lager anfassen.
   ⚠ Die Reihenfolge zählt genauso wie bei den Textvorlagen darüber: dieser
   Block MUSS vor `/purchase-orders/:id` stehen, sonst hält Express
   «ai-extract» für eine Bestellnummer. */
router.use('/purchase-orders', purchaseOrderImport_routes_1.purchaseOrderImportRouter);
/**
 * @swagger
 * /inventory/purchase-orders/{id}:
 *   get:
 *     tags: [Inventory]
 *     summary: Satın alma siparişi detayı
 *     security:
 *       - bearerAuth: []
 */
router.get('/purchase-orders/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog', 'production'], ttlSec: 30 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const row = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!row)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        // Produktion (19.09.2026): Projekt und Geräte gleich mit — Maske,
        // Bestellseite und Wareneingang zeigen sie ohne zweite Abfrage.
        const production = await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)
            ? await productionModule_1.productionModule.picker.assignmentFor(tenantId, row.id)
            : null;
        res.status(200).json({ ...(0, exports.parsePurchaseOrderRow)(row), production });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/production:
 *   put:
 *     tags: [Inventory]
 *     summary: "Produktion: Projekt und Geräte einer Bestellung setzen (auch je Zeile)"
 *     security:
 *       - bearerAuth: []
 */
// ── PROJEKT UND GERÄTE AN DER BESTEHENDEN BESTELLUNG (19.09.2026) ───────────
// Für die Bestellseite und den Wareneingang: dort wird die Auswahl gesetzt,
// ohne die Positionen als Inhalt neu zu schreiben — keine Revision, kein
// «aktualisiert». `lineItemIds` (je Zeile ein Gerät, in der Reihenfolge von
// `items`) braucht es nur, wenn mehrere Geräte gewählt sind.
router.put('/purchase-orders/:id/production', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        if (!(await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId))) {
            return res.status(403).json({ error: 'Das Produktionsmodul ist für diese Firma nicht eingeschaltet.', code: 'MODULE_DISABLED' });
        }
        const input = ProductionPurchaseLinkService_1.ProductionPurchaseLinkService.readInput(req.body) ?? { productionProjectId: null, productionItemIds: [] };
        const current = await productionModule_1.productionModule.purchaseLink.getAssignment(tenantId, existing.id);
        const checked = await productionModule_1.productionModule.purchaseLink.validate(tenantId, input, current);
        let items = [];
        try {
            items = JSON.parse(existing.items || '[]');
        }
        catch {
            items = [];
        }
        /* `lineItemIds`: was die Oberfläche je Zeile sagt — eine Id setzt
           das Gerät, ein LEERER Text stellt die Zeile zum Projekt zurück,
           nichts (null) lässt sie, wie sie ist. */
        const lineItemIds = Array.isArray(req.body?.lineItemIds) ? req.body.lineItemIds : [];
        items = items.map((item, index) => {
            const chosen = lineItemIds[index];
            if (typeof chosen !== 'string')
                return item;
            return { ...item, productionItemId: chosen.trim() ? chosen.trim().slice(0, 64) : null };
        });
        items = productionModule_1.productionModule.purchaseLink.assignLines(items, checked.selection);
        const updated = await prisma_client_1.default.purchaseOrder.update({
            where: { id: existing.id },
            data: {
                items: JSON.stringify(items),
                // Ohne Projekt gibt es auch keine Beschriftung zu setzen.
                ...(existing.projectName || !checked.label ? {} : { projectName: checked.label }),
            },
        });
        await productionModule_1.productionModule.purchaseLink.saveAssignment(tenantId, existing.id, checked.selection, req.user.id);
        await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, req.user.id);
        res.status(200).json({
            ...(0, exports.parsePurchaseOrderRow)(updated),
            production: await productionModule_1.productionModule.picker.assignmentFor(tenantId, existing.id),
        });
    }
    catch (error) {
        (0, exports.sendPurchaseOrderError)(res, error);
    }
});
/**
 * @swagger
 * /inventory/purchase-orders:
 *   post:
 *     tags: [Inventory]
 *     summary: Satın alma siparişi oluştur (çoklu tedarikçi seçiminde tedarikçi başına bir sipariş)
 *     security:
 *       - bearerAuth: []
 */
router.post('/purchase-orders', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const rawOrders = Array.isArray(req.body?.orders) ? req.body.orders : [req.body || {}];
        if (!rawOrders.length)
            return res.status(400).json({ error: 'En az bir sipariş gereklidir.' });
        if (rawOrders.length > 20)
            return res.status(400).json({ error: 'Tek istekte en fazla 20 sipariş oluşturulabilir.' });
        // İki faz: önce TÜM siparişler doğrulanır (kısmî yazma olmasın), sonra yazılır.
        const prepared = [];
        // PRODUKTION (19.09.2026): wo das Modul an ist, braucht schon die
        // Preisanfrage ein Projekt und mindestens ein Gerät (Vorgabe Samet).
        const productionOn = await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId);
        let canPickSuppliers;
        for (const raw of rawOrders) {
            const normalized = (0, exports.normalizePurchaseOrderItems)(raw?.items);
            let items = normalized.items;
            const { totalNet, totalGross, totalVat } = normalized;
            const { fees, totalFees } = normalizePurchaseOrderFees(raw?.additionalFees);
            const vat = normalizePurchaseOrderVat(raw || {});
            // Üç giriş yolu: taslak (DRAFT), fiyat talebi (PRICE_REQUEST — satırlar
            // fiyatsız olabilir), doğrudan sipariş (PENDING, varsayılan).
            const requestedStatus = String(raw?.status || 'PENDING').toUpperCase();
            if (!PO_INITIAL_STATUSES.has(requestedStatus)) {
                throw new Error('Yeni sipariş yalnızca DRAFT, PRICE_REQUEST veya PENDING durumuyla açılabilir.');
            }
            /* FİYAT TALEBİ: tedarikçi(ler)i yalnızca Administrator + muhasebe
               seçer (25.09.2026); başka rolde talep tedarikçisiz kaydedilir.
               Sipariş eskisi gibi TEK ve ZORUNLU tedarikçiyle açılır. */
            let supplier;
            let requestSuppliers = null;
            if (PO_PRICE_REQUEST_STATUSES.has(requestedStatus)) {
                canPickSuppliers ??= await poCanPickRequestSuppliers(req.user.id);
                if (!canPickSuppliers) {
                    supplier = { ...PO_NO_SUPPLIER };
                }
                else {
                    const rawList = Array.isArray(raw?.requestSuppliers)
                        ? raw.requestSuppliers
                        : (raw?.supplierId || String(raw?.supplierName ?? '').trim() ? [raw] : []);
                    const columns = poRequestSupplierColumns(await poResolveRequestSuppliers(tenantId, rawList, []));
                    ({ requestSuppliers, ...supplier } = columns);
                }
            }
            else {
                supplier = await resolvePurchaseOrderSupplier(tenantId, raw || {});
            }
            let production = null;
            let productionLabel = null;
            if (productionOn) {
                // Projekt und Gerät sind FREIWILLIG (21.09.2026): kommt nichts
                // mit, entsteht der Vorgang ohne Produktionsbezug und lässt
                // sich später zuordnen.
                const selection = ProductionPurchaseLinkService_1.ProductionPurchaseLinkService.readInput(raw);
                if (selection) {
                    const checked = await productionModule_1.productionModule.purchaseLink.validate(tenantId, selection, null);
                    items = productionModule_1.productionModule.purchaseLink.assignLines(items, checked.selection);
                    production = checked.selection;
                    productionLabel = checked.label || null;
                }
            }
            // Direkt als bestätigte Bestellung angelegt: dieselbe Pflicht wie beim Bestätigen.
            if (requestedStatus === 'PENDING')
                assertApprovable(items);
            prepared.push({
                // Boş bırakılırsa sunucu BE-{yıl}-{sıra} üretir.
                referenceNumber: raw?.referenceNumber ? normalizeReferenceNumber(raw.referenceNumber) : null,
                quoteNumber: raw?.quoteNumber ? String(raw.quoteNumber).trim() || null : null,
                orderedByName: raw?.orderedByName ? String(raw.orderedByName).trim() || null : null,
                // Ohne eigene Angabe steht das Produktionsprojekt im PDF.
                projectName: raw?.projectName ? String(raw.projectName).trim() || null : productionLabel,
                // Alıcı adı opsiyoneldir; boşsa PDF bloğu bugünkü hâlinde kalır.
                recipientName: poRecipientName(raw?.recipientName),
                // Boş ön yazı NULL yazılır: PDF standart metnine döner.
                coverLetter: poCoverLetter(raw?.coverLetter),
                // Was die Vorlage ausgeblendet hatte, faehrt mit — das PDF
                // braucht es spaeter ohne die Vorlage.
                hiddenColumnKeys: poHiddenColumnKeys(raw?.hiddenColumnKeys),
                // Die Spalten der Vorlage (Name + Reihenfolge) fahren mit —
                // das PDF traegt spaeter genau diese Titel.
                tableColumns: poTableColumns(raw?.tableColumns),
                currency: raw?.currency ? String(raw.currency) : 'CHF',
                status: requestedStatus,
                ...vat,
                ...supplier,
                requestSuppliers,
                items,
                additionalFees: fees,
                totalNet,
                totalGross,
                // Die Zeilenbeträge gehen mit: die Steuer wird JE ZEILE
                // gerechnet und addiert (Vorgabe Samet, 07.09.2026).
                totalVat: (0, exports.purchaseOrderTotalVat)(vat, totalNet, totalFees, totalVat, items.map((it) => it.lineTotal)),
                totalFees,
                production,
            });
        }
        const created = [];
        for (const order of prepared) {
            let row = null;
            // Numara benzersiz indeksle korunur. Kullanıcı kod verdiyse çakışma
            // hatadır; otomatik numarada yeniden taranıp denenir.
            const kind = purchaseKindOfStatus(order.status);
            const codeColumn = kind === 'PRICE_REQUEST' ? 'priceRequestNumber' : 'orderNumber';
            for (let attempt = 0; attempt < 3 && !row; attempt++) {
                // Elle girilen kod da depo yazımına çevrilir: Türkçe ekranda
                // yazılan FT-2026-007, PA-2026-007 olarak saklanır.
                const referenceNumber = order.referenceNumber ?? await (0, exports.nextPurchaseReference)(tenantId, kind);
                try {
                    row = await prisma_client_1.default.purchaseOrder.create({
                        data: {
                            id: (0, nanoid_1.nanoid)(12),
                            tenantId,
                            referenceNumber,
                            // Kayıt hangi aşamada doğduysa kod o sütuna da yazılır;
                            // öbürü boş kalır ve sırası geldiğinde çekilir.
                            [codeColumn]: referenceNumber,
                            quoteNumber: order.quoteNumber,
                            orderedByName: order.orderedByName,
                            projectName: order.projectName,
                            recipientName: order.recipientName,
                            coverLetter: order.coverLetter,
                            hiddenColumnKeys: order.hiddenColumnKeys,
                            tableColumns: order.tableColumns,
                            status: order.status,
                            vatMode: order.vatMode,
                            orderVatRate: order.orderVatRate,
                            orderVatCountry: order.orderVatCountry,
                            supplierId: order.supplierId,
                            supplierName: order.supplierName,
                            supplierEmail: order.supplierEmail,
                            supplierAddress: order.supplierAddress,
                            requestSuppliers: order.requestSuppliers,
                            items: JSON.stringify(order.items),
                            additionalFees: JSON.stringify(order.additionalFees),
                            currency: order.currency,
                            totalNet: order.totalNet,
                            totalGross: order.totalGross,
                            totalVat: order.totalVat,
                            totalFees: order.totalFees,
                            createdByEmpId: req.user.id,
                        },
                    });
                }
                catch (err) {
                    if (err?.code !== 'P2002')
                        throw err;
                    if (order.referenceNumber) {
                        return res.status(400).json({ error: `"${order.referenceNumber}" sipariş kodu zaten kullanılıyor.` });
                    }
                }
            }
            if (!row)
                throw new Error('Sipariş numarası üretilemedi, lütfen tekrar deneyin.');
            if (order.production?.productionProjectId) {
                await productionModule_1.productionModule.purchaseLink.saveAssignment(tenantId, row.id, order.production, req.user.id);
                // Schon bestätigt angelegt: die Zeilen stehen sofort bei der Produktion.
                if (PO_APPROVED_STATUSES.has(row.status)) {
                    await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, row, req.user.id);
                }
            }
            created.push((0, exports.parsePurchaseOrderRow)(row));
        }
        res.status(201).json({ createdCount: created.length, orders: created });
    }
    catch (error) {
        (0, exports.sendPurchaseOrderError)(res, error);
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}:
 *   patch:
 *     tags: [Inventory]
 *     summary: Siparişi düzenle (ad değişikliği durumu etkilemez; mail sonrası içerik değişikliği revizyonu artırır)
 *     security:
 *       - bearerAuth: []
 */
router.patch('/purchase-orders/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        const b = req.body || {};
        const data = {};
        let contentChanged = false;
        // Üstbilgi alanları (kod, teklif no, Bestellung, proje) durumu ETKİLEMEZ —
        // tedarikçiye giden ürün listesi değişmediği sürece "güncellendi" yok.
        if (b.referenceNumber !== undefined) {
            data.referenceNumber = normalizeReferenceNumber(b.referenceNumber);
            // Elle değiştirilen kod, kaydın ŞU ANKİ aşamasının kodudur — yoksa
            // bir sonraki aşama değişikliğinde eski kod geri gelirdi.
            const editedColumn = purchaseKindOfStatus(existing.status) === 'PRICE_REQUEST'
                ? 'priceRequestNumber'
                : 'orderNumber';
            data[editedColumn] = data.referenceNumber;
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
        // Die ausgeblendeten Spalten sind ebenfalls Kopf, nicht Inhalt: sie
        // aendern, was das Blatt ZEIGT, nicht, was der Lieferant bekommt —
        // darum kein «güncellendi», keine neue Revision.
        if (b.hiddenColumnKeys !== undefined) {
            data.hiddenColumnKeys = poHiddenColumnKeys(b.hiddenColumnKeys);
        }
        // Ebenso der Schnappschuss der Vorlagenspalten (Titel + Reihenfolge
        // im PDF): Kopf, nicht Inhalt.
        if (b.tableColumns !== undefined) {
            data.tableColumns = poTableColumns(b.tableColumns);
        }
        const vatChanged = b.vatMode !== undefined || b.orderVatRate !== undefined || b.orderVatCountry !== undefined;
        const wantsContentChange = b.items !== undefined || b.currency !== undefined
            || b.additionalFees !== undefined || vatChanged
            || b.supplierId !== undefined || b.supplierName !== undefined || b.supplierEmail !== undefined;
        if (wantsContentChange && existing.status === 'COMPLETED') {
            return res.status(400).json({ error: 'Tamamlanmış (stoğa eklenmiş) sipariş düzenlenemez.' });
        }
        /* ── PRODUKTION (19.09.2026) ─────────────────────────────────────
           Die Auswahl (Projekt + Geräte) darf mitkommen; wo das Modul an
           ist, braucht jede Änderung der Zeilen eine — gespeichert oder
           mitgeschickt —, und jede Zeile ihr Gerät. Kopfangaben allein
           (Anschreiben, Empfänger …) prüfen nichts. */
        const productionOn = await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId);
        const productionInput = productionOn ? ProductionPurchaseLinkService_1.ProductionPurchaseLinkService.readInput(b) : undefined;
        const currentAssignment = productionOn ? await productionModule_1.productionModule.purchaseLink.getAssignment(tenantId, existing.id) : null;
        let productionSelection = currentAssignment
            ? { productionProjectId: currentAssignment.productionProjectId, productionItemIds: currentAssignment.productionItemIds }
            : null;
        if (productionInput !== undefined) {
            const checked = await productionModule_1.productionModule.purchaseLink.validate(tenantId, productionInput, currentAssignment);
            productionSelection = checked.selection;
            if (!existing.projectName && b.projectName === undefined && checked.label)
                data.projectName = checked.label;
        }
        if (b.items !== undefined) {
            const normalized = (0, exports.normalizePurchaseOrderItems)(b.items);
            let items = normalized.items;
            // Ohne Projekt bleiben die Zeilen unetikettiert — das ist erlaubt.
            if (productionOn) {
                items = productionModule_1.productionModule.purchaseLink.assignLines(items, productionSelection ?? { productionProjectId: null, productionItemIds: [] });
            }
            data.items = JSON.stringify(items);
            data.totalNet = normalized.totalNet;
            data.totalGross = normalized.totalGross;
            data.totalVat = normalized.totalVat;
            contentChanged = true;
        }
        else if (productionInput !== undefined && productionSelection) {
            // Nur die Auswahl ändert sich: die gespeicherten Zeilen bekommen
            // ihr Gerät neu (bei EINEM Gerät alle), ohne dass sich an Betrag
            // oder Lieferant etwas ändert — also keine neue Revision.
            let storedItems = [];
            try {
                storedItems = JSON.parse(existing.items || '[]');
            }
            catch {
                storedItems = [];
            }
            data.items = JSON.stringify(productionModule_1.productionModule.purchaseLink.assignLines(storedItems, productionSelection));
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
        const touchesSupplier = b.supplierId !== undefined || b.supplierName !== undefined || b.supplierEmail !== undefined;
        if (PO_PRICE_REQUEST_STATUSES.has(existing.status)) {
            /* FİYAT TALEBİ (25.09.2026): tedarikçi LİSTESİ, yalnızca
               Administrator + muhasebe. Başka rolün gönderdiği tedarikçi
               alanları sessizce yok sayılır — kayıttaki liste kalır. */
            if ((b.requestSuppliers !== undefined || touchesSupplier) && await poCanPickRequestSuppliers(req.user.id)) {
                const rawList = b.requestSuppliers !== undefined
                    ? b.requestSuppliers
                    : (b.supplierId || String(b.supplierName ?? '').trim() ? [b] : []);
                Object.assign(data, poRequestSupplierColumns(await poResolveRequestSuppliers(tenantId, rawList, poReadRequestSuppliers(existing))));
                contentChanged = true;
            }
        }
        else if (touchesSupplier) {
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
            /* Die Zeilen, auf denen die Steuer sitzt: entweder die eben
               geschickten oder die gespeicherten. Ohne sie liesse sich die
               Steuer nicht mehr JE ZEILE rechnen, und das gespeicherte
               Dokument wiche vom Bildschirm ab. */
            let effectiveItems = [];
            if (b.items !== undefined) {
                try {
                    effectiveItems = JSON.parse(data.items || '[]');
                }
                catch {
                    effectiveItems = [];
                }
            }
            else {
                try {
                    effectiveItems = JSON.parse(existing.items || '[]');
                }
                catch {
                    effectiveItems = [];
                }
            }
            const lineVatSum = b.items !== undefined
                ? data.totalVat
                : Math.round(effectiveItems.reduce((sum, it) => sum + (Number(it?.lineVat) || 0), 0) * 100) / 100;
            data.totalVat = (0, exports.purchaseOrderTotalVat)({
                vatMode: data.vatMode ?? existing.vatMode ?? 'LINE',
                orderVatRate: data.orderVatRate ?? existing.orderVatRate ?? 0,
            }, data.totalNet ?? existing.totalNet ?? 0, data.totalFees ?? existing.totalFees ?? 0, lineVatSum, effectiveItems.map((it) => Number(it?.lineTotal) || 0));
        }
        if (!Object.keys(data).length)
            return res.status(400).json({ error: 'Güncellenecek alan yok.' });
        // REVİZYON: mail atılmış (tedarikçinin elindeki PDF eskimiş) ve HENÜZ
        // MAL KABULE GEÇMEMİŞ siparişlerde içerik değişikliği `revision`ı
        // artırır — sonraki mail "güncellendi" etiketi taşır. Ad değişikliği
        // bu bloğa hiç girmez. DURUM ARTIK DEĞİŞMEZ: "Aktualisiert" (UPDATED)
        // durumu kaldırıldı (kullanıcı isteği 2026-08-03), sipariş verilmiş
        // olarak (ORDERED) kalır. Fiyat talebi aşamasındaki ve TO_BE_STOCKED'daki
        // değişiklikler revizyon da üretmez (kullanıcı akışı 2026-08-02).
        const stageTakesRevision = existing.status === 'ORDER_DRAFT' || existing.status === 'PENDING' || existing.status === 'ORDERED';
        if (contentChanged && existing.emailSentAt && stageTakesRevision) {
            data.revision = (existing.revision || 0) + 1;
        }
        try {
            const updated = await prisma_client_1.default.purchaseOrder.update({ where: { id: existing.id }, data });
            if (productionOn && productionInput !== undefined && productionSelection !== null) {
                await productionModule_1.productionModule.purchaseLink.saveAssignment(tenantId, existing.id, productionSelection, req.user.id);
            }
            // Eine bestätigte Bestellung (etwa im Wareneingang bearbeitet):
            // ihre Zeilen bei der Produktion folgen dem neuen Stand.
            if (productionOn && PO_APPROVED_STATUSES.has(updated.status) && (data.items !== undefined || productionInput !== undefined)) {
                await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, req.user.id);
            }
            // Onaylı iç sipariş düzenlendi (miktar, satır): üretim projesi
            // hemen yeni hâli alır — eski satırların üreticisi de dahil.
            if (PO_APPROVED_STATUSES.has(updated.status) && data.items !== undefined) {
                // Aynı üreticinin ikinci çağrısı süren senkrona katılır.
                (0, exports.refreshProducerProduction)(existing);
                (0, exports.refreshProducerProduction)(updated);
            }
            res.status(200).json((0, exports.parsePurchaseOrderRow)(updated));
        }
        catch (err) {
            if (err?.code === 'P2002') {
                return res.status(400).json({ error: `"${data.referenceNumber}" sipariş kodu zaten kullanılıyor.` });
            }
            throw err;
        }
    }
    catch (error) {
        (0, exports.sendPurchaseOrderError)(res, error);
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/status:
 *   patch:
 *     tags: [Inventory]
 *     summary: Sipariş durumunu elle değiştir (COMPLETED dışındaki durumlar arasında serbest geçiş)
 *     security:
 *       - bearerAuth: []
 */
router.patch('/purchase-orders/:id/status', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
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
        let storedItems = [];
        try {
            storedItems = JSON.parse(existing.items || '[]');
        }
        catch {
            storedItems = [];
        }
        /* ONAY KONTROLÜ KALKTI (22.09.2026, Vorgabe Samet: «onay butonları da
       olmayacak»): eksik satır siparişi durdurmaz, mal kabulde zaten her
       satır tek tek ele alınır. */
        // PRODUKTION: der Stufenwechsel verlangt NICHTS mehr (21.09.2026) —
        // ist ein Projekt zugeordnet, bekommen die Zeilen ihre Geräte, sonst
        // geht es ohne weiter und die Zuordnung kann später kommen.
        const productionOn = await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId);
        if (productionOn && purchaseStageRank(status) > purchaseStageRank(existing.status)) {
            const assignment = await productionModule_1.productionModule.purchaseLink.getAssignment(tenantId, existing.id);
            if (assignment) {
                productionModule_1.productionModule.purchaseLink.assignLines(storedItems, {
                    productionProjectId: assignment.productionProjectId,
                    productionItemIds: assignment.productionItemIds,
                });
            }
        }
        // AŞAMA DEĞİŞİNCE BELGE DEĞİŞİR: fiyat talebi siparişe dönünce kendi
        // sipariş kodunu alır (PA-2026-001 → BE-2026-004), bir aşama geri
        // alınırsa eski talep kodu geri gelir. Her iki kod da kayıtta kalır ve
        // aranabilir — tedarikçi hangisini yazıyorsa kayıt bulunur.
        const codePatch = await purchaseStageCodePatch(tenantId, existing, purchaseKindOfStatus(status));
        /* BELGE TAKASI KALKTI (22.09.2026): bir kaydın TEK belgesi vardır.
           Fiyat talebi ile sipariş ayrı kayıtlardır, mal kabul de siparişin
           kendi satırları üzerinde çalışır — takas edilecek ikinci bir liste
           yoktur ve olsaydı mal kabulde girilen miktarları silerdi. */
        const updated = await prisma_client_1.default.purchaseOrder.update({
            where: { id: existing.id },
            data: { status, ...codePatch },
        });
        // Bestätigt → die Zeilen stehen bei der Produktion; zurück in den
        // Entwurf → sie verschwinden dort wieder.
        if (productionOn)
            await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, req.user.id);
        // Üretim şirketine giden sipariş: onay (ya da geri alma) üretim emrini
        // kurar ya da kaldırır.
        (0, exports.refreshProducerProduction)(updated);
        res.status(200).json((0, exports.parsePurchaseOrderRow)(updated));
    }
    catch (error) {
        (0, exports.sendPurchaseOrderError)(res, error);
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/convert-to-order:
 *   post:
 *     tags: [Inventory]
 *     summary: "Fiyat talebinden YENİ bir sipariş oluştur (talep listede kalır)"
 *     security:
 *       - bearerAuth: []
 */
/* ══ FİYAT TALEBİ → YENİ SİPARİŞ (Vorgabe Samet, 22.09.2026) ══════════════
 *
 * «Eğer fiyat modülü siparişe dönüştür derse fiyat talebi yine listede kalması
 *  lazım ama yeni sipariş oluşturması lazım ve siparişin otomatik açılması
 *  lazım — artık bir süreç olmayacak.»
 *
 * Eskiden dönüştürme AYNI kaydın durumunu değiştiriyordu: talep ekrandan
 * kayboluyor, yerine sipariş geçiyordu. Artık talep DOKUNULMADAN kalır ve
 * satırlarının bir KOPYASI yeni bir kayıt olarak doğar:
 *
 *   • Yeni kayıt kendi SİPARİŞ numarasını çeker (BE-YYYY-NNN).
 *   • `priceRequestNumber` alanına talebin numarası yazılır — iz burada kalır
 *     ve tedarikçi eski kodu yazınca arama iki kaydı da bulur.
 *   • Satırlar kopyalanırken MAL KABUL DAMGALARI SIFIRLANIR: talebin
 *     (olmayan) kabulü yeni siparişe geçmez.
 *   • Üretim ataması (proje + cihazlar) varsa o da kopyalanır.
 *
 * Bir talep birden çok kez dönüştürülebilir (iki tedarikçiden iki sipariş) —
 * engel yoktur, her çağrı yeni bir kayıt açar.
 */
router.post('/purchase-orders/:id/convert-to-order', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const source = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!source)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        if (!PO_PRICE_REQUEST_STATUSES.has(source.status)) {
            return res.status(400).json({ error: 'Yalnızca fiyat talebi siparişe dönüştürülebilir.' });
        }
        /* ÇOK TEDARİKÇİLİ TALEP (25.09.2026): sipariş TEK tedarikçilidir —
           hangisiyle açılacağını `supplierIndex` söyler (yoksa ilki). */
        const requestSuppliers = poReadRequestSuppliers(source);
        const chosen = requestSuppliers[poSupplierIndex(req.body?.supplierIndex, requestSuppliers) ?? 0];
        const orderSupplier = chosen
            ? {
                supplierId: chosen.supplierId,
                supplierName: chosen.supplierName,
                supplierEmail: chosen.supplierEmail,
                supplierAddress: chosen.supplierAddress,
            }
            : {
                supplierId: source.supplierId,
                supplierName: source.supplierName,
                supplierEmail: source.supplierEmail,
                supplierAddress: source.supplierAddress,
            };
        /* SİPARİŞTEN GELEN TALEP YERİNDE GERİ DÖNER (24.09.2026): «Fiyat
           talebi almak istiyorum» ile talebe dönmüş bir sipariş kendi
           sipariş numarasını taşır — dönüştürünce AYNI kayıt, AYNI numarayla
           yeniden sipariş olur; kopya açılmaz, numara yanmaz. */
        if (source.orderNumber) {
            const taken = await prisma_client_1.default.purchaseOrder.findFirst({
                where: { tenantId, referenceNumber: source.orderNumber, NOT: { id: source.id } },
                select: { id: true },
            });
            if (!taken) {
                const standard = (0, standardOrderTemplate_1.isStandardColumns)(source.tableColumns);
                const flipped = await prisma_client_1.default.purchaseOrder.update({
                    where: { id: source.id },
                    data: {
                        status: 'ORDER_DRAFT',
                        referenceNumber: source.orderNumber,
                        ...orderSupplier,
                        requestSuppliers: null,
                        ...(standard || !source.tableColumns
                            ? { tableColumns: (0, standardOrderTemplate_1.standardTableColumnsJson)('ORDER'), hiddenColumnKeys: (0, standardOrderTemplate_1.standardHiddenKeysJson)('ORDER') }
                            : {}),
                    },
                });
                if (await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)) {
                    await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, flipped, req.user.id);
                }
                return res.status(200).json((0, exports.parsePurchaseOrderRow)(flipped));
            }
        }
        let items = [];
        try {
            items = JSON.parse(source.items || '[]');
        }
        catch {
            items = [];
        }
        // Kopyanın satırları TEMİZ gelir: talepte kabul edilmiş bir şey yoktur.
        const copiedItems = (Array.isArray(items) ? items : []).map((item) => ({
            ...item,
            receivedQuantity: 0,
            receivedAt: null,
        }));
        let row = null;
        for (let attempt = 0; attempt < 3 && !row; attempt++) {
            const referenceNumber = await (0, exports.nextPurchaseReference)(tenantId, 'ORDER');
            try {
                row = await prisma_client_1.default.purchaseOrder.create({
                    data: {
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId,
                        referenceNumber,
                        orderNumber: referenceNumber,
                        // Nereden geldiği kayıtta durur: talebin numarası.
                        priceRequestNumber: source.priceRequestNumber || source.referenceNumber,
                        status: 'ORDER_DRAFT',
                        quoteNumber: source.quoteNumber,
                        orderedByName: source.orderedByName,
                        projectName: source.projectName,
                        recipientName: source.recipientName,
                        coverLetter: source.coverLetter,
                        // Standart talep şablonu → standart sipariş şablonu (24.09.2026).
                        ...((0, standardOrderTemplate_1.isStandardColumns)(source.tableColumns)
                            ? { tableColumns: (0, standardOrderTemplate_1.standardTableColumnsJson)('ORDER'), hiddenColumnKeys: (0, standardOrderTemplate_1.standardHiddenKeysJson)('ORDER') }
                            : { tableColumns: source.tableColumns, hiddenColumnKeys: source.hiddenColumnKeys }),
                        ...orderSupplier,
                        items: JSON.stringify(copiedItems),
                        additionalFees: source.additionalFees,
                        currency: source.currency,
                        vatMode: source.vatMode,
                        orderVatRate: source.orderVatRate,
                        orderVatCountry: source.orderVatCountry,
                        totalNet: source.totalNet,
                        totalGross: source.totalGross,
                        totalVat: source.totalVat,
                        totalFees: source.totalFees,
                        createdByEmpId: req.user.id,
                    },
                });
            }
            catch (err) {
                if (err?.code !== 'P2002')
                    throw err;
            }
        }
        if (!row)
            return res.status(400).json({ error: 'Sipariş numarası üretilemedi, lütfen tekrar deneyin.' });
        // Üretim ataması (proje + cihazlar) kopyaya da geçer.
        if (await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)) {
            const assignment = await productionModule_1.productionModule.purchaseLink.getAssignment(tenantId, source.id);
            if (assignment) {
                await productionModule_1.productionModule.purchaseLink.saveAssignment(tenantId, row.id, {
                    productionProjectId: assignment.productionProjectId,
                    productionItemIds: assignment.productionItemIds,
                }, req.user.id);
                await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, row, req.user.id);
            }
        }
        res.status(201).json((0, exports.parsePurchaseOrderRow)(row));
    }
    catch (error) {
        (0, exports.sendPurchaseOrderError)(res, error);
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/duplicate:
 *   post:
 *     tags: [Inventory]
 *     summary: "Fiyat talebinin ya da siparişin TASLAK kopyasını aç"
 *     security:
 *       - bearerAuth: []
 */
/* ══ KOPYA AÇ (Vorgabe Samet, 25.09.2026) ═══════════════════════════════════
 *
 * «Fiyat taleplerinin ve siparişlerin de başka kopyaları açılabilsin ama
 *  taslak olarak açılması lazım.»
 *
 * Kopya kaynağın TÜRÜNDE kalır ve her zaman TASLAK doğar:
 *   • fiyat talebi → DRAFT, yeni PA- numarası
 *   • sipariş (hangi durumda olursa olsun) → ORDER_DRAFT, yeni BE- numarası
 * Kaynak hiç değişmez. Kopyaya GEÇMEYENLER: mail damgası / revizyon, mal kabul
 * damgaları, stoğa işlenme, talep ↔ sipariş izi — ve satırların PROJE BAĞI
 * (`source`): proje tedarik ekranı sipariş edilen miktarı bu bağdan sayar,
 * kopya onu iki kez saydırırdı. Üretim ataması da aynı sebeple kopyalanmaz.
 */
router.post('/purchase-orders/:id/duplicate', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const source = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!source)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        const kind = PO_PRICE_REQUEST_STATUSES.has(source.status) ? 'PRICE_REQUEST' : 'ORDER';
        const codeColumn = kind === 'PRICE_REQUEST' ? 'priceRequestNumber' : 'orderNumber';
        let items = [];
        try {
            items = JSON.parse(source.items || '[]');
        }
        catch {
            items = [];
        }
        const copiedItems = (Array.isArray(items) ? items : []).map((item) => {
            const { source: _projectLink, ...rest } = item ?? {};
            return { ...rest, receivedQuantity: 0, receivedAt: null };
        });
        let row = null;
        for (let attempt = 0; attempt < 3 && !row; attempt++) {
            const referenceNumber = await (0, exports.nextPurchaseReference)(tenantId, kind);
            try {
                row = await prisma_client_1.default.purchaseOrder.create({
                    data: {
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId,
                        referenceNumber,
                        [codeColumn]: referenceNumber,
                        status: kind === 'PRICE_REQUEST' ? 'DRAFT' : 'ORDER_DRAFT',
                        quoteNumber: source.quoteNumber,
                        orderedByName: source.orderedByName,
                        projectName: source.projectName,
                        recipientName: source.recipientName,
                        coverLetter: source.coverLetter,
                        tableColumns: source.tableColumns,
                        hiddenColumnKeys: source.hiddenColumnKeys,
                        supplierId: source.supplierId,
                        supplierName: source.supplierName,
                        supplierEmail: source.supplierEmail,
                        supplierAddress: source.supplierAddress,
                        // Talebin tedarikçi listesi gelir — mail damgaları gelmez.
                        requestSuppliers: kind === 'PRICE_REQUEST' && source.requestSuppliers
                            ? JSON.stringify(poReadRequestSuppliers(source).map((entry) => ({ ...entry, emailSentAt: null, emailRecipient: null })))
                            : null,
                        items: JSON.stringify(copiedItems),
                        additionalFees: source.additionalFees,
                        currency: source.currency,
                        vatMode: source.vatMode,
                        orderVatRate: source.orderVatRate,
                        orderVatCountry: source.orderVatCountry,
                        totalNet: source.totalNet,
                        totalGross: source.totalGross,
                        totalVat: source.totalVat,
                        totalFees: source.totalFees,
                        createdByEmpId: req.user.id,
                    },
                });
            }
            catch (err) {
                if (err?.code !== 'P2002')
                    throw err;
            }
        }
        if (!row)
            return res.status(400).json({ error: 'Numara üretilemedi, lütfen tekrar deneyin.' });
        res.status(201).json((0, exports.parsePurchaseOrderRow)(row));
    }
    catch (error) {
        (0, exports.sendPurchaseOrderError)(res, error);
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/convert-to-request:
 *   post:
 *     tags: [Inventory]
 *     summary: "Siparişi fiyat talebine geri çevir (Fiyat talebi almak istiyorum)"
 *     security:
 *       - bearerAuth: []
 */
/* ══ SİPARİŞ → FİYAT TALEBİ (Vorgabe Samet, 24.09.2026) ═════════════════════
 *
 * «Sipariş ekranında ‹fiyat talebi almak istiyorum› butonu olsun, tıklayınca
 *  sipariş geri fiyat talebine dönsün, fiyat talebi açılsın.»
 *
 * AYNI kayıt talebe döner (kopya açılmaz): durum DRAFT, görünen kod talebin
 * kodu (varsa eskisi, yoksa yeni PA-), sipariş numarası kayıtta SAKLI kalır ve
 * talep yeniden siparişe dönüştürülünce aynı numara geri gelir. Sütunlar
 * standart fiyat talebi şablonuna geçer (ÜRÜN - MALZEME / MİKTAR). Onaylanmış
 * (mal kabulde) ya da stoğa işlenmiş sipariş geri dönemez — önce onay geri
 * alınır. Üretim satırları ve üretim emri düşer.
 */
router.post('/purchase-orders/:id/convert-to-request', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const source = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!source)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        if (!['ORDER_DRAFT', 'PENDING', 'ORDERED'].includes(String(source.status))) {
            return res.status(400).json({
                error: 'Yalnızca onaylanmamış sipariş fiyat talebine çevrilebilir.',
                code: 'ORDER_LOCKED',
            });
        }
        let referenceNumber = source.priceRequestNumber || null;
        if (referenceNumber) {
            const taken = await prisma_client_1.default.purchaseOrder.findFirst({
                where: { tenantId, referenceNumber, NOT: { id: source.id } },
                select: { id: true },
            });
            if (taken)
                referenceNumber = null;
        }
        let row = null;
        for (let attempt = 0; attempt < 3 && !row; attempt++) {
            const code = referenceNumber ?? await (0, exports.nextPurchaseReference)(tenantId, 'PRICE_REQUEST');
            try {
                row = await prisma_client_1.default.purchaseOrder.update({
                    where: { id: source.id },
                    data: {
                        status: 'DRAFT',
                        referenceNumber: code,
                        priceRequestNumber: code,
                        // Sipariş numarası SAKLI kalır: geri dönüşte aynı kod gelir.
                        orderNumber: source.orderNumber || source.referenceNumber,
                        tableColumns: (0, standardOrderTemplate_1.standardTableColumnsJson)('PRICE_REQUEST'),
                        hiddenColumnKeys: (0, standardOrderTemplate_1.standardHiddenKeysJson)('PRICE_REQUEST'),
                    },
                });
            }
            catch (err) {
                if (err?.code !== 'P2002')
                    throw err;
                referenceNumber = null;
            }
        }
        if (!row)
            return res.status(400).json({ error: 'Fiyat talebi numarası üretilemedi, lütfen tekrar deneyin.' });
        if (await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)) {
            await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, row, req.user.id);
        }
        (0, exports.refreshProducerProduction)(row);
        res.status(200).json((0, exports.parsePurchaseOrderRow)(row));
    }
    catch (error) {
        (0, exports.sendPurchaseOrderError)(res, error);
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/receive/revert-line:
 *   post:
 *     tags: [Inventory]
 *     summary: "Stoğa gitmiş TEK satırı geri gönder (o satırın lager buchungları geri alınır)"
 *     security:
 *       - bearerAuth: []
 */
/* ══ «STOĞA GİDENLER» SEKMESİNDEKİ GERİ GÖNDERME (22.09.2026) ═════════════
 *
 * «Stoğa gidenler olarak ayrı bir tab de olacak, orada geri gönderme butonu
 *  olacak; geri gönderince gidecek.»
 *
 * Bütün mal kabulü geri almak (`/receive/revert`) yerine TEK SATIRIN
 * buchunglarını geri alır: o satırın ürününe ait, bu siparişin yazdığı giriş
 * hareketleri en yeniden başlayarak satırın kabul miktarı kadar geri sarılır
 * (tam örtüşen hareket silinir, artan bir hareket küçültülür), bakiye düşer,
 * partiler silinir ve satır yeniden «mal kabul bekliyor» olur.
 *
 * Son kabul edilmiş satır da geri gelince sipariş MAL KABULDEN ÇIKAR ve
 * sipariş durumuna döner (mail gitmişse ORDERED, gitmemişse ORDER_DRAFT).
 */
router.post('/purchase-orders/:id/receive/revert-line', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        let items = [];
        try {
            items = JSON.parse(existing.items || '[]');
        }
        catch {
            items = [];
        }
        const index = Number(req.body?.index);
        if (!Number.isInteger(index) || index < 0 || index >= items.length) {
            return res.status(400).json({ error: 'Geçersiz satır indeksi.' });
        }
        const item = items[index];
        const receivedQuantity = Number(item?.receivedQuantity) || 0;
        if (receivedQuantity <= 0) {
            return res.status(400).json({ error: 'Bu satır stoğa aktarılmamış.' });
        }
        const articleId = item?.articleId ? String(item.articleId) : null;
        /* Bu satırın hareketleri: aynı siparişin, aynı ürünün giriş
           hareketleri. En YENİden geri sarılır — kısmî kabullerde son
           yapılan işlem ilk geri alınandır. */
        const movements = articleId
            ? await prisma_client_1.default.stockMovement.findMany({
                where: { tenantId, referenceId: existing.id, movementType: 'IN', articleId },
                orderBy: { transactionDate: 'desc' },
                select: { id: true, articleId: true, quantity: true, destinationLocationId: true },
            })
            : [];
        let need = receivedQuantity;
        const dropIds = [];
        const shrink = [];
        const deltasByLocation = new Map();
        const noteDelta = (locationId, article, amount) => {
            if (!locationId)
                return;
            const perArticle = deltasByLocation.get(locationId) ?? new Map();
            perArticle.set(article, (perArticle.get(article) ?? 0) - amount);
            deltasByLocation.set(locationId, perArticle);
        };
        for (const movement of movements) {
            if (need <= 0.0000001)
                break;
            const quantity = Number(movement.quantity) || 0;
            const locationId = movement.destinationLocationId ? String(movement.destinationLocationId) : null;
            if (quantity <= need + 0.0000001) {
                dropIds.push(String(movement.id));
                noteDelta(locationId, String(movement.articleId), quantity);
                need -= quantity;
            }
            else {
                shrink.push({ id: String(movement.id), quantity: quantity - need, taken: need });
                noteDelta(locationId, String(movement.articleId), need);
                need = 0;
            }
        }
        item.receivedQuantity = 0;
        item.receivedAt = null;
        const stillReceived = items.some((entry) => (Number(entry?.receivedQuantity) || 0) > 0);
        // Son kabul de geri geldiyse sipariş mal kabulden çıkar.
        const targetStatus = stillReceived
            ? 'TO_BE_STOCKED'
            : (existing.emailSentAt ? 'ORDERED' : 'ORDER_DRAFT');
        const updated = await prisma_client_1.default.$transaction(async (tx) => {
            if (dropIds.length) {
                await tx.articleSupplier.deleteMany({ where: { tenantId, stockMovementId: { in: dropIds } } });
                await tx.stockMovement.deleteMany({ where: { tenantId, id: { in: dropIds } } });
            }
            for (const entry of shrink) {
                await tx.stockMovement.update({ where: { id: entry.id }, data: { quantity: entry.quantity } });
                /* Partinin kalanı da düşer; sıfırlanırsa parti gider. */
                const lots = await tx.articleSupplier.findMany({ where: { tenantId, stockMovementId: entry.id }, select: { id: true, quantity: true, remainingQuantity: true } });
                for (const lot of lots) {
                    const nextQuantity = Math.max(0, (Number(lot.quantity) || 0) - entry.taken);
                    const nextRemaining = Math.max(0, (Number(lot.remainingQuantity) || 0) - entry.taken);
                    if (nextQuantity <= 0)
                        await tx.articleSupplier.delete({ where: { id: lot.id } });
                    else
                        await tx.articleSupplier.update({ where: { id: lot.id }, data: { quantity: nextQuantity, remainingQuantity: nextRemaining } });
                }
            }
            for (const [locationId, perArticle] of deltasByLocation) {
                await bulkApplyStockBalanceDeltas(tx, tenantId, locationId, perArticle);
            }
            return tx.purchaseOrder.update({
                where: { id: existing.id },
                data: {
                    items: JSON.stringify(items),
                    status: targetStatus,
                    stockedAt: null,
                },
            });
        });
        if (await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)) {
            await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, req.user.id);
        }
        res.status(200).json({
            revertedMovements: dropIds.length + shrink.length,
            order: (0, exports.parsePurchaseOrderRow)(updated),
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
const readStageDocuments = (value) => {
    try {
        const parsed = JSON.parse(String(value || '{}'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
};
/** Das Blatt, das der Datensatz GERADE offen hat. */
const currentStageDoc = (row) => {
    const parse = (value) => {
        try {
            const data = JSON.parse(String(value || '[]'));
            return Array.isArray(data) ? data : [];
        }
        catch {
            return [];
        }
    };
    return {
        items: parse(row.items),
        additionalFees: parse(row.additionalFees),
        totalNet: Number(row.totalNet) || 0,
        totalGross: Number(row.totalGross) || 0,
        totalVat: Number(row.totalVat) || 0,
        totalFees: Number(row.totalFees) || 0,
        vatMode: String(row.vatMode || 'LINE'),
        orderVatRate: Number(row.orderVatRate) || 0,
        orderVatCountry: row.orderVatCountry ?? null,
    };
};
/** Ein Blatt in die Spalten des Datensatzes zurücklegen. */
const stageDocToData = (doc) => ({
    items: JSON.stringify(doc.items ?? []),
    additionalFees: JSON.stringify(doc.additionalFees ?? []),
    totalNet: Number(doc.totalNet) || 0,
    totalGross: Number(doc.totalGross) || 0,
    totalVat: Number(doc.totalVat) || 0,
    totalFees: Number(doc.totalFees) || 0,
    vatMode: doc.vatMode === 'TOTAL' ? 'TOTAL' : 'LINE',
    orderVatRate: Number(doc.orderVatRate) || 0,
    orderVatCountry: doc.orderVatCountry ?? null,
});
/**
 * DER STUFENWECHSEL ALS BLATTWECHSEL: das verlassene Blatt wird abgelegt, das
 * betretene geholt. Fehlt das betretene, bleibt die Liste stehen — so
 * entsteht die Bestellung wie eh und je aus der Anfrage.
 */
const purchaseStageDocPatch = (row, fromStage, toStage) => {
    if (fromStage === toStage)
        return {};
    const docs = readStageDocuments(row.stageDocuments);
    docs[String(fromStage)] = currentStageDoc(row);
    const target = docs[String(toStage)];
    return {
        stageDocuments: JSON.stringify(docs),
        ...(target ? stageDocToData(target) : {}),
    };
};
/**
 * ══ ZWEI VORGÄNGE WERDEN EINER (Vorgabe Samet, 21.09.2026) ═══════════════
 *
 * «Fiyat talebi ↔ sipariş, sipariş ↔ mal kabul birleştirilebilsin … ayrı ayrı
 * oluşturulanlar detayda birleştirilebilsin, ikili ikili. Hangisinden
 * ekliyorsak geçerli numara o olacak.»
 *
 * Es werden nicht zwei Tabellen addiert, sondern ZWEI ABLÄUFE ZU EINEM: der
 * Vorgang, auf dessen Seite man steht (das ZIEL), nimmt den anderen (die
 * QUELLE) in sich auf und BEHÄLT SEINE NUMMER — sie bleibt die gültige.
 *
 *   • Die Positionen der Quelle hängen sich UNTEN an (nichts wird verrechnet
 *     oder zusammengezogen: eine Zeile bleibt die Zeile, die sie war, mit
 *     ihrer eingelagerten Menge). Zusatzkosten kommen mit.
 *   • DIE CODES: ein LEERES Fach des Ziels füllt die Quelle. Eine Anfrage,
 *     die eine Bestellung aufnimmt, trägt deren `BE-` in ihrem Bestellfach —
 *     wird sie später umgewandelt, bekommt sie GENAU DIESE Nummer und keine
 *     neue. Das volle Fach des Ziels bleibt unangetastet.
 *   • DIE STUFE: das Ziel bleibt, wo es steht — AUSSER die Quelle ist schon im
 *     Wareneingang (Stufe 3). Was im Lager gebucht ist, lässt sich nicht
 *     stillschweigend zurücknehmen; dann rückt das Ziel auf diese Stufe und
 *     die Lagerbewegungen der Quelle zeigen fortan auf das Ziel.
 *   • Zusammengeführt wird nur über EINE Stufe hinweg (1↔2, 2↔3) und nie mit
 *     einem abgeschlossenen Vorgang — der ist nicht mehr zu bearbeiten.
 *   • Die Quelle VERSCHWINDET: ihre Mailentwürfe, ihre Produktionszuordnung
 *     und ihre Zeile gehen; ihre Nummer wird nie wieder vergeben.
 */
router.get('/purchase-orders/:id/merge-candidates', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        const stage = purchaseFlowStage(existing.status);
        // Nur die NACHBARSTUFEN, und nie ein abgeschlossener Vorgang.
        const statuses = Object.keys(PURCHASE_FLOW_STAGE).filter((status) => (status !== 'COMPLETED' && Math.abs(PURCHASE_FLOW_STAGE[status] - stage) === 1));
        const search = String(req.query.search || '').trim();
        const rows = await prisma_client_1.default.purchaseOrder.findMany({
            where: {
                tenantId,
                id: { not: existing.id },
                status: { in: statuses },
                ...(search ? {
                    OR: [
                        { referenceNumber: { contains: (0, purchaseDocumentCode_1.purchaseSearchTerm)(search) } },
                        { priceRequestNumber: { contains: (0, purchaseDocumentCode_1.purchaseSearchTerm)(search) } },
                        { orderNumber: { contains: (0, purchaseDocumentCode_1.purchaseSearchTerm)(search) } },
                        { supplierName: { contains: search } },
                        { projectName: { contains: search } },
                    ],
                } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: 60,
            select: {
                id: true, referenceNumber: true, priceRequestNumber: true, orderNumber: true,
                status: true, supplierName: true, projectName: true, currency: true,
                totalNet: true, createdAt: true, items: true,
            },
        });
        res.status(200).json({
            stage,
            orders: rows.map((row) => {
                let items = [];
                try {
                    items = JSON.parse(row.items || '[]');
                }
                catch {
                    items = [];
                }
                const { items: _drop, ...rest } = row;
                return { ...rest, itemCount: Array.isArray(items) ? items.length : 0, stage: purchaseFlowStage(row.status) };
            }),
        });
    }
    catch (error) {
        (0, exports.sendPurchaseOrderError)(res, error);
    }
});
router.post('/purchase-orders/:id/merge', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const target = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!target)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        const sourceId = String(req.body?.sourceId || '').trim();
        const source = sourceId
            ? await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: sourceId, tenantId } })
            : null;
        if (!source)
            return res.status(400).json({ error: 'Birleştirilecek kayıt bulunamadı.', code: 'MERGE_SOURCE_NOT_FOUND' });
        if (source.id === target.id)
            return res.status(400).json({ error: 'Bir kayıt kendisiyle birleştirilemez.', code: 'MERGE_SAME_RECORD' });
        if (target.status === 'COMPLETED' || source.status === 'COMPLETED') {
            return res.status(400).json({ error: 'Tamamlanmış (stoğa eklenmiş) kayıt birleştirilemez.', code: 'MERGE_COMPLETED' });
        }
        const targetStage = purchaseFlowStage(target.status);
        const sourceStage = purchaseFlowStage(source.status);
        if (Math.abs(targetStage - sourceStage) !== 1) {
            return res.status(400).json({
                error: 'Yalnızca komşu aşamadaki iki kayıt birleştirilebilir: fiyat talebi ↔ sipariş, sipariş ↔ mal kabul.',
                code: 'MERGE_STAGE_MISMATCH',
            });
        }
        /* ZEILEN WERDEN NICHT ZUSAMMENGESCHÜTTET (Vorgabe Samet, 21.09.2026):
           die Preisanfrage bleibt die Preisanfrage, die Bestellung die
           Bestellung. Die BLÄTTER der Quelle füllen die LEEREN FÄCHER des
           Ziels; ein Fach, das das Ziel schon hat, bleibt unberührt. */
        const targetDocs = readStageDocuments(target.stageDocuments);
        targetDocs[String(targetStage)] = currentStageDoc(target);
        const sourceDocs = readStageDocuments(source.stageDocuments);
        sourceDocs[String(sourceStage)] = currentStageDoc(source);
        const adopted = [];
        const skipped = [];
        for (const [stage, doc] of Object.entries(sourceDocs)) {
            if (!doc || !Array.isArray(doc.items) || !doc.items.length)
                continue;
            const existingDoc = targetDocs[stage];
            if (existingDoc && Array.isArray(existingDoc.items) && existingDoc.items.length) {
                skipped.push(Number(stage));
                continue;
            }
            targetDocs[stage] = doc;
            adopted.push(Number(stage));
        }
        if (!adopted.length) {
            return res.status(400).json({
                error: 'Bu süreçte o aşamanın belgesi zaten var — alınacak yeni bir belge yok.',
                code: 'MERGE_NOTHING_TO_ADOPT',
            });
        }
        // Leeres Fach füllt die Quelle; das volle Fach des Ziels bleibt.
        const priceRequestNumber = target.priceRequestNumber ?? source.priceRequestNumber ?? null;
        const orderNumber = target.orderNumber ?? source.orderNumber ?? null;
        // Gebuchte Ware zieht die Stufe mit — sonst bleibt das Ziel, wo es ist,
        // und mit ihm SEIN Blatt (die Zeilen der Seite ändern sich nicht).
        const adoptsReceipt = sourceStage === 3 && targetStage < 3 && adopted.includes(3);
        const status = adoptsReceipt ? source.status : target.status;
        const currentCode = purchaseKindOfStatus(status) === 'PRICE_REQUEST' ? priceRequestNumber : orderNumber;
        const openDoc = adoptsReceipt ? targetDocs['3'] : null;
        const updated = await prisma_client_1.default.$transaction(async (tx) => {
            const row = await tx.purchaseOrder.update({
                where: { id: target.id },
                data: {
                    stageDocuments: JSON.stringify(targetDocs),
                    ...(openDoc ? stageDocToData(openDoc) : {}),
                    status,
                    priceRequestNumber,
                    orderNumber,
                    referenceNumber: currentCode ?? target.referenceNumber,
                    ...(adoptsReceipt && source.stockedAt ? { stockedAt: source.stockedAt } : {}),
                    // Ist das offene Blatt ein anderes geworden, trägt die
                    // nächste Mail den Stempel «aktualisiert».
                    ...(openDoc && target.emailSentAt ? { revision: (target.revision || 0) + 1 } : {}),
                },
            });
            // Die Buchungen der Quelle gehören jetzt zum Ziel.
            await tx.stockMovement.updateMany({ where: { tenantId, referenceId: source.id }, data: { referenceId: target.id } });
            await tx.purchaseOrderMailDraft.deleteMany({ where: { tenantId, orderId: source.id } });
            await tx.purchaseOrder.delete({ where: { id: source.id } });
            return row;
        });
        // PRODUKTION: hat das Ziel noch kein Projekt, erbt es das der Quelle.
        if (await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)) {
            const targetAssignment = await productionModule_1.productionModule.purchaseLink.getAssignment(tenantId, target.id);
            const sourceAssignment = await productionModule_1.productionModule.purchaseLink.getAssignment(tenantId, source.id);
            if (!targetAssignment && sourceAssignment) {
                await productionModule_1.productionModule.purchaseLink.saveAssignment(tenantId, target.id, {
                    productionProjectId: sourceAssignment.productionProjectId,
                    productionItemIds: sourceAssignment.productionItemIds,
                }, req.user.id);
            }
            await productionModule_1.productionModule.purchaseLink.removeForPurchaseOrder(tenantId, source.id);
            await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, req.user.id);
        }
        AuditLogService_1.auditLog.log({
            action: 'inventory.purchaseOrder.merge',
            tenantId,
            employeeId: req.user.id,
            entityType: 'PurchaseOrder',
            entityId: target.id,
            metadata: {
                kept: updated.referenceNumber,
                merged: source.referenceNumber,
                targetStage,
                sourceStage,
                adoptedStages: adopted,
                skippedStages: skipped,
            },
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json({
            ...(0, exports.parsePurchaseOrderRow)(updated),
            mergedFrom: source.referenceNumber,
            adoptedStages: adopted,
            skippedStages: skipped,
            production: await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)
                ? await productionModule_1.productionModule.picker.assignmentFor(tenantId, target.id)
                : null,
        });
    }
    catch (error) {
        (0, exports.sendPurchaseOrderError)(res, error);
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/mark-stocked:
 *   post:
 *     tags: [Inventory]
 *     summary: Siparişi stoğa eklendi olarak işaretle (COMPLETED)
 *     security:
 *       - bearerAuth: []
 */
router.post('/purchase-orders/:id/mark-stocked', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        const updated = await prisma_client_1.default.purchaseOrder.update({
            where: { id: existing.id },
            data: { status: 'COMPLETED', stockedAt: new Date() },
        });
        res.status(200).json((0, exports.parsePurchaseOrderRow)(updated));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
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
router.post('/purchase-orders/:id/receive', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const employeeId = req.user.id;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        if (existing.status === 'COMPLETED') {
            return res.status(400).json({ error: 'Sipariş zaten stoğa aktarılmış.' });
        }
        let items = [];
        try {
            items = JSON.parse(existing.items || '[]');
        }
        catch {
            items = [];
        }
        if (!items.length)
            return res.status(400).json({ error: 'Siparişte aktarılacak satır yok.' });
        const complete = req.body?.complete === true;
        const codeSchemeId = String(req.body?.codeSchemeId ?? '').trim();
        const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
        if (!complete && !rawLines.length)
            return res.status(400).json({ error: 'Aktarılacak satır seçilmedi.' });
        const remainingOf = (item) => Math.max(0, (Number(item.quantity) || 0) - (Number(item.receivedQuantity) || 0));
        // Plan: satır indeksi → aktarılacak miktar (+ opsiyonel birim maliyet).
        const plan = new Map();
        if (complete) {
            items.forEach((item, index) => {
                const remaining = remainingOf(item);
                if (remaining > 0)
                    plan.set(index, { quantity: remaining, unitCost: null });
            });
            if (!plan.size)
                return res.status(400).json({ error: 'Tüm satırlar zaten stoğa aktarılmış.' });
        }
        else {
            for (const line of rawLines) {
                const index = Number(line?.index);
                if (!Number.isInteger(index) || index < 0 || index >= items.length) {
                    return res.status(400).json({ error: `Geçersiz satır indeksi: ${line?.index}` });
                }
                const remaining = remainingOf(items[index]);
                if (remaining <= 0)
                    continue; // zaten aktarılmış satır sessizce atlanır
                const requested = Number(line?.quantity);
                const quantity = Number.isFinite(requested) && requested > 0 ? Math.min(requested, remaining) : remaining;
                const rawCost = Number(line?.unitCost);
                plan.set(index, { quantity, unitCost: Number.isFinite(rawCost) && rawCost > 0 ? rawCost : null });
            }
            if (!plan.size)
                return res.status(400).json({ error: 'Seçilen satırların tamamı zaten stoğa aktarılmış.' });
        }
        // PRODUKTION: der Wareneingang läuft auch OHNE Projekt (21.09.2026).
        // Ist eines zugeordnet, tragen die Zeilen ihre Geräte wie bisher.
        const productionOn = await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId);
        if (productionOn) {
            const assignment = await productionModule_1.productionModule.purchaseLink.getAssignment(tenantId, existing.id);
            if (assignment) {
                productionModule_1.productionModule.purchaseLink.assignLines(items, {
                    productionProjectId: assignment.productionProjectId,
                    productionItemIds: assignment.productionItemIds,
                });
            }
        }
        /* ── ERST HIER ENTSTEHT DER ARTIKEL (Vorgabe Samet, 14.09.2026) ─────
           «Bevor es in den Wareneingang übertragen ist, kommt nichts ins
           Lager und nichts in die Produkte — nicht einmal als Definition.»
           Die Bestellmaske legt darum keine Artikel mehr an; eine Zeile ohne
           Produktcode reist codelos bis hierher.

           ── UND ERST HIER ENTSTEHT DER ERP-CODE (19.09.2026) ───────────────
           Preisanfrage und Bestellung vergeben keine Codes. Ohne gewählten
           Nummernkreis bekommt eine codelose Zeile VORLÄUFIG den nächsten
           Code aus AA-BB-000001 … (Vorgabe Samet: «bis das Codesystem
           steht»). Ein mitgeschickter Kreis (`codeSchemeId`) gilt weiter. */
        const codelessIndexes = Array.from(plan.keys()).filter((index) => {
            const item = items[index];
            return !item.articleId && !String(item.code || '').trim();
        });
        if (codelessIndexes.length) {
            let codes;
            try {
                codes = codeSchemeId
                    ? (await (0, articleCodeCatalog_1.issueCodes)(tenantId, codeSchemeId, codelessIndexes.length)).codes
                    : await (0, articleCodeCatalog_1.issueTemporaryReceiptCodes)(tenantId, codelessIndexes.length);
            }
            catch (error) {
                return res.status(error?.status || 400).json({ error: error.message, ...(error?.code ? { code: error.code } : {}) });
            }
            codelessIndexes.forEach((index, position) => {
                items[index].code = codes[position];
            });
        }
        // Ürün çözümü: önce articleId, sonra kod. Bulunamayan KODLU satırlar
        // otomatik ürün olarak açılır; kodsuz satır aktarılamaz (kod = kimlik).
        const planItems = Array.from(plan.keys()).map((index) => items[index]);
        const wantedIds = planItems.map((it) => (it.articleId ? String(it.articleId) : null)).filter(Boolean);
        const wantedCodes = planItems.map((it) => String(it.code || '').trim()).filter(Boolean);
        const [defaultLocation, articleRows, supplierRow] = await Promise.all([
            repository.ensureDefaultLocation(tenantId),
            wantedIds.length || wantedCodes.length
                /* AUCH DER PAPIERKORB (20.09.2026) — der eindeutige Schluessel
                   (tenantId, articleCode) kennt keinen Papierkorb. Suchte der
                   Wareneingang nur die lebenden Artikel, wollte er einen
                   geloeschten Code ZWEITES MAL anlegen und die Uebernahme
                   brach ab («Unique constraint failed on … articleCode»).
                   Ein geloeschter Artikel, dessen Ware im Haus ankommt, wird
                   unten wieder in Betrieb genommen — der Code ist seine
                   Identitaet, und die Lieferung beweist, dass es ihn gibt. */
                ? prisma_client_1.default.article.findMany({
                    where: {
                        tenantId,
                        OR: [
                            ...(wantedIds.length ? [{ id: { in: wantedIds } }] : []),
                            ...(wantedCodes.length ? [{ articleCode: { in: wantedCodes } }] : []),
                        ],
                    },
                    select: { id: true, articleCode: true, deletedAt: true },
                })
                : Promise.resolve([]),
            existing.supplierId
                ? prisma_client_1.default.supplier.findFirst({ where: { id: existing.supplierId, tenantId }, select: { id: true } })
                : Promise.resolve(null),
        ]);
        const articleById = new Map(articleRows.map((row) => [row.id, row]));
        const articleByCode = new Map(articleRows.map((row) => [row.articleCode, row]));
        const supplierId = supplierRow?.id || null;
        /* Artikel, die im Papierkorb lagen und deren Ware jetzt ankommt:
           sie werden mit der Uebernahme wieder in Betrieb genommen. */
        const reviveIds = new Set();
        const errors = [];
        const articleCreates = [];
        const movementCreates = [];
        const lotCreates = [];
        const deltaByArticle = new Map();
        const preferredByArticle = new Map();
        const received = [];
        const now = new Date();
        for (const [index, entry] of plan) {
            const item = items[index];
            const code = String(item.code || '').trim();
            let article = item.articleId ? articleById.get(String(item.articleId)) : undefined;
            if (!article && code)
                article = articleByCode.get(code);
            if (article?.deletedAt)
                reviveIds.add(String(article.id));
            if (!article) {
                if (!code) {
                    errors.push({ index, error: 'Satırın ürün kodu yok; stoğa aktarılamaz.' });
                    continue;
                }
                // Otomatik ürün açılışı (mal kabulden gelen tanım) — bulk ürün
                // girişindeki alan seti, miktar hareketi aşağıda ayrıca yazılır.
                article = { id: (0, nanoid_1.nanoid)(10), articleCode: code };
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
            const movementId = (0, nanoid_1.nanoid)(12);
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
                // Herkunft: Wareneingang aus einer Lieferantenbestellung.
                origin: 'ORDER_RECEIPT',
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
                    id: (0, nanoid_1.nanoid)(10),
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
        const updated = await prisma_client_1.default.$transaction(async (tx) => {
            if (articleCreates.length)
                await tx.article.createMany({ data: articleCreates });
            // Zurueck aus dem Papierkorb: die Ware ist da, also ist der
            // Artikel wieder da (sein Bestand kommt aus der Bewegung unten).
            if (reviveIds.size) {
                await tx.article.updateMany({
                    where: { tenantId, id: { in: Array.from(reviveIds) } },
                    data: { deletedAt: null, isActive: true },
                });
            }
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
        // Der eingegangene Anteil steht auch bei der Produktion.
        if (productionOn)
            await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, employeeId);
        res.status(200).json({
            processedCount: received.length,
            received,
            errors,
            // Wie viele Artikel der Wareneingang aus dem Papierkorb geholt hat.
            restoredCount: reviveIds.size,
            order: (0, exports.parsePurchaseOrderRow)(updated),
        });
    }
    catch (error) {
        (0, exports.sendPurchaseOrderError)(res, error);
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/receive/revert:
 *   post:
 *     tags: [Inventory]
 *     summary: "Wareneingang loeschen: Lagerbuchungen der Bestellung zuruecknehmen und eine Stufe zurueckgehen"
 *     security:
 *       - bearerAuth: []
 */
// ── WARENEINGANG LÖSCHEN (Vorgabe Samet, 08.09.2026) ────────────────────────
// «Wird der Wareneingang gelöscht, geht der Vorgang eine Stufe zurück.»
//
// Das Löschen ist kein Statuswechsel, sondern die RÜCKNAHME DER BUCHUNGEN: die
// Eingangsbewegungen dieser Bestellung (StockMovement.referenceId = Bestellung,
// movementType = IN) werden gelöscht, ihre Menge wieder vom Bestand abgezogen
// und die aus ihnen entstandenen Lieferantenpartien (ArticleSupplier
// .stockMovementId) verschwinden mit. Erst danach fallen `receivedQuantity`
// und `receivedAt` jeder Zeile auf null zurück und die Bestellung steht wieder
// auf der BESTELLSTUFE — «Bestellung erteilt» (ORDERED), wenn die Mail bereits
// draussen ist, sonst «Bestellung bestätigt» (PENDING).
//
// Ein blosser Statuswechsel wäre hier falsch: er liesse die Ware im Lager
// stehen und der nächste Wareneingang würde sie ein zweites Mal buchen.
//
// ⚠ WAS NICHT ZURÜCKGENOMMEN WIRD: die ABGELEITETEN Angaben am Artikel, die der
// Wareneingang nebenbei fortschreibt — `baseCost` (gleitender Einstandspreis),
// `defaultSupplierId`, `lastPurchaseDate` und das `isPreferred`-Kreuz der zuvor
// bevorzugten Partie. Sie liessen sich nur aus einer Momentaufnahme
// wiederherstellen, die der Wareneingang heute nicht anlegt. Menge, Bewegung,
// Partie und Stufe gehen vollständig zurück; die «zuletzt gekauft für …»-Angabe
// bleibt auf dem Stand des gelöschten Eingangs stehen, bis der nächste echte
// Wareneingang sie überschreibt.
router.post('/purchase-orders/:id/receive/revert', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        if (existing.status !== 'TO_BE_STOCKED' && existing.status !== 'COMPLETED') {
            return res.status(400).json({ error: 'Bu sipariş mal kabul aşamasında değil.' });
        }
        let items = [];
        try {
            items = JSON.parse(existing.items || '[]');
        }
        catch {
            items = [];
        }
        // Bu siparişin yazdığı TÜM giriş hareketleri. Konum başına ayrı
        // toplanır: bakiye (ürün, konum) çiftinde tutulur.
        const movements = await prisma_client_1.default.stockMovement.findMany({
            where: { tenantId, referenceId: existing.id, movementType: 'IN' },
            select: { id: true, articleId: true, quantity: true, destinationLocationId: true },
        });
        const deltasByLocation = new Map();
        for (const movement of movements) {
            const locationId = movement.destinationLocationId ? String(movement.destinationLocationId) : null;
            if (!locationId)
                continue; // konumsuz hareket bakiye yazmamıştır
            const perArticle = deltasByLocation.get(locationId) ?? new Map();
            perArticle.set(String(movement.articleId), (perArticle.get(String(movement.articleId)) ?? 0) - (Number(movement.quantity) || 0));
            deltasByLocation.set(locationId, perArticle);
        }
        const movementIds = movements.map((movement) => String(movement.id));
        // Satırların kabul damgası sıfırlanır: mal kabul hiç yapılmamış olur.
        items.forEach((item) => {
            item.receivedQuantity = 0;
            item.receivedAt = null;
        });
        // Mail gitmişse sipariş "verilmiş"tir, gitmemişse taslaktır (onay yok).
        const targetStatus = existing.emailSentAt ? 'ORDERED' : 'ORDER_DRAFT';
        const updated = await prisma_client_1.default.$transaction(async (tx) => {
            if (movementIds.length) {
                // Partiler önce: hareketlere bağlıdırlar.
                await tx.articleSupplier.deleteMany({ where: { tenantId, stockMovementId: { in: movementIds } } });
                await tx.stockMovement.deleteMany({ where: { tenantId, id: { in: movementIds } } });
            }
            for (const [locationId, perArticle] of deltasByLocation) {
                await bulkApplyStockBalanceDeltas(tx, tenantId, locationId, perArticle);
            }
            /* Mal kabul siparişin İÇİNDEDİR: geri alınca satırlar kalır,
               yalnızca kabul damgaları düşer (belge takası yok). */
            return tx.purchaseOrder.update({
                where: { id: existing.id },
                data: {
                    items: JSON.stringify(items),
                    status: targetStatus,
                    stockedAt: null,
                },
            });
        });
        // Die Zeilen bei der Produktion: wieder ohne Eingang.
        if (await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)) {
            await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, req.user.id);
        }
        res.status(200).json({
            revertedMovements: movementIds.length,
            order: (0, exports.parsePurchaseOrderRow)(updated),
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/send-mail:
 *   post:
 *     tags: [Inventory]
 *     summary: Sipariş PDF'ini tedarikçiye e-posta ile gönder
 *     security:
 *       - bearerAuth: []
 */
router.post('/purchase-orders/:id/send-mail', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId: await (0, serviceTenantScope_1.getMailTenantId)(tenantId) } });
        /* ÇOK TEDARİKÇİLİ TALEP (25.09.2026): mail listedeki BİR tedarikçiye
           gider (`supplierIndex`), ekindeki PDF de onun adını taşır; damga
           o tedarikçinin kaydına düşer. */
        const requestSuppliers = PO_PRICE_REQUEST_STATUSES.has(existing.status) ? poReadRequestSuppliers(existing) : [];
        const supplierIndex = poSupplierIndex(req.body?.supplierIndex, requestSuppliers);
        const target = supplierIndex !== null
            ? requestSuppliers[supplierIndex]
            : { supplierId: existing.supplierId ?? null, supplierEmail: existing.supplierEmail ?? null };
        // Alıcı: kullanıcının girdiği herhangi geçerli adres (kullanıcı isteği
        // 2026-09-15 — önceki "yalnızca tedarikçinin adresi" kısıtı kaldırıldı).
        // Girilmezse sipariş snapshot'ındaki / tedarikçi kaydındaki e-posta.
        // Uç nokta yetkili (inventory.transfer) ve gönderici tenant ayarından.
        let to = '';
        if (req.body?.to !== undefined && String(req.body.to).trim() !== '') {
            to = poStripHeader(String(req.body.to));
            if (!PO_EMAIL_RE.test(to)) {
                return res.status(400).json({ error: 'Geçersiz alıcı e-posta adresi.' });
            }
        }
        else {
            const snapshot = String(target.supplierEmail || '').trim();
            if (snapshot && PO_EMAIL_RE.test(snapshot)) {
                to = snapshot;
            }
            else if (target.supplierId) {
                const supplier = await prisma_client_1.default.supplier.findFirst({
                    where: { id: target.supplierId, tenantId },
                    select: { email: true },
                });
                const supplierEmail = String(supplier?.email || '').trim();
                if (supplierEmail && PO_EMAIL_RE.test(supplierEmail))
                    to = supplierEmail;
            }
            if (!to) {
                return res.status(400).json({ error: 'Bu tedarikçi için tanımlı geçerli bir e-posta adresi yok.' });
            }
        }
        // Gönderici her zaman tenant MailSetting'inden (gövdeden asla).
        const fromEmail = poStripHeader(String(settings?.fromEmail || req.user.email || ''));
        if (!fromEmail || !PO_EMAIL_RE.test(fromEmail)) {
            return res.status(400).json({ error: 'Gönderici e-posta adresi yapılandırılmamış.' });
        }
        const fromName = poStripHeader(String(settings?.fromName || 'Offitec Control Center')).slice(0, 100) || 'Offitec Control Center';
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
        if (!subject)
            return res.status(400).json({ error: 'Konu boş olamaz.' });
        if (subject.length > 200)
            return res.status(400).json({ error: 'Konu 200 karakteri aşamaz.' });
        const message = String(req.body?.message || '').trim();
        if (message.length > 5000)
            return res.status(400).json({ error: 'Mesaj çok uzun.' });
        // ── CC (kullanıcı isteği 2026-08-02) ─────────────────────────────
        // ALICI (`to`) tedarikçinin adresiyle SINIRLIDIR (açık relay engeli);
        // CC ise serbesttir — takvim tarafındaki `sanitizeCcEmails` emsali:
        // kullanıcı kendi ekibinden birini ya da tedarikçinin ikinci bir
        // adresini kopyaya alabilir. Sertleştirme: başlık kırpma (CRLF
        // enjeksiyonu), biçim denetimi, ALICININ KENDİSİ elenir (aynı adrese
        // iki kopya gitmesin), tekrarlar atılır ve liste 10 adresle sınırlıdır.
        const ccSeen = new Set([to.toLowerCase()]);
        const ccEmails = [];
        const rawCc = Array.isArray(req.body?.ccEmails)
            ? req.body.ccEmails
            : String(req.body?.ccEmails ?? '').split(',');
        for (const value of rawCc) {
            const email = poStripHeader(String(value ?? ''));
            if (!email || !PO_EMAIL_RE.test(email))
                continue;
            const key = email.toLowerCase();
            if (ccSeen.has(key))
                continue;
            ccSeen.add(key);
            ccEmails.push(email);
        }
        if (ccEmails.length > 10)
            return res.status(400).json({ error: 'En fazla 10 CC adresi eklenebilir.' });
        // Ekler: yalnızca gövde içi PDF/PNG/JPG, adet + boyut sınırlı (tender emsali).
        const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
        if (rawAttachments.length > 5)
            return res.status(400).json({ error: 'En fazla 5 ek dosya gönderilebilir.' });
        const allowedAttachmentTypes = new Set(['application/pdf', 'image/png', 'image/jpeg']);
        let totalAttachmentBytes = 0;
        const attachments = [];
        for (const item of rawAttachments) {
            if (!item || typeof item !== 'object')
                return res.status(400).json({ error: 'Geçersiz ek dosya.' });
            const contentType = String(item.contentType || '').trim().toLowerCase();
            const contentBase64 = typeof item.contentBase64 === 'string' ? item.contentBase64 : '';
            const rawName = String(item.filename || '').trim();
            if (!rawName || !contentBase64)
                return res.status(400).json({ error: 'Ek dosya adı ve içeriği zorunludur.' });
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
        const signature = (0, mailSignature_1.buildSignatureParts)(settings);
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
            const sentAt = new Date();
            order = await prisma_client_1.default.purchaseOrder.update({
                where: { id: existing.id },
                data: {
                    emailSentAt: sentAt,
                    emailRecipient: to,
                    ...(statusAfterSend ? { status: statusAfterSend } : {}),
                    ...(supplierIndex !== null
                        ? {
                            requestSuppliers: JSON.stringify(requestSuppliers.map((entry, index) => (index === supplierIndex
                                ? { ...entry, emailSentAt: sentAt.toISOString(), emailRecipient: to }
                                : entry))),
                        }
                        : {}),
                },
            });
        }
        res.status(200).json({
            message: result.preview
                ? 'SMTP ayarı olmadığı için sipariş maili önizleme olarak hazırlandı.'
                : 'Sipariş maili gönderildi.',
            ...result,
            order: (0, exports.parsePurchaseOrderRow)(order),
        });
    }
    catch (error) {
        if (typeof error?.message === 'string' && error.message.startsWith('SMTP')) {
            return res.status(502).json({ error: 'E-posta gönderilemedi: SMTP sunucusuna bağlanılamadı veya kullanıcı adı/parola hatalı. Lütfen mail ayarlarını kontrol edin.' });
        }
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/mail-manual:
 *   post:
 *     tags: [Inventory]
 *     summary: "Mail manuell gesendet – Haken setzen oder entfernen"
 *     security:
 *       - bearerAuth: []
 */
// ── MAIL MANUELL GESENDET (Vorgabe Samet, 14.09.2026) ──────────────────────
// Das Häkchen wirkt wie eine echte Sendung: DRAFT → PRICE_REQUEST und
// PENDING → ORDERED, `emailSentAt` wird gestempelt. Entfernen lässt es sich
// NUR, wenn es auch von Hand gesetzt wurde — eine echte Sendung nimmt kein
// Häkchen zurück.
router.post('/purchase-orders/:id/mail-manual', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        const sent = req.body?.sent === true;
        /* ÇOK TEDARİKÇİLİ TALEP (25.09.2026): işaret BİR tedarikçinin. Talep
           «gönderildi» olur, ilki işaretlenince; «gönderilmedi»ye ancak
           SONUNCUSUNUN işareti kalkınca döner. */
        const requestSuppliers = PO_PRICE_REQUEST_STATUSES.has(existing.status) ? poReadRequestSuppliers(existing) : [];
        const supplierIndex = poSupplierIndex(req.body?.supplierIndex, requestSuppliers);
        if (supplierIndex !== null) {
            const now = new Date();
            const recipient = poStripHeader(String(req.body?.recipient ?? requestSuppliers[supplierIndex].supplierEmail ?? '')).slice(0, 180);
            const list = requestSuppliers.map((entry, index) => (index === supplierIndex
                ? { ...entry, emailSentAt: sent ? now.toISOString() : null, emailRecipient: sent ? `${PO_MANUAL_MAIL_PREFIX}${recipient}` : null }
                : entry));
            const stillSent = list.some((entry) => entry.emailSentAt);
            const updated = await prisma_client_1.default.purchaseOrder.update({
                where: { id: existing.id },
                data: {
                    requestSuppliers: JSON.stringify(list),
                    ...(sent
                        ? { status: 'PRICE_REQUEST', emailSentAt: now, emailRecipient: `${PO_MANUAL_MAIL_PREFIX}${recipient}` }
                        : (stillSent ? {} : { status: 'DRAFT', emailSentAt: null, emailRecipient: null })),
                },
            });
            return res.status(200).json((0, exports.parsePurchaseOrderRow)(updated));
        }
        // 15.09.2026 (Samet): «istediğim zaman değiştirebiliyor olmam gerek» —
        // das Häkchen lässt sich jederzeit setzen und entfernen, auch auf
        // einem Auftragsentwurf und auch nach einer Systemsendung.
        if (sent) {
            const next = existing.status === 'DRAFT'
                ? 'PRICE_REQUEST'
                : existing.status === 'PENDING' || existing.status === 'ORDER_DRAFT'
                    ? 'ORDERED'
                    : null;
            if (!next) {
                if (existing.status === 'PRICE_REQUEST' || existing.status === 'ORDERED') {
                    return res.status(200).json((0, exports.parsePurchaseOrderRow)(existing));
                }
                return res.status(400).json({ error: 'Im Wareneingang gibt es keine Mail mehr.', code: 'NOT_SENDABLE' });
            }
            const recipient = poStripHeader(String(req.body?.recipient ?? existing.supplierEmail ?? '')).slice(0, 180);
            const updated = await prisma_client_1.default.purchaseOrder.update({
                where: { id: existing.id },
                data: {
                    status: next,
                    emailSentAt: new Date(),
                    emailRecipient: `${PO_MANUAL_MAIL_PREFIX}${recipient}`,
                },
            });
            return res.status(200).json((0, exports.parsePurchaseOrderRow)(updated));
        }
        const back = existing.status === 'PRICE_REQUEST'
            ? 'DRAFT'
            : existing.status === 'ORDERED'
                ? 'PENDING'
                : null;
        const updated = await prisma_client_1.default.purchaseOrder.update({
            where: { id: existing.id },
            data: {
                ...(back ? { status: back } : {}),
                emailSentAt: null,
                emailRecipient: null,
            },
        });
        res.status(200).json((0, exports.parsePurchaseOrderRow)(updated));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/* ── MAIL-ENTWÜRFE JE AUFTRAG (Vorgabe Samet, 14.09.2026) ───────────────────
   «Taslaklar da olacak»: das Mailfenster der Auftragsseite speichert, was man
   geschrieben hat, und bietet es wieder an. Anders als die Anschreiben-Vorlagen
   gehören diese Entwürfe EINEM Auftrag — sie sind halbfertige Mails, keine
   Textbausteine. */
const poMailDraftRow = (row) => {
    let ccEmails = [];
    try {
        ccEmails = JSON.parse(row.ccEmails || '[]');
    }
    catch {
        ccEmails = [];
    }
    return { ...row, ccEmails: Array.isArray(ccEmails) ? ccEmails : [] };
};
const poMailDraftData = (body) => {
    const ccRaw = Array.isArray(body?.ccEmails) ? body.ccEmails : [];
    const ccEmails = Array.from(new Set(ccRaw.map((value) => poStripHeader(String(value ?? ''))).filter((email) => PO_EMAIL_RE.test(email)))).slice(0, 10);
    return {
        toEmail: poStripHeader(String(body?.toEmail ?? '')).slice(0, 180) || null,
        ccEmails: JSON.stringify(ccEmails),
        subject: poStripHeader(String(body?.subject ?? '')).slice(0, 200),
        message: String(body?.message ?? '').slice(0, 5000),
    };
};
/**
 * @swagger
 * /inventory/purchase-orders/{id}/mail-drafts:
 *   get:
 *     tags: [Inventory]
 *     summary: Mail-Entwürfe eines Auftrags
 *     security:
 *       - bearerAuth: []
 */
router.get('/purchase-orders/:id/mail-drafts', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog'], ttlSec: 30 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const rows = await prisma_client_1.default.purchaseOrderMailDraft.findMany({
            where: { tenantId, orderId: String(req.params.id) },
            orderBy: { updatedAt: 'desc' },
            take: 50,
        });
        res.status(200).json(rows.map(poMailDraftRow));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/mail-drafts:
 *   post:
 *     tags: [Inventory]
 *     summary: Mail-Entwurf speichern
 *     security:
 *       - bearerAuth: []
 */
router.post('/purchase-orders/:id/mail-drafts', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const order = await prisma_client_1.default.purchaseOrder.findFirst({
            where: { id: String(req.params.id), tenantId },
            select: { id: true },
        });
        if (!order)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        const data = poMailDraftData(req.body);
        if (!data.subject && !data.message.trim()) {
            return res.status(400).json({ error: 'Ein leerer Entwurf wird nicht gespeichert.' });
        }
        const row = await prisma_client_1.default.purchaseOrderMailDraft.create({
            data: { id: (0, nanoid_1.nanoid)(12), tenantId, orderId: order.id, ...data, createdBy: req.user.id || null },
        });
        res.status(201).json(poMailDraftRow(row));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/mail-drafts/{draftId}:
 *   patch:
 *     tags: [Inventory]
 *     summary: Mail-Entwurf aktualisieren
 *     security:
 *       - bearerAuth: []
 */
router.patch('/purchase-orders/:id/mail-drafts/:draftId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrderMailDraft.findFirst({
            where: { id: String(req.params.draftId), orderId: String(req.params.id), tenantId },
            select: { id: true },
        });
        if (!existing)
            return res.status(404).json({ error: 'Entwurf nicht gefunden.' });
        const row = await prisma_client_1.default.purchaseOrderMailDraft.update({
            where: { id: existing.id },
            data: poMailDraftData(req.body),
        });
        res.status(200).json(poMailDraftRow(row));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}/mail-drafts/{draftId}:
 *   delete:
 *     tags: [Inventory]
 *     summary: Mail-Entwurf löschen
 *     security:
 *       - bearerAuth: []
 */
router.delete('/purchase-orders/:id/mail-drafts/:draftId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrderMailDraft.findFirst({
            where: { id: String(req.params.draftId), orderId: String(req.params.id), tenantId },
            select: { id: true },
        });
        if (!existing)
            return res.status(404).json({ error: 'Entwurf nicht gefunden.' });
        await prisma_client_1.default.purchaseOrderMailDraft.delete({ where: { id: existing.id } });
        res.status(200).json({ draftId: existing.id });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/{id}:
 *   delete:
 *     tags: [Inventory]
 *     summary: Satın alma siparişini sil
 *     security:
 *       - bearerAuth: []
 */
router.delete('/purchase-orders/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const existing = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: req.params.id, tenantId } });
        if (!existing)
            return res.status(404).json({ error: 'Sipariş bulunamadı.' });
        /* EIN VORGANG (Vorgabe Samet, 22.09.2026): die Bestellung und ihre
           Produktionszeilen gehen zusammen — oder gar nicht. Sonst bliebe in
           der Produktion ein bestelltes Produkt ohne Bestellung stehen, das
           niemand mehr zuordnen kann («boş bağımsız ürün»).
           Produktion (19.09.2026): «Wird die Bestellung gelöscht, müssen auch
           ihre Zeilen in dieser Tabelle gelöscht werden» — samt Zuordnung. */
        await prisma_client_1.default.$transaction(async (tx) => {
            await productionModule_1.productionModule.purchaseLink.removeForPurchaseOrder(tenantId, existing.id, tx);
            await tx.purchaseOrder.delete({ where: { id: existing.id } });
        });
        // Die Mail-Entwürfe gehören dem Auftrag und gehen mit. Ein Fehler hier
        // (etwa eine noch nicht ausgerollte Tabelle) darf das Löschen nicht kippen.
        await prisma_client_1.default.purchaseOrderMailDraft
            .deleteMany({ where: { tenantId, orderId: existing.id } })
            .catch(() => undefined);
        // Onaylı bir üretim siparişi silindiyse cihazlar üretim projesinden düşer.
        (0, exports.refreshProducerProduction)(existing);
        res.status(204).send();
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=inventory.routes.js.map