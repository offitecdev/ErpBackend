/**
 * ── DIE REGELN DER BOM (27.09.2026, Vorgabe Samet) ──────────────────────────
 *
 * Reine Funktionen — keine Datenbank, keine Anfrage. Hier steht, was eine
 * Vorlage/BOM gültig macht, wie reserviert wird, was «Sipariş oluştur»
 * vorschlägt und wann «BOM tamamla» geht. Die Anwendungsfälle holen die
 * Tatsachen, diese Datei rechnet.
 *
 * DIE RESERVIERUNG (Samets Regel, wörtlich):
 *   «rezerveler seri numarası olan ürünler için olmalı sadece, diğerleri
 *    direkt sıradan proje teslim tarihi önce olan projeye otomatik gitmeli;
 *    rezerve edilenler seri numarası içinde termini önce olan projeye
 *    otomatik gitmeli.»
 *
 *   · Karten MIT Seriennummer: die Nummer selbst ist reserviert — sie trägt
 *     Projekt und Gerät (depo_seri_numaralari). Freie Nummern gehen an die
 *     wartende Zeile mit dem frühesten Liefertermin.
 *   · alle anderen: der Bestand wird der Reihe nach verteilt — frühester
 *     Liefertermin zuerst, dann die früher freigegebene BOM. Das wird bei
 *     jedem Lesen neu GERECHNET, nichts ist gespeichert; so gilt die Regel
 *     auch dann, wenn später ein Projekt mit früherem Termin dazukommt.
 *   · Bestellte Ware: jede Zeile nimmt zuerst, was IHRE Bestellung bringt;
 *     was eine Bestellung mehr bringt als ihre Zeile braucht (weil der
 *     Bestand inzwischen an ein früheres Projekt ging), deckt die nächste
 *     wartende Zeile. So fehlt nie scheinbar etwas, das schon bestellt ist.
 */
import type {
    Bom,
    BomArea,
    BomCategory,
    BomCode,
    BomDemand,
    BomIncomingLine,
    BomLine,
    BomLineChange,
    BomLineCoverage,
    BomLineDraft,
    BomOrderAction,
    BomOrderActionLine,
    BomOrderLineInput,
    BomOrderProposalLine,
    BomPurchaseLineRecord,
    BomRequestLineInput,
    BomRevisionLine,
    BomStockProduct,
    BomTemplateInput,
    BomUnit,
    BomSerialFact,
} from '../entities/ProductionBom';
import { BOM_CATEGORIES, BOM_UNITS, MAIN_BOM_PREFIX } from '../entities/ProductionBom';

/* ── Fehler mit Kennung ─────────────────────────────────────────────────── */

export type BomErrorCode =
    | 'NOT_AVAILABLE'
    | 'FORBIDDEN'
    | 'TEMPLATE_NOT_FOUND'
    | 'BOM_NOT_FOUND'
    | 'DEVICE_NOT_FOUND'
    | 'PRODUCT_NOT_FOUND'
    | 'PURCHASE_NOT_FOUND'
    | 'NAME_REQUIRED'
    | 'CATEGORY_INVALID'
    | 'MAIN_CARD_REQUIRED'
    | 'PREFIX_INVALID'
    | 'LINES_TOO_MANY'
    | 'LINE_INVALID'
    | 'CATEGORY_MISMATCH'
    | 'MAX_REACHED'
    | 'STATUS_INVALID'
    | 'LINES_REQUIRED'
    | 'HAS_ORDERS'
    | 'NOT_READY'
    | 'ALREADY_CONSUMED'
    | 'ORDER_EMPTY'
    | 'LINE_BLOCKED'
    | 'LINE_DUPLICATE'
    | 'QTY_BELOW_FLOOR'
    | 'NOTE_REQUIRED'
    | 'SUPPLIER_REQUIRED'
    | 'RECEIPT_INVALID'
    | 'SERIAL_REQUIRED'
    | 'SERIAL_TAKEN'
    | 'FILE_REQUIRED'
    | 'FILE_TYPE'
    | 'FILE_TOO_LARGE'
    | 'SETTINGS_INVALID'
    | 'AI_NOT_CONFIGURED'
    | 'AI_SOURCE_REQUIRED'
    | 'AI_COLUMN_INVALID'
    | 'AI_FAILED'
    | 'AI_COLUMNS_REQUIRED'
    | 'AI_SOURCE_UNREADABLE'
    | 'ROWS_LOCKED'
    | 'QUOTE_NUMBER_REQUIRED'
    | 'CONFIRM_REQUIREMENTS'
    | 'REQUEST_NO_CONVERT'
    | 'ORDER_ONLY'
    | 'CODE_INVALID'
    | 'CODE_RESERVED'
    | 'CODE_DUPLICATE'
    | 'CODE_UNKNOWN'
    | 'MAIN_LOCKED'
    | 'PARENT_COMPLETED'
    | 'REQUEST_DRAFT_ONLY'
    | 'REQUEST_EMPTY'
    | 'QTY_INVALID'
    | 'SUPPLIERS_TOO_MANY'
    | 'LINE_UNKNOWN'
    | 'HAS_REQUESTS'
    | 'APPROVAL_FINAL'
    | 'REVISION_OPEN'
    | 'REVISION_NONE'
    | 'REVISION_NOT_ALLOWED'
    | 'REVISION_NOT_FOUND'
    | 'REASON_REQUIRED'
    | 'REVISION_NO_CHANGES'
    | 'REVISION_CONFLICT'
    // Satın alma talebi (27.09.2026 abends)
    | 'KIND_INVALID'
    | 'NOT_FOUND'
    | 'REQUEST_NOT_FOUND'
    | 'REQUEST_IN_PROGRESS'
    | 'REQUEST_MISMATCH'
    // Satın alma, der Schreibtisch (28.09.2026)
    | 'PRICES_REQUIRED'
    | 'PRICE_MISSING'
    // Fiyat karşılaştırması (29.09.2026)
    | 'COMPARE_COUNT'
    | 'COMPARE_PDF_REQUIRED'
    | 'COMPARE_PDF_UNREADABLE'
    | 'COMPARISON_NOT_FOUND';

export type BomError = Error & {
    code: BomErrorCode;
    status: number;
    params?: Record<string, string | number>;
    details?: unknown;
};

export const bomError = (
    code: BomErrorCode,
    message: string,
    options: { status?: number; params?: Record<string, string | number>; details?: unknown } = {},
): BomError =>
    Object.assign(new Error(message), {
        code,
        status: options.status ?? 400,
        ...(options.params ? { params: options.params } : {}),
        ...(options.details !== undefined ? { details: options.details } : {}),
    });

export const isBomError = (error: unknown): error is BomError =>
    Boolean(error)
    && typeof (error as BomError).code === 'string'
    && typeof (error as BomError).status === 'number'
    && (error as Error) instanceof Error;

