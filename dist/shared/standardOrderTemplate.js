"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureStandardTemplateOnce = exports.ensureStandardTemplate = exports.isStandardColumns = exports.standardHiddenKeysJson = exports.standardTableColumnsJson = exports.standardColumnsOf = exports.STANDARD_TEMPLATE_TITLE = exports.STANDARD_REQUEST_COLUMNS = exports.STANDARD_ORDER_COLUMNS = void 0;
/**
 * ── STANDART ŞABLON (Vorgabe Samet, 24.09.2026) ─────────────────────────────
 *
 * «Varsayılan sipariş şablonumuz, 3 dilde de: ÜRÜN - MALZEME / MİKTAR /
 *  BİRİM FİYAT / NET FİYAT / TUTAR; fiyat talebi: ÜRÜN - MALZEME / MİKTAR —
 *  otomatik çekecek.»
 *
 * Her şirkette sipariş ve fiyat talebi için BİRER sabit şablon kendiliğinden
 * kurulur. Sütun ANAHTARLARI (`std…`) sabittir ve arayüz + PDF başlığı o
 * anahtardan o anki DİLE çevirir; `name` yalnızca depoda duran Almanca
 * yazımdır (frontend eşi: `utils/standardOrderColumns.ts`).
 *
 * Projeden açılan siparişler (bkz. projectProcurement.routes.ts) her zaman bu
 * şablonun sütunlarıyla kaydedilir; sipariş ⇄ fiyat talebi geçişinde sütunlar
 * karşı türün standart şablonuna çevrilir.
 */
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
exports.STANDARD_ORDER_COLUMNS = [
    { key: 'stdProduct', name: 'Produkt - Material', type: 'text', label: 'productName', width: 240 },
    { key: 'stdQty', name: 'Menge', type: 'number', label: 'quantity', width: 100 },
    { key: 'stdUnitPrice', name: 'Einzelpreis', type: 'number', label: 'grossPrice', width: 120 },
    { key: 'stdNetPrice', name: 'Nettopreis', type: 'number', label: 'netPrice', width: 120 },
    { key: 'stdAmount', name: 'Betrag', type: 'number', label: 'total', width: 130 },
];
exports.STANDARD_REQUEST_COLUMNS = exports.STANDARD_ORDER_COLUMNS.slice(0, 2);
exports.STANDARD_TEMPLATE_TITLE = 'Standard';
const standardColumnsOf = (documentType) => documentType === 'PRICE_REQUEST' ? exports.STANDARD_REQUEST_COLUMNS : exports.STANDARD_ORDER_COLUMNS;
exports.standardColumnsOf = standardColumnsOf;
/** Siparişin `tableColumns` sütununa yazılan anlık görüntü (genişliksiz). */
const standardTableColumnsJson = (documentType) => JSON.stringify((0, exports.standardColumnsOf)(documentType).map(({ key, name, label, type }) => ({ key, name, label, type })));
exports.standardTableColumnsJson = standardTableColumnsJson;
/**
 * Şablonun gizlediği sütunlar: ERP kodu hiçbir zaman PDF'e girmez; standart
 * sipariş şablonunda indirim yoktur, fiyat talebinde fiyat da yoktur.
 */
const standardHiddenKeysJson = (documentType) => JSON.stringify(documentType === 'PRICE_REQUEST' ? ['code', 'priceGross', 'discount'] : ['code', 'discount']);
exports.standardHiddenKeysJson = standardHiddenKeysJson;
/** Bir sütun listesi standart şablonun mu? (ilk sütunun anahtarından tanınır) */
const isStandardColumns = (raw) => {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            return false;
        }
    }
    return Array.isArray(value) && value.some((column) => String(column?.key ?? '') === 'stdProduct');
};
exports.isStandardColumns = isStandardColumns;
const ensured = new Set();
/**
 * Şirketin standart şablonu yoksa kurar ve VARSAYILAN yapar (tek seferlik:
 * sonradan kullanıcı başka bir şablonu varsayılan seçerse o geçerli kalır).
 * Kurulmuş şablonun kimliğini döner.
 */
const ensureStandardTemplate = async (tenantId, documentType) => {
    const rows = await prisma_client_1.default.supplierOrderTemplate.findMany({
        where: { tenantId, documentType, config: { contains: '"stdProduct"' } },
        select: { id: true },
        take: 1,
    });
    if (rows.length) {
        ensured.add(`${tenantId}:${documentType}`);
        return rows[0].id;
    }
    const id = (0, nanoid_1.nanoid)(12);
    await prisma_client_1.default.supplierOrderTemplate.updateMany({
        where: { tenantId, documentType, isDefault: true },
        data: { isDefault: false },
    });
    await prisma_client_1.default.supplierOrderTemplate.create({
        data: {
            id,
            tenantId,
            supplierId: null,
            supplierName: '',
            title: exports.STANDARD_TEMPLATE_TITLE,
            documentType,
            isDefault: true,
            config: JSON.stringify({ columns: (0, exports.standardColumnsOf)(documentType) }),
            createdBy: null,
        },
    });
    ensured.add(`${tenantId}:${documentType}`);
    return id;
};
exports.ensureStandardTemplate = ensureStandardTemplate;
/** Liste açılırken ucuz yol: bu süreçte bir kez kurulduysa sorgu atılmaz. */
const ensureStandardTemplateOnce = async (tenantId, documentType) => {
    if (ensured.has(`${tenantId}:${documentType}`))
        return;
    await (0, exports.ensureStandardTemplate)(tenantId, documentType);
};
exports.ensureStandardTemplateOnce = ensureStandardTemplateOnce;
//# sourceMappingURL=standardOrderTemplate.js.map