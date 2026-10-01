import type {
    WarehouseCurrency,
    WarehouseImportIssue,
    WarehouseImportRow,
    WarehouseLabelLayout,
    WarehouseLabelSettings,
} from '../entities/Warehouse';
import {
    cleanCode,
    cleanLine,
    cleanText,
    isWarehouseError,
    parseCurrency,
    parsePrice,
    parseQuantity,
    parseSupplierEmail,
    parseUnit,
    WAREHOUSE_LIMITS,
} from './warehouse';

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

export const ABBREVIATION_MIN = 2;
export const ABBREVIATION_MAX = 5;

const TRANSLITERATION: Record<string, string> = {
    Ç: 'C', Ğ: 'G', İ: 'I', I: 'I', Ö: 'O', Ş: 'S', Ü: 'U',
    Â: 'A', Î: 'I', Û: 'U', Ä: 'A', É: 'E', È: 'E', Ê: 'E', À: 'A', Ô: 'O',
};

/** Grossbuchstaben ohne Zeichen ausserhalb von A–Z/0–9 (ç → C, ş → S, ı → I). */
export const normalizeAbbreviation = (raw: unknown): string =>
    String(raw ?? '')
        .trim()
        .toLocaleUpperCase('tr-TR')
        .replace(/[ÇĞİIÖŞÜÂÎÛÄÉÈÊÀÔ]/g, (char) => TRANSLITERATION[char] ?? char)
        .replace(/[^A-Z0-9]/g, '');

export const isValidAbbreviation = (code: string): boolean =>
    new RegExp(`^[A-Z0-9]{${ABBREVIATION_MIN},${ABBREVIATION_MAX}}$`).test(code);

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);

/**
 * Ein Vorschlag aus dem Namen: der erste Buchstabe, dann die folgenden
 * Mitlaute — Elektrik → ELK, Kablo → KBL, Kontaktör → KNT, PLC → PLC.
 * Reichen die Mitlaute nicht, füllen die übrigen Buchstaben auf.
 */
export const suggestAbbreviation = (name: unknown, length = 3): string => {
    const letters = normalizeAbbreviation(name);
    if (letters.length <= length) return letters;
    const first = letters[0] ?? '';
    const rest = letters.slice(1).split('');
    const consonants = rest.filter((char) => !VOWELS.has(char));
    const picked = [first, ...consonants].slice(0, length);
    if (picked.length < length) {
        for (const char of rest) {
            if (picked.length >= length) break;
            if (VOWELS.has(char)) picked.push(char);
        }
    }
    return picked.join('').slice(0, length);
};

/* ═══════════════════════════════════════════════════════════════════════════
   2) ERP-CODE
   ═════════════════════════════════════════════════════════════════════════ */

export const ERP_DIGITS = 5;

export const erpPrefix = (categoryCode: string, groupCode: string): string => `${categoryCode}-${groupCode}-`;

export const formatErpCode = (categoryCode: string, groupCode: string, n: number): string =>
    `${erpPrefix(categoryCode, groupCode)}${String(n).padStart(ERP_DIGITS, '0')}`;

/** Der nächste Code einer Gruppe — für die Vorschau in den Einstellungen. */
export const nextErpCode = (group: { categoryCode: string; code: string | null; lastNumber: number }): string | null =>
    group.code ? formatErpCode(group.categoryCode, group.code, group.lastNumber + 1) : null;

/* ═══════════════════════════════════════════════════════════════════════════
   3) GS1-BARCODE (EAN-13, firmenintern 04…)
   ═════════════════════════════════════════════════════════════════════════ */

export const GS1_INTERNAL_PREFIX = '04';
export const BARCODE_COUNTER_DIGITS = 10;
export const MAX_BARCODE_NUMBER = 9_999_999_999;

/** Prüfziffer eines EAN-13 aus den ersten zwölf Stellen (Gewichte 1-3-1-3 … von links). */
export const ean13CheckDigit = (first12: string): number => {
    let sum = 0;
    for (let index = 0; index < 12; index += 1) {
        const digit = Number(first12[index] ?? 0);
        sum += index % 2 === 0 ? digit : digit * 3;
    }
    return (10 - (sum % 10)) % 10;
};

export const isValidEan13 = (code: string): boolean =>
    /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);