/** Antwortkörper — Kennung, Werte und Zeilen reisen mit (Oberfläche: `productionBom.err.*`). */
export const bomErrorBody = (error: BomError) => ({
    error: error.message || 'Error',
    code: error.code,
    ...(error.params ? { params: error.params } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
});

/* ── Grenzen ────────────────────────────────────────────────────────────── */

export const BOM_LIMITS = {
    name: 160,
    mainCard: 80,
    description: 2000,
    note: 255,
    lines: 300,
    /** Höchstzahl Alt-BOMs je Haupt-BOM, die die Einstellung zulässt. */
    maxPerAreaCeiling: 12,
    /** Alt-BOM-Kodes je Bereich in den Einstellungen. */
    codesPerArea: 40,
    codeName: 80,
    quantityMax: 1_000_000,
    /** Lieferanten je Zeile einer Preisanfrage (wie die Liste der Preisanfrage im Einkauf). */
    requestSuppliers: 10,
} as const;

/** Vorsatz der BOM-Nummer: 2–4 Teile aus A–Z/0–9, mit «-» verbunden (ELK-PANO-MONTAJ). */
const PREFIX_RE = /^[A-Z0-9]{2,8}(?:-[A-Z0-9]{2,10}){1,3}$/;
export const PREFIX_MAX = 24;
export const BOM_NUMBER_DIGITS = 5;

export const round3 = (value: number): number => Math.round((Number(value) || 0) * 1000) / 1000;
/** Auf drei Stellen AUFgerundet — eine Mindestmenge darf nie unterschritten werden. */
export const ceil3 = (value: number): number => Math.ceil((Number(value) || 0) * 1000 - 1e-6) / 1000;
const EPS = 1e-9;

const text = (value: unknown, max: number): string =>
    String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const optionalText = (value: unknown, max: number): string | null => {
    const clean = String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
    return clean ? clean : null;
};

/** «makine / elektrik» — auch die Wörter der drei Sprachen werden verstanden. */
export const categoryFrom = (value: unknown): BomCategory | null => {
    const raw = String(value ?? '').trim().toUpperCase();
    if ((BOM_CATEGORIES as readonly string[]).includes(raw)) return raw as BomCategory;
    if (['MAKINE', 'MAKİNE', 'MECHANICAL', 'MEKANIK', 'MASCHINE'].includes(raw)) return 'MACHINE';
    if (['ELEKTRIK', 'ELEKTRİK', 'ELECTRIC'].includes(raw)) return 'ELECTRICAL';
    return null;
};

export const areaFrom = (value: unknown): BomArea | null => {
    const raw = String(value ?? '').trim().toUpperCase();
    if (raw === 'MECHANICAL' || raw === 'MECHANIK' || raw === 'MEKANIK') return 'MECHANICAL';
    if (raw === 'ELECTRICAL' || raw === 'ELEKTRIK') return 'ELECTRICAL';
    return null;
};

export const unitFrom = (value: unknown): BomUnit => {
    const raw = String(value ?? '').trim().toUpperCase();
    return (BOM_UNITS as readonly string[]).includes(raw) ? raw as BomUnit : 'PCS';
};

/** «MAK-COOL-XXXX» → «MAK-COOL»; Kleinschreibung und Leerzeichen werden bereinigt. */
export const prefixFrom = (value: unknown): string | null => {
    const raw = String(value ?? '')
        .trim()
        .toUpperCase()
        .replace(/[İ]/g, 'I')
        .replace(/\s+/g, '-')
        .replace(/-X{3,}$/, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (!raw || raw.length > PREFIX_MAX || !PREFIX_RE.test(raw)) return null;
    return raw;
};

export const formatBomNumber = (prefix: string, seq: number): string =>
    `${prefix}-${String(Math.max(1, Math.trunc(seq))).padStart(BOM_NUMBER_DIGITS, '0')}`;

/** Menge einer Zeile: > 0, höchstens drei Nachkommastellen. */
export const quantityFrom = (value: unknown): number | null => {
    const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > BOM_LIMITS.quantityMax) return null;
    return round3(parsed);
};

/**
 * Die Zeilen einer Eingabe — Karte und Menge sind Pflicht. Namen und Codes
 * schreibt der Anwendungsfall aus der Depo-Karte ab, nie aus der Anfrage.
 */
export const lineDraftsFrom = (raw: unknown): Array<Pick<BomLineDraft, 'productId' | 'quantity' | 'unit' | 'note'>> => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw bomError('LINE_INVALID', 'Die Zeilen fehlen.', { params: { row: 1 } });
    if (raw.length > BOM_LIMITS.lines) {
        throw bomError('LINES_TOO_MANY', `Höchstens ${BOM_LIMITS.lines} Zeilen.`, { params: { max: BOM_LIMITS.lines } });
    }
    return raw.map((entry, index) => {
        const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const productId = text(value.productId, 64);
        const quantity = quantityFrom(value.quantity);
        if (!productId || quantity === null) {
            throw bomError('LINE_INVALID', `Zeile ${index + 1}: Produkt und Menge (> 0) sind Pflicht.`, {
                params: { row: index + 1 },
                details: [{ row: index + 1 }],
            });
        }
        return { productId, quantity, unit: unitFrom(value.unit), note: optionalText(value.note, BOM_LIMITS.note) };
    });
};

/** Kopf einer Vorlage aus der Anfrage (Zeilen separat über `lineDraftsFrom`). */
export const templateHeadFrom = (raw: unknown): Omit<BomTemplateInput, 'lines'> => {
    const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = text(value.name, BOM_LIMITS.name);
    if (!name) throw bomError('NAME_REQUIRED', 'Die Vorlage braucht einen Namen.');
    const category = categoryFrom(value.category);
    if (!category) throw bomError('CATEGORY_INVALID', 'Kategorie: Makine oder Elektrik.');
    // Ohne Gebietsschema: «chiller» wird CHILLER, nicht CHİLLER.
    const mainCard = text(value.mainCard, BOM_LIMITS.mainCard).toUpperCase();
    if (!mainCard) throw bomError('MAIN_CARD_REQUIRED', 'Die Vorlage braucht eine Ana kart (z. B. CHILLER).');
    // Seit der Hierarchie (27.09.2026) kommt die Nummer aus den Einstellungen —
    // die Vorlage ist nur noch eine Zeilenliste; ein alter Vorsatz bleibt stehen.
    const rawPrefix = String(value.codePrefix ?? '').trim();
    const codePrefix = rawPrefix ? prefixFrom(rawPrefix) : '';
    if (codePrefix === null) {
        throw bomError('PREFIX_INVALID', 'Der Nummernvorsatz ist ungültig (z. B. ELK-PANO).', { params: { max: PREFIX_MAX } });
    }
    return { name, category, mainCard, codePrefix, description: optionalText(value.description, BOM_LIMITS.description) };
};

/* ── Die Alt-BOM-Kodes der Einstellungen ────────────────────────────────── */

/** Die Vorsätze der Haupt-BOMs (BOM-MEK / BOM-ELK) sind vergeben. */
const RESERVED_PREFIXES = new Set(Object.values(MAIN_BOM_PREFIX));

/**
 * `{ MECHANICAL: [{ prefix, name }], ELECTRICAL: [...] }` aus der Anfrage —
 * jeder Vorsatz gültig (MAK-COOL), nicht BOM-MEK/BOM-ELK, in beiden Bereichen
 * zusammen nur einmal (er zählt seine Nummern selbst).
 */
