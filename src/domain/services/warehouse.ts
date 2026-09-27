import {
    WAREHOUSE_CURRENCIES,
    type WarehouseCurrency,
    type WarehouseProduct,
    type WarehouseProductFields,
    type WarehouseSortKey,
    type WarehouseSupplierEntry,
} from '../entities/Warehouse';

/**
 * ── DIE REGELN DES DEPOS (26.09.2026) ───────────────────────────────────────
 *
 * Reine Funktionen, ohne Datenbank: was eine Produktkarte an Feldern annimmt,
 * wie ein gescannter Code bereinigt wird und wie die Liste sortiert und
 * blättert. Die Anwendungsschicht liest, ruft diese Regeln auf und schreibt.
 *
 * Fehler tragen eine feste Kennung (`code`) — der Server kennt die Sprache
 * des Nutzers nicht, die Oberfläche übersetzt sie (`warehouse.err.*`).
 */

/* ═══════════════════════════════════════════════════════════════════════════
   0) FEHLER MIT KENNUNG
   ═════════════════════════════════════════════════════════════════════════ */

export type WarehouseErrorCode =
    | 'NOT_FOUND'
    | 'SERIAL_NOT_FOUND'
    | 'GROUP_NOT_FOUND'
    | 'PROJECT_NOT_FOUND'
    | 'DEVICE_NOT_IN_PROJECT'
    | 'NOT_PRODUCTION_COMPANY'
    | 'MODULE_DISABLED'
    | 'NAME_REQUIRED'
    | 'FIELD_TOO_LONG'
    | 'QUANTITY_INVALID'
    | 'PRICE_INVALID'
    | 'MIN_ORDER_INVALID'
    | 'CURRENCY_INVALID'
    | 'ERP_CODE_TAKEN'
    | 'BARCODE_TAKEN'
    | 'SERIAL_EMPTY'
    | 'SERIAL_TAKEN'
    | 'SERIAL_DUPLICATE_INPUT'
    | 'SERIALS_DISABLED'
    | 'QUANTITY_SERIAL_MANAGED'
    | 'RECEIVE_INVALID'
    | 'GROUP_NAME_REQUIRED'
    | 'GROUP_IN_USE'
    | 'CODE_REQUIRED'
    // Zweiter Durchgang (26.09.2026): Kategorien, Kürzel, Codes, Etikett, Aktarım.
    | 'CATEGORY_NOT_FOUND'
    | 'CATEGORY_NAME_REQUIRED'
    | 'CATEGORY_NAME_TAKEN'
    | 'CATEGORY_CODE_INVALID'
    | 'CATEGORY_CODE_TAKEN'
    | 'CATEGORY_CODE_LOCKED'
    | 'CATEGORY_IN_USE'
    | 'GROUP_NAME_TAKEN'
    | 'GROUP_CODE_INVALID'
    | 'GROUP_CODE_TAKEN'
    | 'GROUP_CODE_LOCKED'
    | 'GROUP_CODE_MISSING'
    | 'BARCODE_RANGE_EXHAUSTED'
    | 'QUANTITY_BELOW_ZERO'
    | 'LABEL_SIZE_INVALID'
    | 'IMPORT_EMPTY'
    | 'IMPORT_TOO_MANY_ROWS'
    | 'IMPORT_NOT_FOUND'
    | 'IMPORT_NOT_PENDING'
    | 'IMPORT_NOTHING_VALID'
    | 'IMPORT_FORBIDDEN'
    // Dritter Durchgang (26.09.2026): mehrere Lieferanten, Herstellerbarcode eindeutig.
    // Vierter: SUPPLIER_NAME_REQUIRED = ein Barcode ohne Lieferanten in der Liste.
    | 'SUPPLIER_NAME_REQUIRED'
    | 'SUPPLIER_DUPLICATE'
    | 'TOO_MANY_SUPPLIERS'
    | 'MANUFACTURER_BARCODE_TAKEN';

export type WarehouseError = Error & {
    code: WarehouseErrorCode;
    status: number;
    params?: Record<string, string | number> | undefined;
    details?: unknown;
};

