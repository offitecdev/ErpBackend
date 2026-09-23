import type {
    ProductionItem,
    ProductionItemKind,
    ProductionItemSource,
    ProductionOrderKind,
    ProductionOrderLine,
    ProductionSourceKind,
    PurchaseOrderLineView,
    SalesSourceOrder,
    SalesSourceSnapshot,
} from '../entities/Production';

/**
 * ── DIE REGELN DES PRODUKTIONSMODULS ────────────────────────────────────────
 *
 * Reine Funktionen, ohne Datenbank: wie aus den Aufträgen einer Firma
 * Produktionsprojekte werden, wie eine Bestellzeile ihr Gerät findet und wie
 * Verkauf und Einkauf einander gegenübergestellt werden. Die Anwendungsschicht
 * liest, ruft diese Regeln auf und schreibt.
 */

export const round2 = (value: number): number => Math.round((Number(value) || 0) * 100) / 100;

/* ═══════════════════════════════════════════════════════════════════════════
   1) AUS DEN AUFTRÄGEN WERDEN PRODUKTIONSPROJEKTE
   ═════════════════════════════════════════════════════════════════════════ */

/** Die Auftragsarten, die in die Produktion gehen (Regie-Einsätze nicht). */
export const PRODUCTION_ORDER_TYPES = ['PROJECT_NEW', 'PROJECT_EXISTING', 'INVOICE', 'PROJECT_ADDON'] as const;

export interface PlannedProject {
    id: string;
    sourceTenantId: string;
    sourceKey: string;
    sourceKind: ProductionSourceKind;
    sourceProjectId: string | null;
    sourceSalesOrderId: string | null;
    projectNumber: string;
    projectName: string;
    customerName: string | null;
    sourceStatus: string | null;
    salesTotal: number;
    isActive: boolean;
}

export interface PlannedOrder {
    id: string;
    productionProjectId: string;
    sourceSalesOrderId: string;
    parentSalesOrderId: string | null;
    orderNumber: string;
    orderType: string;
    orderKind: ProductionOrderKind;
    orderDate: Date | null;
    status: string;
    totalAmount: number;
    isActive: boolean;
}

export interface PlannedItem {
    id: string;
    productionProjectId: string;
    productionOrderId: string;
    sourceType: ProductionItemSource;
    sourceId: string;
    kind: ProductionItemKind;
    positionNumber: string | null;
    name: string;
    description: string | null;
    articleId: string | null;
    articleCode: string | null;
    quantity: number;
    unit: string | null;
    unitPrice: number;
    totalPrice: number;
    sortOrder: number;
    isActive: boolean;
}

export interface SnapshotPlan {
    projects: PlannedProject[];
    orders: PlannedOrder[];
    items: PlannedItem[];
}

/** Die Ids, die schon vergeben sind — der Abgleich behält sie (Bestellungen zeigen darauf). */
export interface ExistingProductionIds {
    projectIdByKey: Map<string, string>;
    orderIdBySalesOrder: Map<string, string>;
    itemIdBySource: Map<string, string>;
}

export const itemSourceKey = (sourceType: string, sourceId: string): string => `${sourceType}:${sourceId}`;

const isCancelled = (status: string | null | undefined): boolean => String(status || '').toUpperCase() === 'CANCELLED';

/** Ein Lieferauftrag hat kein Projekt (Vorgabe: «teslimat siparişi doğrudan müşteriye gider»). */
const sourceKindOf = (main: SalesSourceOrder): ProductionSourceKind =>
    main.orderType === 'INVOICE' || !main.projectId ? 'DELIVERY' : 'PROJECT';

const projectKeyOf = (main: SalesSourceOrder): string =>
    sourceKindOf(main) === 'PROJECT' ? `P:${main.projectId}` : `D:${main.id}`;

/**
 * Der Titel eines Produktionsprojekts. Die ERP-Projekte tragen als Namen oft
 * nur ihre Nummer («PR-2026-10008») — dann ist die Referenz der Offerte oder
 * der Kunde die sprechendere Angabe.
 */
const titleOf = (main: SalesSourceOrder, number: string): string => {
    const candidates = [
        main.projectName && main.projectName.trim() !== number ? main.projectName : null,
        main.reference,
        main.customerName,
    ];
    const found = candidates.map((value) => String(value ?? '').trim()).find(Boolean);
    return (found || number).slice(0, 255);
};