export const codesFrom = (raw: unknown): Record<BomArea, BomCode[]> => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const result: Record<BomArea, BomCode[]> = { MECHANICAL: [], ELECTRICAL: [] };
    const seen = new Set<string>();
    for (const area of ['MECHANICAL', 'ELECTRICAL'] as const) {
        const list = Array.isArray(input[area]) ? input[area] as unknown[] : [];
        if (list.length > BOM_LIMITS.codesPerArea) {
            throw bomError('SETTINGS_INVALID', `Höchstens ${BOM_LIMITS.codesPerArea} Kodes je Bereich.`, {
                params: { min: 0, max: BOM_LIMITS.codesPerArea },
            });
        }
        list.forEach((entry, index) => {
            const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
            const prefix = prefixFrom(value.prefix);
            if (!prefix) {
                throw bomError('CODE_INVALID', `Kod ${index + 1} ist ungültig (z. B. MAK-COOL).`, { params: { row: index + 1, area } });
            }
            if (RESERVED_PREFIXES.has(prefix)) {
                throw bomError('CODE_RESERVED', `${prefix} gehört der Haupt-BOM.`, { params: { prefix } });
            }
            if (seen.has(prefix)) throw bomError('CODE_DUPLICATE', `${prefix} steht zweimal.`, { params: { prefix } });
            seen.add(prefix);
            result[area].push({ prefix, name: text(value.name, BOM_LIMITS.codeName) || prefix });
        });
    }
    return result;
};

/** Gespeicherte Kodes lesen (JSON aus der Datenbank) — Ungültiges fällt still weg. */
export const storedCodes = (raw: unknown): Record<BomArea, BomCode[]> => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const result: Record<BomArea, BomCode[]> = { MECHANICAL: [], ELECTRICAL: [] };
    for (const area of ['MECHANICAL', 'ELECTRICAL'] as const) {
        const list = Array.isArray(input[area]) ? input[area] as unknown[] : [];
        for (const entry of list) {
            const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
            const prefix = prefixFrom(value.prefix);
            if (prefix && !RESERVED_PREFIXES.has(prefix)) result[area].push({ prefix, name: text(value.name, BOM_LIMITS.codeName) || prefix });
        }
    }
    return result;
};

/* ── Priorität: frühester Liefertermin zuerst ───────────────────────────── */

const time = (value: Date | null): number => (value ? value.getTime() : Number.POSITIVE_INFINITY);

/** «termini önce olan projeye» — ohne Termin ganz hinten, dann die früher freigegebene BOM. */
export const byPriority = (a: BomDemand, b: BomDemand): number =>
    time(a.deliveryDate) - time(b.deliveryDate)
    || time(a.approvedAt) - time(b.approvedAt)
    || a.bomSortOrder - b.bomSortOrder
    || a.bomId.localeCompare(b.bomId)
    || a.lineSortOrder - b.lineSortOrder
    || a.lineId.localeCompare(b.lineId);

/** Offene Menge einer Zeile: Bedarf − abgebucht. */
export const openOf = (line: Pick<BomLine, 'quantity' | 'consumedQuantity'>): number =>
    Math.max(0, round3(line.quantity - line.consumedQuantity));

/* ── Die Rechnung ───────────────────────────────────────────────────────── */

export interface CoverageInput {
    demands: BomDemand[];
    products: Map<string, BomStockProduct>;
    serials: BomSerialFact[];
    incoming: BomIncomingLine[];
}

export interface CoverageResult {
    lines: Map<string, BomLineCoverage>;
    /** Freier Bestand je Karte — was keiner Zeile reserviert ist. */
    free: Map<string, number>;
    /** Reservierter Bestand je Karte. */
    reserved: Map<string, number>;
}

interface Pool { confirmed: number; open: number }

const takeFrom = (pool: Pool, wanted: number): { total: number; confirmed: number } => {
    const fromConfirmed = Math.min(wanted, pool.confirmed);
    pool.confirmed = round3(pool.confirmed - fromConfirmed);
    const fromOpen = Math.min(wanted - fromConfirmed, pool.open);
    pool.open = round3(pool.open - fromOpen);
    return { total: round3(fromConfirmed + fromOpen), confirmed: round3(fromConfirmed) };
};

/**
 * Was jede offene Zeile hat: reserviert, bestellt, fehlend — über alle Geräte
 * der Firma gerechnet (der frühere Liefertermin geht vor).
 */
