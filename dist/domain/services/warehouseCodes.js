"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.importRowHasContent = exports.importRowFromInput = exports.groupTextKey = exports.serialFlagFrom = exports.IMPORT_MAX_ROWS = exports.storedLabelSettings = exports.labelSettingsFrom = exports.DEFAULT_LABEL = exports.LABEL_LIMITS = exports.codeVariants = exports.isInternalBarcode = exports.gs1InternalBarcode = exports.isValidEan13 = exports.ean13CheckDigit = exports.MAX_BARCODE_NUMBER = exports.BARCODE_COUNTER_DIGITS = exports.GS1_INTERNAL_PREFIX = exports.nextErpCode = exports.formatErpCode = exports.erpPrefix = exports.ERP_DIGITS = exports.suggestAbbreviation = exports.isValidAbbreviation = exports.normalizeAbbreviation = exports.ABBREVIATION_MAX = exports.ABBREVIATION_MIN = void 0;
const warehouse_1 = require("./warehouse");
/**
 * ── ERP-CODE, GS1-BARCODE, ETIKETT, EXCEL-ZEILE (26.09.2026, 2. Durchgang) ───
 *
 * Reine Regeln ohne Datenbank.
 *
 *   ERP-Code   «Malzeme grubuna göre ERP kodu oluşturulması gerekiyor.
 *               ELK-PLC-00001 şeklinde.» Kategorie-Kürzel, Gruppen-Kürzel,
 *               fünfstellige Laufnummer der Gruppe.
 *   Barcode    «her ERP numarasına özel bir barkod tanımlansın, GS1'e göre».
 *               Ein GTIN-13-förmiger EAN-13 im GS1-Bereich 040–049, der für
 *               firmeninterne Nummern freigehalten ist (Restricted Circulation
 *               Number «within a company», GS1 General Specifications): «04»,
 *               zehn Stellen Zähler, Prüfziffer nach Modulo 10. Solche Codes
 *               verlassen die Firma nicht und kollidieren mit keiner GTIN
 *               eines Herstellers.
 *
 * Ein EAN-13 mit führender 0 ist zugleich ein UPC-A: manche Handscanner
 * senden ihn zwölfstellig (ohne die 0). `codeVariants` kennt beide Formen.
 */
/* ═══════════════════════════════════════════════════════════════════════════
   1) KÜRZEL (ELK, PLC)
   ═════════════════════════════════════════════════════════════════════════ */
exports.ABBREVIATION_MIN = 2;
exports.ABBREVIATION_MAX = 5;
const TRANSLITERATION = {
    Ç: 'C', Ğ: 'G', İ: 'I', I: 'I', Ö: 'O', Ş: 'S', Ü: 'U',
    Â: 'A', Î: 'I', Û: 'U', Ä: 'A', É: 'E', È: 'E', Ê: 'E', À: 'A', Ô: 'O',
};
/** Grossbuchstaben ohne Zeichen ausserhalb von A–Z/0–9 (ç → C, ş → S, ı → I). */
const normalizeAbbreviation = (raw) => String(raw ?? '')
    .trim()
    .toLocaleUpperCase('tr-TR')
    .replace(/[ÇĞİIÖŞÜÂÎÛÄÉÈÊÀÔ]/g, (char) => TRANSLITERATION[char] ?? char)
    .replace(/[^A-Z0-9]/g, '');
exports.normalizeAbbreviation = normalizeAbbreviation;
const isValidAbbreviation = (code) => new RegExp(`^[A-Z0-9]{${exports.ABBREVIATION_MIN},${exports.ABBREVIATION_MAX}}$`).test(code);
exports.isValidAbbreviation = isValidAbbreviation;
const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);
/**
 * Ein Vorschlag aus dem Namen: der erste Buchstabe, dann die folgenden
 * Mitlaute — Elektrik → ELK, Kablo → KBL, Kontaktör → KNT, PLC → PLC.
 * Reichen die Mitlaute nicht, füllen die übrigen Buchstaben auf.
 */
