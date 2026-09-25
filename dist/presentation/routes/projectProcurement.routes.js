"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleProjectAutoOrder = exports.autoOrderProject = void 0;
/**
 * ── PROJE → SİPARİŞ («Siparişlerim», Vorgabe Samet 24.09.2026) ─────────────
 *
 * Proje detayında «Pozisyon Özeti»nin YANINDAKİ ayrı «Siparişlerim» sekmesi
 * (Pozisyon Özeti olduğu gibi kalır). Ürünler TEDARİKÇİYE GÖRE gruplanır
 * (grup başında tedarikçi + türü + «Siparişe Git»); ne olacağını ürünün TÜRÜ
 * söyler (ayrıntı: aşağıdaki OTOMATİK SİPARİŞ ve Türsüzler notları):
 *
 *   MANUFACTURED (Üretilecek)    PROJE OLUŞTURULUNCA otomatik: eksik, ayarlarda
 *                                türü «Üretim» olan şirkete (örn. Offitec
 *                                Türkiye) sipariş edilir. Stok bakılmaz.
 *   RESALE (Satın Alınacak)      PROJE OLUŞTURULUNCA otomatik: depo kontrolü
 *                                (talep / stok / eksik), eksik ürünün varsayılan
 *                                tedarikçisine sipariş edilir; stok yetiyorsa
 *                                «Stokta Var» + «+». Sekmede «Siparişe Git»
 *                                sonradan doğan eksiği de yazar.
 *   türsüz / tedarikçisiz ürün   ELLE: «Türsüzler» başlığından işaretlenir,
 *                                «Oluştur» hepsini TEK, tedarikçisiz siparişe
 *                                koyar; tedarikçi siparişte seçilir. Sipariş
 *                                tabloda Türsüzler'in üstünde kendi başlığıyla
 *                                (U1, U2 …) durur, pozisyonları altında.
 *   SERVICE (Ek Hizmet)          boş sipariş formu açılır (burada kayıt yok).
 *
 * BİRLEŞTİRME: aynı tedarikçinin aynı projeye ait AÇIK (taslak) siparişi
 * varsa satırlar ona eklenir — en az ürün adı ve miktarıyla; yeni sipariş
 * açılmaz. Aynı pozisyonun satırı zaten oradaysa miktarı artar. Başka
 * tedarikçinin ürünü kendi ayrı siparişine gider.
 *
 * Bağ YENİ BİR SÜTUN İSTEMEZ: her satır `source = { projectId, positionId,
 * producerTenantId }` taşır (PurchaseOrder.items JSON). Sipariş formundaki
 * proje adı `projectName`'dedir — «talebin hangi projeden geldiği mutlaka
 * yazmalı».
 *
 * Üretim şirketine giden sipariş ONAYLANINCA orada üretim emri doğar:
 * cihaz üretim şirketinin projesine girer (bkz. SyncProductionProjectsUseCase,
 * `refreshProducerProduction`).
 */
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
const postalAddress_1 = require("../../shared/postalAddress");
const inventory_routes_1 = require("./inventory.routes");
const standardOrderTemplate_1 = require("../../shared/standardOrderTemplate");
const companyType_1 = require("../../shared/companyType");
const projectEvents_1 = require("../../shared/projectEvents");
const router = (0, express_1.Router)();
/** Bir sipariş sayılan durumlar (fiyat talebi SAYILMAZ). */
const ORDER_STATUSES = new Set(['ORDER_DRAFT', 'PENDING', 'ORDERED', 'TO_BE_STOCKED', 'COMPLETED']);
/** Yeni satır alabilen açık sipariş. */
const OPEN_ORDER_STATUS = 'ORDER_DRAFT';
/**
 * Pozisyon Özeti'nin «ürün satırı» kuralı (frontend `getLineKind` ikizi):
 * PRODUCT/CUSTOM üründür, TITLE/SECTION/DESCRIPTION değildir; türü boş eski
 * satır ürün verisi taşıyorsa (ürün, fiyat, miktar ya da birim) üründür.
 */
