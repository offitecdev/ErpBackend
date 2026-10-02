import prisma from '../infrastructure/database/prisma.client';
import { getCompanyTreeTenantIds } from '../presentation/controllers/serviceTenantScope';

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
 *
 * Weg 3 (02.10.2026, Vorgabe Samet: «modül ayarları üretimde üretim
 * tedarikçisi seç»): die bestellende Firma legt unter Modul-Einstellungen ›
 * Produktion ausdrücklich fest, WELCHER ihrer Lieferanten die Produktionsfirma
 * ist (`uretim_tedarikci_baglari`). Eine Bestellung bei diesem Lieferanten
 * zählt wie Weg 2 — ohne dass die Namen gleich sein müssen.
 */

/** Bestellstufen, in denen eine interne Bestellung als BESTÄTIGT gilt. */
export const CONFIRMED_PRODUCER_ORDER_STATUSES = ['PENDING', 'TO_BE_STOCKED', 'COMPLETED'];

export const normalizeCompanyName = (value: unknown): string =>
    String(value ?? '')
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

export interface ProducerOrderLine {
    positionId: string;
    quantity: number;
}

export interface ProducerOrder {
    id: string;
    tenantId: string;
    referenceNumber: string;
    status: string;
    lines: ProducerOrderLine[];
}

/* Die Tabelle kommt mit einer Migration; solange sie fehlt, gibt es eben
   keine ausdrückliche Zuordnung (Weg 2 läuft weiter). */
const isMissingTable = (error: unknown): boolean => {
    const e = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { code?: string | number } } } };
    return e?.code === 'P2021'
        || e?.meta?.code === '1146'
        || String(e?.meta?.driverAdapterError?.cause?.code ?? '') === '1146';
};

interface SupplierLinkRow {
    tenantId: string;
    supplierId: string;
    producerTenantId: string;
}

const readSupplierLinks = async (where: Record<string, unknown>): Promise<SupplierLinkRow[]> => {
    try {
        const rows = await (prisma as any).productionSupplierLink.findMany({
            where,
            select: { tenantId: true, supplierId: true, producerTenantId: true },
        });
        return (rows as any[]).map((row) => ({
            tenantId: String(row.tenantId),
            supplierId: String(row.supplierId),
            producerTenantId: String(row.producerTenantId),
        }));
    } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
    }
};

/** Weg 3: je bestellende Firma die Lieferanten, die DIESE Produktion sind. */
const linkedSuppliersOf = async (producerTenantId: string): Promise<Map<string, Set<string>>> => {
    const result = new Map<string, Set<string>>();
    for (const row of await readSupplierLinks({ producerTenantId })) {
        const set = result.get(row.tenantId) ?? new Set<string>();
        set.add(row.supplierId);
        result.set(row.tenantId, set);
    }
    return result;
};

const parseItems = (raw: unknown): any[] => {
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== 'string') return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

/**
 * Die Zeilen einer Bestellung, die diese Produktion betreffen: ausdrücklich
 * adressierte (Weg 1) und — wenn der Lieferant die Produktionsfirma ist
 * (gleicher Name, Weg 2, oder als Produktionslieferant eingestellt, Weg 3) —
 * jede Zeile, die aus einer Offertposition stammt und KEINE andere
 * Produktionsfirma nennt.
 */
export const producerLinesOf = (
    order: { items: unknown; supplierId?: string | null; supplierName?: string | null },
    producerTenantId: string,
    producerNameKey: string,
    linkedSupplierIds?: Set<string>,
): ProducerOrderLine[] => {
    const toProducer = (Boolean(producerNameKey) && normalizeCompanyName(order.supplierName) === producerNameKey)
        || Boolean(order.supplierId && linkedSupplierIds?.has(String(order.supplierId)));
    const lines: ProducerOrderLine[] = [];
    for (const item of parseItems(order.items)) {
        const source = item?.source;
        const positionId = source?.positionId ? String(source.positionId) : '';
        if (!positionId) continue;
        const named = source.producerTenantId ? String(source.producerTenantId) : null;
        if (named === producerTenantId || (!named && toProducer)) {
            lines.push({ positionId, quantity: Number(item.quantity) || 0 });
        }
    }
    return lines;
};

const tenantNameKey = async (tenantId: string): Promise<string> => {
    const row = await (prisma as any).tenant.findUnique({ where: { id: tenantId }, select: { tenantName: true } });
    return normalizeCompanyName(row?.tenantName);
};

/**
 * Alle BESTÄTIGTEN Bestellungen der Firmen im Baum dieser Produktion, die
 * ihr etwas bestellen — mit den betroffenen Zeilen.
 */
export const findConfirmedProducerOrders = async (producerTenantId: string): Promise<ProducerOrder[]> => {
    const [treeIds, nameKey, linked] = await Promise.all([
        getCompanyTreeTenantIds(producerTenantId),
        tenantNameKey(producerTenantId),
        linkedSuppliersOf(producerTenantId),
    ]);
    const ordering = [...new Set([...treeIds, ...linked.keys()])].filter((id) => id !== producerTenantId);
    if (!ordering.length) return [];
    const rows = await (prisma as any).purchaseOrder.findMany({
        where: {
            tenantId: { in: ordering },
            status: { in: CONFIRMED_PRODUCER_ORDER_STATUSES },
            items: { contains: '"positionId"' },
        },
        select: { id: true, tenantId: true, referenceNumber: true, status: true, supplierId: true, supplierName: true, items: true },
        orderBy: { createdAt: 'asc' },
    });
    const result: ProducerOrder[] = [];
    for (const row of rows as any[]) {
        const lines = producerLinesOf(row, producerTenantId, nameKey, linked.get(String(row.tenantId)));
        if (!lines.length) continue;
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

/**
 * Welche Produktionsfirmen eine Bestellung betrifft — für den sofortigen
 * Abgleich nach Bestätigung, Rücknahme, Änderung oder Löschung.
 */
export const producerTenantIdsForOrder = async (order: {
    tenantId: string;
    supplierId?: string | null;
    supplierName?: string | null;
    items: unknown;
}): Promise<string[]> => {
    const ids = new Set<string>();
    const items = parseItems(order.items);
    for (const item of items) {
        const named = item?.source?.producerTenantId;
        if (named) ids.add(String(named));
    }
    const fromPositions = items.some((item) => item?.source?.positionId && !item.source.producerTenantId);
    const supplierKey = normalizeCompanyName(order.supplierName);
    if (fromPositions && supplierKey) {
        const treeIds = await getCompanyTreeTenantIds(order.tenantId);
        const producers = await (prisma as any).tenant.findMany({
            where: { id: { in: treeIds.filter((id) => id !== order.tenantId) }, companyType: 'PRODUCTION', isActive: true },
            select: { id: true, tenantName: true },
        });
        for (const producer of producers as any[]) {
            if (normalizeCompanyName(producer.tenantName) === supplierKey) ids.add(String(producer.id));
        }
    }
    if (fromPositions && order.supplierId) {
        for (const link of await readSupplierLinks({ tenantId: order.tenantId, supplierId: String(order.supplierId) })) {
            ids.add(link.producerTenantId);
        }
    }
    return [...ids];
};