const suggestAbbreviation = (name, length = 3) => {
    const letters = (0, exports.normalizeAbbreviation)(name);
    if (letters.length <= length)
        return letters;
    const first = letters[0] ?? '';
    const rest = letters.slice(1).split('');
    const consonants = rest.filter((char) => !VOWELS.has(char));
    const picked = [first, ...consonants].slice(0, length);
    if (picked.length < length) {
        for (const char of rest) {
            if (picked.length >= length)
                break;
            if (VOWELS.has(char))
                picked.push(char);
        }
    }
    return picked.join('').slice(0, length);
};
exports.suggestAbbreviation = suggestAbbreviation;
/* ═══════════════════════════════════════════════════════════════════════════
   2) ERP-CODE
   ═════════════════════════════════════════════════════════════════════════ */
exports.ERP_DIGITS = 5;
const erpPrefix = (categoryCode, groupCode) => `${categoryCode}-${groupCode}-`;
exports.erpPrefix = erpPrefix;
const formatErpCode = (categoryCode, groupCode, n) => `${(0, exports.erpPrefix)(categoryCode, groupCode)}${String(n).padStart(exports.ERP_DIGITS, '0')}`;
exports.formatErpCode = formatErpCode;
/** Der nächste Code einer Gruppe — für die Vorschau in den Einstellungen. */
const nextErpCode = (group) => group.code ? (0, exports.formatErpCode)(group.categoryCode, group.code, group.lastNumber + 1) : null;
exports.nextErpCode = nextErpCode;
/* ═══════════════════════════════════════════════════════════════════════════
   3) GS1-BARCODE (EAN-13, firmenintern 04…)
   ═════════════════════════════════════════════════════════════════════════ */
exports.GS1_INTERNAL_PREFIX = '04';
exports.BARCODE_COUNTER_DIGITS = 10;
exports.MAX_BARCODE_NUMBER = 9_999_999_999;
/** Prüfziffer eines EAN-13 aus den ersten zwölf Stellen (Gewichte 1-3-1-3 … von links). */
const ean13CheckDigit = (first12) => {
    let sum = 0;
    for (let index = 0; index < 12; index += 1) {
        const digit = Number(first12[index] ?? 0);
        sum += index % 2 === 0 ? digit : digit * 3;
    }
    return (10 - (sum % 10)) % 10;
};
exports.ean13CheckDigit = ean13CheckDigit;
const isValidEan13 = (code) => /^\d{13}$/.test(code) && (0, exports.ean13CheckDigit)(code.slice(0, 12)) === Number(code[12]);
exports.isValidEan13 = isValidEan13;
/** Der n-te firmeninterne Barcode: 04 + zehn Stellen + Prüfziffer. */
const gs1InternalBarcode = (n) => {
    if (!Number.isInteger(n) || n < 1 || n > exports.MAX_BARCODE_NUMBER) {
        throw new RangeError(`Barcodenummer ausserhalb des Bereichs: ${n}`);
    }
    const body = `${exports.GS1_INTERNAL_PREFIX}${String(n).padStart(exports.BARCODE_COUNTER_DIGITS, '0')}`;
    return `${body}${(0, exports.ean13CheckDigit)(body)}`;
};
exports.gs1InternalBarcode = gs1InternalBarcode;
/** Stammt dieser Code aus unserem Bereich (04…, gültige Prüfziffer)? */
const isInternalBarcode = (code) => Boolean(code) && (0, exports.isValidEan13)(code) && code.startsWith(exports.GS1_INTERNAL_PREFIX);
exports.isInternalBarcode = isInternalBarcode;
/**
 * Die Formen, unter denen ein gescannter Code gespeichert sein kann: wie
 * gelesen, und für EAN-13/UPC-A die jeweils andere Schreibweise (12 Stellen
 * ↔ führende 0 + 12 Stellen).
 */