const isProductLine = (row) => {
    const type = String(row?.rowType ?? '').trim().toUpperCase();
    if (type === 'DESCRIPTION' || type === 'TITLE' || type === 'SECTION')
        return false;
    if (type === 'PRODUCT' || type === 'CUSTOM')
        return true;
    return Boolean(row?.sourceArticleId) || row?.unitPrice != null
        || Number(row?.quantity || 0) > 0 || Boolean(row?.unit);
};
/** Pozisyon Özeti'nin sırası: `displayOrder`, eşitse pozisyon numarası (sayısal). */
const byDisplayOrder = (a, b) => {
    const orderA = a.displayOrder ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.displayOrder ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB)
        return orderA - orderB;
    return String(a.positionNumber || '').localeCompare(String(b.positionNumber || ''), undefined, { numeric: true });
};
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;
const plain = (value, max = 500) => String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const parseItems = (raw) => {
    try {
        const parsed = JSON.parse(String(raw || '[]'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
};
/** «PR-2026-10008 · Muster AG» — siparişte projenin adı. */
const projectLabelOf = (project) => {
    const number = String(project.projectNumber ?? '').trim();
    const name = String(project.projectName ?? '').trim();
    if (number && name && name !== number)
        return `${number} · ${name}`.slice(0, 191);
    return (number || name).slice(0, 191);
};
/**
 * ÜRETİM YAPAN ŞİRKET: şirket ağacında türü «Üretim» (PRODUCTION) olan şirket
 * (/settings/company-categories → Şirket türü). Birden çoksa, Firmenübertragungen
 * ayarında bu şirketi kaynak olarak seçmiş olan; o da yoksa ada göre ilki.
 */
const resolveProducer = async (tenantId) => {
    const treeIds = (await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId)).filter((id) => id !== tenantId);
    if (!treeIds.length)
        return null;
    const candidates = await prisma_client_1.default.tenant.findMany({
        where: { id: { in: treeIds }, companyType: 'PRODUCTION', isActive: true },
        select: {
            id: true, tenantName: true, addressLine1: true, addressLine2: true,
            postalCode: true, city: true, country: true,
        },
        orderBy: { tenantName: 'asc' },
    });
    if (!candidates.length)
        return null;
    if (candidates.length === 1)
        return candidates[0];
    const settings = await prisma_client_1.default.productionTransferSetting.findMany({
        where: { tenantId: { in: candidates.map((c) => c.id) } },
        select: { tenantId: true, sourceTenantIds: true },
    });
    const chosen = settings.find((row) => Array.isArray(row.sourceTenantIds) && row.sourceTenantIds.includes(tenantId));
    return candidates.find((c) => c.id === chosen?.tenantId) ?? candidates[0];
};
/** Üretim şirketi, proje şirketinin tedarikçi listesinde (adıyla, bir kez). */
const producerSupplier = async (tenantId, producer) => {
    const companyName = String(producer.tenantName || '').trim().slice(0, 191) || 'Produktion';
    const address = (0, postalAddress_1.composeAddressSnapshot)({
        street: [producer.addressLine1, producer.addressLine2].filter(Boolean).join(' ') || null,
        postalCode: producer.postalCode,
        city: producer.city,
        country: producer.country,
    });
    const supplier = await prisma_client_1.default.supplier.upsert({
        where: { tenantId_companyName: { tenantId, companyName } },
        update: {},
        create: {
            id: (0, nanoid_1.nanoid)(10),
            tenantId,
            companyName,
            address: [producer.addressLine1, producer.addressLine2].filter(Boolean).join(' ') || null,
            postalCode: producer.postalCode ?? null,
            city: producer.city ?? null,
            country: producer.country ?? null,
            notes: 'Üretim şirketi (otomatik)',
        },
    });
    return { supplier, address: (0, inventory_routes_1.supplierAddressSnapshot)(supplier) ?? address };
};
/**
 * ELLE sipariş edilen pozisyon: tablonun «Türsüzler»i (türü seçilmemiş ya da
 * ürüne bağlı olmayan satır) ve «Tedarikçisi olmayanlar»ı (tedarikçisiz
 * «Satın Alınacak») — frontend `buildGroups` ikizi. Otomatik sipariş bunlara
 * dokunmaz; işaretlenip «Oluştur» ile sipariş edilirler.
 */
const isOrderedByHand = (info) => info.mode === 'PURCHASE' && !(info.articleKind === 'RESALE' && Boolean(info.supplier));
/** İş kuralı hatası — arayüz `code`'dan ne yapacağını bilir. */
class ProcurementError extends Error {
    code;
    status;
    extra;
    constructor(code, message, status = 409, extra = {}) {
        super(message);
        this.code = code;
        this.status = status;
        this.extra = extra;
    }
}
const sendProcurementError = (res, error) => {
    if (error instanceof ProcurementError) {
        return res.status(error.status).json({ error: error.message, code: error.code, ...error.extra });
    }
    return (0, inventory_routes_1.sendPurchaseOrderError)(res, error);
};
/** Fiyat talebi aşamaları — satırları «işlemde» sayılır ama sipariş değildir. */
const REQUEST_STATUSES = new Set(['DRAFT', 'PRICE_REQUEST']);
/**
 * Projenin bütün pozisyonlarının tedarik durumu — tek seferde, pozisyon
 * sayısından bağımsız olarak sabit sayıda sorgu.
 */
const buildProcurement = async (tenantId, projectId) => {
    const project = await prisma_client_1.default.project.findFirst({
        where: { id: projectId, tenantId },
        select: { id: true, projectNumber: true, projectName: true, tenderId: true },
    });
    if (!project)
        return null;
    const [positions, orderRows, producer] = await Promise.all([
        project.tenderId
            ? prisma_client_1.default.position.findMany({
                where: { tenderId: project.tenderId },
                select: {
                    id: true, rowType: true, positionNumber: true, shortDescription: true,
                    quantity: true, unit: true, unitPrice: true, sourceArticleId: true, displayOrder: true,
                    articleMappings: { select: { articleId: true, quantityMultiplier: true }, take: 1 },
                },
            })
            : Promise.resolve([]),
        prisma_client_1.default.purchaseOrder.findMany({
            where: { tenantId, items: { contains: `"projectId":"${projectId}"` } },
            select: {
                id: true, referenceNumber: true, status: true, supplierId: true, supplierName: true,
                totalNet: true, currency: true, items: true, createdAt: true, projectName: true,
            },
            orderBy: { createdAt: 'desc' },
        }),
        resolveProducer(tenantId),
    ]);
    const lines = positions.filter(isProductLine).sort(byDisplayOrder);
    const articleOf = (row) => {
        if (row.sourceArticleId)
            return { id: String(row.sourceArticleId), multiplier: 1 };
        const mapping = row.articleMappings?.[0];
        return mapping ? { id: String(mapping.articleId), multiplier: Number(mapping.quantityMultiplier) || 1 } : { id: null, multiplier: 1 };
    };
    const articleIds = [...new Set(lines.map((row) => articleOf(row).id).filter(Boolean))];
    const [articles, balances, links] = articleIds.length
        ? await Promise.all([
            prisma_client_1.default.article.findMany({
                where: { id: { in: articleIds } },
                select: {
                    id: true, articleCode: true, name: true, unit: true, articleKind: true,
                    itemType: true, defaultSupplierId: true, baseCost: true,
                },
            }),
            prisma_client_1.default.stockBalance.groupBy({
                by: ['articleId'],
                where: { tenantId, articleId: { in: articleIds } },
                _sum: { currentQuantity: true, reservedQuantity: true },
            }),
            prisma_client_1.default.articleSupplier.findMany({
                where: { tenantId, articleId: { in: articleIds } },
                select: { articleId: true, supplierId: true, purchasePrice: true, isPreferred: true, updatedAt: true },
                orderBy: [{ isPreferred: 'desc' }, { updatedAt: 'desc' }],
            }),
        ])
        : [[], [], []];
    const articleById = new Map(articles.map((a) => [a.id, a]));
    // Kullanılabilir stok = mevcut − rezerve; eksiye düşmüş bakiye 0 sayılır.
    const stockPool = new Map(balances.map((b) => [
        String(b.articleId),
        Math.max(0, round3((Number(b._sum?.currentQuantity) || 0) - (Number(b._sum?.reservedQuantity) || 0))),
    ]));
    const linkByArticle = new Map();
    for (const link of links)
        if (!linkByArticle.has(link.articleId))
            linkByArticle.set(link.articleId, link);
    const supplierIds = new Set();
    for (const article of articles) {
        const id = article.defaultSupplierId || linkByArticle.get(article.id)?.supplierId;
        if (id)
            supplierIds.add(String(id));
    }
    const suppliers = supplierIds.size
        ? await prisma_client_1.default.supplier.findMany({
            where: { tenantId, id: { in: [...supplierIds] } },
            select: { id: true, companyName: true },
        })
        : [];
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    // Sipariş/talep satırları → pozisyon başına miktar.
    const orderedByPosition = new Map();
    const inRequestByPosition = new Map();
    const ordersByPosition = new Map();
    /** Siparişin bu projeye ait pozisyonları ve «elle açıldı» işareti (U-başlığı için). */
    const orderLines = new Map();
    const orders = orderRows.map((row) => {
        const items = parseItems(row.items);
        const own = items.filter((item) => (0, inventory_routes_1.poLineSource)(item?.source)?.projectId === projectId);
        orderLines.set(row.id, {
            marked: own.some((item) => (0, inventory_routes_1.poLineSource)(item.source)?.manual === true),
            positionIds: own.map((item) => (0, inventory_routes_1.poLineSource)(item.source)?.positionId).filter(Boolean),
        });
        const status = String(row.status);
        for (const item of own) {
            const positionId = (0, inventory_routes_1.poLineSource)(item.source)?.positionId;
            if (!positionId)
                continue;
            const quantity = Number(item.quantity) || 0;
            if (ORDER_STATUSES.has(status))
                orderedByPosition.set(positionId, round3((orderedByPosition.get(positionId) ?? 0) + quantity));
            else if (REQUEST_STATUSES.has(status))
                inRequestByPosition.set(positionId, round3((inRequestByPosition.get(positionId) ?? 0) + quantity));
            const list = ordersByPosition.get(positionId) ?? [];
            const existing = list.find((entry) => entry.id === row.id);
            if (existing)
                existing.quantity = round3(existing.quantity + quantity);
            else
                list.push({ id: row.id, referenceNumber: row.referenceNumber, status, supplierName: row.supplierName || '', quantity });
            ordersByPosition.set(positionId, list);
        }
        return {
            id: row.id,
            referenceNumber: row.referenceNumber,
            status,
            supplierId: row.supplierId ?? null,
            supplierName: row.supplierName || '',
            totalNet: Number(row.totalNet) || 0,
            currency: row.currency || 'CHF',
            createdAt: row.createdAt,
            lineCount: own.length,
            production: own.some((item) => Boolean((0, inventory_routes_1.poLineSource)(item.source)?.producerTenantId)),
            /** Türsüzler'den ELLE açılan sipariş — tabloda kendi başlığı (U1, U2 …). */
            manual: false,
        };
    });
    /* STOK PAYLAŞTIRILIR: aynı ürün birden çok pozisyonda geçiyorsa depo
       yalnızca bir kez sayılır — pozisyon sırasıyla her satır kalan stoktan
       ihtiyacı kadar alır (ihtiyaç = talep − siparişte − fiyat talebinde). */
    const infos = lines.map((row) => {
        const ref = articleOf(row);
        const article = ref.id ? articleById.get(ref.id) ?? null : null;
        const kind = article?.articleKind ? String(article.articleKind).toUpperCase() : null;
        const isService = kind === 'SERVICE' || (!kind && String(article?.itemType || '').toUpperCase() === 'SERVICE');
        // Türsüz ürün ve ürüne bağlı olmayan satır da SATIN ALMA yoluna girer
        // (elle, «Türsüzler» başlığından); türü «Satın Alınacak» olan otomatik.
        const mode = isService
            ? 'EMPTY'
            : (kind === 'MANUFACTURED' ? 'PRODUCTION' : 'PURCHASE');
        const requested = round3((Number(row.quantity) || 0) * ref.multiplier);
        const ordered = orderedByPosition.get(row.id) ?? 0;
        const inRequest = inRequestByPosition.get(row.id) ?? 0;
        const link = article ? linkByArticle.get(article.id) : null;
        const supplierId = article?.defaultSupplierId || link?.supplierId || null;
        const supplierRow = supplierId ? supplierById.get(String(supplierId)) : null;
        const need = mode === 'EMPTY' ? 0 : round3(Math.max(0, requested - ordered - inRequest));
        let stock = null;
        let fromStock = 0;
        if (mode === 'PURCHASE' && article) {
            stock = stockPool.get(article.id) ?? 0;
            fromStock = round3(Math.min(need, stock));
            stockPool.set(article.id, round3(stock - fromStock));
        }
        const missing = round3(Math.max(0, need - fromStock));
        return {
            positionId: row.id,
            positionNumber: row.positionNumber ?? null,
            name: plain(row.shortDescription) || article?.name || '—',
            unit: row.unit || article?.unit || null,
            requested,
            articleId: article?.id ?? null,
            articleCode: article?.articleCode ?? null,
            articleKind: kind,
            itemType: article?.itemType ?? null,
            mode,
            supplier: mode === 'PRODUCTION'
                ? (producer ? { id: `tenant:${producer.id}`, name: producer.tenantName } : null)
                : (supplierRow ? { id: supplierRow.id, name: supplierRow.companyName } : null),
            unitCost: Number(link?.purchasePrice) || Number(article?.baseCost) || 0,
            stock,
            fromStock,
            ordered,
            inRequest,
            missing,
            orders: ordersByPosition.get(row.id) ?? [],
        };
    });
    /* U-SİPARİŞLERİ (Vorgabe Samet, 24.09.2026): Türsüzler'den işaretlenip
       ELLE açılan sipariş tabloda Türsüzler'in üstünde kendi başlığıyla (U1,
       U2 …) durur. Satırları `source.manual` taşır; bu işaretten ÖNCE açılmış
       olan da tanınır: üretim satırı yok ve bütün satırları elle sipariş
       edilen pozisyonlara (Türsüzler / Tedarikçisi olmayanlar) ait. */
    const infoById = new Map(infos.map((info) => [info.positionId, info]));
    for (const order of orders) {
        const own = orderLines.get(order.id);
        if (!own)
            continue;
        const known = own.positionIds.map((id) => infoById.get(id)).filter(Boolean);
        order.manual = own.marked || (!order.production && known.length > 0 && known.every(isOrderedByHand));
    }
    return {
        project: { id: project.id, projectNumber: project.projectNumber, projectName: project.projectName, label: projectLabelOf(project) },
        producer: producer ? { tenantId: producer.id, name: producer.tenantName } : null,
        positions: infos,
        orders,
    };
};
/**
 * @swagger
 * /inventory/project-procurement/{projectId}:
 *   get:
 *     tags: [Inventory]
 *     summary: "Projenin pozisyonlarının tedarik durumu (talep, stok, siparişte, eksik)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/:projectId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['inventory.view', 'projects.view']), async (req, res) => {
    try {
        const data = await buildProcurement(req.user.tenantId, String(req.params.projectId));
        if (!data)
            return res.status(404).json({ error: 'Proje bulunamadı.', code: 'PROJECT_NOT_FOUND' });
        res.status(200).json(data);
    }
    catch (error) {
        sendProcurementError(res, error);
    }
});
/**
 * Satırın fiyatı DOĞRUDAN girilmiş sayılır: birim fiyat × miktar. En az ad + miktar taşır.
 * `manual`: Türsüzler'den ELLE açılan siparişin satırı — tablo siparişi U-başlığıyla gösterir.
 */
const lineFor = (info, projectId, quantity, producerTenantId, manual = false) => {
    const price = round2(info.unitCost);
    return {
        itemType: 'PRODUCT',
        articleId: info.articleId,
        code: info.articleCode,
        name: info.name,
        quantity,
        unit: info.unit,
        grossPrice: price,
        netPrice: price,
        discount: 0,
        discount2: 0,
        vatRate: 0,
        calcMode: 'DIRECT',
        directCopy: true,
        lineTotal: round2(quantity * price),
        source: { projectId, positionId: info.positionId, producerTenantId, ...(manual ? { manual: true } : {}) },
    };
};
/** Üretim şirketi hedefi (tedarikçi kaydıyla); tanımlı değilse `null`. */
const producerTarget = async (tenantId) => {
    const producer = await resolveProducer(tenantId);
    if (!producer)
        return null;
    const resolved = await producerSupplier(tenantId, producer);
    return { supplier: resolved.supplier, supplierAddress: resolved.address, producerTenantId: producer.id };
};
/** Satın almada ürünün varsayılan tedarikçisi. */
const supplierTarget = async (tenantId, supplierId) => {
    const supplier = await prisma_client_1.default.supplier.findFirst({ where: { id: supplierId, tenantId } });
    return supplier ? { supplier, supplierAddress: (0, inventory_routes_1.supplierAddressSnapshot)(supplier), producerTenantId: null } : null;
};
/**
 * SATIRLARI SİPARİŞE YAZ — otomatik sipariş, «+» (yine de sipariş) ve
 * Türsüzler'in «Oluştur»u aynı yolu kullanır:
 *   · hedef bir tedarikçiyse ve onun bu projeye ait AÇIK siparişi varsa
 *     satırlar ona eklenir (aynı pozisyon zaten oradaysa miktarı artar);
 *   · yoksa standart şablonla, projenin adıyla YENİ sipariş açılır;
 *   · hedef yoksa (Türsüzler) tedarikçisiz yeni sipariş açılır — tedarikçi
 *     siparişte seçilir.
 * `mode`: AUTO (varsa ekle, yoksa aç), EXISTING (yalnızca ekle), NEW (hep aç).
 */
const writeOrderLines = async (ctx, target, lines, mode) => {
    const { tenantId, projectId } = ctx;
    const open = mode === 'NEW' || !target
        ? null
        : await prisma_client_1.default.purchaseOrder.findFirst({
            where: {
                tenantId,
                supplierId: target.supplier.id,
                status: OPEN_ORDER_STATUS,
                items: { contains: `"projectId":"${projectId}"` },
            },
            orderBy: { createdAt: 'desc' },
        });
    if (mode === 'EXISTING' && !open) {
        throw new ProcurementError('NO_OPEN_ORDER', 'Tedarikçinin bu projeye ait açık siparişi yok.');
    }
    if (open) {
        const items = parseItems(open.items);
        let merged = false;
        for (const line of lines) {
            const same = items.find((item) => {
                const source = (0, inventory_routes_1.poLineSource)(item?.source);
                return source?.projectId === projectId && source.positionId === line.source.positionId;
            });
            if (same) {
                const nextQty = round3((Number(same.quantity) || 0) + line.quantity);
                const unit = Number(same.netPrice) || Number(same.grossPrice) || 0;
                same.quantity = nextQty;
                if (String(same.calcMode || 'DIRECT').toUpperCase() === 'DIRECT')
                    same.lineTotal = round2(nextQty * unit);
                merged = true;
            }
            else {
                items.push(line);
            }
        }
        const normalized = (0, inventory_routes_1.normalizePurchaseOrderItems)(items);
        const vat = { vatMode: open.vatMode, orderVatRate: Number(open.orderVatRate) || 0 };
        const row = await prisma_client_1.default.purchaseOrder.update({
            where: { id: open.id },
            data: {
                items: JSON.stringify(normalized.items),
                totalNet: normalized.totalNet,
                totalGross: normalized.totalGross,
                totalVat: (0, inventory_routes_1.purchaseOrderTotalVat)(vat, normalized.totalNet, Number(open.totalFees) || 0, normalized.totalVat, normalized.items.map((it) => it.lineTotal)),
                // Mail gitmiş taslakta içerik değişti: sonraki mail «güncellendi» der.
                ...(open.emailSentAt ? { revision: { increment: 1 } } : {}),
            },
        });
        return { row, created: false, merged };
    }
    // YENİ SİPARİŞ — standart şablonla, projenin adıyla.
    await (0, standardOrderTemplate_1.ensureStandardTemplate)(tenantId, 'ORDER');
    const [last, employee] = await Promise.all([
        prisma_client_1.default.purchaseOrder.findFirst({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            select: { vatMode: true, orderVatRate: true, orderVatCountry: true, currency: true },
        }),
        prisma_client_1.default.employee.findUnique({
            where: { id: ctx.userId },
            select: { firstName: true, lastName: true },
        }).catch(() => null),
    ]);
    const normalized = (0, inventory_routes_1.normalizePurchaseOrderItems)(lines);
    // KDV: tedarikçide belirtilmişse (24.09.2026) onun oranı — KDV'ye tabi
    // değilse 0; belirtilmemişse son siparişin oranı devam eder.
    const supplierVat = target?.supplier?.vatLiable;
    const vat = typeof supplierVat === 'boolean'
        ? { vatMode: 'TOTAL', orderVatRate: supplierVat ? Number(target.supplier.vatRate) || 0 : 0 }
        : {
            vatMode: last?.vatMode === 'TOTAL' ? 'TOTAL' : 'LINE',
            orderVatRate: Number(last?.orderVatRate) || 0,
        };
    const vatCountry = typeof supplierVat === 'boolean'
        ? (supplierVat ? target.supplier.vatCountry ?? null : last?.orderVatCountry ?? null)
        : last?.orderVatCountry ?? null;
    let row = null;
    for (let attempt = 0; attempt < 3 && !row; attempt++) {
        const referenceNumber = await (0, inventory_routes_1.nextPurchaseReference)(tenantId, 'ORDER');
        try {
            row = await prisma_client_1.default.purchaseOrder.create({
                data: {
                    id: (0, nanoid_1.nanoid)(12),
                    tenantId,
                    referenceNumber,
                    orderNumber: referenceNumber,
                    status: OPEN_ORDER_STATUS,
                    orderedByName: employee ? `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim() || null : null,
                    projectName: ctx.projectLabel || null,
                    tableColumns: (0, standardOrderTemplate_1.standardTableColumnsJson)('ORDER'),
                    hiddenColumnKeys: (0, standardOrderTemplate_1.standardHiddenKeysJson)('ORDER'),
                    vatMode: vat.vatMode,
                    orderVatRate: vat.orderVatRate,
                    orderVatCountry: vatCountry,
                    // Tedarikçisiz sipariş (Türsüzler): ad boş kalır, siparişte seçilir.
                    supplierId: target?.supplier.id ?? null,
                    supplierName: target?.supplier.companyName ?? '',
                    supplierEmail: target?.supplier.email ?? null,
                    supplierAddress: target?.supplierAddress ?? null,
                    items: JSON.stringify(normalized.items),
                    additionalFees: '[]',
                    currency: last?.currency || 'CHF',
                    totalNet: normalized.totalNet,
                    totalGross: normalized.totalGross,
                    totalVat: (0, inventory_routes_1.purchaseOrderTotalVat)(vat, normalized.totalNet, 0, normalized.totalVat, normalized.items.map((it) => it.lineTotal)),
                    totalFees: 0,
                    createdByEmpId: ctx.userId,
                },
            });
        }
        catch (err) {
            if (err?.code !== 'P2002')
                throw err;
        }
    }
    if (!row)
        throw new ProcurementError('NUMBER_FAILED', 'Sipariş numarası üretilemedi, lütfen tekrar deneyin.', 400);
    return { row, created: true, merged: false };
};
/**
 * @swagger
 * /inventory/project-procurement/{projectId}/order:
 *   post:
 *     tags: [Inventory]
 *     summary: "Pozisyon için sipariş oluştur ya da tedarikçinin açık siparişine ekle («+» yine de sipariş)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/:projectId/order', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const projectId = String(req.params.projectId);
        const positionId = String(req.body?.positionId ?? '').trim();
        const rawMode = String(req.body?.target ?? 'AUTO').toUpperCase();
        const mode = rawMode === 'NEW' || rawMode === 'EXISTING' ? rawMode : 'AUTO';
        const data = await buildProcurement(tenantId, projectId);
        if (!data)
            throw new ProcurementError('PROJECT_NOT_FOUND', 'Proje bulunamadı.', 404);
        const info = data.positions.find((entry) => entry.positionId === positionId);
        if (!info)
            throw new ProcurementError('POSITION_NOT_FOUND', 'Pozisyon bulunamadı.', 404);
        if (info.mode === 'EMPTY')
            throw new ProcurementError('EMPTY_FORM', 'Bu pozisyon için boş sipariş formu açılır.');
        const wanted = Number(req.body?.quantity);
        const quantity = Number.isFinite(wanted) && wanted > 0 ? round3(wanted) : info.missing;
        if (!(quantity > 0)) {
            throw new ProcurementError('NOTHING_MISSING', 'Eksik miktar yok.', 409, {
                orderId: info.orders.find((order) => ORDER_STATUSES.has(order.status))?.id ?? null,
            });
        }
        // Tedarikçi: satın almada ürünün varsayılanı, üretimde üretim şirketi.
        let target;
        if (info.mode === 'PRODUCTION') {
            target = await producerTarget(tenantId);
            if (!target)
                throw new ProcurementError('PRODUCER_MISSING', 'Ayarlarda türü «Üretim» olan bir şirket tanımlı değil.');
        }
        else {
            target = info.supplier ? await supplierTarget(tenantId, info.supplier.id) : null;
            if (!target)
                throw new ProcurementError('SUPPLIER_MISSING', 'Ürünün varsayılan tedarikçisi yok.');
        }
        const result = await writeOrderLines({ tenantId, projectId, projectLabel: data.project.label, userId: req.user.id }, target, [lineFor(info, projectId, quantity, target.producerTenantId)], mode);
        res.status(result.created ? 201 : 200).json({
            created: result.created,
            merged: result.merged,
            order: (0, inventory_routes_1.parsePurchaseOrderRow)(result.row),
        });
    }
    catch (error) {
        sendProcurementError(res, error);
    }
});
/* ══ OTOMATİK SİPARİŞ — PROJE OLUŞTURULUNCA (Vorgabe Samet, 24.09.2026) ═════
 *
 * «Siparişlerim sayfasına girince otomatik oluşturmayacak; proje
 *  oluşturulunca otomatik oluşturulacak.»
 *
 * Teklif siparişe çevrilip YENİ proje açıldığında (SalesOrderController,
 * `PROJECT_NEW`; eski yol ProjectController) arka planda çalışır: türü
 * «Satın Alınacak» olup tedarikçisi belli ve türü «Üretilecek» olan her
 * pozisyonun EKSİĞİ sipariş edilir — aynı tedarikçinin ürünleri AYNI
 * siparişe, farklı tedarikçininkiler ayrı siparişlere. Yalnızca şirket türü
 * «Proje» olan şirketlerde (özellik o şirketler için tanımlandı). Türsüzler,
 * tedarikçisi olmayanlar ve Ek Hizmet otomatik GİTMEZ.
 *
 * Sekmede «Siparişe Git» aynı yolu tek bir tedarikçi için yürütür
 * (`/supplier-order`): o tedarikçinin eksikleri varsa siparişe yazılır, sonra
 * sipariş açılır. TEKRAR ETMEZ: eksik, siparişte + fiyat talebinde duranı ve
 * stoktan karşılananı düşer. Aynı projenin iki yazısı sırayla çalışır (süreç
 * içi kilit).
 */
const projectLocks = new Map();
const withProjectLock = async (key, run) => {
    const previous = projectLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    projectLocks.set(key, next);
    try {
        return await next;
    }
    finally {
        if (projectLocks.get(key) === next)
            projectLocks.delete(key);
    }
};
/** Otomatik siparişe girenler: tedarikçisi belli «Satın Alınacak» ve «Üretilecek». */
const isAutoOrdered = (info) => (info.mode === 'PRODUCTION') || (info.mode === 'PURCHASE' && info.articleKind === 'RESALE' && Boolean(info.supplier));
/** Tablodaki grubun anahtarı — frontend `buildGroups` ile aynı: `P:<tedarikçi>` / `M:<üretim>`. */
const groupKeyOf = (info) => {
    if (!info.supplier)
        return null;
    return `${info.mode === 'PRODUCTION' ? 'M' : 'P'}:${info.supplier.id}`;
};
const runAutoOrder = async (ctx, positions) => {
    const groups = new Map();
    let producer;
    const suppliers = new Map();
    for (const info of positions) {
        if (!isAutoOrdered(info) || !(info.missing > 0))
            continue;
        let target = null;
        if (info.mode === 'PRODUCTION') {
            if (producer === undefined)
                producer = await producerTarget(ctx.tenantId);
            target = producer;
        }
        else if (info.supplier) {
            if (!suppliers.has(info.supplier.id))
                suppliers.set(info.supplier.id, await supplierTarget(ctx.tenantId, info.supplier.id));
            target = suppliers.get(info.supplier.id) ?? null;
        }
        if (!target)
            continue;
        const key = String(target.supplier.id);
        const group = groups.get(key) ?? { target, lines: [] };
        group.lines.push(lineFor(info, ctx.projectId, info.missing, target.producerTenantId));
        groups.set(key, group);
    }
    const written = [];
    for (const group of groups.values()) {
        const result = await writeOrderLines(ctx, group.target, group.lines, 'AUTO');
        written.push({
            id: result.row.id,
            referenceNumber: result.row.referenceNumber,
            supplierName: result.row.supplierName,
            created: result.created,
            lineCount: group.lines.length,
        });
    }
    return written;
};
/**
 * Yeni projenin eksiklerini otomatik sipariş eder (şirket türü «Proje» ise).
 * Dışarıdan (proje oluşturan akışlar) çağrılır.
 */
const autoOrderProject = async (tenantId, projectId, userId) => {
    if (await (0, companyType_1.readTenantCompanyType)(tenantId) !== 'PROJECT')
        return [];
    return withProjectLock(`${tenantId}:${projectId}`, async () => {
        const data = await buildProcurement(tenantId, projectId);
        if (!data)
            return [];
        return runAutoOrder({ tenantId, projectId, projectLabel: data.project.label, userId }, data.positions);
    });
};
exports.autoOrderProject = autoOrderProject;
/**
 * Proje oluşturan akışlar için: cevabı bekletmeden arka planda çalıştırır —
 * sipariş yazılamazsa proje yine de oluşmuştur (hata yalnızca günlüğe düşer).
 */
const scheduleProjectAutoOrder = (tenantId, projectId, userId) => {
    setImmediate(() => {
        (0, exports.autoOrderProject)(tenantId, projectId, userId)
            .then((written) => {
            if (written.length) {
                console.log('[procurement] auto orders for project', projectId, written.map((entry) => entry.referenceNumber).join(', '));
            }
        })
            .catch((error) => console.warn('[procurement] auto order failed', projectId, error?.message));
    });
};
exports.scheduleProjectAutoOrder = scheduleProjectAutoOrder;
// Proje oluşturan akışlar olayı yayınlar; sipariş modülü burada dinler.
(0, projectEvents_1.onProjectCreated)(({ tenantId, projectId, userId }) => (0, exports.scheduleProjectAutoOrder)(tenantId, projectId, userId));
/**
 * @swagger
 * /inventory/project-procurement/{projectId}/supplier-order:
 *   post:
 *     tags: [Inventory]
 *     summary: "Siparişe Git (tedarikçi grubu): grubun eksiklerini siparişe yaz ve siparişi dön"
 *     security:
 *       - bearerAuth: []
 */
router.post('/:projectId/supplier-order', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const projectId = String(req.params.projectId);
        const key = String(req.body?.key ?? '').trim();
        if (!key)
            throw new ProcurementError('GROUP_REQUIRED', 'Tedarikçi grubu seçilmedi.', 400);
        const result = await withProjectLock(`${tenantId}:${projectId}`, async () => {
            const data = await buildProcurement(tenantId, projectId);
            if (!data)
                throw new ProcurementError('PROJECT_NOT_FOUND', 'Proje bulunamadı.', 404);
            const members = data.positions.filter((info) => isAutoOrdered(info) && groupKeyOf(info) === key);
            if (!members.some((info) => info.missing > 0)) {
                // Eksik yok: grubun mevcut siparişi açılır (açık taslak önce).
                const refs = members.flatMap((info) => info.orders);
                const target = refs.find((order) => order.status === OPEN_ORDER_STATUS)
                    ?? refs.find((order) => ORDER_STATUSES.has(order.status))
                    ?? refs[0]
                    ?? null;
                throw new ProcurementError('NOTHING_MISSING', 'Eksik yok.', 409, { orderId: target?.id ?? null });
            }
            const ctx = { tenantId, projectId, projectLabel: data.project.label, userId: req.user.id };
            const written = await runAutoOrder(ctx, members);
            return written[0] ?? null;
        });
        if (!result)
            throw new ProcurementError('SUPPLIER_MISSING', 'Tedarikçi bulunamadı.');
        const row = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: result.id, tenantId } });
        res.status(result.created ? 201 : 200).json({
            created: result.created,
            merged: !result.created,
            order: (0, inventory_routes_1.parsePurchaseOrderRow)(row),
        });
    }
    catch (error) {
        sendProcurementError(res, error);
    }
});
/**
 * @swagger
 * /inventory/project-procurement/{projectId}/manual-order:
 *   post:
 *     tags: [Inventory]
 *     summary: "Türsüzler: işaretlenen pozisyonlardan TEK bir sipariş oluştur (tedarikçi siparişte seçilir)"
 *     security:
 *       - bearerAuth: []
 */
/* «Türsüzlerde Mac işaretlemesiyle: Türsüzler başlığı, yanında ‹Sipariş
 *  oluştur›; checkler çıkar, işaretlenir, ‹Oluştur›a basınca hepsi TEK bir
 *  siparişte olur; tedarikçisi belirlenince de yanlarında tedarikçisi yazar.»
 * Her «Oluştur» YENİ bir siparişdir; satırları `source.manual` taşır ve tablo
 * onu Türsüzler'in üstünde «U1», «U2» … başlığıyla gösterir.
 * Miktar: eksik (yoksa henüz karşılanmamış talep, o da yoksa talebin tamamı). */
router.post('/:projectId/manual-order', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const projectId = String(req.params.projectId);
        const wanted = new Set((Array.isArray(req.body?.positionIds) ? req.body.positionIds : [])
            .map((value) => String(value ?? '').trim())
            .filter(Boolean));
        if (!wanted.size)
            throw new ProcurementError('NOTHING_SELECTED', 'Sipariş için en az bir ürün işaretleyin.', 400);
        const result = await withProjectLock(`${tenantId}:${projectId}`, async () => {
            const data = await buildProcurement(tenantId, projectId);
            if (!data)
                throw new ProcurementError('PROJECT_NOT_FOUND', 'Proje bulunamadı.', 404);
            const chosen = data.positions.filter((info) => wanted.has(info.positionId) && info.mode !== 'EMPTY');
            if (!chosen.length)
                throw new ProcurementError('NOTHING_SELECTED', 'İşaretlenen ürün bulunamadı.', 400);
            const lines = chosen.map((info) => {
                const open = round3(Math.max(0, info.requested - info.ordered - info.inRequest));
                const quantity = info.missing > 0 ? info.missing : (open > 0 ? open : Math.max(1, info.requested));
                return lineFor(info, projectId, quantity, null, true);
            });
            const written = await writeOrderLines({ tenantId, projectId, projectLabel: data.project.label, userId: req.user.id }, null, lines, 'NEW');
            return written;
        });
        res.status(201).json({ created: true, merged: false, order: (0, inventory_routes_1.parsePurchaseOrderRow)(result.row) });
    }
    catch (error) {
        sendProcurementError(res, error);
    }
});
exports.default = router;
//# sourceMappingURL=projectProcurement.routes.js.map