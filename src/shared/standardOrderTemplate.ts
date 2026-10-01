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
import { nanoid } from 'nanoid';
import prisma from '../infrastructure/database/prisma.client';

export type StandardDocumentType = 'ORDER' | 'PRICE_REQUEST';

export interface StandardColumn {
    key: string;
    name: string;
    type: 'text' | 'number';
    /** null = eine freie Spalte (das Modell der Preisanfrage). */
    label: 'productName' | 'quantity' | 'grossPrice' | 'netPrice' | 'discount' | 'total' | null;
    width: number;
}

export const STANDARD_ORDER_COLUMNS: StandardColumn[] = [
    { key: 'stdProduct', name: 'Produkt - Material', type: 'text', label: 'productName', width: 240 },
    { key: 'stdQty', name: 'Menge', type: 'number', label: 'quantity', width: 100 },
    { key: 'stdUnitPrice', name: 'Einzelpreis', type: 'number', label: 'grossPrice', width: 120 },
    { key: 'stdNetPrice', name: 'Nettopreis', type: 'number', label: 'netPrice', width: 120 },
    { key: 'stdAmount', name: 'Betrag', type: 'number', label: 'total', width: 130 },
];

/** Das Modell der Preisanfrage — derselbe Schlüssel wie in der BOM (`stdModel`). */
const STANDARD_MODEL_COLUMN: StandardColumn = { key: 'stdModel', name: 'Modell', type: 'text', label: null, width: 180 };

/** Preisanfrage: Produkt - Material · Modell · Menge — keine Preise. */
export const STANDARD_REQUEST_COLUMNS: StandardColumn[] = [STANDARD_ORDER_COLUMNS[0]!, STANDARD_MODEL_COLUMN, STANDARD_ORDER_COLUMNS[1]!];

/** Die Preisspalten, die eine Preisanfrage vom 28.09.2026 (Codex) mitbekam — sie gehen wieder heraus. */
const REQUEST_PRICE_KEYS = new Set(['stdUnitPrice', 'stdNetPrice', 'stdAmount']);

export const STANDARD_TEMPLATE_TITLE = 'Standard';

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
export const PRODUCTION_GROUP_KEY = 'stdGroup';
/** «Ürün kodu» der Karte — seit dem 01.10.2026 nur noch in älteren Belegen (er ist jetzt die Artikelnummer JE Lieferant). */
export const PRODUCTION_CODE_KEY = 'stdProductCode';
export const PRODUCTION_UNIT_KEY = 'stdUnit';
/**
 * Artikel- und Bestellnummer DES Lieferanten, an den der Beleg geht (01.10.2026,
 * Samet: «her tedarikçiye özel ürün numarası ve sipariş numarası … fiyat
 * taleplerine ve siparişlere de bu sütunlar eklenmeli, otomatik şablonlarla
 * da») — aus seiner Zeile auf der Depo-Karte. Schlüssel ≤ 16 Zeichen
 * (`normalizePurchaseOrderItems` kürzt Extras-Schlüssel darauf).
 */
export const PRODUCTION_ARTICLE_NO_KEY = 'stdArticleNo';
export const PRODUCTION_ORDER_NO_KEY = 'stdOrderNo';

/*
 * Reihenfolge seit dem 01.10.2026 (Samet): «Malzeme Grubu, Malzeme Adı, Ürün
 * Tip Numarası, Ürün Sip. Numarası, Birim, Miktar» — Bestellung dazu «Birim
 * Fiyat, İndirim (boşsa ekleme), Satır Fiyatı; KDV … en sona». Eine Spalte,
 * deren Zellen ALLE leer sind, druckt das PDF nicht (supplierPdfColumns.ts).
 */
export const PRODUCTION_REQUEST_COLUMNS: StandardColumn[] = [
    { key: PRODUCTION_GROUP_KEY, name: 'Materialgruppe', type: 'text', label: null, width: 150 },
    { key: 'stdName', name: 'Materialbezeichnung', type: 'text', label: 'productName', width: 260 },
    { key: PRODUCTION_ARTICLE_NO_KEY, name: 'Produkttypnummer', type: 'text', label: null, width: 140 },
    { key: PRODUCTION_ORDER_NO_KEY, name: 'Bestellnummer', type: 'text', label: null, width: 140 },
    { key: PRODUCTION_UNIT_KEY, name: 'Einheit', type: 'text', label: null, width: 90 },
    { key: 'stdQty', name: 'Menge', type: 'number', label: 'quantity', width: 100 },
];

export const PRODUCTION_ORDER_COLUMNS: StandardColumn[] = [
    ...PRODUCTION_REQUEST_COLUMNS,
    { key: 'stdUnitPrice', name: 'Einzelpreis', type: 'number', label: 'grossPrice', width: 120 },
    { key: 'stdDiscount', name: 'Rabatt', type: 'number', label: 'discount', width: 100 },
    { key: 'stdLineTotal', name: 'Betrag', type: 'number', label: 'total', width: 130 },
];

