"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchFrom = exports.groupIdsFrom = exports.NO_GROUP_TOKEN = exports.pageSizeFrom = exports.pageFrom = exports.WAREHOUSE_MAX_PAGE_SIZE = exports.WAREHOUSE_PAGE_SIZE = exports.directionFrom = exports.sortKeyFrom = exports.firstDuplicate = exports.serialFromInput = exports.productFieldsFromInput = exports.assertSuppliersUnique = exports.makerBarcodesOf = exports.suppliersFromInput = exports.fieldsOfProduct = exports.draftRequestOf = exports.draftStateOf = exports.missingForComplete = exports.parseSupplierEmail = exports.parseUnit = exports.parseCurrency = exports.parseMinimumOrderQuantity = exports.parsePrice = exports.parseQuantity = exports.cleanText = exports.cleanCode = exports.cleanLine = exports.WAREHOUSE_LIMITS = exports.warehouseErrorBody = exports.isWarehouseError = exports.warehouseError = void 0;
const Warehouse_1 = require("../entities/Warehouse");
const warehouseError = (code, message, options = {}) => Object.assign(new Error(message), {
    code,
    status: options.status ?? 400,
    params: options.params,
    details: options.details,
});
exports.warehouseError = warehouseError;
const isWarehouseError = (error) => Boolean(error)
    && typeof error.code === 'string'
    && typeof error.status === 'number'
    && error instanceof Error;
exports.isWarehouseError = isWarehouseError;
/** Antwortkörper eines Fehlers — Kennung und Werte reisen mit. */
const warehouseErrorBody = (error) => {
    const e = error;
    return {
        error: e?.message || 'Error',
        ...(e?.code ? { code: e.code } : {}),
        ...(e?.params ? { params: e.params } : {}),
        ...(e?.details !== undefined ? { details: e.details } : {}),
    };
};
exports.warehouseErrorBody = warehouseErrorBody;
/* ═══════════════════════════════════════════════════════════════════════════
   1) FELDER DER PRODUKTKARTE
   ═════════════════════════════════════════════════════════════════════════ */
/** Die Längen der Spalten (prisma/schema/warehouse.prisma). */
exports.WAREHOUSE_LIMITS = {
    erpCode: 64,
    name: 255,
    brand: 120,
    modelNumber: 120,
    productCode: 120,
    supplierName: 191,
    supplierEmail: 191,
    description: 20_000,
    barcode: 128,
    /** Auch der Barcode je Lieferant. */
    manufacturerBarcode: 128,
    serialNumber: 128,
    groupName: 120,
    categoryName: 120,
    /** Lieferanten je Karte. */
    suppliers: 20,
};
/** DECIMAL(14,3) bzw. DECIMAL(14,4) — mit Luft nach unten. */
const MAX_QUANTITY = 99_999_999_999;
const MAX_PRICE = 9_999_999_999;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const tooLong = (field, max) => (0, exports.warehouseError)('FIELD_TOO_LONG', `Das Feld «${field}» ist zu lang (höchstens ${max} Zeichen).`, {
    params: { field, max },
});
/** Einzeiliger Text: Steuerzeichen weg, Leerraum zusammengezogen; leer = null. */
const cleanLine = (raw, field, max) => {
    if (raw === null || raw === undefined)
        return null;
    const value = String(raw).replace(CONTROL_CHARS, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!value)
        return null;
    if (value.length > max)
        throw tooLong(field, max);
    return value;
};
exports.cleanLine = cleanLine;
/**
 * Ein gescannter oder getippter CODE (Barcode, ERP-Code, Seriennummer).
 * Handscanner hängen gern ein Enter oder einen Tabulator an, Kameras lesen
 * manchmal ein Steuerzeichen mit — beides fällt weg, Leerraum innen auch.
 */