export const warehouseError = (
    code: WarehouseErrorCode,
    message: string,
    options: { status?: number; params?: Record<string, string | number>; details?: unknown } = {},
): WarehouseError =>
    Object.assign(new Error(message), {
        code,
        status: options.status ?? 400,
        params: options.params,
        details: options.details,
    });

export const isWarehouseError = (error: unknown): error is WarehouseError =>
    Boolean(error)
    && typeof (error as WarehouseError).code === 'string'
    && typeof (error as WarehouseError).status === 'number'
    && error instanceof Error;

/** Antwortkörper eines Fehlers — Kennung und Werte reisen mit. */
export const warehouseErrorBody = (error: unknown) => {
    const e = error as Partial<WarehouseError> | null;
    return {
        error: e?.message || 'Error',
        ...(e?.code ? { code: e.code } : {}),
        ...(e?.params ? { params: e.params } : {}),
        ...(e?.details !== undefined ? { details: e.details } : {}),
    };
};

/* ═══════════════════════════════════════════════════════════════════════════
   1) FELDER DER PRODUKTKARTE
   ═════════════════════════════════════════════════════════════════════════ */

/** Die Längen der Spalten (prisma/schema/warehouse.prisma). */
export const WAREHOUSE_LIMITS = {
    erpCode: 64,
    name: 255,
    brand: 120,
    modelNumber: 120,
    supplierName: 191,
    description: 20_000,
    barcode: 128,
    /** Auch der Barcode je Lieferant. */
    manufacturerBarcode: 128,
    serialNumber: 128,
    groupName: 120,
    categoryName: 120,
    /** Lieferanten je Karte. */
    suppliers: 20,
} as const;

/** DECIMAL(14,3) bzw. DECIMAL(14,4) — mit Luft nach unten. */
const MAX_QUANTITY = 99_999_999_999;
const MAX_PRICE = 9_999_999_999;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const tooLong = (field: string, max: number) =>
    warehouseError('FIELD_TOO_LONG', `Das Feld «${field}» ist zu lang (höchstens ${max} Zeichen).`, {
        params: { field, max },
    });

/** Einzeiliger Text: Steuerzeichen weg, Leerraum zusammengezogen; leer = null. */
export const cleanLine = (raw: unknown, field: string, max: number): string | null => {
    if (raw === null || raw === undefined) return null;
    const value = String(raw).replace(CONTROL_CHARS, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!value) return null;
    if (value.length > max) throw tooLong(field, max);
    return value;
};

/**
 * Ein gescannter oder getippter CODE (Barcode, ERP-Code, Seriennummer).
 * Handscanner hängen gern ein Enter oder einen Tabulator an, Kameras lesen
 * manchmal ein Steuerzeichen mit — beides fällt weg, Leerraum innen auch.
 */
export const cleanCode = (raw: unknown, field: string, max: number): string | null => {
    if (raw === null || raw === undefined) return null;
    const value = String(raw).replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
    if (!value) return null;
    if (value.length > max) throw tooLong(field, max);
    return value;
};

/** Mehrzeiliger Text (Beschreibung): Zeilen bleiben, Steuerzeichen nicht. */
export const cleanText = (raw: unknown, field: string, max: number): string | null => {
    if (raw === null || raw === undefined) return null;
    const value = String(raw).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
    if (!value) return null;
    if (value.length > max) throw tooLong(field, max);
    return value;
};

/** Zahl aus Eingabe — «12,5», «1'200.50» und 12.5 werden verstanden. */
const parseNumber = (raw: unknown): number | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : Number.NaN;
    const text = String(raw).trim().replace(/['’\s]/g, '');
    if (!text) return null;
    // «1.234,5» (Komma als Dezimalzeichen) und «1234,5» → Punkt.
    const normalized = /,\d{1,4}$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
    const value = Number(normalized);
    return Number.isFinite(value) ? value : Number.NaN;
};

export const parseQuantity = (raw: unknown): number => {
    const value = parseNumber(raw);
    if (value === null) return 0;
    if (!Number.isFinite(value) || value < 0 || value > MAX_QUANTITY) {
        throw warehouseError('QUANTITY_INVALID', 'Die Menge muss eine Zahl ab 0 sein.');
    }
    return Math.round(value * 1000) / 1000;
};

export const parsePrice = (raw: unknown): number | null => {
    const value = parseNumber(raw);
    if (value === null) return null;
    if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
        throw warehouseError('PRICE_INVALID', 'Der Einkaufspreis muss eine Zahl ab 0 sein.');
    }
    return Math.round(value * 10_000) / 10_000;
};