const codeVariants = (code) => {
    const variants = [code];
    if (/^\d{12}$/.test(code))
        variants.push(`0${code}`);
    if (/^0\d{12}$/.test(code))
        variants.push(code.slice(1));
    return variants;
};
exports.codeVariants = codeVariants;
/* ═══════════════════════════════════════════════════════════════════════════
   4) ETIKETT
   ═════════════════════════════════════════════════════════════════════════ */
exports.LABEL_LIMITS = { minWidth: 25, maxWidth: 120, minHeight: 12, maxHeight: 80 };
exports.DEFAULT_LABEL = { widthMm: 50, heightMm: 25, layout: 'roll', showName: true };
const clampNumber = (raw, min, max, fallback) => {
    if (raw === undefined || raw === null || raw === '')
        return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value))
        return null;
    const rounded = Math.round(value * 10) / 10;
    return rounded >= min && rounded <= max ? rounded : null;
};
/**
 * Etikett-Einstellungen aus der Eingabe (ganz oder teilweise) — `null`, wenn
 * ein Mass ausserhalb der Grenzen liegt. Unbekannte Werte fallen auf die
 * Vorgabe zurück.
 */
const labelSettingsFrom = (raw, base = exports.DEFAULT_LABEL) => {
    const input = (raw && typeof raw === 'object' ? raw : {});
    const widthMm = clampNumber(input.widthMm, exports.LABEL_LIMITS.minWidth, exports.LABEL_LIMITS.maxWidth, base.widthMm);
    const heightMm = clampNumber(input.heightMm, exports.LABEL_LIMITS.minHeight, exports.LABEL_LIMITS.maxHeight, base.heightMm);
    if (widthMm === null || heightMm === null)
        return null;
    const layout = input.layout === 'a4' || input.layout === 'roll' ? input.layout : base.layout;
    const showName = typeof input.showName === 'boolean' ? input.showName : base.showName;
    return { widthMm, heightMm, layout, showName };
};
exports.labelSettingsFrom = labelSettingsFrom;
/** Gespeicherte Einstellungen lesen — was nicht passt, gilt als Vorgabe. */
const storedLabelSettings = (raw) => {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            value = null;
        }
    }
    return (0, exports.labelSettingsFrom)(value) ?? { ...exports.DEFAULT_LABEL };
};
exports.storedLabelSettings = storedLabelSettings;
/* ═══════════════════════════════════════════════════════════════════════════
   5) EXCEL-ZEILE
   ═════════════════════════════════════════════════════════════════════════ */
exports.IMPORT_MAX_ROWS = 2000;
const YES = new Set(['evet', 'e', 'yes', 'y', 'ja', 'j', 'true', '1', 'x', '✓', 'var', 'gerekli']);
const NO = new Set(['hayır', 'hayir', 'h', 'no', 'n', 'nein', 'false', '0', '-', 'yok', '']);
/** «Evet»/«Hayır» (auch Yes/No, Ja/Nein, 1/0, x) → Wahrheitswert; unlesbar → null. */
const serialFlagFrom = (raw) => {
    if (raw === null || raw === undefined)
        return false;
    if (typeof raw === 'boolean')
        return raw;
    if (typeof raw === 'number')
        return raw === 1 ? true : raw === 0 ? false : null;
    const text = String(raw).trim().toLocaleLowerCase('tr-TR');
    if (YES.has(text))
        return true;
    if (NO.has(text))
        return false;
    return null;
};
exports.serialFlagFrom = serialFlagFrom;
/**
 * Der Schlüssel eines Gruppentexts: «ELK-PLC — Elektrik › PLC» → «ELK-PLC».
 * Ohne Kürzelpaar bleibt der Text selbst (dann zählt der Gruppenname).
 */
