"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.revisionOrderPlan = exports.acceptsMoreLines = exports.orderAtSupplier = exports.demandsWithRevision = exports.revisionChanges = exports.revisionLineIds = exports.ORDER_UNIT_LABELS = exports.sameLockedRows = exports.confirmProblems = exports.PRICE_REQUEST_STATUSES = exports.CONFIRMING_STATUSES = exports.CONFIRMED_ORDER_STATUSES = exports.completionOf = exports.requestLinesFrom = exports.mergeLinkRecords = exports.mergeOrderItems = exports.sameSupplier = exports.supplierKey = exports.orderLinesFrom = exports.orderProposal = exports.serialsToRelease = exports.serialAssignments = exports.computeCoverage = exports.openOf = exports.byPriority = exports.storedCodes = exports.storedCodeList = exports.codesFrom = exports.templateHeadFrom = exports.lineDraftsFrom = exports.quantityFrom = exports.formatBomNumber = exports.prefixFrom = exports.unitFrom = exports.newBomCategoryId = exports.categoryInputFrom = exports.categoryCodeFrom = exports.BOM_CATEGORY_LIMITS = exports.areaFrom = exports.categoryFrom = exports.ceil3 = exports.round3 = exports.BOM_NUMBER_DIGITS = exports.PREFIX_MAX = exports.BOM_LIMITS = exports.bomErrorBody = exports.isBomError = exports.bomError = exports.assertErpCodes = void 0;
const ProductionBom_1 = require("../entities/ProductionBom");
/**
 * «ERP kodları olmadan BOM onaylanamasın» (Samet, 30.09.2026): die Zeilen,
 * deren Depo-Karte (noch) keinen ERP-Code trägt — z. B. ohne Materialgruppe.
 */
const assertErpCodes = (lines, products) => {
    const missing = lines.filter((line) => !String(products.get(line.productId)?.erpCode ?? '').trim());
    if (!missing.length)
        return;
    throw (0, exports.bomError)('ERP_CODE_MISSING', 'Ohne ERP-Code lässt sich die BOM nicht freigeben.', {
        status: 409,
        params: {
            count: missing.length,
            names: missing.slice(0, 3).map((line) => products.get(line.productId)?.name ?? line.name).join(', ') + (missing.length > 3 ? ' …' : ''),
        },
    });
};
exports.assertErpCodes = assertErpCodes;
const bomError = (code, message, options = {}) => Object.assign(new Error(message), {
    code,
    status: options.status ?? 400,
    ...(options.params ? { params: options.params } : {}),
    ...(options.details !== undefined ? { details: options.details } : {}),
});
exports.bomError = bomError;
const isBomError = (error) => Boolean(error)
    && typeof error.code === 'string'
    && typeof error.status === 'number'
    && error instanceof Error;