/** Der n-te firmeninterne Barcode: 04 + zehn Stellen + Prüfziffer. */
export const gs1InternalBarcode = (n: number): string => {
    if (!Number.isInteger(n) || n < 1 || n > MAX_BARCODE_NUMBER) {
        throw new RangeError(`Barcodenummer ausserhalb des Bereichs: ${n}`);
    }
    const body = `${GS1_INTERNAL_PREFIX}${String(n).padStart(BARCODE_COUNTER_DIGITS, '0')}`;
    return `${body}${ean13CheckDigit(body)}`;
};

/** Stammt dieser Code aus unserem Bereich (04…, gültige Prüfziffer)? */
export const isInternalBarcode = (code: string | null | undefined): boolean =>
    Boolean(code) && isValidEan13(code!) && code!.startsWith(GS1_INTERNAL_PREFIX);

/**
 * Die Formen, unter denen ein gescannter Code gespeichert sein kann: wie
 * gelesen, und für EAN-13/UPC-A die jeweils andere Schreibweise (12 Stellen
 * ↔ führende 0 + 12 Stellen).
 */
export const codeVariants = (code: string): string[] => {
    const variants = [code];
    if (/^\d{12}$/.test(code)) variants.push(`0${code}`);
    if (/^0\d{12}$/.test(code)) variants.push(code.slice(1));
    return variants;
};

/* ═══════════════════════════════════════════════════════════════════════════
   4) ETIKETT
   ═════════════════════════════════════════════════════════════════════════ */

export const LABEL_LIMITS = { minWidth: 25, maxWidth: 120, minHeight: 12, maxHeight: 80 } as const;

export const DEFAULT_LABEL: WarehouseLabelSettings = { widthMm: 50, heightMm: 25, layout: 'roll', showName: true };

const clampNumber = (raw: unknown, min: number, max: number, fallback: number): number | null => {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    const rounded = Math.round(value * 10) / 10;
    return rounded >= min && rounded <= max ? rounded : null;
};

/**
 * Etikett-Einstellungen aus der Eingabe (ganz oder teilweise) — `null`, wenn
 * ein Mass ausserhalb der Grenzen liegt. Unbekannte Werte fallen auf die
 * Vorgabe zurück.
 */
export const labelSettingsFrom = (raw: unknown, base: WarehouseLabelSettings = DEFAULT_LABEL): WarehouseLabelSettings | null => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const widthMm = clampNumber(input.widthMm, LABEL_LIMITS.minWidth, LABEL_LIMITS.maxWidth, base.widthMm);
    const heightMm = clampNumber(input.heightMm, LABEL_LIMITS.minHeight, LABEL_LIMITS.maxHeight, base.heightMm);
    if (widthMm === null || heightMm === null) return null;
    const layout: WarehouseLabelLayout = input.layout === 'a4' || input.layout === 'roll' ? input.layout : base.layout;
    const showName = typeof input.showName === 'boolean' ? input.showName : base.showName;
    return { widthMm, heightMm, layout, showName };
};

/** Gespeicherte Einstellungen lesen — was nicht passt, gilt als Vorgabe. */
export const storedLabelSettings = (raw: unknown): WarehouseLabelSettings => {
    let value = raw;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { value = null; }
    }
    return labelSettingsFrom(value) ?? { ...DEFAULT_LABEL };
};

/* ═══════════════════════════════════════════════════════════════════════════
   5) EXCEL-ZEILE
   ═════════════════════════════════════════════════════════════════════════ */

export const IMPORT_MAX_ROWS = 2000;

const YES = new Set(['evet', 'e', 'yes', 'y', 'ja', 'j', 'true', '1', 'x', '✓', 'var', 'gerekli']);
const NO = new Set(['hayır', 'hayir', 'h', 'no', 'n', 'nein', 'false', '0', '-', 'yok', '']);

/** «Evet»/«Hayır» (auch Yes/No, Ja/Nein, 1/0, x) → Wahrheitswert; unlesbar → null. */
export const serialFlagFrom = (raw: unknown): boolean | null => {
    if (raw === null || raw === undefined) return false;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw === 1 ? true : raw === 0 ? false : null;
    const text = String(raw).trim().toLocaleLowerCase('tr-TR');
    if (YES.has(text)) return true;
    if (NO.has(text)) return false;
    return null;
};

/**
 * Der Schlüssel eines Gruppentexts: «ELK-PLC — Elektrik › PLC» → «ELK-PLC».
 * Ohne Kürzelpaar bleibt der Text selbst (dann zählt der Gruppenname).
 */