export const computeCoverage = (input: CoverageInput): CoverageResult => {
    const lines = new Map<string, BomLineCoverage>();
    const free = new Map<string, number>();
    const reservedByProduct = new Map<string, number>();

    const demandsByProduct = new Map<string, BomDemand[]>();
    for (const demand of input.demands) {
        const list = demandsByProduct.get(demand.productId) ?? [];
        list.push(demand);
        demandsByProduct.set(demand.productId, list);
    }
    const serialsByProduct = new Map<string, BomSerialFact[]>();
    for (const serial of input.serials) {
        const list = serialsByProduct.get(serial.productId) ?? [];
        list.push(serial);
        serialsByProduct.set(serial.productId, list);
    }
    const incomingByProduct = new Map<string, BomIncomingLine[]>();
    for (const entry of input.incoming) {
        const list = incomingByProduct.get(entry.productId) ?? [];
        list.push(entry);
        incomingByProduct.set(entry.productId, list);
    }

    const productIds = new Set<string>([
        ...demandsByProduct.keys(),
        ...input.products.keys(),
        ...incomingByProduct.keys(),
    ]);

    for (const productId of productIds) {
        const product = input.products.get(productId) ?? null;
        const demands = [...(demandsByProduct.get(productId) ?? [])].sort(byPriority);
        const state = new Map<string, BomLineCoverage>();
        for (const demand of demands) {
            state.set(demand.lineId, {
                lineId: demand.lineId,
                open: round3(demand.openQuantity),
                reserved: 0,
                incoming: 0,
                incomingConfirmed: 0,
                missing: 0,
                serials: [],
            });
        }

        /* 1) DER BESTAND */
        if (product?.serialRequired) {
            const serials = [...(serialsByProduct.get(productId) ?? [])]
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.serialNumber.localeCompare(b.serialNumber));
            const byDevice = new Map<string, BomSerialFact[]>();
            const byProject = new Map<string, BomSerialFact[]>();
            let freeCount = 0;
            for (const serial of serials) {
                if (serial.productionItemId) {
                    const list = byDevice.get(serial.productionItemId) ?? [];
                    list.push(serial);
                    byDevice.set(serial.productionItemId, list);
                } else if (serial.productionProjectId) {
                    const list = byProject.get(serial.productionProjectId) ?? [];
                    list.push(serial);
                    byProject.set(serial.productionProjectId, list);
                } else {
                    freeCount += 1;
                }
            }
            // Erst die Nummern, die schon am Gerät stehen …
            for (const demand of demands) {
                const entry = state.get(demand.lineId)!;
                const pool = byDevice.get(demand.productionItemId) ?? [];
                while (entry.reserved + 1 - EPS <= entry.open && pool.length) {
                    entry.serials.push(pool.shift()!.serialNumber);
                    entry.reserved += 1;
                }
            }
            // … dann die, die nur dem Projekt zugeordnet sind.
            for (const demand of demands) {
                const entry = state.get(demand.lineId)!;
                const pool = byProject.get(demand.productionProjectId) ?? [];
                while (entry.reserved + 1 - EPS <= entry.open && pool.length) {
                    entry.serials.push(pool.shift()!.serialNumber);
                    entry.reserved += 1;
                }
            }
            free.set(productId, freeCount);
        } else {
            let pool = Math.max(0, round3(product?.quantity ?? 0));
            for (const demand of demands) {
                const entry = state.get(demand.lineId)!;
                const take = Math.min(entry.open, pool);
                entry.reserved = round3(take);
                pool = round3(pool - take);
            }
            free.set(productId, pool);
        }

        /* 2) DIE BESTELLTE WARE — eigene Bestellung zuerst, dann der Überschuss */
        const own = new Map<string, Pool>();
        const surplus: Pool = { confirmed: 0, open: 0 };
        for (const entry of incomingByProduct.get(productId) ?? []) {
            const rest = Math.max(0, round3(entry.quantity - entry.received));
            if (rest <= 0) continue;
            if (!state.has(entry.bomLineId)) {
                if (entry.confirmed) surplus.confirmed = round3(surplus.confirmed + rest);
                else surplus.open = round3(surplus.open + rest);
                continue;
            }
            const pool = own.get(entry.bomLineId) ?? { confirmed: 0, open: 0 };
            if (entry.confirmed) pool.confirmed = round3(pool.confirmed + rest);
            else pool.open = round3(pool.open + rest);
            own.set(entry.bomLineId, pool);
        }
        for (const demand of demands) {
            const entry = state.get(demand.lineId)!;
            const pool = own.get(demand.lineId);
            if (!pool) continue;
            const need = Math.max(0, round3(entry.open - entry.reserved));
            const taken = takeFrom(pool, need);
            entry.incoming = taken.total;
            entry.incomingConfirmed = taken.confirmed;
            surplus.confirmed = round3(surplus.confirmed + pool.confirmed);
            surplus.open = round3(surplus.open + pool.open);
        }
        for (const demand of demands) {
            const entry = state.get(demand.lineId)!;
            const need = Math.max(0, round3(entry.open - entry.reserved - entry.incoming));
            if (need <= 0) continue;
            const taken = takeFrom(surplus, need);
            entry.incoming = round3(entry.incoming + taken.total);
            entry.incomingConfirmed = round3(entry.incomingConfirmed + taken.confirmed);
        }

        let reservedSum = 0;
        for (const entry of state.values()) {
            entry.missing = Math.max(0, round3(entry.open - entry.reserved - entry.incoming));
            reservedSum = round3(reservedSum + entry.reserved);
            lines.set(entry.lineId, entry);
        }
        reservedByProduct.set(productId, reservedSum);
    }

    return { lines, free, reserved: reservedByProduct };
};

/**
 * Welche freien Seriennummern an welche wartende Zeile gehen («rezerve
 * edilenler seri numarası içinde termini önce olan projeye otomatik
 * gitmeli»): die älteste freie Nummer an die Zeile mit dem frühesten Termin.
 * Rechnet auf dem Stand NACH `computeCoverage`.
 */
export const serialAssignments = (
    demands: BomDemand[],
    coverage: Map<string, BomLineCoverage>,
    freeSerials: BomSerialFact[],
): Array<{ serialId: string; demand: BomDemand }> => {
    const pool = [...freeSerials]
        .filter((serial) => !serial.productionItemId && !serial.productionProjectId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.serialNumber.localeCompare(b.serialNumber));
    const result: Array<{ serialId: string; demand: BomDemand }> = [];
    for (const demand of [...demands].sort(byPriority)) {
        const entry = coverage.get(demand.lineId);
        if (!entry) continue;
        let reserved = entry.reserved;
        while (reserved + 1 - EPS <= entry.open && pool.length) {
            const serial = pool.shift()!;
            result.push({ serialId: serial.id, demand });
            reserved += 1;
        }
        if (!pool.length) break;
    }
    return result;
};

/**
 * Nummern eines Geräts, die keine freigegebene Zeile mehr braucht (die BOM
 * ging zurück in den Entwurf oder wurde gelöscht) — sie werden wieder frei.
 */
export const serialsToRelease = (
    deviceSerials: BomSerialFact[],
    stillNeeded: number,
): BomSerialFact[] => {
    const sorted = [...deviceSerials].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const surplus = Math.max(0, sorted.length - Math.max(0, Math.floor(stillNeeded + EPS)));
    return sorted.slice(0, surplus);
};

/* ── «Sipariş oluştur» ──────────────────────────────────────────────────── */

/**
 * Der Vorschlag: jede Zeile, der etwas fehlt — «stokta olmayan kadarı sipariş
 * edilecek», nie unter der Mindestbestellmenge («min 100 ise 100 altı
 * vermemelidir»). Gesperrt ist eine Zeile ohne Depo-Karte, ohne ERP-Code
 * («erp kodları dolu, tüm kodlar olmuşsa») oder mit einer offenen Bestellung
 * («bir ürün için sadece bir listeyi seçebilirsin»).
 */
export const orderProposal = (
    lines: BomLine[],
    coverage: Map<string, BomLineCoverage>,
    products: Map<string, BomStockProduct>,
    openOrderLineIds: Set<string>,
): BomOrderProposalLine[] =>
    lines.flatMap((line): BomOrderProposalLine[] => {
        const entry = coverage.get(line.id);
        const missing = entry ? entry.missing : openOf(line);
        if (missing <= EPS) return [];
        const product = products.get(line.productId) ?? null;
        const minimum = product?.minimumOrderQuantity && product.minimumOrderQuantity > 0 ? product.minimumOrderQuantity : null;
        const block = !product
            ? 'NO_PRODUCT' as const
            : !product.erpCode
                ? 'NO_ERP_CODE' as const
                : openOrderLineIds.has(line.id) ? 'OPEN_ORDER' as const : null;
        return [{ lineId: line.id, missing: round3(missing), minimum, floor: ceil3(Math.max(missing, minimum ?? 0)), block }];
    });

/**
 * Die Eingabe von «Sipariş oluştur» prüfen: nie unter der Untergrenze, mehr
 * nur mit Erklärung («daha fazlası edilecekse açıklama yazacak — açıklamasız
 * kabul edilmeyecek»), jede Zeile mit Lieferant, jede Zeile einmal.
 */
