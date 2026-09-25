"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.producerTenantIdsForOrder = exports.findConfirmedProducerOrders = exports.producerLinesOf = exports.normalizeCompanyName = exports.CONFIRMED_PRODUCER_ORDER_STATUSES = void 0;
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
const serviceTenantScope_1 = require("../presentation/controllers/serviceTenantScope");
/**
 * ── WELCHE BESTELLUNG GEHT AN DIE PRODUKTION? (24.09.2026) ──────────────────
 *
 * Vorgabe Samet: «Proje şirketinden sipariş onayı yapılırsa DİREKT üretim
 * projesi oluşmalı.» Eine Projektfirma bestellt bei der Produktionsfirma auf
 * zwei Wegen:
 *
 *   1. über die Gruppe «Üretilecek» der Positionsliste — die Zeile trägt
 *      `source.producerTenantId` (projectProcurement.routes.ts);
 *   2. über einen gewöhnlichen Lieferanten, der die Produktionsfirma IST —
 *      etwa ein von Hand angelegter Lieferant «Offitec Isitma & Soğutma A.Ş.»
 *      neben der Firma «Offitec Isıtma ve Soğutma A.Ş.». Diese Zeilen tragen
 *      `producerTenantId: null`, aber ihre `source.positionId` sagt, welche
 *      Offertposition bestellt wurde.
 *
 * Weg 2 blieb bis heute unerkannt (BE-2026-007 war bestätigt, das
 * Produktionsprojekt stand leer). Der Lieferantenname wird dafür GLEICH
 * GEMACHT (Kleinschreibung, türkische/deutsche Zeichen gefaltet, «&»/«und»/
 * «and» = «ve», Satzzeichen weg) und muss danach dem Firmennamen GENAU
 * gleichen — kein Ähnlichkeitsraten.
 */
/** Bestellstufen, in denen eine interne Bestellung als BESTÄTIGT gilt. */
exports.CONFIRMED_PRODUCER_ORDER_STATUSES = ['PENDING', 'TO_BE_STOCKED', 'COMPLETED'];
const normalizeCompanyName = (value) => String(value ?? '')
    .toLocaleLowerCase('tr')
    // «ı» hat keine Zerlegung; die anderen (ş ğ ü ö ç ä é …) zerlegt NFKD,
    // die abgetrennten Akzente fallen weg.
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/&|\+/g, ' ve ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(und|and)\b/g, 've')
    .replace(/\s+/g, ' ')
    .trim();
exports.normalizeCompanyName = normalizeCompanyName;
const parseItems = (raw) => {
    if (Array.isArray(raw))
        return raw;
    if (typeof raw !== 'string')
        return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
};
/**
 * Die Zeilen einer Bestellung, die diese Produktion betreffen: ausdrücklich
 * adressierte (Weg 1) und — wenn der Lieferant die Produktionsfirma ist —
 * jede Zeile, die aus einer Offertposition stammt und KEINE andere
 * Produktionsfirma nennt (Weg 2).
 */
const producerLinesOf = (order, producerTenantId, producerNameKey) => {
    const toProducer = Boolean(producerNameKey) && (0, exports.normalizeCompanyName)(order.supplierName) === producerNameKey;
    const lines = [];
    for (const item of parseItems(order.items)) {
        const source = item?.source;
        const positionId = source?.positionId ? String(source.positionId) : '';
        if (!positionId)
            continue;
        const named = source.producerTenantId ? String(source.producerTenantId) : null;
        if (named === producerTenantId || (!named && toProducer)) {
            lines.push({ positionId, quantity: Number(item.quantity) || 0 });
        }
    }
    return lines;
};
exports.producerLinesOf = producerLinesOf;
const tenantNameKey = async (tenantId) => {
    const row = await prisma_client_1.default.tenant.findUnique({ where: { id: tenantId }, select: { tenantName: true } });
    return (0, exports.normalizeCompanyName)(row?.tenantName);
};
/**
 * Alle BESTÄTIGTEN Bestellungen der Firmen im Baum dieser Produktion, die
 * ihr etwas bestellen — mit den betroffenen Zeilen.
 */
const findConfirmedProducerOrders = async (producerTenantId) => {
    const [treeIds, nameKey] = await Promise.all([
        (0, serviceTenantScope_1.getCompanyTreeTenantIds)(producerTenantId),
        tenantNameKey(producerTenantId),
    ]);
    const ordering = treeIds.filter((id) => id !== producerTenantId);
    if (!ordering.length)
        return [];
    const rows = await prisma_client_1.default.purchaseOrder.findMany({
        where: {
            tenantId: { in: ordering },
            status: { in: exports.CONFIRMED_PRODUCER_ORDER_STATUSES },
            items: { contains: '"positionId"' },
        },
        select: { id: true, tenantId: true, referenceNumber: true, status: true, supplierName: true, items: true },
        orderBy: { createdAt: 'asc' },
    });
    const result = [];
    for (const row of rows) {
        const lines = (0, exports.producerLinesOf)(row, producerTenantId, nameKey);
        if (!lines.length)
            continue;
        result.push({
            id: String(row.id),
            tenantId: String(row.tenantId),
            referenceNumber: String(row.referenceNumber || ''),
            status: String(row.status),
            lines,
        });
    }
    return result;
};
exports.findConfirmedProducerOrders = findConfirmedProducerOrders;
/**
 * Welche Produktionsfirmen eine Bestellung betrifft — für den sofortigen
 * Abgleich nach Bestätigung, Rücknahme, Änderung oder Löschung.
 */
const producerTenantIdsForOrder = async (order) => {
    const ids = new Set();
    const items = parseItems(order.items);
    for (const item of items) {
        const named = item?.source?.producerTenantId;
        if (named)
            ids.add(String(named));
    }
    const fromPositions = items.some((item) => item?.source?.positionId && !item.source.producerTenantId);
    const supplierKey = (0, exports.normalizeCompanyName)(order.supplierName);
    if (fromPositions && supplierKey) {
        const treeIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(order.tenantId);
        const producers = await prisma_client_1.default.tenant.findMany({
            where: { id: { in: treeIds.filter((id) => id !== order.tenantId) }, companyType: 'PRODUCTION', isActive: true },
            select: { id: true, tenantName: true },
        });
        for (const producer of producers) {
            if ((0, exports.normalizeCompanyName)(producer.tenantName) === supplierKey)
                ids.add(String(producer.id));
        }
    }
    return [...ids];
};
exports.producerTenantIdsForOrder = producerTenantIdsForOrder;
//# sourceMappingURL=producerOrders.js.map