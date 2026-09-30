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
    label: 'productName' | 'quantity' | 'grossPrice' | 'netPrice' | 'total' | null;
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