export const planProductionSnapshot = (
    source: SalesSourceSnapshot,
    existing: ExistingProductionIds,
    newId: () => string,
): SnapshotPlan => {
    const orderById = new Map(source.orders.map((order) => [order.id, order]));
    const mainOf = (order: SalesSourceOrder): SalesSourceOrder | null =>
        order.parentSalesOrderId ? orderById.get(order.parentSalesOrderId) ?? null : order;

    const projects = new Map<string, PlannedProject>();
    const orders = new Map<string, PlannedOrder>();
    /* Die Aufträge der Reihe nach: der älteste Hauptauftrag gibt dem Projekt
       seinen Titel, Nachträge kommen nach ihrem Hauptauftrag. */
    const sorted = [...source.orders].sort((a, b) =>
        (a.orderDate?.getTime() ?? 0) - (b.orderDate?.getTime() ?? 0) || a.orderNumber.localeCompare(b.orderNumber));

    for (const order of sorted) {
        const main = mainOf(order);
        if (!main) continue;
        const key = projectKeyOf(main);
        const kind = sourceKindOf(main);
        let project = projects.get(key);
        if (!project) {
            const number = String((kind === 'PROJECT' ? main.projectNumber : null) || main.orderNumber).slice(0, 191);
            project = {
                id: existing.projectIdByKey.get(key) ?? newId(),
                sourceTenantId: main.tenantId,
                sourceKey: key,
                sourceKind: kind,
                sourceProjectId: kind === 'PROJECT' ? main.projectId : null,
                sourceSalesOrderId: kind === 'DELIVERY' ? main.id : null,
                projectNumber: number,
                projectName: titleOf(main, number),
                customerName: main.customerName ? main.customerName.slice(0, 255) : null,
                sourceStatus: (kind === 'PROJECT' ? main.projectStatus : main.status) ?? null,
                salesTotal: 0,
                isActive: false,
            };
            projects.set(key, project);
        }
        const orderKind: ProductionOrderKind = order.parentSalesOrderId ? 'ADDON' : (kind === 'PROJECT' ? 'PROJECT' : 'DELIVERY');
        const active = !isCancelled(order.status) && !(order.parentSalesOrderId && isCancelled(main.status));
        orders.set(order.id, {
            id: existing.orderIdBySalesOrder.get(order.id) ?? newId(),
            productionProjectId: project.id,
            sourceSalesOrderId: order.id,
            parentSalesOrderId: order.parentSalesOrderId,
            orderNumber: order.orderNumber.slice(0, 191),
            orderType: order.orderType.slice(0, 40),
            orderKind,
            orderDate: order.orderDate,
            status: String(order.status || 'ORDERED').slice(0, 24),
            totalAmount: round2(order.totalAmount),
            isActive: active,
        });
        // Ein Projekt lebt, solange einer seiner Aufträge lebt — und das
        // ERP-Projekt selbst nicht storniert ist.
        if (active && !(kind === 'PROJECT' && isCancelled(main.projectStatus))) project.isActive = true;
    }

    const items: PlannedItem[] = [];
    for (const line of source.lines) {
        const order = orders.get(line.orderId);
        if (!order) continue;
        const key = itemSourceKey(line.sourceType, line.sourceId);
        const item: PlannedItem = {
            id: existing.itemIdBySource.get(key) ?? newId(),
            productionProjectId: order.productionProjectId,
            productionOrderId: order.id,
            sourceType: line.sourceType,
            sourceId: line.sourceId,
            kind: line.kind,
            positionNumber: line.positionNumber ? line.positionNumber.slice(0, 40) : null,
            name: (line.name || '—').slice(0, 500),
            description: line.description ? line.description.slice(0, 4000) : null,
            articleId: line.articleId,
            articleCode: line.articleCode ? line.articleCode.slice(0, 191) : null,
            quantity: Number(line.quantity) || 0,
            unit: line.unit ? line.unit.slice(0, 40) : null,
            unitPrice: Number(line.unitPrice) || 0,
            totalPrice: round2(line.totalPrice),
            sortOrder: line.sortOrder,
            isActive: order.isActive,
        };
        items.push(item);
    }

    const projectById = new Map([...projects.values()].map((project) => [project.id, project]));
    for (const item of items) {
        if (!item.isActive) continue;
        const project = projectById.get(item.productionProjectId);
        if (project) project.salesTotal = round2(project.salesTotal + item.totalPrice);
    }

    return { projects: [...projects.values()], orders: [...orders.values()], items };
};

