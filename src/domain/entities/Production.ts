/**
 * ── PRODUKTION (19.09.2026, Vorgabe Samet) ──────────────────────────────────
 *
 * Das Modul «Produktionsaufträge» arbeitet auf eigenen Tabellen (`uretim_*`).
 * Die Verkaufsseite (Projekte, Aufträge AB, Nachträge NT, deren Positionen)
 * wird aus den unter «Firmenübertragungen» gewählten Firmen gelesen und hier
 * als Produktionsprojekte mit Geräten und Leistungen abgelegt; die
 * Lieferantenbestellungen hängen sich daran.
 *
 * Diese Datei kennt keine Datenbank: nur die Begriffe des Moduls.
 */

/** Woher ein Produktionsprojekt stammt: ein ERP-Projekt oder ein Lieferauftrag ohne Projekt. */
export type ProductionSourceKind = 'PROJECT' | 'DELIVERY';

/** Art eines Auftrags im Produktionsprojekt: Projektauftrag, Lieferauftrag oder Nachtrag. */
export type ProductionOrderKind = 'PROJECT' | 'DELIVERY' | 'ADDON';

export type ProductionItemKind = 'DEVICE' | 'SERVICE';

/** Aus welcher Verkaufszeile ein Gerät / eine Leistung stammt. */
export type ProductionItemSource = 'POSITION' | 'EXTRA_MATERIAL' | 'EXPENSE';

export interface ProductionTransferSettings {
    tenantId: string;
    /** Leer = die eigene Firma. */
    sourceTenantIds: string[];
    lastSyncedAt: Date | null;
    updatedAt: Date | null;
}

export interface ProductionProject {
    id: string;
    tenantId: string;
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
    syncedAt: Date;
}

export interface ProductionProjectOrder {
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

/** Ein Gerät oder eine Leistung — die Zeile, auf die Bestellungen zeigen. */
export interface ProductionItem {
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

/** Bestellung ↔ Projekt + die gewählten Geräte/Leistungen. */
export interface ProductionAssignment {
    purchaseOrderId: string;
    productionProjectId: string;
    productionItemIds: string[];
}

/** Eine Zeile einer BESTÄTIGTEN Lieferantenbestellung (Tabelle «Produktionsaufträge»). */
export interface ProductionOrderLine {
    id: string;
    purchaseOrderId: string;
    purchaseOrderNumber: string;
    supplierName: string | null;
    currency: string;
    productionProjectId: string;
    productionItemId: string | null;
    lineIndex: number;
    articleId: string | null;
    code: string | null;
    name: string;
    unit: string | null;
    quantity: number;
    grossPrice: number;
    discount: number;
    discount2: number;
    netPrice: number;
    lineTotal: number;
    receivedQuantity: number;
    approvedAt: Date;
    approvedById: string | null;
}

/* ── DIE QUELLE: was die Verkaufsseite hergibt ──────────────────────────────
   Das ist die Grenze zum Verkauf. Der Leser (Infrastruktur) übersetzt Aufträge,
   Offerten und Nachträge in diese flachen Zeilen; alles Weitere rechnet das
   Modul selbst. */

export interface SalesSourceOrder {
    id: string;
    tenantId: string;
    orderNumber: string;
    orderType: string;
    /** ORDERED | CANCELLED */
    status: string;
    parentSalesOrderId: string | null;
    projectId: string | null;
    projectNumber: string | null;
    projectName: string | null;
    projectStatus: string | null;
    customerName: string | null;
    /** Bezeichnung aus der Offerte (Kundenreferenz, Kommission) — für den Titel. */
    reference: string | null;
    orderDate: Date | null;
    totalAmount: number;
}

export interface SalesSourceLine {
    orderId: string;
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
}

export interface SalesSourceSnapshot {
    orders: SalesSourceOrder[];
    lines: SalesSourceLine[];
}

/** Die Lieferantenbestellung, wie das Modul sie liest (nur was es braucht). */
export interface PurchaseOrderView {
    id: string;
    referenceNumber: string;
    status: string;
    supplierName: string | null;
    currency: string;
    createdAt: Date;
    items: PurchaseOrderLineView[];
}

export interface PurchaseOrderLineView {
    index: number;
    articleId: string | null;
    code: string | null;
    name: string;
    unit: string | null;
    quantity: number;
    grossPrice: number;
    netPrice: number;
    discount: number;
    discount2: number;
    lineTotal: number;
    calcMode: string | null;
    receivedQuantity: number;
    productionItemId: string | null;
}
