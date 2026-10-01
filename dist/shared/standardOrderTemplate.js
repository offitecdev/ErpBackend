"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureStandardTemplateOnce = exports.ensureStandardTemplate = exports.isStandardColumns = exports.standardHiddenKeysJson = exports.standardTableColumnsJson = exports.standardColumnsOf = exports.productionHiddenKeysJson = exports.productionColumnsJson = exports.PRODUCTION_ORDER_COLUMNS = exports.PRODUCTION_REQUEST_COLUMNS = exports.PRODUCTION_UNIT_KEY = exports.PRODUCTION_CODE_KEY = exports.PRODUCTION_GROUP_KEY = exports.STANDARD_TEMPLATE_TITLE = exports.STANDARD_REQUEST_COLUMNS = exports.STANDARD_ORDER_COLUMNS = void 0;
/**
 * ── STANDART ŞABLON (Vorgabe Samet, 24.09.2026) ─────────────────────────────
 *
 * «Varsayılan sipariş şablonumuz, 3 dilde de: ÜRÜN - MALZEME / MİKTAR /
 *  BİRİM FİYAT / NET FİYAT / TUTAR» — und seit dem 29.09.2026 wieder:
 * «fiyat talebi standart şablon ürün malzeme, model no, miktar olması
 *  gerekiyor; birim fiyat, tutar olmayacak» (Samet). Eine Preisanfrage FRAGT
 * nach Preisen, sie trägt keine; die Angebote kommen als PDF zum Talep.
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
/** Das Modell der Preisanfrage — derselbe Schlüssel wie in der BOM (`stdModel`). */
const STANDARD_MODEL_COLUMN = { key: 'stdModel', name: 'Modell', type: 'text', label: null, width: 180 };
/** Preisanfrage: Produkt - Material · Modell · Menge — keine Preise. */
exports.STANDARD_REQUEST_COLUMNS = [exports.STANDARD_ORDER_COLUMNS[0], STANDARD_MODEL_COLUMN, exports.STANDARD_ORDER_COLUMNS[1]];
/** Die Preisspalten, die eine Preisanfrage vom 28.09.2026 (Codex) mitbekam — sie gehen wieder heraus. */
const REQUEST_PRICE_KEYS = new Set(['stdUnitPrice', 'stdNetPrice', 'stdAmount']);
exports.STANDARD_TEMPLATE_TITLE = 'Standard';
/**
 * ── DIE VORLAGE DER PRODUKTION (30.09.2026, Vorgabe Samet) ────────────────
 * «Fiyat talebi şablonu: malzeme grubu, ürün kodu (boş olabilir), ürün adı,
 *  birim, miktar. Siparişte standart şablon: malzeme grubu, ürün kodu (boş
 *  olabilir), ürün adı, birim, miktar, birim fiyat, indirim, satır tutarı —
 *  en altta varsa KDV.» NUR die Belege der BOM tragen sie (der Stok behält
 * seine Standardvorlage). Die Spalten ohne Zuordnung (Gruppe, Code, Einheit)
 * sind eigene Angaben je Position; ihre Titel übersetzt die Oberfläche
 * (`utils/standardOrderColumns.ts`), die Einheit ebenso.
 */
exports.PRODUCTION_GROUP_KEY = 'stdGroup';
exports.PRODUCTION_CODE_KEY = 'stdProductCode';
exports.PRODUCTION_UNIT_KEY = 'stdUnit';
exports.PRODUCTION_REQUEST_COLUMNS = [
    { key: exports.PRODUCTION_GROUP_KEY, name: 'Materialgruppe', type: 'text', label: null, width: 150 },
    { key: exports.PRODUCTION_CODE_KEY, name: 'Produktcode', type: 'text', label: null, width: 150 },
    { key: 'stdName', name: 'Produktname', type: 'text', label: 'productName', width: 260 },
    { key: exports.PRODUCTION_UNIT_KEY, name: 'Einheit', type: 'text', label: null, width: 90 },
    { key: 'stdQty', name: 'Menge', type: 'number', label: 'quantity', width: 100 },
];
exports.PRODUCTION_ORDER_COLUMNS = [
    ...exports.PRODUCTION_REQUEST_COLUMNS,
    { key: 'stdUnitPrice', name: 'Einzelpreis', type: 'number', label: 'grossPrice', width: 120 },
    { key: 'stdDiscount', name: 'Rabatt', type: 'number', label: 'discount', width: 100 },
    { key: 'stdLineTotal', name: 'Betrag', type: 'number', label: 'total', width: 130 },
];
/** Die Spalten einer BOM-Anfrage/-Bestellung als Schnappschuss (`tableColumns`). */
const productionColumnsJson = (documentType) => JSON.stringify((documentType === 'PRICE_REQUEST' ? exports.PRODUCTION_REQUEST_COLUMNS : exports.PRODUCTION_ORDER_COLUMNS)
    .map(({ key, name, label, type }) => ({ key, name, label, type })));
exports.productionColumnsJson = productionColumnsJson;
/** Was die Vorlage der Produktion ausblendet: nie den ERP-Code, bei Anfragen keine Preise. */
const productionHiddenKeysJson = (documentType) => JSON.stringify(documentType === 'PRICE_REQUEST' ? ['code', 'priceGross', 'discount'] : ['code']);
exports.productionHiddenKeysJson = productionHiddenKeysJson;
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
        select: { id: true, config: true },
        take: 1,
    });
    if (rows.length) {
        if (documentType === 'PRICE_REQUEST') {
            /* 29.09.2026: die Preisspalten, die der 28.09. an die Standardvorlage der
               Preisanfrage hängte, gehen wieder heraus, und das Modell kommt nach dem
               Produkt dazu. Eigene Spalten und eigene Namen bleiben, wie sie sind. */
            let config = {};
            try {
                config = JSON.parse(rows[0].config || '{}');
            }
            catch { /* unlesbar — so lassen */ }
            const columns = Array.isArray(config.columns) ? config.columns : [];
            const next = columns.filter((column) => !REQUEST_PRICE_KEYS.has(String(column?.key ?? '')));
            if (!next.some((column) => column?.key === STANDARD_MODEL_COLUMN.key)) {
                const product = next.findIndex((column) => column?.key === 'stdProduct');
                next.splice(product + 1, 0, STANDARD_MODEL_COLUMN);
            }
            if (columns.length && JSON.stringify(next) !== JSON.stringify(columns)) {
                await prisma_client_1.default.supplierOrderTemplate.update({
                    where: { id: rows[0].id },
                    data: { config: JSON.stringify({ ...config, columns: next }) },
                });
            }
        }
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