/* ═══════════════════════════════════════════════════════════════════════════
   2) DIE BESTELLZEILE UND IHR GERÄT
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * Die Zeilen einer Lieferantenbestellung aus ihrer JSON-Spalte `items` — nur
 * die Felder, die die Produktion braucht.
 */
export const parsePurchaseLines = (raw: unknown): PurchaseOrderLineView[] => {
    let items: unknown = raw;
    if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch { items = []; }
    }
    if (!Array.isArray(items)) return [];
    return items.map((item: any, index: number) => ({
        index,
        articleId: item?.articleId ? String(item.articleId) : null,
        code: item?.code ? String(item.code) : null,
        name: String(item?.name ?? ''),
        unit: item?.unit ? String(item.unit) : null,
        quantity: Number(item?.quantity) || 0,
        grossPrice: Number(item?.grossPrice) || 0,
        netPrice: Number(item?.netPrice) || 0,
        discount: Number(item?.discount) || 0,
        discount2: Number(item?.discount2) || 0,
        lineTotal: Number(item?.lineTotal) || 0,
        calcMode: item?.calcMode ? String(item.calcMode) : null,
        receivedQuantity: Number(item?.receivedQuantity) || 0,
        productionItemId: typeof item?.productionItemId === 'string' && item.productionItemId ? item.productionItemId : null,
    }));
};

/* ═══════════════════════════════════════════════════════════════════════════
   2a) DIE GEWÄHLTEN GERÄTE EINER BESTELLUNG
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * Die Spalte `productionItemIds` ist eine Liste von Ids — eine Bestellung
 * betrifft ein Gerät oder eine Leistung GANZ: «cihazı seçince işte eklensin»
 * (Vorgabe Samet, 20.09.2026, nach einem kurzen Versuch mit Mengen). Zeilen
 * aus diesem Versuch können `[{ id, quantity }]` tragen — auch die werden
 * gelesen, die Menge wird dabei verworfen.
 */
export const parseAssignmentItemIds = (raw: unknown): string[] => {
    let value: unknown = raw;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { value = []; }
    }
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    for (const entry of value) {
        const id = (typeof entry === 'string' ? entry : String((entry as any)?.id ?? '')).trim();
        if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
};

export interface LineAssignmentResult {
    /** Je Zeile ihr Gerät — `null` heisst: die Zeile gehört dem PROJEKT. */
    itemIds: Array<string | null>;
}

/**
 * Welche Zeile zu welchem Gerät gehört: NUR ihr eigenes Etikett
 * (`productionItemId`) sagt es. Ohne Etikett gehört die Zeile dem PROJEKT —
 * auch dann, wenn genau EIN Gerät gewählt ist (Vorgabe Samet, 20.09.2026:
 * «tek bir cihaza yüklenmesin … eğer cihaza etiketlenirse yüklensin»). Ein
 * Etikett, das nicht (mehr) zur Auswahl gehört, fällt weg; niemand muss
 * etikettieren.
 */
export const assignPurchaseLines = (
    lines: Array<{ productionItemId?: string | null }>,
    selectedItemIds: string[],
): LineAssignmentResult => {
    const selected = new Set(selectedItemIds);
    return {
        itemIds: lines.map((line) => {
            const own = typeof line.productionItemId === 'string' ? line.productionItemId.trim() : '';
            return own && selected.has(own) ? own : null;
        }),
    };
};

/**
 * Der wirksame Nettopreis einer Bestellzeile. In der LIEFERANTENBERECHNUNG ist
 * `netPrice` der Preis des Lieferanten VOR den Zeilenrabatten; seit dem
 * 19.09.2026 wirken Rabatt und Rabatt 2 dort mit (Vorgabe: «girilen
 * indirimler tedarikçi hesaplamalarına ve satır toplamlarına yansımalı»).
 */
export const effectiveNetPrice = (line: {
    netPrice: number;
    discount?: number | null;
    discount2?: number | null;
    calcMode?: string | null;
}): number => {
    const net = Number(line.netPrice) || 0;
    if (String(line.calcMode || '').toUpperCase() !== 'SUPPLIER') return net;
    const factor = (1 - clampPercent(line.discount) / 100) * (1 - clampPercent(line.discount2) / 100);
    return net * factor;
};

const clampPercent = (value: unknown): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(100, Math.max(0, parsed));
};

/* ═══════════════════════════════════════════════════════════════════════════
   3) VERKAUF GEGEN EINKAUF — DER VERGLEICH
   ═════════════════════════════════════════════════════════════════════════ */