const cleanCode = (raw, field, max) => {
    if (raw === null || raw === undefined)
        return null;
    const value = String(raw).replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
    if (!value)
        return null;
    if (value.length > max)
        throw tooLong(field, max);
    return value;
};
exports.cleanCode = cleanCode;
/** Mehrzeiliger Text (Beschreibung): Zeilen bleiben, Steuerzeichen nicht. */
const cleanText = (raw, field, max) => {
    if (raw === null || raw === undefined)
        return null;
    const value = String(raw).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
    if (!value)
        return null;
    if (value.length > max)
        throw tooLong(field, max);
    return value;
};
exports.cleanText = cleanText;
/** Zahl aus Eingabe — «12,5», «1'200.50» und 12.5 werden verstanden. */
const parseNumber = (raw) => {
    if (raw === null || raw === undefined || raw === '')
        return null;
    if (typeof raw === 'number')
        return Number.isFinite(raw) ? raw : Number.NaN;
    const text = String(raw).trim().replace(/['’\s]/g, '');
    if (!text)
        return null;
    // «1.234,5» (Komma als Dezimalzeichen) und «1234,5» → Punkt.
    const normalized = /,\d{1,4}$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
    const value = Number(normalized);
    return Number.isFinite(value) ? value : Number.NaN;
};
const parseQuantity = (raw) => {
    const value = parseNumber(raw);
    if (value === null)
        return 0;
    if (!Number.isFinite(value) || value < 0 || value > MAX_QUANTITY) {
        throw (0, exports.warehouseError)('QUANTITY_INVALID', 'Die Menge muss eine Zahl ab 0 sein.');
    }
    return Math.round(value * 1000) / 1000;
};
exports.parseQuantity = parseQuantity;
const parsePrice = (raw) => {
    const value = parseNumber(raw);
    if (value === null)
        return null;
    if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE) {
        throw (0, exports.warehouseError)('PRICE_INVALID', 'Der Einkaufspreis muss eine Zahl ab 0 sein.');
    }
    return Math.round(value * 10_000) / 10_000;
};
exports.parsePrice = parsePrice;
/**
 * Mindestbestellmenge (BOM, 27.09.2026: «ürün detayında minimum alış olmalı»).
 * Leer oder 0 = keine Untergrenze.
 */
const parseMinimumOrderQuantity = (raw) => {
    const value = parseNumber(raw);
    if (value === null || value === 0)
        return null;
    if (!Number.isFinite(value) || value < 0 || value > MAX_QUANTITY) {
        throw (0, exports.warehouseError)('MIN_ORDER_INVALID', 'Die Mindestbestellmenge muss eine Zahl ab 0 sein.');
    }
    return Math.round(value * 1000) / 1000;
};
exports.parseMinimumOrderQuantity = parseMinimumOrderQuantity;
const parseCurrency = (raw) => {
    if (raw === null || raw === undefined || raw === '')
        return null;
    const value = String(raw).trim().toUpperCase();
    if (!Warehouse_1.WAREHOUSE_CURRENCIES.includes(value)) {
        throw (0, exports.warehouseError)('CURRENCY_INVALID', 'Unbekannte Währung.', { params: { currency: value.slice(0, 8) } });
    }
    return value;
};
exports.parseCurrency = parseCurrency;
/** Die Wörter, mit denen eine Einheit getippt oder importiert wird (drei Sprachen). */
const UNIT_ALIASES = {
    PCS: 'PCS', PC: 'PCS', STK: 'PCS', 'STK.': 'PCS', STÜCK: 'PCS', STUECK: 'PCS', ADET: 'PCS', AD: 'PCS', PIECE: 'PCS', PIECES: 'PCS', EA: 'PCS',
    M: 'M', MT: 'M', METER: 'M', METRE: 'M', LFM: 'M',
    KG: 'KG', KILO: 'KG', KILOGRAMM: 'KG', KILOGRAM: 'KG',
    SET: 'SET', SATZ: 'SET', TAKIM: 'SET',
    PACK: 'PACK', PAKET: 'PACK', PACKUNG: 'PACK', PKG: 'PACK', PCK: 'PACK',
};
/**
 * Die Einheit einer Karte (30.09.2026): PCS | M | KG | SET | PACK — auch
 * «Adet», «Stk», «m», «Paket» … werden verstanden. Leer = keine.
 */
const parseUnit = (raw) => {
    if (raw === null || raw === undefined)
        return null;
    const value = String(raw).trim().toLocaleUpperCase('de-CH');
    if (!value)
        return null;
    if (Warehouse_1.WAREHOUSE_UNITS.includes(value))
        return value;
    const alias = UNIT_ALIASES[value] ?? UNIT_ALIASES[value.replace(/\.$/, '')];
    if (alias)
        return alias;
    throw (0, exports.warehouseError)('UNIT_INVALID', 'Unbekannte Einheit.', { params: { unit: value.slice(0, 12) } });
};
exports.parseUnit = parseUnit;
/** Eine E-Mail-Adresse, wie sie in einen Kopf einer Mail darf — sonst ein Fehler mit dem Lieferanten. */
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
const parseSupplierEmail = (raw, supplierName) => {
    const value = (0, exports.cleanCode)(raw, 'supplierEmail', exports.WAREHOUSE_LIMITS.supplierEmail);
    if (!value)
        return null;
    const email = value.replace(/^mailto:/i, '').trim();
    if (!EMAIL_RE.test(email)) {
        throw (0, exports.warehouseError)('SUPPLIER_EMAIL_INVALID', 'Die E-Mail des Lieferanten ist ungültig.', { params: { name: supplierName, email: email.slice(0, 80) } });
    }
    return email;
};
exports.parseSupplierEmail = parseSupplierEmail;
const missingForComplete = (fields) => {
    const missing = [];
    if (!fields.name.trim())
        missing.push('name');
    if (!fields.unit)
        missing.push('unit');
    if (!fields.suppliers.length)
        missing.push('supplier');
    if (!fields.suppliers.some((entry) => Boolean(entry.email)))
        missing.push('supplierEmail');
    return missing;
};
exports.missingForComplete = missingForComplete;
/**
 * Taslak oder fertig? `requested` = was die Eingabe ausdrücklich will:
 *   false  «Kaydet» — nur mit allen Pflichtangaben, sonst PRODUCT_INCOMPLETE
 *   true   «Taslak olarak kaydet» — immer
 *   undefined (Scan, Excel, BOM-Schnellkarte, alte Aufrufer) — eine
 *          unvollständige Karte wird Taslak, eine Taslak bleibt es.
 */
const draftStateOf = (fields, requested, current) => {
    const missing = (0, exports.missingForComplete)(fields);
    if (requested === true)
        return true;
    if (requested === false) {
        if (missing.length) {
            throw (0, exports.warehouseError)('PRODUCT_INCOMPLETE', 'Für eine fertige Karte fehlen Angaben — als Taslak speichern.', {
                params: { missing: missing.join(',') },
            });
        }
        return false;
    }
    return Boolean(current) || missing.length > 0;
};
exports.draftStateOf = draftStateOf;
/** `isDraft` der Eingabe: true · false · (nicht angegeben) undefined. */
const draftRequestOf = (raw) => {
    const value = (raw && typeof raw === 'object' ? raw.isDraft : undefined);
    if (value === true || value === 'true')
        return true;
    if (value === false || value === 'false')
        return false;
    return undefined;
};
exports.draftRequestOf = draftRequestOf;
const has = (input, key) => Object.prototype.hasOwnProperty.call(input, key);
/** Die Felder, die aus einer Karte für die Prüfung gebraucht werden. */
const fieldsOfProduct = (product) => ({
    erpCode: product.erpCode,
    materialGroupId: product.materialGroupId,
    name: product.name,
    brand: product.brand,
    modelNumber: product.modelNumber,
    productCode: product.productCode,
    unit: product.unit,
    suppliers: product.suppliers.map((entry) => ({ ...entry })),
    description: product.description,
    quantity: product.quantity,
    purchasePrice: product.purchasePrice,
    minimumOrderQuantity: product.minimumOrderQuantity,
    currency: product.currency ?? null,
    barcode: product.barcode,
    manufacturerBarcode: product.manufacturerBarcode,
    serialRequired: product.serialRequired,
    isDraft: product.isDraft,
});
exports.fieldsOfProduct = fieldsOfProduct;
const EMPTY_FIELDS = {
    erpCode: null,
    materialGroupId: null,
    name: '',
    brand: null,
    modelNumber: null,
    productCode: null,
    unit: null,
    suppliers: [],
    description: null,
    quantity: 0,
    purchasePrice: null,
    minimumOrderQuantity: null,
    currency: null,
    barcode: null,
    manufacturerBarcode: null,
    serialRequired: false,
    isDraft: false,
};
/**
 * Die Lieferanten einer Karte aus der Eingabe: `[{ supplierId?, name, barcode? }]`.
 * Leere Zeilen fallen weg; ein Barcode ohne Lieferanten ist hier ein Fehler
 * (der Barcode, dessen Lieferant noch fehlt, reist als `manufacturerBarcode`
 * der Karte); derselbe Lieferant zweimal (ohne Gross/Klein) auch. Höchstens 20.
 */
const suppliersFromInput = (raw) => {
    const list = Array.isArray(raw) ? raw : [];
    const L = exports.WAREHOUSE_LIMITS;
    const entries = [];
    for (const item of list) {
        const input = (item && typeof item === 'object' ? item : {});
        const name = (0, exports.cleanLine)(input.name ?? input.supplierName, 'supplierName', L.supplierName);
        // Bis zum vierten Durchgang hiess das Feld «number» (Produktnummer des Lieferanten).
        const barcode = (0, exports.cleanCode)(input.barcode ?? input.number ?? input.supplierNumber, 'barcode', L.manufacturerBarcode);
        if (!name) {
            if (barcode)
                throw (0, exports.warehouseError)('SUPPLIER_NAME_REQUIRED', 'Zu einem Barcode fehlt der Lieferant.', { params: { code: barcode } });
            continue;
        }
        const idRaw = input.supplierId ?? input.id;
        const supplierId = idRaw === null || idRaw === undefined ? null : String(idRaw).trim().slice(0, 191) || null;
        entries.push({ supplierId, name, barcode, email: (0, exports.parseSupplierEmail)(input.email, name) });
    }
    if (entries.length > L.suppliers) {
        throw (0, exports.warehouseError)('TOO_MANY_SUPPLIERS', 'Zu viele Lieferanten auf einer Karte.', { params: { max: L.suppliers } });
    }
    (0, exports.assertSuppliersUnique)(entries);
    return entries;
};
exports.suppliersFromInput = suppliersFromInput;
/**
 * Alle Herstellerbarcodes einer Karte: der ohne Lieferant und die der
 * Lieferanten — jeder nur einmal (ohne Gross/Klein). Jeder gehört genau
 * dieser Karte (vierter Durchgang: «üretici barkodlarını her tedarikçiye
 * özel olarak»).
 */
const makerBarcodesOf = (fields) => {
    const seen = new Set();
    const codes = [];
    for (const code of [fields.manufacturerBarcode, ...fields.suppliers.map((entry) => entry.barcode)]) {
        if (!code)
            continue;
        const key = code.toLocaleLowerCase('de-CH');
        if (seen.has(key))
            continue;
        seen.add(key);
        codes.push(code);
    }
    return codes;
};
exports.makerBarcodesOf = makerBarcodesOf;
/** Derselbe Lieferant zweimal auf einer Karte (nach Namen, ohne Gross/Klein, oder nach Kennung). */
const assertSuppliersUnique = (entries) => {
    const names = new Set();
    const ids = new Set();
    for (const entry of entries) {
        const key = entry.name.trim().toLocaleLowerCase('tr-TR');
        if (names.has(key) || (entry.supplierId && ids.has(entry.supplierId))) {
            throw (0, exports.warehouseError)('SUPPLIER_DUPLICATE', 'Dieser Lieferant steht schon auf der Karte.', { params: { name: entry.name } });
        }
        names.add(key);
        if (entry.supplierId)
            ids.add(entry.supplierId);
    }
};
exports.assertSuppliersUnique = assertSuppliersUnique;
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
const productFieldsFromInput = (raw, base) => {
    const input = (raw && typeof raw === 'object' ? raw : {});
    const next = { ...(base ?? EMPTY_FIELDS) };
    const L = exports.WAREHOUSE_LIMITS;
    if (has(input, 'materialGroupId')) {
        const id = input.materialGroupId === null ? null : String(input.materialGroupId ?? '').trim();
        next.materialGroupId = id || null;
    }
    if (has(input, 'name') || !base)
        next.name = (0, exports.cleanLine)(input.name, 'name', L.name) ?? '';
    if (has(input, 'brand'))
        next.brand = (0, exports.cleanLine)(input.brand, 'brand', L.brand);
    if (has(input, 'modelNumber'))
        next.modelNumber = (0, exports.cleanLine)(input.modelNumber, 'modelNumber', L.modelNumber);
    if (has(input, 'productCode'))
        next.productCode = (0, exports.cleanCode)(input.productCode, 'productCode', L.productCode);
    if (has(input, 'unit'))
        next.unit = (0, exports.parseUnit)(input.unit);
    if (has(input, 'suppliers')) {
        next.suppliers = (0, exports.suppliersFromInput)(input.suppliers);
    }
    else if (has(input, 'supplierName') || has(input, 'supplierId') || has(input, 'supplierBarcode')) {
        // Die ältere Form mit genau einem Lieferanten (alte Aufrufer).
        next.suppliers = (0, exports.suppliersFromInput)([{
                supplierId: input.supplierId,
                name: input.supplierName,
                barcode: input.supplierBarcode,
            }]);
    }
    if (has(input, 'description'))
        next.description = (0, exports.cleanText)(input.description, 'description', L.description);
    if (has(input, 'quantity'))
        next.quantity = (0, exports.parseQuantity)(input.quantity);
    if (has(input, 'purchasePrice'))
        next.purchasePrice = (0, exports.parsePrice)(input.purchasePrice);
    if (has(input, 'minimumOrderQuantity'))
        next.minimumOrderQuantity = (0, exports.parseMinimumOrderQuantity)(input.minimumOrderQuantity);
    if (has(input, 'currency'))
        next.currency = (0, exports.parseCurrency)(input.currency);
    if (has(input, 'manufacturerBarcode')) {
        next.manufacturerBarcode = (0, exports.cleanCode)(input.manufacturerBarcode, 'manufacturerBarcode', L.manufacturerBarcode);
    }
    if (has(input, 'serialRequired'))
        next.serialRequired = input.serialRequired === true || input.serialRequired === 'true';
    if (!next.name)
        throw (0, exports.warehouseError)('NAME_REQUIRED', 'Der Produktname ist Pflicht.', { params: { field: 'name' } });
    // Ein Preis ohne Währung liest sich wie Franken — so wird er auch gespeichert.
    if (next.purchasePrice !== null && !next.currency)
        next.currency = 'CHF';
    return next;
};
exports.productFieldsFromInput = productFieldsFromInput;
/** Eine Seriennummer aus der Eingabe (Scan oder Tastatur). */
const serialFromInput = (raw) => {
    const value = (0, exports.cleanCode)(raw, 'serialNumber', exports.WAREHOUSE_LIMITS.serialNumber);
    if (!value)
        throw (0, exports.warehouseError)('SERIAL_EMPTY', 'Die Seriennummer ist leer.');
    return value;
};
exports.serialFromInput = serialFromInput;
/** Gleiche Seriennummer zweimal in EINER Eingabe (die Datenbank vergleicht ohne Gross/Klein). */
const firstDuplicate = (values) => {
    const seen = new Set();
    for (const value of values) {
        const key = value.toLocaleLowerCase('de-CH');
        if (seen.has(key))
            return value;
        seen.add(key);
    }
    return null;
};
exports.firstDuplicate = firstDuplicate;
/* ═══════════════════════════════════════════════════════════════════════════
   2) DIE LISTE: SUCHE, GRUPPEN, SORTIERUNG, SEITEN
   ═════════════════════════════════════════════════════════════════════════ */
const SORT_KEYS = [
    'erpCode', 'name', 'brand', 'modelNumber', 'supplierName', 'description', 'quantity', 'barcode', 'updatedAt',
];
const sortKeyFrom = (raw) => SORT_KEYS.includes(String(raw)) ? String(raw) : 'name';
exports.sortKeyFrom = sortKeyFrom;
const directionFrom = (raw, sort) => {
    const value = String(raw ?? '').toLowerCase();
    if (value === 'asc' || value === 'desc')
        return value;
    return sort === 'updatedAt' ? 'desc' : 'asc';
};
exports.directionFrom = directionFrom;
exports.WAREHOUSE_PAGE_SIZE = 50;
exports.WAREHOUSE_MAX_PAGE_SIZE = 200;
const pageFrom = (raw) => {
    const value = Math.trunc(Number(raw));
    return Number.isFinite(value) && value >= 1 ? Math.min(value, 100_000) : 1;
};
exports.pageFrom = pageFrom;
const pageSizeFrom = (raw) => {
    const value = Math.trunc(Number(raw));
    if (!Number.isFinite(value) || value < 1)
        return exports.WAREHOUSE_PAGE_SIZE;
    return Math.min(value, exports.WAREHOUSE_MAX_PAGE_SIZE);
};
exports.pageSizeFrom = pageSizeFrom;
/** Die Kennung, die in der Gruppenauswahl «ohne Gruppe» bedeutet. */
exports.NO_GROUP_TOKEN = 'none';
/** «a,b,none» → ['a', 'b', null]; höchstens 50 Gruppen. */
const groupIdsFrom = (raw) => {
    if (raw === undefined || raw === null || raw === '')
        return undefined;
    const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
        .map((part) => String(part).trim())
        .filter(Boolean)
        .slice(0, 50);
    if (!parts.length)
        return undefined;
    return [...new Set(parts)].map((part) => (part === exports.NO_GROUP_TOKEN ? null : part));
};
exports.groupIdsFrom = groupIdsFrom;
/** Suchtext der Liste: getrimmt, höchstens 120 Zeichen. */
const searchFrom = (raw) => {
    const value = (0, exports.cleanLine)(typeof raw === 'string' ? raw.slice(0, 200) : raw, 'search', 200);
    return value ? value.slice(0, 120) : undefined;
};
exports.searchFrom = searchFrom;
//# sourceMappingURL=warehouse.js.map