export const groupTextKey = (raw: string): { pair: string | null; text: string } => {
    const text = raw.trim();
    const match = /^([A-Za-z0-9ÇĞİıÖŞÜçğöşü]{1,8})\s*-\s*([A-Za-z0-9ÇĞİıÖŞÜçğöşü]{1,8})(?=$|[\s—–:|·(])/.exec(text);
    if (!match) return { pair: null, text };
    return { pair: `${normalizeAbbreviation(match[1])}-${normalizeAbbreviation(match[2])}`, text };
};

/**
 * Eine Zeile aus der Datei prüfen (ohne Datenbank): Werte bereinigen, Fehler
 * und Hinweise sammeln. Die Gruppe bleibt Text — sie prüft der
 * Anwendungsfall gegen die Gruppen der Firma.
 */
export const importRowFromInput = (
    raw: unknown,
    fallbackRow: number,
): { row: WarehouseImportRow; issues: WarehouseImportIssue[] } => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const issues: WarehouseImportIssue[] = [];
    const L = WAREHOUSE_LIMITS;

    const guard = <T>(field: string, read: () => T, fallback: T): T => {
        try {
            return read();
        } catch (error) {
            if (!isWarehouseError(error)) throw error;
            issues.push({ level: 'error', code: error.code, field, ...(error.params ? { params: error.params } : {}) });
            return fallback;
        }
    };

    const rowNumber = Math.trunc(Number(input.row));
    const row = Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber : fallbackRow;

    const name = guard('name', () => cleanLine(input.name, 'name', L.name), null);
    if (!name && !issues.some((issue) => issue.field === 'name')) {
        issues.push({ level: 'error', code: 'NAME_REQUIRED', field: 'name' });
    }

    const group = guard('group', () => cleanLine(input.group, 'group', 200), null);
    const quantity = guard('quantity', () => parseQuantity(input.quantity), 0);
    const purchasePrice = guard('purchasePrice', () => parsePrice(input.purchasePrice), null);
    let currency = guard<WarehouseCurrency | null>('currency', () => parseCurrency(input.currency), null);
    if (purchasePrice !== null && !currency) currency = 'CHF';

    let serialRequired = serialFlagFrom(input.serialRequired);
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
            brand: guard('brand', () => cleanLine(input.brand, 'brand', L.brand), null),
            modelNumber: guard('modelNumber', () => cleanLine(input.modelNumber, 'modelNumber', L.modelNumber), null),
            /* «Ürün kodu» gibt es auf der Karte nicht mehr (01.10.2026): er ist die
               Artikelnummer des Lieferanten der Zeile — eine ältere Datei mit der
               Spalte «Ürün kodu» landet dort. */
            productCode: null,
            unit: guard('unit', () => parseUnit(input.unit), null),
            supplierName: guard('supplierName', () => cleanLine(input.supplierName, 'supplierName', L.supplierName), null),
            supplierEmail: guard('supplierEmail', () => parseSupplierEmail(input.supplierEmail, String(input.supplierName ?? '')), null),
            supplierArticleNumber: guard(
                'supplierArticleNumber',
                () => cleanCode(input.supplierArticleNumber ?? input.productCode, 'supplierArticleNumber', L.supplierArticleNumber),
                null,
            ),
            supplierOrderNumber: guard(
                'supplierOrderNumber',
                () => cleanCode(input.supplierOrderNumber, 'supplierOrderNumber', L.supplierOrderNumber),
                null,
            ),
            description: guard('description', () => cleanText(input.description, 'description', L.description), null),
            quantity: finalQuantity,
            purchasePrice,
            currency,
            manufacturerBarcode: guard(
                'manufacturerBarcode',
                () => cleanCode(input.manufacturerBarcode, 'manufacturerBarcode', L.manufacturerBarcode),
                null,
            ),
            serialRequired,
        },
        issues,
    };
};

/** Hat die Zeile überhaupt etwas? (Leere Zeilen der Vorlage fallen weg.) */
export const importRowHasContent = (raw: unknown): boolean => {
    if (!raw || typeof raw !== 'object') return false;
    return Object.entries(raw as Record<string, unknown>).some(([key, value]) =>
        key !== 'row' && value !== null && value !== undefined && String(value).trim() !== '');
};