/**
 * Mindestbestellmenge (BOM, 27.09.2026: «ürün detayında minimum alış olmalı»).
 * Leer oder 0 = keine Untergrenze.
 */
export const parseMinimumOrderQuantity = (raw: unknown): number | null => {
    const value = parseNumber(raw);
    if (value === null || value === 0) return null;
    if (!Number.isFinite(value) || value < 0 || value > MAX_QUANTITY) {
        throw warehouseError('MIN_ORDER_INVALID', 'Die Mindestbestellmenge muss eine Zahl ab 0 sein.');
    }
    return Math.round(value * 1000) / 1000;
};

export const parseCurrency = (raw: unknown): WarehouseCurrency | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    const value = String(raw).trim().toUpperCase();
    if (!(WAREHOUSE_CURRENCIES as readonly string[]).includes(value)) {
        throw warehouseError('CURRENCY_INVALID', 'Unbekannte Währung.', { params: { currency: value.slice(0, 8) } });
    }
    return value as WarehouseCurrency;
};

const has = (input: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(input, key);

/** Die Felder, die aus einer Karte für die Prüfung gebraucht werden. */
export const fieldsOfProduct = (product: WarehouseProduct): WarehouseProductFields => ({
    erpCode: product.erpCode,
    materialGroupId: product.materialGroupId,
    name: product.name,
    brand: product.brand,
    modelNumber: product.modelNumber,
    suppliers: product.suppliers.map((entry) => ({ ...entry })),
    description: product.description,
    quantity: product.quantity,
    purchasePrice: product.purchasePrice,
    minimumOrderQuantity: product.minimumOrderQuantity,
    currency: (product.currency as WarehouseCurrency | null) ?? null,
    barcode: product.barcode,
    manufacturerBarcode: product.manufacturerBarcode,
    serialRequired: product.serialRequired,
});

const EMPTY_FIELDS: WarehouseProductFields = {
    erpCode: null,
    materialGroupId: null,
    name: '',
    brand: null,
    modelNumber: null,
    suppliers: [],
    description: null,
    quantity: 0,
    purchasePrice: null,
    minimumOrderQuantity: null,
    currency: null,
    barcode: null,
    manufacturerBarcode: null,
    serialRequired: false,
};

/**
 * Die Lieferanten einer Karte aus der Eingabe: `[{ supplierId?, name, barcode? }]`.
 * Leere Zeilen fallen weg; ein Barcode ohne Lieferanten ist hier ein Fehler
 * (der Barcode, dessen Lieferant noch fehlt, reist als `manufacturerBarcode`
 * der Karte); derselbe Lieferant zweimal (ohne Gross/Klein) auch. Höchstens 20.
 */
export const suppliersFromInput = (raw: unknown): WarehouseSupplierEntry[] => {
    const list = Array.isArray(raw) ? raw : [];
    const L = WAREHOUSE_LIMITS;
    const entries: WarehouseSupplierEntry[] = [];
    for (const item of list) {
        const input = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const name = cleanLine(input.name ?? input.supplierName, 'supplierName', L.supplierName);
        // Bis zum vierten Durchgang hiess das Feld «number» (Produktnummer des Lieferanten).
        const barcode = cleanCode(input.barcode ?? input.number ?? input.supplierNumber, 'barcode', L.manufacturerBarcode);
        if (!name) {
            if (barcode) throw warehouseError('SUPPLIER_NAME_REQUIRED', 'Zu einem Barcode fehlt der Lieferant.', { params: { code: barcode } });
            continue;
        }
        const idRaw = input.supplierId ?? input.id;
        const supplierId = idRaw === null || idRaw === undefined ? null : String(idRaw).trim().slice(0, 191) || null;
        entries.push({ supplierId, name, barcode });
    }
    if (entries.length > L.suppliers) {
        throw warehouseError('TOO_MANY_SUPPLIERS', 'Zu viele Lieferanten auf einer Karte.', { params: { max: L.suppliers } });
    }
    assertSuppliersUnique(entries);
    return entries;
};

/**
 * Alle Herstellerbarcodes einer Karte: der ohne Lieferant und die der
 * Lieferanten — jeder nur einmal (ohne Gross/Klein). Jeder gehört genau
 * dieser Karte (vierter Durchgang: «üretici barkodlarını her tedarikçiye
 * özel olarak»).
 */
export const makerBarcodesOf = (fields: Pick<WarehouseProductFields, 'manufacturerBarcode' | 'suppliers'>): string[] => {
    const seen = new Set<string>();
    const codes: string[] = [];
    for (const code of [fields.manufacturerBarcode, ...fields.suppliers.map((entry) => entry.barcode)]) {
        if (!code) continue;
        const key = code.toLocaleLowerCase('de-CH');
        if (seen.has(key)) continue;
        seen.add(key);
        codes.push(code);
    }
    return codes;
};

/** Derselbe Lieferant zweimal auf einer Karte (nach Namen, ohne Gross/Klein, oder nach Kennung). */
export const assertSuppliersUnique = (entries: WarehouseSupplierEntry[]): void => {
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const entry of entries) {
        const key = entry.name.trim().toLocaleLowerCase('tr-TR');
        if (names.has(key) || (entry.supplierId && ids.has(entry.supplierId))) {
            throw warehouseError('SUPPLIER_DUPLICATE', 'Dieser Lieferant steht schon auf der Karte.', { params: { name: entry.name } });
        }
        names.add(key);
        if (entry.supplierId) ids.add(entry.supplierId);
    }
};