exports.isBomError = isBomError;
/** Antwortkörper — Kennung, Werte und Zeilen reisen mit (Oberfläche: `productionBom.err.*`). */
const bomErrorBody = (error) => ({
    error: error.message || 'Error',
    code: error.code,
    ...(error.params ? { params: error.params } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
});
exports.bomErrorBody = bomErrorBody;
/* ── Grenzen ────────────────────────────────────────────────────────────── */
exports.BOM_LIMITS = {
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
};
/** Vorsatz der BOM-Nummer: 2–4 Teile aus A–Z/0–9, mit «-» verbunden (ELK-PANO-MONTAJ). */
const PREFIX_RE = /^[A-Z0-9]{2,8}(?:-[A-Z0-9]{2,10}){1,3}$/;
exports.PREFIX_MAX = 24;
exports.BOM_NUMBER_DIGITS = 5;
const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;
exports.round3 = round3;
/** Auf drei Stellen AUFgerundet — eine Mindestmenge darf nie unterschritten werden. */
const ceil3 = (value) => Math.ceil((Number(value) || 0) * 1000 - 1e-6) / 1000;
exports.ceil3 = ceil3;
const EPS = 1e-9;
const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const optionalText = (value, max) => {
    const clean = String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
    return clean ? clean : null;
};
/** «makine / elektrik» — auch die Wörter der drei Sprachen werden verstanden. */
const categoryFrom = (value) => {
    const raw = String(value ?? '').trim().toUpperCase();
    if (ProductionBom_1.BOM_CATEGORIES.includes(raw))
        return raw;
    if (['MAKINE', 'MAKİNE', 'MECHANICAL', 'MEKANIK', 'MASCHINE'].includes(raw))
        return 'MACHINE';
    if (['ELEKTRIK', 'ELEKTRİK', 'ELECTRIC'].includes(raw))
        return 'ELECTRICAL';
    // Eine eigene Kategorie («c-…») — ob es sie gibt, prüft der Anwendungsfall.
    const custom = String(value ?? '').trim().toLowerCase();
    return (0, ProductionBom_1.isCustomBomCategory)(custom) ? custom : null;
};
exports.categoryFrom = categoryFrom;
const areaFrom = (value) => {
    const raw = String(value ?? '').trim().toUpperCase();
    if (raw === 'MECHANICAL' || raw === 'MECHANIK' || raw === 'MEKANIK')
        return 'MECHANICAL';
    if (raw === 'ELECTRICAL' || raw === 'ELEKTRIK')
        return 'ELECTRICAL';
    const custom = String(value ?? '').trim().toLowerCase();
    return (0, ProductionBom_1.isCustomBomCategory)(custom) ? custom : null;
};
exports.areaFrom = areaFrom;
/* ── Eigene Kategorien ──────────────────────────────────────────────────── */
exports.BOM_CATEGORY_LIMITS = { categories: 20, name: 60 };
/** Kod einer Kategorie: 2–8 Zeichen A–Z/0–9 (HYD → BOM-HYD-00001). */
const CATEGORY_CODE_RE = /^[A-Z0-9]{2,8}$/;
const categoryCodeFrom = (value) => {
    const raw = String(value ?? '').trim().toUpperCase().replace(/[İ]/g, 'I').replace(/\s+/g, '');
    return CATEGORY_CODE_RE.test(raw) ? raw : null;
};
exports.categoryCodeFrom = categoryCodeFrom;
/** Name und Kod einer eigenen Kategorie aus der Anfrage; MEK/ELK gehören den festen. */
const categoryInputFrom = (raw) => {
    const value = (raw && typeof raw === 'object' ? raw : {});
    const name = text(value.name, exports.BOM_CATEGORY_LIMITS.name);
    if (!name)
        throw (0, exports.bomError)('CATEGORY_NAME_REQUIRED', 'Die Kategorie braucht einen Namen.');
    const code = (0, exports.categoryCodeFrom)(value.code);
    if (!code)
        throw (0, exports.bomError)('CATEGORY_CODE_INVALID', 'Kod: 2–8 Zeichen A–Z / 0–9 (z. B. HYD).');
    if (Object.values(ProductionBom_1.BUILT_IN_CATEGORY_CODE).includes(code)) {
        throw (0, exports.bomError)('CATEGORY_CODE_TAKEN', `${code} gehört einer festen Kategorie.`, { status: 409, params: { code } });
    }
    return { name, code };
};
exports.categoryInputFrom = categoryInputFrom;
const newBomCategoryId = () => `c-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
exports.newBomCategoryId = newBomCategoryId;
const unitFrom = (value) => {
    const raw = String(value ?? '').trim().toUpperCase();
    return ProductionBom_1.BOM_UNITS.includes(raw) ? raw : 'PCS';
};
exports.unitFrom = unitFrom;
/** «MAK-COOL-XXXX» → «MAK-COOL»; Kleinschreibung und Leerzeichen werden bereinigt. */
const prefixFrom = (value) => {
    const raw = String(value ?? '')
        .trim()
        .toUpperCase()
        .replace(/[İ]/g, 'I')
        .replace(/\s+/g, '-')
        .replace(/-X{3,}$/, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (!raw || raw.length > exports.PREFIX_MAX || !PREFIX_RE.test(raw))
        return null;
    return raw;
};
exports.prefixFrom = prefixFrom;
const formatBomNumber = (prefix, seq) => `${prefix}-${String(Math.max(1, Math.trunc(seq))).padStart(exports.BOM_NUMBER_DIGITS, '0')}`;
exports.formatBomNumber = formatBomNumber;
/** Menge einer Zeile: > 0, höchstens drei Nachkommastellen. */
const quantityFrom = (value) => {
    const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > exports.BOM_LIMITS.quantityMax)
        return null;
    return (0, exports.round3)(parsed);
};
exports.quantityFrom = quantityFrom;
/**
 * Die Zeilen einer Eingabe — Karte und Menge sind Pflicht. Namen und Codes
 * schreibt der Anwendungsfall aus der Depo-Karte ab, nie aus der Anfrage.
 */
const lineDraftsFrom = (raw) => {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw))
        throw (0, exports.bomError)('LINE_INVALID', 'Die Zeilen fehlen.', { params: { row: 1 } });
    if (raw.length > exports.BOM_LIMITS.lines) {
        throw (0, exports.bomError)('LINES_TOO_MANY', `Höchstens ${exports.BOM_LIMITS.lines} Zeilen.`, { params: { max: exports.BOM_LIMITS.lines } });
    }
    return raw.map((entry, index) => {
        const value = (entry && typeof entry === 'object' ? entry : {});
        const productId = text(value.productId, 64);
        const quantity = (0, exports.quantityFrom)(value.quantity);
        if (!productId || quantity === null) {
            throw (0, exports.bomError)('LINE_INVALID', `Zeile ${index + 1}: Produkt und Menge (> 0) sind Pflicht.`, {
                params: { row: index + 1 },
                details: [{ row: index + 1 }],
            });
        }
        return { productId, quantity, unit: (0, exports.unitFrom)(value.unit), note: optionalText(value.note, exports.BOM_LIMITS.note) };
    });
};
exports.lineDraftsFrom = lineDraftsFrom;
/** Kopf einer Vorlage aus der Anfrage (Zeilen separat über `lineDraftsFrom`). */
const templateHeadFrom = (raw) => {
    const value = (raw && typeof raw === 'object' ? raw : {});
    const name = text(value.name, exports.BOM_LIMITS.name);
    if (!name)
        throw (0, exports.bomError)('NAME_REQUIRED', 'Die Vorlage braucht einen Namen.');
    const category = (0, exports.categoryFrom)(value.category);
    if (!category)
        throw (0, exports.bomError)('CATEGORY_INVALID', 'Kategorie: Makine oder Elektrik.');
    // Ohne Gebietsschema: «chiller» wird CHILLER, nicht CHİLLER.
    const mainCard = text(value.mainCard, exports.BOM_LIMITS.mainCard).toUpperCase();
    if (!mainCard)
        throw (0, exports.bomError)('MAIN_CARD_REQUIRED', 'Die Vorlage braucht eine Ana kart (z. B. CHILLER).');
    // Seit der Hierarchie (27.09.2026) kommt die Nummer aus den Einstellungen —
    // die Vorlage ist nur noch eine Zeilenliste; ein alter Vorsatz bleibt stehen.
    const rawPrefix = String(value.codePrefix ?? '').trim();
    const codePrefix = rawPrefix ? (0, exports.prefixFrom)(rawPrefix) : '';
    if (codePrefix === null) {
        throw (0, exports.bomError)('PREFIX_INVALID', 'Der Nummernvorsatz ist ungültig (z. B. ELK-PANO).', { params: { max: exports.PREFIX_MAX } });
    }
    return { name, category, mainCard, codePrefix, description: optionalText(value.description, exports.BOM_LIMITS.description) };
};
exports.templateHeadFrom = templateHeadFrom;
/* ── Die Alt-BOM-Kodes der Einstellungen ────────────────────────────────── */
/** Die Vorsätze der Haupt-BOMs (BOM-MEK / BOM-ELK) sind vergeben. */
const RESERVED_PREFIXES = new Set(Object.values(ProductionBom_1.MAIN_BOM_PREFIX));
/**
 * `{ MECHANICAL: [{ prefix, name }], ELECTRICAL: [...], 'c-…': [...] }` aus der
 * Anfrage — jeder Vorsatz gültig (MAK-COOL), nicht der einer Haupt-BOM
 * (BOM-MEK, BOM-ELK, BOM-<Kod> der eigenen), über alle Bereiche zusammen nur
 * einmal (er zählt seine Nummern selbst). Eine eigene Kategorie, die die
 * Anfrage nicht nennt, fehlt im Ergebnis (ihre Kodes bleiben unverändert).
 */
const codesFrom = (raw, custom = []) => {
    const input = (raw && typeof raw === 'object' ? raw : {});
    const result = { MECHANICAL: [], ELECTRICAL: [] };
    const reserved = new Set([...RESERVED_PREFIXES, ...custom.map((category) => (0, ProductionBom_1.mainBomPrefixOf)(category.code))]);
    const seen = new Set();
    const areas = ['MECHANICAL', 'ELECTRICAL', ...custom.filter((category) => input[category.id] !== undefined).map((category) => category.id)];
    for (const area of areas) {
        const list = Array.isArray(input[area]) ? input[area] : [];
        if (list.length > exports.BOM_LIMITS.codesPerArea) {
            throw (0, exports.bomError)('SETTINGS_INVALID', `Höchstens ${exports.BOM_LIMITS.codesPerArea} Kodes je Bereich.`, {
                params: { min: 0, max: exports.BOM_LIMITS.codesPerArea },
            });
        }
        const codes = [];
        list.forEach((entry, index) => {
            const value = (entry && typeof entry === 'object' ? entry : {});
            const prefix = (0, exports.prefixFrom)(value.prefix);
            if (!prefix) {
                throw (0, exports.bomError)('CODE_INVALID', `Kod ${index + 1} ist ungültig (z. B. MAK-COOL).`, { params: { row: index + 1, area } });
            }
            if (reserved.has(prefix)) {
                throw (0, exports.bomError)('CODE_RESERVED', `${prefix} gehört der Haupt-BOM.`, { params: { prefix } });
            }
            if (seen.has(prefix))
                throw (0, exports.bomError)('CODE_DUPLICATE', `${prefix} steht zweimal.`, { params: { prefix } });
            seen.add(prefix);
            codes.push({ prefix, name: text(value.name, exports.BOM_LIMITS.codeName) || prefix });
        });
        result[area] = codes;
    }
    return result;
};
exports.codesFrom = codesFrom;
/** Eine gespeicherte Liste von Kodes (JSON) lesen — Ungültiges fällt still weg. */
const storedCodeList = (raw) => {
    const list = Array.isArray(raw) ? raw : [];
    const result = [];
    for (const entry of list) {
        const value = (entry && typeof entry === 'object' ? entry : {});
        const prefix = (0, exports.prefixFrom)(value.prefix);
        if (prefix && !RESERVED_PREFIXES.has(prefix))
            result.push({ prefix, name: text(value.name, exports.BOM_LIMITS.codeName) || prefix });
    }
    return result;
};
exports.storedCodeList = storedCodeList;
/** Die gespeicherten Kodes der FESTEN Bereiche (`uretim_bom_ayarlari.codes`). */
const storedCodes = (raw) => {
    const input = (raw && typeof raw === 'object' ? raw : {});
    return { MECHANICAL: (0, exports.storedCodeList)(input.MECHANICAL), ELECTRICAL: (0, exports.storedCodeList)(input.ELECTRICAL) };
};
exports.storedCodes = storedCodes;
/* ── Priorität: frühester Liefertermin zuerst ───────────────────────────── */
const time = (value) => (value ? value.getTime() : Number.POSITIVE_INFINITY);
/** «termini önce olan projeye» — ohne Termin ganz hinten, dann die früher freigegebene BOM. */
const byPriority = (a, b) => time(a.deliveryDate) - time(b.deliveryDate)
    || time(a.approvedAt) - time(b.approvedAt)
    || a.bomSortOrder - b.bomSortOrder
    || a.bomId.localeCompare(b.bomId)
    || a.lineSortOrder - b.lineSortOrder
    || a.lineId.localeCompare(b.lineId);
exports.byPriority = byPriority;
/** Offene Menge einer Zeile: Bedarf − abgebucht. */
const openOf = (line) => Math.max(0, (0, exports.round3)(line.quantity - line.consumedQuantity));
exports.openOf = openOf;
const takeFrom = (pool, wanted) => {
    const fromConfirmed = Math.min(wanted, pool.confirmed);
    pool.confirmed = (0, exports.round3)(pool.confirmed - fromConfirmed);
    const fromOpen = Math.min(wanted - fromConfirmed, pool.open);
    pool.open = (0, exports.round3)(pool.open - fromOpen);
    return { total: (0, exports.round3)(fromConfirmed + fromOpen), confirmed: (0, exports.round3)(fromConfirmed) };
};
/**
 * Was jede offene Zeile hat: reserviert, bestellt, fehlend — über alle Geräte
 * der Firma gerechnet (der frühere Liefertermin geht vor).
 */
const computeCoverage = (input) => {
    const lines = new Map();
    const free = new Map();
    const reservedByProduct = new Map();
    const demandsByProduct = new Map();
    for (const demand of input.demands) {
        const list = demandsByProduct.get(demand.productId) ?? [];
        list.push(demand);
        demandsByProduct.set(demand.productId, list);
    }
    const serialsByProduct = new Map();
    for (const serial of input.serials) {
        const list = serialsByProduct.get(serial.productId) ?? [];
        list.push(serial);
        serialsByProduct.set(serial.productId, list);
    }
    const incomingByProduct = new Map();
    for (const entry of input.incoming) {
        const list = incomingByProduct.get(entry.productId) ?? [];
        list.push(entry);
        incomingByProduct.set(entry.productId, list);
    }
    const productIds = new Set([
        ...demandsByProduct.keys(),
        ...input.products.keys(),
        ...incomingByProduct.keys(),
    ]);
    for (const productId of productIds) {
        const product = input.products.get(productId) ?? null;
        const demands = [...(demandsByProduct.get(productId) ?? [])].sort(exports.byPriority);
        const state = new Map();
        for (const demand of demands) {
            state.set(demand.lineId, {
                lineId: demand.lineId,
                open: (0, exports.round3)(demand.openQuantity),
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
            const byDevice = new Map();
            const byProject = new Map();
            let freeCount = 0;
            for (const serial of serials) {
                if (serial.productionItemId) {
                    const list = byDevice.get(serial.productionItemId) ?? [];
                    list.push(serial);
                    byDevice.set(serial.productionItemId, list);
                }
                else if (serial.productionProjectId) {
                    const list = byProject.get(serial.productionProjectId) ?? [];
                    list.push(serial);
                    byProject.set(serial.productionProjectId, list);
                }
                else {
                    freeCount += 1;
                }
            }
            // Erst die Nummern, die schon am Gerät stehen …
            for (const demand of demands) {
                const entry = state.get(demand.lineId);
                const pool = byDevice.get(demand.productionItemId) ?? [];
                while (entry.reserved + 1 - EPS <= entry.open && pool.length) {
                    entry.serials.push(pool.shift().serialNumber);
                    entry.reserved += 1;
                }
            }
            // … dann die, die nur dem Projekt zugeordnet sind.
            for (const demand of demands) {
                const entry = state.get(demand.lineId);
                const pool = byProject.get(demand.productionProjectId) ?? [];
                while (entry.reserved + 1 - EPS <= entry.open && pool.length) {
                    entry.serials.push(pool.shift().serialNumber);
                    entry.reserved += 1;
                }
            }
            free.set(productId, freeCount);
        }
        else {
            let pool = Math.max(0, (0, exports.round3)(product?.quantity ?? 0));
            for (const demand of demands) {
                const entry = state.get(demand.lineId);
                const take = Math.min(entry.open, pool);
                entry.reserved = (0, exports.round3)(take);
                pool = (0, exports.round3)(pool - take);
            }
            free.set(productId, pool);
        }
        /* 2) DIE BESTELLTE WARE — eigene Bestellung zuerst, dann der Überschuss */
        const own = new Map();
        const surplus = { confirmed: 0, open: 0 };
        for (const entry of incomingByProduct.get(productId) ?? []) {
            const rest = Math.max(0, (0, exports.round3)(entry.quantity - entry.received));
            if (rest <= 0)
                continue;
            if (!state.has(entry.bomLineId)) {
                if (entry.confirmed)
                    surplus.confirmed = (0, exports.round3)(surplus.confirmed + rest);
                else
                    surplus.open = (0, exports.round3)(surplus.open + rest);
                continue;
            }
            const pool = own.get(entry.bomLineId) ?? { confirmed: 0, open: 0 };
            if (entry.confirmed)
                pool.confirmed = (0, exports.round3)(pool.confirmed + rest);
            else
                pool.open = (0, exports.round3)(pool.open + rest);
            own.set(entry.bomLineId, pool);
        }
        for (const demand of demands) {
            const entry = state.get(demand.lineId);
            const pool = own.get(demand.lineId);
            if (!pool)
                continue;
            const need = Math.max(0, (0, exports.round3)(entry.open - entry.reserved));
            const taken = takeFrom(pool, need);
            entry.incoming = taken.total;
            entry.incomingConfirmed = taken.confirmed;
            surplus.confirmed = (0, exports.round3)(surplus.confirmed + pool.confirmed);
            surplus.open = (0, exports.round3)(surplus.open + pool.open);
        }
        for (const demand of demands) {
            const entry = state.get(demand.lineId);
            const need = Math.max(0, (0, exports.round3)(entry.open - entry.reserved - entry.incoming));
            if (need <= 0)
                continue;
            const taken = takeFrom(surplus, need);
            entry.incoming = (0, exports.round3)(entry.incoming + taken.total);
            entry.incomingConfirmed = (0, exports.round3)(entry.incomingConfirmed + taken.confirmed);
        }
        let reservedSum = 0;
        for (const entry of state.values()) {
            entry.missing = Math.max(0, (0, exports.round3)(entry.open - entry.reserved - entry.incoming));
            reservedSum = (0, exports.round3)(reservedSum + entry.reserved);
            lines.set(entry.lineId, entry);
        }
        reservedByProduct.set(productId, reservedSum);
    }
    return { lines, free, reserved: reservedByProduct };
};
exports.computeCoverage = computeCoverage;
/**
 * Welche freien Seriennummern an welche wartende Zeile gehen («rezerve
 * edilenler seri numarası içinde termini önce olan projeye otomatik
 * gitmeli»): die älteste freie Nummer an die Zeile mit dem frühesten Termin.
 * Rechnet auf dem Stand NACH `computeCoverage`.
 */
const serialAssignments = (demands, coverage, freeSerials) => {
    const pool = [...freeSerials]
        .filter((serial) => !serial.productionItemId && !serial.productionProjectId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.serialNumber.localeCompare(b.serialNumber));
    const result = [];
    for (const demand of [...demands].sort(exports.byPriority)) {
        const entry = coverage.get(demand.lineId);
        if (!entry)
            continue;
        let reserved = entry.reserved;
        while (reserved + 1 - EPS <= entry.open && pool.length) {
            const serial = pool.shift();
            result.push({ serialId: serial.id, demand });
            reserved += 1;
        }
        if (!pool.length)
            break;
    }
    return result;
};
exports.serialAssignments = serialAssignments;
/**
 * Nummern eines Geräts, die keine freigegebene Zeile mehr braucht (die BOM
 * ging zurück in den Entwurf oder wurde gelöscht) — sie werden wieder frei.
 */
const serialsToRelease = (deviceSerials, stillNeeded) => {
    const sorted = [...deviceSerials].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const surplus = Math.max(0, sorted.length - Math.max(0, Math.floor(stillNeeded + EPS)));
    return sorted.slice(0, surplus);
};
exports.serialsToRelease = serialsToRelease;
/* ── «Sipariş oluştur» ──────────────────────────────────────────────────── */
/**
 * Der Vorschlag: jede Zeile, der etwas fehlt — «stokta olmayan kadarı sipariş
 * edilecek», nie unter der Mindestbestellmenge («min 100 ise 100 altı
 * vermemelidir»). Gesperrt ist eine Zeile ohne Depo-Karte, ohne ERP-Code
 * («erp kodları dolu, tüm kodlar olmuşsa») oder mit einer offenen Bestellung
 * («bir ürün için sadece bir listeyi seçebilirsin»).
 */
const orderProposal = (lines, coverage, products, openOrderLineIds) => lines.flatMap((line) => {
    const entry = coverage.get(line.id);
    const missing = entry ? entry.missing : (0, exports.openOf)(line);
    if (missing <= EPS)
        return [];
    const product = products.get(line.productId) ?? null;
    const minimum = product?.minimumOrderQuantity && product.minimumOrderQuantity > 0 ? product.minimumOrderQuantity : null;
    const block = !product
        ? 'NO_PRODUCT'
        : !product.erpCode
            ? 'NO_ERP_CODE'
            : openOrderLineIds.has(line.id) ? 'OPEN_ORDER' : null;
    return [{ lineId: line.id, missing: (0, exports.round3)(missing), minimum, floor: (0, exports.ceil3)(Math.max(missing, minimum ?? 0)), block }];
});
exports.orderProposal = orderProposal;
/**
 * Die Eingabe von «Sipariş oluştur» prüfen: nie unter der Untergrenze, mehr
 * nur mit Erklärung («daha fazlası edilecekse açıklama yazacak — açıklamasız
 * kabul edilmeyecek»), jede Zeile mit Lieferant, jede Zeile einmal.
 */
const orderLinesFrom = (raw, proposal) => {
    if (!Array.isArray(raw) || !raw.length)
        throw (0, exports.bomError)('ORDER_EMPTY', 'Keine Zeile zum Bestellen gewählt.');
    const byLine = new Map(proposal.map((entry) => [entry.lineId, entry]));
    const seen = new Set();
    const problems = [];
    const result = [];
    for (const entry of raw) {
        const value = (entry && typeof entry === 'object' ? entry : {});
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
        const quantity = (0, exports.quantityFrom)(value.quantity);
        if (quantity === null || quantity + EPS < proposed.floor) {
            problems.push({ lineId, code: 'QTY_BELOW_FLOOR', floor: proposed.floor });
            continue;
        }
        const note = optionalText(value.note, exports.BOM_LIMITS.note);
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
        throw (0, exports.bomError)(first.code, 'Die Bestellung ist nicht vollständig.', {
            ...(first.floor !== undefined ? { params: { floor: first.floor } } : {}),
            details: problems,
        });
    }
    return result;
};
exports.orderLinesFrom = orderLinesFrom;
/** Gleicher Lieferant? Mit Kennung über sie, sonst über den Namen (ohne Gross/Klein). */
const supplierKey = (supplierId, supplierName) => supplierId ? `id:${supplierId}` : `name:${supplierName.trim().toLocaleLowerCase('tr-TR')}`;
exports.supplierKey = supplierKey;
/**
 * Derselbe Lieferant? Tragen beide eine Kennung, entscheidet sie — sonst der
 * Name ohne Gross/Klein (der Firmenname eines Lieferanten ist je Firma
 * eindeutig). So findet auch eine Zeile ohne Kennung die Bestellung ihres
 * Lieferanten.
 */
const sameSupplier = (a, b) => (a.supplierId && b.supplierId
    ? a.supplierId === b.supplierId
    : a.supplierName.trim().toLocaleLowerCase('tr-TR') === b.supplierName.trim().toLocaleLowerCase('tr-TR'));
exports.sameSupplier = sameSupplier;
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
const mergeOrderItems = (items, additions) => {
    const next = items.map((item) => ({ ...item }));
    for (const addition of additions) {
        const index = next.findIndex((item) => item.bomLineId === addition.bomLineId
            && String(item.unit ?? '') === String(addition.unit ?? ''));
        if (index < 0) {
            next.push({ ...addition });
            continue;
        }
        const copy = { ...next[index], quantity: (0, exports.round3)((Number(next[index].quantity) || 0) + addition.quantity) };
        if (String(copy.calcMode ?? '').toUpperCase() === 'DIRECT' || copy.directCopy === true)
            delete copy.lineTotal;
        next[index] = copy;
    }
    return next;
};
exports.mergeOrderItems = mergeOrderItems;
/**
 * Die Zeilen der Verknüpfung (wie bestellt wurde) nach dem Ergänzen: je
 * BOM-Zeile ein Eintrag — eine schon bestellte Zeile addiert ihr «fehlend»
 * und behält beide Erklärungen; `ordered` ist, was die Bestellung jetzt trägt.
 */
const mergeLinkRecords = (records, additions, items) => {
    const ordered = new Map();
    for (const item of items) {
        const bomLineId = typeof item.bomLineId === 'string' ? item.bomLineId : null;
        if (bomLineId)
            ordered.set(bomLineId, (0, exports.round3)((ordered.get(bomLineId) ?? 0) + (Number(item.quantity) || 0)));
    }
    const result = records.map((record) => ({ ...record }));
    for (const addition of additions) {
        const existing = result.find((record) => record.bomLineId === addition.bomLineId);
        if (!existing) {
            result.push({ ...addition });
            continue;
        }
        existing.missing = (0, exports.round3)(existing.missing + addition.missing);
        existing.minimum = addition.minimum ?? existing.minimum;
        existing.note = [existing.note, addition.note]
            .filter((note) => Boolean(note?.trim()))
            .join(' · ')
            .slice(0, exports.BOM_LIMITS.note) || null;
    }
    return result.map((record) => ({ ...record, ordered: ordered.get(record.bomLineId) ?? record.ordered }));
};
exports.mergeLinkRecords = mergeLinkRecords;
/* ── «Fiyat talebi» ─────────────────────────────────────────────────────── */
/**
 * Die Eingabe von «Fiyat talebi» prüfen (27.09.2026, Vorgabe Samet: «birden
 * fazla tedarikçiye aynı ürün eklenip fiyat talebi alınabilsin … birden fazla
 * tedarikçi seçilebilsin»): jede Zeile der BOM höchstens einmal, Menge > 0,
 * mindestens ein Lieferant — derselbe Lieferant zählt je Zeile nur einmal.
 * Mindestmenge und Erklärung einer Mehrmenge gelten hier nicht: gefragt wird
 * nur der Preis (Name, Modell, Menge).
 */
const requestLinesFrom = (raw, lineIds) => {
    if (!Array.isArray(raw) || !raw.length)
        throw (0, exports.bomError)('REQUEST_EMPTY', 'Keine Zeile für die Preisanfrage gewählt.');
    if (raw.length > exports.BOM_LIMITS.lines) {
        throw (0, exports.bomError)('LINES_TOO_MANY', `Höchstens ${exports.BOM_LIMITS.lines} Zeilen.`, { params: { max: exports.BOM_LIMITS.lines } });
    }
    const seen = new Set();
    const problems = [];
    const result = [];
    for (const entry of raw) {
        const value = (entry && typeof entry === 'object' ? entry : {});
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
        const quantity = (0, exports.quantityFrom)(value.quantity);
        if (quantity === null) {
            problems.push({ lineId, code: 'QTY_INVALID' });
            continue;
        }
        const suppliers = new Map();
        for (const item of Array.isArray(value.suppliers) ? value.suppliers : []) {
            const supplier = (item && typeof item === 'object' ? item : {});
            const supplierName = text(supplier.supplierName, 191);
            if (!supplierName)
                continue;
            const supplierId = text(supplier.supplierId, 64) || null;
            const key = (0, exports.supplierKey)(supplierId, supplierName);
            if (!suppliers.has(key))
                suppliers.set(key, { supplierId, supplierName });
        }
        if (!suppliers.size) {
            problems.push({ lineId, code: 'SUPPLIER_REQUIRED' });
            continue;
        }
        if (suppliers.size > exports.BOM_LIMITS.requestSuppliers) {
            problems.push({ lineId, code: 'SUPPLIERS_TOO_MANY' });
            continue;
        }
        result.push({ lineId, quantity, suppliers: [...suppliers.values()] });
    }
    const first = problems[0];
    if (first) {
        throw (0, exports.bomError)(first.code, 'Die Preisanfrage ist nicht vollständig.', {
            ...(first.code === 'SUPPLIERS_TOO_MANY' ? { params: { max: exports.BOM_LIMITS.requestSuppliers } } : {}),
            details: problems,
        });
    }
    return result;
};
exports.requestLinesFrom = requestLinesFrom;
/**
 * «Sadece tüm bomları sipariş edip siparişleri onaylayınca rezerveler tam
 *  anlamıyla oluşunca BOM TAMAMLA olur.»
 */
const completionOf = (bom, coverage, orders, 
/** Nur die Haupt-BOM: ihre Alt-BOMs (abgeschlossen = COMPLETED, auch schon abgebucht). */
subs = []) => {
    const open = bom.lines.filter((line) => (0, exports.openOf)(line) > EPS);
    const ordered = open.every((line) => (coverage.get(line.id)?.missing ?? (0, exports.openOf)(line)) <= EPS);
    const reserved = open.every((line) => (coverage.get(line.id)?.reserved ?? 0) + EPS >= (0, exports.openOf)(line));
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
exports.completionOf = completionOf;
/* ── Die Regeln der BOM-Belege (Lieferantenbestellung / Preisanfrage) ────── */
/** Bestätigt heisst: beim Lieferanten fest und die Ware wird erwartet (oder ist da). */
exports.CONFIRMED_ORDER_STATUSES = new Set(['PENDING', 'TO_BE_STOCKED', 'COMPLETED']);
/** Auf diese Stände geht nur, wer die Bedingungen erfüllt («siparişi onaylayamasınız»). */
exports.CONFIRMING_STATUSES = new Set(['PENDING', 'TO_BE_STOCKED', 'COMPLETED']);
exports.PRICE_REQUEST_STATUSES = new Set(['DRAFT', 'PRICE_REQUEST']);
/**
 * Was vor der Bestätigung fehlt: die Angebotsnummer des Lieferanten
 * («tedarikçi sipariş numarasını yazmadan … ne de siparişi onaylayabiliyoruz»)
 * und sein Angebots-PDF («sipariş onayından önce … fiyat teklifi zorunlu»).
 */
const confirmProblems = (order, link) => {
    const problems = [];
    if (!String(order.quoteNumber ?? '').trim())
        problems.push('QUOTE_NUMBER');
    /* Das Angebots-PDF braucht nur die ERSTE Bestätigung (30.09.2026, Samet: «revizyonda teklif
       PDF'ini istemeye gerek yok, o ilk onay için») — eine revidierte Bestellung bestätigt man ohne. */
    if (!link?.quoteFileRef && !((link?.orderRevision ?? 0) > 0))
        problems.push('QUOTE_FILE');
    return problems;
};
exports.confirmProblems = confirmProblems;
const lockKey = (item) => [
    String(item?.bomLineId ?? ''),
    String(item?.code ?? '').trim(),
    String(item?.name ?? '').trim(),
    (0, exports.round3)(Number(item?.quantity) || 0),
].join('\u0001');
/**
 * «Sütun ekleyebiliyoruz, ancak satır ekleyemiyoruz.» Dieselben Zeilen mit
 * derselben BOM-Zeile, demselben Code, Namen und derselben Menge — Preise und
 * eigene Spalten dürfen sich ändern. `true` = unverändert.
 */
const sameLockedRows = (before, after) => {
    const a = Array.isArray(before) ? before : [];
    const b = Array.isArray(after) ? after : [];
    if (a.length !== b.length)
        return false;
    const left = a.map((item) => lockKey(item)).sort();
    const right = b.map((item) => lockKey(item)).sort();
    return left.every((key, index) => key === right[index]);
};
exports.sameLockedRows = sameLockedRows;
/** Die Einheit einer BOM-Zeile, wie sie in der Bestellung steht (Anlegen UND Revision). */
exports.ORDER_UNIT_LABELS = { PCS: 'Adet', M: 'm', KG: 'kg', SET: 'Set', PACK: 'Paket' };
/**
 * Die Kennungen der Zeilen einer neuen Fassung: je Karte zuerst eine der
 * `pools` der Reihe nach (geltende BOM, dann Arbeitskopie), sonst eine neue.
 * Dieselbe Kennung wird nie zweimal vergeben.
 */
const revisionLineIds = (next, pools, newId) => {
    const used = new Set();
    const queues = pools.map((pool) => {
        const byProduct = new Map();
        for (const line of pool)
            byProduct.set(line.productId, [...(byProduct.get(line.productId) ?? []), line.id]);
        return byProduct;
    });
    return next.map((line) => {
        for (const queue of queues) {
            const list = queue.get(line.productId);
            while (list?.length) {
                const id = list.shift();
                if (!used.has(id)) {
                    used.add(id);
                    return id;
                }
            }
        }
        let id = newId();
        while (used.has(id))
            id = newId();
        used.add(id);
        return id;
    });
};
exports.revisionLineIds = revisionLineIds;
const sameNote = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
/** Was sich von `before` (geltende Fassung) zu `after` (neue Fassung) ändert — in der Reihenfolge der neuen, Entferntes am Ende. */
const revisionChanges = (before, after) => {
    const beforeById = new Map(before.map((line) => [line.id, line]));
    const afterIds = new Set(after.map((line) => line.id));
    const changes = [];
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
                after: (0, exports.round3)(line.quantity),
                noteBefore: null,
                noteAfter: line.note,
            });
            continue;
        }
        const qtyBefore = (0, exports.round3)(old.quantity);
        const qtyAfter = (0, exports.round3)(line.quantity);
        const kind = qtyAfter > qtyBefore + EPS
            ? 'INCREASED'
            : qtyAfter + EPS < qtyBefore
                ? 'DECREASED'
                : old.unit !== line.unit || !sameNote(old.note, line.note) ? 'EDITED' : null;
        if (!kind)
            continue;
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
        if (afterIds.has(old.id))
            continue;
        changes.push({
            kind: 'REMOVED',
            lineId: old.id,
            productId: old.productId,
            erpCode: old.erpCode,
            name: old.name,
            unitBefore: old.unit,
            unitAfter: null,
            before: (0, exports.round3)(old.quantity),
            after: 0,
            noteBefore: old.note,
            noteAfter: null,
        });
    }
    return changes;
};
exports.revisionChanges = revisionChanges;
/**
 * Der Bedarf der Firma, wie er NACH der Revision wäre: die Zeilen dieser BOM
 * durch die der neuen Fassung ersetzt (Priorität, Termin und Freigabe der BOM
 * bleiben — eine Revision drängelt sich nicht vor).
 */
const demandsWithRevision = (demands, bom, lines, deliveryDate) => [
    ...demands.filter((demand) => demand.bomId !== bom.id),
    ...lines.map((line, index) => ({
        lineId: line.id,
        bomId: bom.id,
        productId: line.productId,
        productionProjectId: bom.productionProjectId,
        productionItemId: bom.productionItemId,
        openQuantity: Math.max(0, (0, exports.round3)(line.quantity)),
        deliveryDate,
        approvedAt: bom.approvedAt,
        bomSortOrder: bom.sortOrder,
        lineSortOrder: index,
    })),
];
exports.demandsWithRevision = demandsWithRevision;
/** Hat der Lieferant die Bestellung (Mail hinaus oder bestätigt)? */
const orderAtSupplier = (order) => Boolean(order.emailSentAt) || ['ORDERED', 'PENDING', 'TO_BE_STOCKED'].includes(String(order.status).toUpperCase());
exports.orderAtSupplier = orderAtSupplier;
/**
 * Nimmt eine Bestellung der BOM noch Zeilen auf («zaten olan siparişe
 * eklenir»)? Nur ein Entwurf, der nie beim Lieferanten war.
 */
const acceptsMoreLines = (order) => String(order.status).toUpperCase() === 'ORDER_DRAFT' && !(0, exports.orderAtSupplier)(order);
exports.acceptsMoreLines = acceptsMoreLines;
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
const revisionOrderPlan = (input) => {
    const open = input.orders
        .filter((order) => !exports.PRICE_REQUEST_STATUSES.has(String(order.status).toUpperCase()) && String(order.status).toUpperCase() !== 'COMPLETED')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const targets = new Map();
    const itemOf = (orderId, index) => open.find((order) => order.purchaseOrderId === orderId)?.items.find((item) => item.index === index);
    const setTarget = (orderId, index, patch) => {
        const item = itemOf(orderId, index);
        if (!item)
            return;
        const map = targets.get(orderId) ?? new Map();
        const current = map.get(index) ?? { after: item.quantity, unitAfter: item.unit };
        map.set(index, { ...current, ...patch });
        targets.set(orderId, map);
    };
    const entriesOf = (lineId) => open.flatMap((order) => order.items
        .filter((item) => item.bomLineId === lineId && item.received + EPS < item.quantity)
        .map((item) => ({ order, item })));
    for (const change of input.changes) {
        if (change.kind === 'ADDED')
            continue;
        const entries = entriesOf(change.lineId);
        if (!entries.length)
            continue;
        const unitChanged = change.unitAfter !== null && change.unitBefore !== change.unitAfter;
        const unitAfter = change.unitAfter ? exports.ORDER_UNIT_LABELS[change.unitAfter] ?? null : null;
        if (change.kind === 'REMOVED') {
            for (const { order, item } of entries)
                setTarget(order.purchaseOrderId, item.index, { after: (0, exports.round3)(item.received) });
            continue;
        }
        if (change.kind === 'INCREASED') {
            const delta = (0, exports.round3)(change.after - change.before);
            const missing = input.missingAfter.get(change.lineId);
            const add = (0, exports.round3)(Math.min(delta, Math.max(0, missing ?? delta)));
            const newest = entries[0];
            if (add > EPS)
                setTarget(newest.order.purchaseOrderId, newest.item.index, { after: (0, exports.round3)(newest.item.quantity + add) });
        }
        else if (change.kind === 'DECREASED') {
            let remaining = (0, exports.round3)(change.before - change.after);
            const minimum = input.minimums.get(change.lineId) ?? null;
            for (const { order, item } of entries) {
                if (remaining <= EPS)
                    break;
                const cut = Math.min(remaining, (0, exports.round3)(item.quantity - item.received));
                let after = (0, exports.round3)(item.quantity - cut);
                // Eine bleibende Zeile geht nicht unter die Mindestbestellmenge.
                if (minimum && after > item.received + EPS && after + EPS < minimum)
                    after = (0, exports.round3)(Math.min(item.quantity, Math.max(minimum, item.received)));
                remaining = (0, exports.round3)(remaining - (item.quantity - after));
                if (Math.abs(after - item.quantity) > EPS)
                    setTarget(order.purchaseOrderId, item.index, { after });
            }
        }
        if (unitChanged && unitAfter) {
            for (const { order, item } of entries) {
                if (item.unit !== unitAfter)
                    setTarget(order.purchaseOrderId, item.index, { unitAfter });
            }
        }
    }
    const actions = [];
    for (const order of open) {
        const map = targets.get(order.purchaseOrderId);
        if (!map)
            continue;
        const lines = [];
        let remainingItems = 0;
        let onlyLess = true;
        for (const item of order.items) {
            const target = map.get(item.index);
            const after = target ? target.after : item.quantity;
            if (after > EPS)
                remainingItems += 1;
            if (!target)
                continue;
            const unitAfter = target.unitAfter ?? item.unit;
            if (Math.abs(after - item.quantity) <= EPS && unitAfter === item.unit)
                continue;
            if (after > item.quantity + EPS || unitAfter !== item.unit)
                onlyLess = false;
            lines.push({
                index: item.index,
                bomLineId: item.bomLineId ?? '',
                code: item.code,
                name: item.name,
                unitBefore: item.unit,
                unitAfter,
                before: (0, exports.round3)(item.quantity),
                after: (0, exports.round3)(after),
                received: (0, exports.round3)(item.received),
            });
        }
        if (!lines.length)
            continue;
        const atSupplier = (0, exports.orderAtSupplier)(order);
        const status = String(order.status).toUpperCase();
        let action;
        let statusAfter = status;
        let orderRevision = null;
        if (!atSupplier) {
            action = remainingItems ? 'UPDATE' : 'DELETE';
        }
        else if (!remainingItems) {
            action = 'CANCEL';
        }
        else {
            action = 'REVISE';
            orderRevision = order.orderRevision + 1;
            // Die Bestätigung galt der alten Fassung: bis der Lieferant neu bestätigt, ist sie offen.
            if (exports.CONFIRMED_ORDER_STATUSES.has(status))
                statusAfter = order.emailSentAt ? 'ORDERED' : 'ORDER_DRAFT';
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
exports.revisionOrderPlan = revisionOrderPlan;
//# sourceMappingURL=productionBom.js.map