export const orderLinesFrom = (raw: unknown, proposal: BomOrderProposalLine[]): BomOrderLineInput[] => {
    if (!Array.isArray(raw) || !raw.length) throw bomError('ORDER_EMPTY', 'Keine Zeile zum Bestellen gewählt.');
    const byLine = new Map(proposal.map((entry) => [entry.lineId, entry]));
    const seen = new Set<string>();
    const problems: Array<{ lineId: string; code: BomErrorCode; floor?: number }> = [];
    const result: BomOrderLineInput[] = [];
    for (const entry of raw) {
        const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const lineId = text(value.lineId, 64);
        const proposed = byLine.get(lineId);
        if (!lineId || seen.has(lineId)) {
            problems.push({ lineId, code: 'LINE_DUPLICATE' });
            continue;
        }
        seen.add(lineId);
        if (!proposed || proposed.block) {
            problems.push({ lineId, code: 'LINE_BLOCKED' });
            continue;
        }
        const quantity = quantityFrom(value.quantity);
        if (quantity === null || quantity + EPS < proposed.floor) {
            problems.push({ lineId, code: 'QTY_BELOW_FLOOR', floor: proposed.floor });
            continue;
        }
        const note = optionalText(value.note, BOM_LIMITS.note);
        if (quantity > proposed.floor + EPS && !note) {
            problems.push({ lineId, code: 'NOTE_REQUIRED', floor: proposed.floor });
            continue;
        }
        const supplierName = text(value.supplierName, 191);
        if (!supplierName) {
            problems.push({ lineId, code: 'SUPPLIER_REQUIRED' });
            continue;
        }
        const supplierId = text(value.supplierId, 64) || null;
        result.push({ lineId, quantity, supplierId, supplierName, note });
    }
    const first = problems[0];
    if (first) {
        throw bomError(first.code, 'Die Bestellung ist nicht vollständig.', {
            ...(first.floor !== undefined ? { params: { floor: first.floor } } : {}),
            details: problems,
        });
    }
    return result;
};

/** Gleicher Lieferant? Mit Kennung über sie, sonst über den Namen (ohne Gross/Klein). */
export const supplierKey = (supplierId: string | null, supplierName: string): string =>
    supplierId ? `id:${supplierId}` : `name:${supplierName.trim().toLocaleLowerCase('tr-TR')}`;

/**
 * Derselbe Lieferant? Tragen beide eine Kennung, entscheidet sie — sonst der
 * Name ohne Gross/Klein (der Firmenname eines Lieferanten ist je Firma
 * eindeutig). So findet auch eine Zeile ohne Kennung die Bestellung ihres
 * Lieferanten.
 */
export const sameSupplier = (
    a: { supplierId: string | null; supplierName: string },
    b: { supplierId: string | null; supplierName: string },
): boolean => (a.supplierId && b.supplierId
    ? a.supplierId === b.supplierId
    : a.supplierName.trim().toLocaleLowerCase('tr-TR') === b.supplierName.trim().toLocaleLowerCase('tr-TR'));

/* ── «Aynı tedarikçi → aynı sipariş» (27.09.2026) ───────────────────────────
 *
 * «Sipariş oluştur dedikten sonra ayrı ayrı siparişler oluşturulursa, aynı
 *  tedarikçiye ait ise o tek sipariş altında birleştirilir, zaten olan
 *  siparişe eklenir (aynı BOM altında).» (Samet)
 *
 * Eine BOM hat je Lieferant EINE offene Bestellung: ein zweiter Durchgang von
 * «Sipariş oluştur» legt keine neue an, er ergänzt die, die es schon gibt —
 * solange sie ein Entwurf ist, der nie beim Lieferanten war
 * (`acceptsMoreLines`). Eine Bestellung beim Lieferanten ändert sich nie still;
 * für sie entsteht wie bisher eine neue.
 */

/**
 * Die Positionen einer Bestellung, um neue BOM-Zeilen ergänzt. Eine BOM-Zeile
 * steht je Bestellung nur EINMAL: steht sie schon darin (dieselbe Einheit),
 * wächst ihre Menge — eine übernommene Zeile (DIRECT) trägt ihren Betrag fest,
 * er rechnet dann neu (Menge × Nettopreis); sonst kommt die Position hinten
 * dazu, in der Reihenfolge der BOM.
 */
export const mergeOrderItems = (
    items: Array<Record<string, unknown>>,
    additions: Array<Record<string, unknown> & { bomLineId: string; quantity: number }>,
): Array<Record<string, unknown>> => {
    const next = items.map((item) => ({ ...item }));
    for (const addition of additions) {
        const index = next.findIndex((item) => item.bomLineId === addition.bomLineId
            && String(item.unit ?? '') === String(addition.unit ?? ''));
        if (index < 0) {
            next.push({ ...addition });
            continue;
        }
        const copy: Record<string, unknown> = { ...next[index]!, quantity: round3((Number(next[index]!.quantity) || 0) + addition.quantity) };
        if (String(copy.calcMode ?? '').toUpperCase() === 'DIRECT' || copy.directCopy === true) delete copy.lineTotal;
        next[index] = copy;
    }
    return next;
};

/**
 * Die Zeilen der Verknüpfung (wie bestellt wurde) nach dem Ergänzen: je
 * BOM-Zeile ein Eintrag — eine schon bestellte Zeile addiert ihr «fehlend»
 * und behält beide Erklärungen; `ordered` ist, was die Bestellung jetzt trägt.
 */
export const mergeLinkRecords = (
    records: BomPurchaseLineRecord[],
    additions: BomPurchaseLineRecord[],
    items: Array<Record<string, unknown>>,
): BomPurchaseLineRecord[] => {
    const ordered = new Map<string, number>();
    for (const item of items) {
        const bomLineId = typeof item.bomLineId === 'string' ? item.bomLineId : null;
        if (bomLineId) ordered.set(bomLineId, round3((ordered.get(bomLineId) ?? 0) + (Number(item.quantity) || 0)));
    }
    const result = records.map((record) => ({ ...record }));
    for (const addition of additions) {
        const existing = result.find((record) => record.bomLineId === addition.bomLineId);
        if (!existing) {
            result.push({ ...addition });
            continue;
        }
        existing.missing = round3(existing.missing + addition.missing);
        existing.minimum = addition.minimum ?? existing.minimum;
        existing.note = [existing.note, addition.note]
            .filter((note): note is string => Boolean(note?.trim()))
            .join(' · ')
            .slice(0, BOM_LIMITS.note) || null;
    }
    return result.map((record) => ({ ...record, ordered: ordered.get(record.bomLineId) ?? record.ordered }));
};

/* ── «Fiyat talebi» ─────────────────────────────────────────────────────── */

/**
 * Die Eingabe von «Fiyat talebi» prüfen (27.09.2026, Vorgabe Samet: «birden
 * fazla tedarikçiye aynı ürün eklenip fiyat talebi alınabilsin … birden fazla
 * tedarikçi seçilebilsin»): jede Zeile der BOM höchstens einmal, Menge > 0,
 * mindestens ein Lieferant — derselbe Lieferant zählt je Zeile nur einmal.
 * Mindestmenge und Erklärung einer Mehrmenge gelten hier nicht: gefragt wird
 * nur der Preis (Name, Modell, Menge).
 */