/**
 * Die Eingabe einer Karte prüfen. Ohne `base` ist es eine NEUE Karte (fehlende
 * Felder bleiben leer), mit `base` eine Änderung: nur mitgeschickte Felder
 * zählen. Pflicht ist allein der Name (Vorgabe: «sadece ürün adı zorunlu»).
 *
 * ERP-Code und unser Barcode kommen seit dem zweiten Durchgang vom System
 * (siehe warehouseCodes.ts): mitgeschickte Werte zählen nicht, die Karte
 * behält, was sie hat.
 *
 * Lieferanten: seit dem dritten Durchgang eine Liste (`suppliers`), seit dem
 * vierten jeder mit seinem Barcode des Produkts; die ältere Einzelform
 * (supplierName/…) wird noch verstanden.
 */
export const productFieldsFromInput = (
    raw: unknown,
    base?: WarehouseProductFields,
): WarehouseProductFields => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const next: WarehouseProductFields = { ...(base ?? EMPTY_FIELDS) };
    const L = WAREHOUSE_LIMITS;

    if (has(input, 'materialGroupId')) {
        const id = input.materialGroupId === null ? null : String(input.materialGroupId ?? '').trim();
        next.materialGroupId = id || null;
    }
    if (has(input, 'name') || !base) next.name = cleanLine(input.name, 'name', L.name) ?? '';
    if (has(input, 'brand')) next.brand = cleanLine(input.brand, 'brand', L.brand);
    if (has(input, 'modelNumber')) next.modelNumber = cleanLine(input.modelNumber, 'modelNumber', L.modelNumber);
    if (has(input, 'suppliers')) {
        next.suppliers = suppliersFromInput(input.suppliers);
    } else if (has(input, 'supplierName') || has(input, 'supplierId') || has(input, 'supplierBarcode')) {
        // Die ältere Form mit genau einem Lieferanten (alte Aufrufer).
        next.suppliers = suppliersFromInput([{
            supplierId: input.supplierId,
            name: input.supplierName,
            barcode: input.supplierBarcode,
        }]);
    }
    if (has(input, 'description')) next.description = cleanText(input.description, 'description', L.description);
    if (has(input, 'quantity')) next.quantity = parseQuantity(input.quantity);
    if (has(input, 'purchasePrice')) next.purchasePrice = parsePrice(input.purchasePrice);
    if (has(input, 'minimumOrderQuantity')) next.minimumOrderQuantity = parseMinimumOrderQuantity(input.minimumOrderQuantity);
    if (has(input, 'currency')) next.currency = parseCurrency(input.currency);
    if (has(input, 'manufacturerBarcode')) {
        next.manufacturerBarcode = cleanCode(input.manufacturerBarcode, 'manufacturerBarcode', L.manufacturerBarcode);
    }
    if (has(input, 'serialRequired')) next.serialRequired = input.serialRequired === true || input.serialRequired === 'true';

    if (!next.name) throw warehouseError('NAME_REQUIRED', 'Der Produktname ist Pflicht.', { params: { field: 'name' } });
    // Ein Preis ohne Währung liest sich wie Franken — so wird er auch gespeichert.
    if (next.purchasePrice !== null && !next.currency) next.currency = 'CHF';
    return next;
};