export interface CostFigures {
    /** Verkaufswert (Positionen des Auftrags). */
    salesTotal: number;
    /** Offene, noch NICHT bestätigte Preise (Preisanfrage mit Preisen, Bestellentwurf). */
    openTotal: number;
    /** Bestätigte Bestellungen. */
    orderedTotal: number;
    /** Davon eingegangen (Wareneingang). */
    receivedTotal: number;
    /** Verkaufswert − Bestellt. */
    difference: number;
    /** Anteil der Differenz am Verkaufswert, in Prozent; null ohne Verkaufswert. */
    marginPercent: number | null;
}

export const emptyCostFigures = (): CostFigures => ({
    salesTotal: 0, openTotal: 0, orderedTotal: 0, receivedTotal: 0, difference: 0, marginPercent: null,
});

export const finishCostFigures = (figures: CostFigures): CostFigures => {
    const salesTotal = round2(figures.salesTotal);
    const orderedTotal = round2(figures.orderedTotal);
    const difference = round2(salesTotal - orderedTotal);
    return {
        salesTotal,
        openTotal: round2(figures.openTotal),
        orderedTotal,
        receivedTotal: round2(figures.receivedTotal),
        difference,
        marginPercent: salesTotal > 0 ? Math.round((difference / salesTotal) * 1000) / 10 : null,
    };
};

/** Der eingegangene Anteil einer bestätigten Zeile, in Franken. */
export const receivedValueOf = (line: Pick<ProductionOrderLine, 'lineTotal' | 'quantity' | 'receivedQuantity'>): number => {
    const quantity = Number(line.quantity) || 0;
    if (quantity <= 0) return 0;
    const share = Math.min(quantity, Math.max(0, Number(line.receivedQuantity) || 0)) / quantity;
    return round2((Number(line.lineTotal) || 0) * share);
};

export interface OpenPriceRow {
    productionItemId: string | null;
    lineTotal: number;
}

/**
 * Die Zahlen JE GERÄT (Schlüssel = Geräte-Id; `null` sammelt, was keinem Gerät
 * zugeordnet ist). Verkauf kommt vom Gerät, Einkauf aus den Bestellzeilen.
 */
export const costFiguresByItem = (
    items: Array<Pick<ProductionItem, 'id' | 'totalPrice' | 'isActive'>>,
    confirmed: Array<Pick<ProductionOrderLine, 'productionItemId' | 'lineTotal' | 'quantity' | 'receivedQuantity'>>,
    open: OpenPriceRow[],
): Map<string | null, CostFigures> => {
    const known = new Set(items.map((item) => item.id));
    const figures = new Map<string | null, CostFigures>();
    const bucket = (id: string | null | undefined): CostFigures => {
        const key = id && known.has(id) ? id : null;
        let entry = figures.get(key);
        if (!entry) { entry = emptyCostFigures(); figures.set(key, entry); }
        return entry;
    };
    for (const item of items) {
        const entry = bucket(item.id);
        if (item.isActive) entry.salesTotal += Number(item.totalPrice) || 0;
    }
    for (const line of confirmed) {
        const entry = bucket(line.productionItemId);
        entry.orderedTotal += Number(line.lineTotal) || 0;
        entry.receivedTotal += receivedValueOf(line);
    }
    for (const row of open) bucket(row.productionItemId).openTotal += Number(row.lineTotal) || 0;
    for (const [key, entry] of figures) figures.set(key, finishCostFigures(entry));
    return figures;
};

/** Mehrere Zahlenblöcke zusammenzählen (Projekt aus Geräten, Modul aus Projekten). */
export const sumCostFigures = (list: CostFigures[]): CostFigures =>
    finishCostFigures(list.reduce<CostFigures>((acc, entry) => ({
        salesTotal: acc.salesTotal + entry.salesTotal,
        openTotal: acc.openTotal + entry.openTotal,
        orderedTotal: acc.orderedTotal + entry.orderedTotal,
        receivedTotal: acc.receivedTotal + entry.receivedTotal,
        difference: 0,
        marginPercent: null,
    }), emptyCostFigures()));

/** Bestellstufen, deren Preise noch OFFEN sind — alles vor der Bestätigung. */
export const OPEN_PURCHASE_STATUSES = new Set(['DRAFT', 'PRICE_REQUEST', 'ORDER_DRAFT']);
/** Bestellstufen, in denen die Bestellung BESTÄTIGT ist. */
export const APPROVED_PURCHASE_STATUSES = new Set(['PENDING', 'ORDERED', 'TO_BE_STOCKED', 'COMPLETED']);