export const requestLinesFrom = (raw: unknown, lineIds: Set<string>): BomRequestLineInput[] => {
    if (!Array.isArray(raw) || !raw.length) throw bomError('REQUEST_EMPTY', 'Keine Zeile für die Preisanfrage gewählt.');
    if (raw.length > BOM_LIMITS.lines) {
        throw bomError('LINES_TOO_MANY', `Höchstens ${BOM_LIMITS.lines} Zeilen.`, { params: { max: BOM_LIMITS.lines } });
    }
    const seen = new Set<string>();
    const problems: Array<{ lineId: string; code: BomErrorCode }> = [];
    const result: BomRequestLineInput[] = [];
    for (const entry of raw) {
        const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const lineId = text(value.lineId, 64);
        if (!lineId || seen.has(lineId)) {
            problems.push({ lineId, code: 'LINE_DUPLICATE' });
            continue;
        }
        seen.add(lineId);
        if (!lineIds.has(lineId)) {
            problems.push({ lineId, code: 'LINE_UNKNOWN' });
            continue;
        }
        const quantity = quantityFrom(value.quantity);
        if (quantity === null) {
            problems.push({ lineId, code: 'QTY_INVALID' });
            continue;
        }
        const suppliers = new Map<string, { supplierId: string | null; supplierName: string }>();
        for (const item of Array.isArray(value.suppliers) ? value.suppliers : []) {
            const supplier = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
            const supplierName = text(supplier.supplierName, 191);
            if (!supplierName) continue;
            const supplierId = text(supplier.supplierId, 64) || null;
            const key = supplierKey(supplierId, supplierName);
            if (!suppliers.has(key)) suppliers.set(key, { supplierId, supplierName });
        }
        if (!suppliers.size) {
            problems.push({ lineId, code: 'SUPPLIER_REQUIRED' });
            continue;
        }
        if (suppliers.size > BOM_LIMITS.requestSuppliers) {
            problems.push({ lineId, code: 'SUPPLIERS_TOO_MANY' });
            continue;
        }
        result.push({ lineId, quantity, suppliers: [...suppliers.values()] });
    }
    const first = problems[0];
    if (first) {
        throw bomError(first.code, 'Die Preisanfrage ist nicht vollständig.', {
            ...(first.code === 'SUPPLIERS_TOO_MANY' ? { params: { max: BOM_LIMITS.requestSuppliers } } : {}),
            details: problems,
        });
    }
    return result;
};

/* ── «BOM tamamla» ──────────────────────────────────────────────────────── */

export interface BomCompletion {
    /** Keiner Zeile fehlt etwas (alles ist im Bestand oder bestellt). */
    ordered: boolean;
    /** Jede Bestellung dieser BOM ist bestätigt. */
    confirmed: boolean;
    /** Jede Zeile ist vollständig aus dem Bestand reserviert. */
    reserved: boolean;
    /** Haupt-BOM: wie viele Alt-BOMs darunter, wie viele davon abgeschlossen. */
    subs: { total: number; completed: number };
    ready: boolean;
}

/**
 * «Sadece tüm bomları sipariş edip siparişleri onaylayınca rezerveler tam
 *  anlamıyla oluşunca BOM TAMAMLA olur.»
 */
export const completionOf = (
    bom: Pick<Bom, 'status' | 'lines'> & { kind?: Bom['kind'] },
    coverage: Map<string, BomLineCoverage>,
    orders: Array<{ kind: string; confirmed: boolean }>,
    /** Nur die Haupt-BOM: ihre Alt-BOMs (abgeschlossen = COMPLETED, auch schon abgebucht). */
    subs: Array<{ completed: boolean }> = [],
): BomCompletion => {
    const open = bom.lines.filter((line) => openOf(line) > EPS);
    const ordered = open.every((line) => (coverage.get(line.id)?.missing ?? openOf(line)) <= EPS);
    const reserved = open.every((line) => (coverage.get(line.id)?.reserved ?? 0) + EPS >= openOf(line));
    const purchaseOrders = orders.filter((order) => order.kind === 'ORDER');
    // Ohne Bestellung ist «bestätigt» nur wahr, wenn nichts zu bestellen war —
    // sonst stünde bei neun fehlenden Zeilen schon ein grüner Haken.
    const confirmed = purchaseOrders.length ? purchaseOrders.every((order) => order.confirmed) : ordered;
    const completedSubs = subs.filter((sub) => sub.completed).length;
    // Die Haupt-BOM darf ohne eigene Zeilen abschliessen — dann tragen die Alt-BOMs sie.
    const hasContent = bom.lines.length > 0 || subs.length > 0;
    // Die Haupt-BOM ohne eigene Zeilen ist nur die Klammer (Samet 27.09.2026:
    // «ilk başta bu olmasın … alt BOM'lar olsun») — sie braucht keine Freigabe.
    const container = bom.kind === 'MAIN' && bom.lines.length === 0;
    const statusOk = bom.status === 'APPROVED' || (container && bom.status === 'DRAFT');
    return {
        ordered,
        confirmed,
        reserved,
        subs: { total: subs.length, completed: completedSubs },
        ready: statusOk && hasContent && ordered && confirmed && reserved && completedSubs === subs.length,
    };
};

/* ── Die Regeln der BOM-Belege (Lieferantenbestellung / Preisanfrage) ────── */

/** Bestätigt heisst: beim Lieferanten fest und die Ware wird erwartet (oder ist da). */
export const CONFIRMED_ORDER_STATUSES = new Set(['PENDING', 'TO_BE_STOCKED', 'COMPLETED']);
/** Auf diese Stände geht nur, wer die Bedingungen erfüllt («siparişi onaylayamasınız»). */
export const CONFIRMING_STATUSES = new Set(['PENDING', 'TO_BE_STOCKED', 'COMPLETED']);
export const PRICE_REQUEST_STATUSES = new Set(['DRAFT', 'PRICE_REQUEST']);

/**
 * Was vor der Bestätigung fehlt: die Angebotsnummer des Lieferanten
 * («tedarikçi sipariş numarasını yazmadan … ne de siparişi onaylayabiliyoruz»)
 * und sein Angebots-PDF («sipariş onayından önce … fiyat teklifi zorunlu»).
 */
export const confirmProblems = (
    order: { quoteNumber?: string | null },
    link: { quoteFileRef: string | null } | null,
): Array<'QUOTE_NUMBER' | 'QUOTE_FILE'> => {
    const problems: Array<'QUOTE_NUMBER' | 'QUOTE_FILE'> = [];
    if (!String(order.quoteNumber ?? '').trim()) problems.push('QUOTE_NUMBER');
    if (!link?.quoteFileRef) problems.push('QUOTE_FILE');
    return problems;
};

interface LockedItem {
    bomLineId?: unknown;
    code?: unknown;
    name?: unknown;
    quantity?: unknown;
}

const lockKey = (item: LockedItem): string => [
    String(item?.bomLineId ?? ''),
    String(item?.code ?? '').trim(),
    String(item?.name ?? '').trim(),
    round3(Number(item?.quantity) || 0),
].join('\u0001');

/**
 * «Sütun ekleyebiliyoruz, ancak satır ekleyemiyoruz.» Dieselben Zeilen mit
 * derselben BOM-Zeile, demselben Code, Namen und derselben Menge — Preise und
 * eigene Spalten dürfen sich ändern. `true` = unverändert.
 */
export const sameLockedRows = (before: unknown, after: unknown): boolean => {
    const a = Array.isArray(before) ? before : [];
    const b = Array.isArray(after) ? after : [];
    if (a.length !== b.length) return false;
    const left = a.map((item) => lockKey(item as LockedItem)).sort();
    const right = b.map((item) => lockKey(item as LockedItem)).sort();
    return left.every((key, index) => key === right[index]);
};