/** Die Spalten einer BOM-Anfrage/-Bestellung als Schnappschuss (`tableColumns`). */
export const productionColumnsJson = (documentType: StandardDocumentType): string =>
    JSON.stringify((documentType === 'PRICE_REQUEST' ? PRODUCTION_REQUEST_COLUMNS : PRODUCTION_ORDER_COLUMNS)
        .map(({ key, name, label, type }) => ({ key, name, label, type })));

/** Was die Vorlage der Produktion ausblendet: nie den ERP-Code, bei Anfragen keine Preise. */
export const productionHiddenKeysJson = (documentType: StandardDocumentType): string =>
    JSON.stringify(documentType === 'PRICE_REQUEST' ? ['code', 'priceGross', 'discount'] : ['code']);

export const standardColumnsOf = (documentType: StandardDocumentType): StandardColumn[] =>
    documentType === 'PRICE_REQUEST' ? STANDARD_REQUEST_COLUMNS : STANDARD_ORDER_COLUMNS;

/** Siparişin `tableColumns` sütununa yazılan anlık görüntü (genişliksiz). */
export const standardTableColumnsJson = (documentType: StandardDocumentType): string =>
    JSON.stringify(standardColumnsOf(documentType).map(({ key, name, label, type }) => ({ key, name, label, type })));

/**
 * Şablonun gizlediği sütunlar: ERP kodu hiçbir zaman PDF'e girmez; standart
 * sipariş şablonunda indirim yoktur, fiyat talebinde fiyat da yoktur.
 */
export const standardHiddenKeysJson = (documentType: StandardDocumentType): string =>
    JSON.stringify(documentType === 'PRICE_REQUEST' ? ['code', 'priceGross', 'discount'] : ['code', 'discount']);

/** Bir sütun listesi standart şablonun mu? (ilk sütunun anahtarından tanınır) */
export const isStandardColumns = (raw: unknown): boolean => {
    let value: unknown = raw;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return false; }
    }
    return Array.isArray(value) && value.some((column: any) => String(column?.key ?? '') === 'stdProduct');
};

const ensured = new Set<string>();

/**
 * Şirketin standart şablonu yoksa kurar ve VARSAYILAN yapar (tek seferlik:
 * sonradan kullanıcı başka bir şablonu varsayılan seçerse o geçerli kalır).
 * Kurulmuş şablonun kimliğini döner.
 */
export const ensureStandardTemplate = async (tenantId: string, documentType: StandardDocumentType): Promise<string> => {
    const rows = await (prisma as any).supplierOrderTemplate.findMany({
        where: { tenantId, documentType, config: { contains: '"stdProduct"' } },
        select: { id: true, config: true },
        take: 1,
    });
    if (rows.length) {
        if (documentType === 'PRICE_REQUEST') {
            /* 29.09.2026: die Preisspalten, die der 28.09. an die Standardvorlage der
               Preisanfrage hängte, gehen wieder heraus, und das Modell kommt nach dem
               Produkt dazu. Eigene Spalten und eigene Namen bleiben, wie sie sind. */
            let config: { columns?: Array<Partial<StandardColumn>> } = {};
            try { config = JSON.parse(rows[0].config || '{}'); } catch { /* unlesbar — so lassen */ }
            const columns = Array.isArray(config.columns) ? config.columns : [];
            const next = columns.filter((column) => !REQUEST_PRICE_KEYS.has(String(column?.key ?? '')));
            if (!next.some((column) => column?.key === STANDARD_MODEL_COLUMN.key)) {
                const product = next.findIndex((column) => column?.key === 'stdProduct');
                next.splice(product + 1, 0, STANDARD_MODEL_COLUMN);
            }
            if (columns.length && JSON.stringify(next) !== JSON.stringify(columns)) {
                await (prisma as any).supplierOrderTemplate.update({
                    where: { id: rows[0].id },
                    data: { config: JSON.stringify({ ...config, columns: next }) },
                });
            }
        }
        ensured.add(`${tenantId}:${documentType}`);
        return rows[0].id as string;
    }
    const id = nanoid(12);
    await (prisma as any).supplierOrderTemplate.updateMany({
        where: { tenantId, documentType, isDefault: true },
        data: { isDefault: false },
    });
    await (prisma as any).supplierOrderTemplate.create({
        data: {
            id,
            tenantId,
            supplierId: null,
            supplierName: '',
            title: STANDARD_TEMPLATE_TITLE,
            documentType,
            isDefault: true,
            config: JSON.stringify({ columns: standardColumnsOf(documentType) }),
            createdBy: null,
        },
    });
    ensured.add(`${tenantId}:${documentType}`);
    return id;
};

/** Liste açılırken ucuz yol: bu süreçte bir kez kurulduysa sorgu atılmaz. */
export const ensureStandardTemplateOnce = async (tenantId: string, documentType: StandardDocumentType): Promise<void> => {
    if (ensured.has(`${tenantId}:${documentType}`)) return;
    await ensureStandardTemplate(tenantId, documentType);
};