const groupTextKey = (raw) => {
    const text = raw.trim();
    const match = /^([A-Za-z0-9ÇĞİıÖŞÜçğöşü]{1,8})\s*-\s*([A-Za-z0-9ÇĞİıÖŞÜçğöşü]{1,8})(?=$|[\s—–:|·(])/.exec(text);
    if (!match)
        return { pair: null, text };
    return { pair: `${(0, exports.normalizeAbbreviation)(match[1])}-${(0, exports.normalizeAbbreviation)(match[2])}`, text };
};
exports.groupTextKey = groupTextKey;
/**
 * Eine Zeile aus der Datei prüfen (ohne Datenbank): Werte bereinigen, Fehler
 * und Hinweise sammeln. Die Gruppe bleibt Text — sie prüft der
 * Anwendungsfall gegen die Gruppen der Firma.
 */
const importRowFromInput = (raw, fallbackRow) => {
    const input = (raw && typeof raw === 'object' ? raw : {});
    const issues = [];
    const L = warehouse_1.WAREHOUSE_LIMITS;
    const guard = (field, read, fallback) => {
        try {
            return read();
        }
        catch (error) {
            if (!(0, warehouse_1.isWarehouseError)(error))
                throw error;
            issues.push({ level: 'error', code: error.code, field, ...(error.params ? { params: error.params } : {}) });
            return fallback;
        }
    };
    const rowNumber = Math.trunc(Number(input.row));
    const row = Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber : fallbackRow;
    const name = guard('name', () => (0, warehouse_1.cleanLine)(input.name, 'name', L.name), null);
    if (!name && !issues.some((issue) => issue.field === 'name')) {
        issues.push({ level: 'error', code: 'NAME_REQUIRED', field: 'name' });
    }
    const group = guard('group', () => (0, warehouse_1.cleanLine)(input.group, 'group', 200), null);
    const quantity = guard('quantity', () => (0, warehouse_1.parseQuantity)(input.quantity), 0);
    const purchasePrice = guard('purchasePrice', () => (0, warehouse_1.parsePrice)(input.purchasePrice), null);
    let currency = guard('currency', () => (0, warehouse_1.parseCurrency)(input.currency), null);
    if (purchasePrice !== null && !currency)
        currency = 'CHF';
    let serialRequired = (0, exports.serialFlagFrom)(input.serialRequired);
    if (serialRequired === null) {
        issues.push({ level: 'warning', code: 'SERIAL_FLAG_UNREADABLE', field: 'serialRequired', params: { value: String(input.serialRequired).slice(0, 40) } });
        serialRequired = false;
    }
    let finalQuantity = quantity;
    if (serialRequired && quantity > 0) {
        issues.push({ level: 'warning', code: 'QUANTITY_IGNORED_SERIAL', field: 'quantity' });
        finalQuantity = 0;
    }
    return {
        row: {
            row,
            group,
            name: name ?? '',
            brand: guard('brand', () => (0, warehouse_1.cleanLine)(input.brand, 'brand', L.brand), null),
            modelNumber: guard('modelNumber', () => (0, warehouse_1.cleanLine)(input.modelNumber, 'modelNumber', L.modelNumber), null),
            supplierName: guard('supplierName', () => (0, warehouse_1.cleanLine)(input.supplierName, 'supplierName', L.supplierName), null),
            description: guard('description', () => (0, warehouse_1.cleanText)(input.description, 'description', L.description), null),
            quantity: finalQuantity,
            purchasePrice,
            currency,
            manufacturerBarcode: guard('manufacturerBarcode', () => (0, warehouse_1.cleanCode)(input.manufacturerBarcode, 'manufacturerBarcode', L.manufacturerBarcode), null),
            serialRequired,
        },
        issues,
    };
};
exports.importRowFromInput = importRowFromInput;
/** Hat die Zeile überhaupt etwas? (Leere Zeilen der Vorlage fallen weg.) */
const importRowHasContent = (raw) => {
    if (!raw || typeof raw !== 'object')
        return false;
    return Object.entries(raw).some(([key, value]) => key !== 'row' && value !== null && value !== undefined && String(value).trim() !== '');
};
exports.importRowHasContent = importRowHasContent;
//# sourceMappingURL=warehouseCodes.js.map