/** Die Einheit einer BOM-Zeile, wie sie in der Bestellung steht (Anlegen UND Revision). */
export const ORDER_UNIT_LABELS: Record<BomUnit, string> = { PCS: 'Adet', M: 'm', KG: 'kg', SET: 'Set', PACK: 'Paket' };

/* ── Revisionen (27.09.2026, Vorgabe Samet) ─────────────────────────────────
 *
 * «Bom onaylandıktan sonra artık sipariş verilirse eski bom artık kayıt
 *  edilmeli ve yeni revizyon oluşturulmalı … bom onaylanırsa geri dönüş yok,
 *  revize olması lazım.»
 *
 * Die Regeln, auf die sich Samet und Claude am 27.09.2026 geeinigt haben:
 *   · Eine freigegebene BOM ändert sich nie an Ort und Stelle — die Nummer
 *     bleibt, die Revision zählt hoch (MAK-COOL-00001 Rev.0 → Rev.1), die
 *     alte Fassung bleibt als Abzug stehen.
 *   · Die Kennung einer Zeile bleibt je Karte über alle Revisionen — so
 *     bleiben die Bestellungen an ihrer Zeile.
 *   · Eine Bestellung beim Lieferanten ändert sich nie still: die Freigabe
 *     zeigt vorher, was mit jeder geschieht, und der Einkauf bestätigt.
 *       Entwurf (nie hinausgegangen)   → die Zeilen ändern sich direkt
 *       beim Lieferanten, Ware fehlt   → dieselbe Nummer, Revision +1, der
 *                                        Lieferant bestätigt neu
 *       Ware da                         → bleibt; ein Mehr wird neu bestellt,
 *                                        ein Weniger bleibt frei im Bestand
 */

/** Eine Zeile, wie der Vergleich sie braucht (BOM-Zeile oder Zeile einer Revision). */
export type RevisionLineLike = Pick<BomRevisionLine, 'id' | 'productId' | 'erpCode' | 'name' | 'unit' | 'quantity' | 'note'>;

/**
 * Die Kennungen der Zeilen einer neuen Fassung: je Karte zuerst eine der
 * `pools` der Reihe nach (geltende BOM, dann Arbeitskopie), sonst eine neue.
 * Dieselbe Kennung wird nie zweimal vergeben.
 */
export const revisionLineIds = (
    next: Array<{ productId: string }>,
    pools: Array<Array<{ id: string; productId: string }>>,
    newId: () => string,
): string[] => {
    const used = new Set<string>();
    const queues = pools.map((pool) => {
        const byProduct = new Map<string, string[]>();
        for (const line of pool) byProduct.set(line.productId, [...(byProduct.get(line.productId) ?? []), line.id]);
        return byProduct;
    });
    return next.map((line) => {
        for (const queue of queues) {
            const list = queue.get(line.productId);
            while (list?.length) {
                const id = list.shift()!;
                if (!used.has(id)) {
                    used.add(id);
                    return id;
                }
            }
        }
        let id = newId();
        while (used.has(id)) id = newId();
        used.add(id);
        return id;
    });
};

const sameNote = (a: string | null | undefined, b: string | null | undefined): boolean =>
    String(a ?? '').trim() === String(b ?? '').trim();

/** Was sich von `before` (geltende Fassung) zu `after` (neue Fassung) ändert — in der Reihenfolge der neuen, Entferntes am Ende. */
export const revisionChanges = (before: RevisionLineLike[], after: RevisionLineLike[]): BomLineChange[] => {
    const beforeById = new Map(before.map((line) => [line.id, line]));
    const afterIds = new Set(after.map((line) => line.id));
    const changes: BomLineChange[] = [];
    for (const line of after) {
        const old = beforeById.get(line.id);
        if (!old) {
            changes.push({
                kind: 'ADDED',
                lineId: line.id,
                productId: line.productId,
                erpCode: line.erpCode,
                name: line.name,
                unitBefore: null,
                unitAfter: line.unit,
                before: 0,
                after: round3(line.quantity),
                noteBefore: null,
                noteAfter: line.note,
            });
            continue;
        }
        const qtyBefore = round3(old.quantity);
        const qtyAfter = round3(line.quantity);
        const kind = qtyAfter > qtyBefore + EPS
            ? 'INCREASED' as const
            : qtyAfter + EPS < qtyBefore
                ? 'DECREASED' as const
                : old.unit !== line.unit || !sameNote(old.note, line.note) ? 'EDITED' as const : null;
        if (!kind) continue;
        changes.push({
            kind,
            lineId: line.id,
            productId: line.productId,
            erpCode: line.erpCode ?? old.erpCode,
            name: line.name || old.name,
            unitBefore: old.unit,
            unitAfter: line.unit,
            before: qtyBefore,
            after: qtyAfter,
            noteBefore: old.note,
            noteAfter: line.note,
        });
    }
    for (const old of before) {
        if (afterIds.has(old.id)) continue;
        changes.push({
            kind: 'REMOVED',
            lineId: old.id,
            productId: old.productId,
            erpCode: old.erpCode,
            name: old.name,
            unitBefore: old.unit,
            unitAfter: null,
            before: round3(old.quantity),
            after: 0,
            noteBefore: old.note,
            noteAfter: null,
        });
    }
    return changes;
};

/**
 * Der Bedarf der Firma, wie er NACH der Revision wäre: die Zeilen dieser BOM
 * durch die der neuen Fassung ersetzt (Priorität, Termin und Freigabe der BOM
 * bleiben — eine Revision drängelt sich nicht vor).
 */
export const demandsWithRevision = (
    demands: BomDemand[],
    bom: Pick<Bom, 'id' | 'productionProjectId' | 'productionItemId' | 'approvedAt' | 'sortOrder'>,
    lines: Array<Pick<BomRevisionLine, 'id' | 'productId' | 'quantity'>>,
    deliveryDate: Date | null,
): BomDemand[] => [
    ...demands.filter((demand) => demand.bomId !== bom.id),
    ...lines.map((line, index) => ({
        lineId: line.id,
        bomId: bom.id,
        productId: line.productId,
        productionProjectId: bom.productionProjectId,
        productionItemId: bom.productionItemId,
        openQuantity: Math.max(0, round3(line.quantity)),
        deliveryDate,
        approvedAt: bom.approvedAt,
        bomSortOrder: bom.sortOrder,
        lineSortOrder: index,
    })),
];

/** Eine Bestellung der BOM, wie der Plan sie liest. */
export interface RevisionPlanOrder {
    purchaseOrderId: string;
    referenceNumber: string;
    supplierName: string;
    status: string;
    emailSentAt: Date | null;
    createdAt: Date;
    /** Wie oft sie schon revidiert wurde (uretim_bom_siparisleri.orderRevision). */
    orderRevision: number;
    items: Array<{ index: number; bomLineId: string | null; code: string | null; name: string; unit: string | null; quantity: number; received: number }>;
}

/** Hat der Lieferant die Bestellung (Mail hinaus oder bestätigt)? */
export const orderAtSupplier = (order: { status: string; emailSentAt: Date | null }): boolean =>
    Boolean(order.emailSentAt) || ['ORDERED', 'PENDING', 'TO_BE_STOCKED'].includes(String(order.status).toUpperCase());