/** Eine Seriennummer aus der Eingabe (Scan oder Tastatur). */
export const serialFromInput = (raw: unknown): string => {
    const value = cleanCode(raw, 'serialNumber', WAREHOUSE_LIMITS.serialNumber);
    if (!value) throw warehouseError('SERIAL_EMPTY', 'Die Seriennummer ist leer.');
    return value;
};

/** Gleiche Seriennummer zweimal in EINER Eingabe (die Datenbank vergleicht ohne Gross/Klein). */
export const firstDuplicate = (values: string[]): string | null => {
    const seen = new Set<string>();
    for (const value of values) {
        const key = value.toLocaleLowerCase('de-CH');
        if (seen.has(key)) return value;
        seen.add(key);
    }
    return null;
};

/* ═══════════════════════════════════════════════════════════════════════════
   2) DIE LISTE: SUCHE, GRUPPEN, SORTIERUNG, SEITEN
   ═════════════════════════════════════════════════════════════════════════ */

const SORT_KEYS: readonly WarehouseSortKey[] = [
    'erpCode', 'name', 'brand', 'modelNumber', 'supplierName', 'description', 'quantity', 'barcode', 'updatedAt',
];

export const sortKeyFrom = (raw: unknown): WarehouseSortKey =>
    (SORT_KEYS as readonly string[]).includes(String(raw)) ? String(raw) as WarehouseSortKey : 'name';

export const directionFrom = (raw: unknown, sort: WarehouseSortKey): 'asc' | 'desc' => {
    const value = String(raw ?? '').toLowerCase();
    if (value === 'asc' || value === 'desc') return value;
    return sort === 'updatedAt' ? 'desc' : 'asc';
};

export const WAREHOUSE_PAGE_SIZE = 50;
export const WAREHOUSE_MAX_PAGE_SIZE = 200;

export const pageFrom = (raw: unknown): number => {
    const value = Math.trunc(Number(raw));
    return Number.isFinite(value) && value >= 1 ? Math.min(value, 100_000) : 1;
};

export const pageSizeFrom = (raw: unknown): number => {
    const value = Math.trunc(Number(raw));
    if (!Number.isFinite(value) || value < 1) return WAREHOUSE_PAGE_SIZE;
    return Math.min(value, WAREHOUSE_MAX_PAGE_SIZE);
};

/** Die Kennung, die in der Gruppenauswahl «ohne Gruppe» bedeutet. */
export const NO_GROUP_TOKEN = 'none';

/** «a,b,none» → ['a', 'b', null]; höchstens 50 Gruppen. */
export const groupIdsFrom = (raw: unknown): Array<string | null> | undefined => {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
        .map((part) => String(part).trim())
        .filter(Boolean)
        .slice(0, 50);
    if (!parts.length) return undefined;
    return [...new Set(parts)].map((part) => (part === NO_GROUP_TOKEN ? null : part));
};

/** Suchtext der Liste: getrimmt, höchstens 120 Zeichen. */
export const searchFrom = (raw: unknown): string | undefined => {
    const value = cleanLine(typeof raw === 'string' ? raw.slice(0, 200) : raw, 'search', 200);
    return value ? value.slice(0, 120) : undefined;
};