/**
 * Nimmt eine Bestellung der BOM noch Zeilen auf («zaten olan siparişe
 * eklenir»)? Nur ein Entwurf, der nie beim Lieferanten war.
 */
export const acceptsMoreLines = (order: { status: string; emailSentAt: Date | null }): boolean =>
    String(order.status).toUpperCase() === 'ORDER_DRAFT' && !orderAtSupplier(order);

/**
 * Was die Revision mit jeder Bestellung macht (nur die betroffenen):
 *   · MEHR   die offene Bestellung der Zeile wächst um das, was Bestand und
 *            unterwegs befindliche Ware nicht decken (`missingAfter`, höchstens
 *            um das Mehr der Revision); ohne offene Bestellung bestellt man das
 *            Fehlende danach wie immer über «Sipariş oluştur».
 *   · WENIGER die offenen Bestellungen der Zeile (neueste zuerst) schrumpfen um
 *            das Weniger — nie unter das schon Gelieferte und, solange die Zeile
 *            bleibt, nicht unter die Mindestbestellmenge.
 *   · WEG    was noch nicht geliefert ist, fällt weg.
 *   · EINHEIT die offenen Positionen der Zeile bekommen die neue Einheit.
 * Eine Bestellung, deren Zeilen alle wegfallen: als Entwurf gelöscht, beim
 * Lieferanten stehen gelassen (CANCEL — der Einkauf klärt die Stornierung).
 * `keep` = Bestellungen, die der Einkauf trotz Minderung so lassen will
 * («tedarikçi azaltmayı kabul etmezse») — nur, wo nichts mehr gebraucht wird.
 */
export const revisionOrderPlan = (input: {
    changes: BomLineChange[];
    orders: RevisionPlanOrder[];
    missingAfter: Map<string, number>;
    minimums: Map<string, number | null>;
    keep?: Set<string>;
}): BomOrderAction[] => {
    const open = input.orders
        .filter((order) => !PRICE_REQUEST_STATUSES.has(String(order.status).toUpperCase()) && String(order.status).toUpperCase() !== 'COMPLETED')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    type Target = { after: number; unitAfter: string | null };
    const targets = new Map<string, Map<number, Target>>();
    const itemOf = (orderId: string, index: number) => open.find((order) => order.purchaseOrderId === orderId)?.items.find((item) => item.index === index);
    const setTarget = (orderId: string, index: number, patch: Partial<Target>) => {
        const item = itemOf(orderId, index);
        if (!item) return;
        const map = targets.get(orderId) ?? new Map<number, Target>();
        const current = map.get(index) ?? { after: item.quantity, unitAfter: item.unit };
        map.set(index, { ...current, ...patch });
        targets.set(orderId, map);
    };
    const entriesOf = (lineId: string) => open.flatMap((order) => order.items
        .filter((item) => item.bomLineId === lineId && item.received + EPS < item.quantity)
        .map((item) => ({ order, item })));

    for (const change of input.changes) {
        if (change.kind === 'ADDED') continue;
        const entries = entriesOf(change.lineId);
        if (!entries.length) continue;
        const unitChanged = change.unitAfter !== null && change.unitBefore !== change.unitAfter;
        const unitAfter = change.unitAfter ? ORDER_UNIT_LABELS[change.unitAfter] ?? null : null;
        if (change.kind === 'REMOVED') {
            for (const { order, item } of entries) setTarget(order.purchaseOrderId, item.index, { after: round3(item.received) });
            continue;
        }
        if (change.kind === 'INCREASED') {
            const delta = round3(change.after - change.before);
            const missing = input.missingAfter.get(change.lineId);
            const add = round3(Math.min(delta, Math.max(0, missing ?? delta)));
            const newest = entries[0]!;
            if (add > EPS) setTarget(newest.order.purchaseOrderId, newest.item.index, { after: round3(newest.item.quantity + add) });
        } else if (change.kind === 'DECREASED') {
            let remaining = round3(change.before - change.after);
            const minimum = input.minimums.get(change.lineId) ?? null;
            for (const { order, item } of entries) {
                if (remaining <= EPS) break;
                const cut = Math.min(remaining, round3(item.quantity - item.received));
                let after = round3(item.quantity - cut);
                // Eine bleibende Zeile geht nicht unter die Mindestbestellmenge.
                if (minimum && after > item.received + EPS && after + EPS < minimum) after = round3(Math.min(item.quantity, Math.max(minimum, item.received)));
                remaining = round3(remaining - (item.quantity - after));
                if (Math.abs(after - item.quantity) > EPS) setTarget(order.purchaseOrderId, item.index, { after });
            }
        }
        if (unitChanged && unitAfter) {
            for (const { order, item } of entries) {
                if (item.unit !== unitAfter) setTarget(order.purchaseOrderId, item.index, { unitAfter });
            }
        }
    }

    const actions: BomOrderAction[] = [];
    for (const order of open) {
        const map = targets.get(order.purchaseOrderId);
        if (!map) continue;
        const lines: BomOrderActionLine[] = [];
        let remainingItems = 0;
        let onlyLess = true;
        for (const item of order.items) {
            const target = map.get(item.index);
            const after = target ? target.after : item.quantity;
            if (after > EPS) remainingItems += 1;
            if (!target) continue;
            const unitAfter = target.unitAfter ?? item.unit;
            if (Math.abs(after - item.quantity) <= EPS && unitAfter === item.unit) continue;
            if (after > item.quantity + EPS || unitAfter !== item.unit) onlyLess = false;
            lines.push({
                index: item.index,
                bomLineId: item.bomLineId ?? '',
                code: item.code,
                name: item.name,
                unitBefore: item.unit,
                unitAfter,
                before: round3(item.quantity),
                after: round3(after),
                received: round3(item.received),
            });
        }
        if (!lines.length) continue;
        const atSupplier = orderAtSupplier(order);
        const status = String(order.status).toUpperCase();
        let action: BomOrderAction['action'];
        let statusAfter = status;
        let orderRevision: number | null = null;
        if (!atSupplier) {
            action = remainingItems ? 'UPDATE' : 'DELETE';
        } else if (!remainingItems) {
            action = 'CANCEL';
        } else {
            action = 'REVISE';
            orderRevision = order.orderRevision + 1;
            // Die Bestätigung galt der alten Fassung: bis der Lieferant neu bestätigt, ist sie offen.
            if (CONFIRMED_ORDER_STATUSES.has(status)) statusAfter = order.emailSentAt ? 'ORDERED' : 'ORDER_DRAFT';
        }
        const canKeep = atSupplier && onlyLess;
        if (canKeep && action === 'REVISE' && input.keep?.has(order.purchaseOrderId)) {
            action = 'KEEP';
            orderRevision = null;
            statusAfter = status;
        }
        actions.push({
            purchaseOrderId: order.purchaseOrderId,
            referenceNumber: order.referenceNumber,
            supplierName: order.supplierName,
            status,
            atSupplier,
            action,
            canKeep,
            orderRevision,
            statusAfter,
            lines,
        });
    }
    return actions;
};
