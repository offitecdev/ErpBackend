/**
 * ── DEPO — DAS LAGER DER PRODUKTIONSFIRMA (26.09.2026, Vorgabe Samet) ────────
 *
 * «Stok modülünü bozmuyoruz. Ek olarak depo modülü yazıyoruz. Depo modülü
 *  sadece üretim modülü ile ilişkili olması gerekir.»
 *
 * Ein eigenes Lager neben dem Artikellager (Article/StockBalance bleiben
 * unberührt), nur in Firmen mit `companyType = PRODUCTION`. Die erste Seite
 * sind die Produktkarten; Pflicht ist allein der Name.
 *
 * Zweiter Durchgang (am selben Tag): Hauptkategorien mit Kürzel (Elektrik =
 * ELK), Materialgruppen mit Kürzel (PLC), der ERP-Code je Gruppe
 * (ELK-PLC-00001), ein GS1-Barcode je Karte, Etiketten und der Excel-Aktarım
 * mit Freigabe durch die Verwaltung.
 *
 * Tabellen: `depo_*` (prisma/schema/warehouse.prisma).
 */

/** Dieselbe Liste wie die Offerte (Frontend utils/currency.ts). */
export const WAREHOUSE_CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP', 'TRY'] as const;
export type WarehouseCurrency = typeof WAREHOUSE_CURRENCIES[number];

/**
 * Die Einheit einer Karte (30.09.2026, Samet: «her ürünün de birim türü
 * olmalıdır — adet, uzunluk … bom listede vardı, oraya otomatik gelmesi
 * gerekmektedir»). Dieselbe Liste wie die BOM-Zeile (BOM_UNITS) — das Depo
 * importiert die BOM nicht, darum hier gespiegelt.
 */
export const WAREHOUSE_UNITS = ['PCS', 'M', 'KG', 'SET', 'PACK'] as const;
export type WarehouseUnit = typeof WAREHOUSE_UNITS[number];

/** Hauptkategorie (erste Zelle des ERP-Codes). */
export interface WarehouseCategory {
    id: string;
    tenantId: string;
    name: string;
    code: string;
    sortOrder: number;
}

export interface WarehouseMaterialGroup {
    id: string;
    tenantId: string;
    categoryId: string;
    categoryName: string;
    categoryCode: string;
    name: string;
    /** Kürzel (zweite Zelle); leer nur beim Altbestand vor den Kategorien. */
    code: string | null;
    /** Zuletzt vergebene Laufnummer der Gruppe. */
    lastNumber: number;
    sortOrder: number;
}

export interface WarehouseMaterialGroupWithCount extends WarehouseMaterialGroup {
    productCount: number;
    /** Karten der Gruppe ohne ERP-Code (Altbestand) — «Kod ver» holt sie nach. */
    uncodedCount: number;
}

export interface WarehouseCategoryWithGroups extends WarehouseCategory {
    groups: WarehouseMaterialGroupWithCount[];
}

/**
 * Ein Lieferant einer Karte mit SEINEM Barcode des Produkts (dritter
 * Durchgang: «birden fazla tedarikçi»; vierter: «bu tedarikçi ürün kodu değil
 * aslında bu ürün barkodu olması lazım — tedarikçiye göre ürün barkodu»).
 * `supplierId` = Supplier.id, wenn aus der Lieferantenliste gewählt.
 */
export interface WarehouseSupplierEntry {
    supplierId: string | null;
    name: string;
    barcode: string | null;
    /** Seine E-Mail für diese Karte (30.09.2026) — an sie geht die Preisanfrage. */
    email: string | null;
    /** Seine Artikel- und Bestellnummer für das Produkt (01.10.2026) — stehen in seiner Anfrage/Bestellung. */
    articleNumber?: string | null;
    orderNumber?: string | null;
}

export interface WarehouseProduct {
    id: string;
    tenantId: string;
    erpCode: string | null;
    materialGroupId: string | null;
    materialGroupName: string | null;
    materialGroupCode: string | null;
    categoryId: string | null;
    categoryName: string | null;
    categoryCode: string | null;
    name: string;
    brand: string | null;
    /** In der Oberfläche seit dem 30.09.2026 «Üretici kodu» (nie gedruckt). */
    modelNumber: string | null;
    /** «Ürün kodu» (30.09.2026) — steht im PDF der Preisanfrage und der Bestellung. */
    productCode: string | null;
    /** Einheit der Karte; leer bei älteren Karten. */
    unit: WarehouseUnit | null;
    /** Taslak: es fehlt noch, was eine fertige Karte braucht (Einheit, Lieferant, E-Mail). */
    isDraft: boolean;
    /** Der erste Lieferant (Abzug auf der Karte, für Liste und Sortierung). */
    supplierId: string | null;
    supplierName: string | null;
    /** Alle Lieferanten der Karte, in ihrer Reihenfolge, jeder mit seinem Barcode. */
    suppliers: WarehouseSupplierEntry[];
    description: string | null;
    /** Bei Seriennummernpflicht = Zahl der Seriennummern. */
    quantity: number;
    purchasePrice: number | null;
    /** Mindestbestellmenge — darunter wird nie bestellt (BOM). Leer = keine. */
    minimumOrderQuantity: number | null;
    currency: string | null;
    barcode: string | null;
    /** Herstellerbarcode OHNE Lieferant (die der Lieferanten stehen in `suppliers`). */
    manufacturerBarcode: string | null;
    serialRequired: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface WarehouseSerial {
    id: string;
    tenantId: string;
    productId: string;
    serialNumber: string;
    productionProjectId: string | null;
    productionItemId: string | null;
    /** Abzug beim Speichern — die lebenden Namen liest der Anwendungsfall nach. */
    projectNumber: string | null;
    projectName: string | null;
    deviceName: string | null;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Die geprüften, gespeicherten Felder einer Karte (ohne Kennung und Zähler).
 * ERP-Code und Barcode stehen hier nur zum Durchreichen: das System vergibt
 * sie (siehe domain/services/warehouseCodes.ts), die Eingabe setzt sie nie.
 * Der erste Eintrag von `suppliers` wird als Abzug auf die Karte geschrieben.
 */
export interface WarehouseProductFields {
    erpCode: string | null;
    materialGroupId: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    productCode: string | null;
    unit: WarehouseUnit | null;
    suppliers: WarehouseSupplierEntry[];
    description: string | null;
    quantity: number;
    purchasePrice: number | null;
    minimumOrderQuantity: number | null;
    currency: WarehouseCurrency | null;
    barcode: string | null;
    manufacturerBarcode: string | null;
    serialRequired: boolean;
    isDraft: boolean;
}

/** Wem ein Stück zugeordnet ist — Produktionsprojekt und (freiwillig) Gerät. */
export interface WarehouseProductionTarget {
    productionProjectId: string | null;
    productionItemId: string | null;
    projectNumber: string | null;
    projectName: string | null;
    deviceName: string | null;
}

export interface WarehouseSerialDraft extends WarehouseProductionTarget {
    serialNumber: string;
}

export type WarehouseSortKey =
    | 'erpCode'
    | 'name'
    | 'brand'
    | 'modelNumber'
    | 'supplierName'
    | 'description'
    | 'quantity'
    | 'barcode'
    | 'updatedAt';

export interface WarehouseProductFilter {
    /** ERP-Code ODER Name enthält … (Vorgabe: «tek bir arama çubuğu»). */
    search?: string;
    /** Materialgruppen (mehrere); `null` in der Liste = ohne Gruppe. */
    groupIds?: Array<string | null>;
    /** Genau dieser Code: Barcode, Herstellerbarcode, ERP-Code oder Seriennummer. */
    barcode?: string;
    sort: WarehouseSortKey;
    direction: 'asc' | 'desc';
    page: number;
    pageSize: number;
}

export interface WarehouseProductPage {
    items: WarehouseProduct[];
    total: number;
}

/**
 * Ein Treffer einer anderen Karte auf einen Code dieser Karte:
 *   barcode             — unser Barcode steht schon (als Barcode oder Herstellerbarcode) auf einer anderen Karte
 *   manufacturerBarcode — der Herstellerbarcode gehört schon einer anderen Karte («sadece 1 tane ürün»),
 *                         ob ohne Lieferant oder als Barcode eines ihrer Lieferanten
 */
export interface WarehouseCodeConflict {
    productId: string;
    productName: string;
    field: 'erpCode' | 'barcode' | 'manufacturerBarcode';
    code: string;
}

/** Ein Produktionsprojekt der Auswahl (nur lesend aus `uretim_projeler`). */
export interface WarehouseProjectOption {
    id: string;
    projectNumber: string;
    projectName: string;
    customerName: string | null;
    deviceCount: number;
    isActive: boolean;
}

/** Ein Gerät eines Produktionsprojekts (nur lesend aus `uretim_proje_kalemleri`). */
export interface WarehouseDeviceOption {
    id: string;
    productionProjectId: string;
    name: string;
    positionNumber: string | null;
    articleCode: string | null;
    isActive: boolean;
}

/** Ein Lieferant der Auswahl: aus der Lieferantenliste oder schon auf einer Karte geschrieben. */
export interface WarehouseSupplierOption {
    id: string | null;
    name: string;
    /** Die E-Mail aus der Lieferantenliste (30.09.2026) — die Karte schlägt sie vor. */
    email?: string | null;
}

/* ── Etikett ─────────────────────────────────────────────────────────────── */

/** «roll» = Etikettendrucker (jede Seite ein Etikett); «a4» = Etikettenbogen. */
export type WarehouseLabelLayout = 'roll' | 'a4';

export interface WarehouseLabelSettings {
    widthMm: number;
    heightMm: number;
    layout: WarehouseLabelLayout;
    /** Den Produktnamen über den Barcode setzen. */
    showName: boolean;
}

export interface WarehouseSettings {
    tenantId: string;
    barcodeLastNumber: number;
    label: WarehouseLabelSettings;
}

/* ── Excel-Aktarım ───────────────────────────────────────────────────────── */

export type WarehouseImportStatus = 'PENDING' | 'DONE' | 'REJECTED' | 'CANCELLED';

/** Eine Zeile, wie sie zur Freigabe eingereicht wird — Werte schon bereinigt. */
export interface WarehouseImportRow {
    /** Zeile in der Excel-Datei (für die Meldungen). */
    row: number;
    /** Der Gruppentext aus der Datei («ELK-PLC — Elektrik › PLC» oder leer). */
    group: string | null;
    /** Die beim Einreichen erkannte Gruppe — bei der Freigabe zuerst gesucht. */
    groupId?: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    /** «Ürün kodu» (30.09.2026) — fehlt in älteren Dateien. */
    productCode?: string | null;
    /** Einheit (30.09.2026) — fehlt in älteren Dateien. */
    unit?: WarehouseUnit | null;
    supplierName: string | null;
    /** E-Mail des Lieferanten (30.09.2026) — fehlt in älteren Dateien. */
    supplierEmail?: string | null;
    /** Artikel- und Bestellnummer DES Lieferanten der Zeile (01.10.2026). */
    supplierArticleNumber?: string | null;
    supplierOrderNumber?: string | null;
    description: string | null;
    quantity: number;
    purchasePrice: number | null;
    currency: WarehouseCurrency | null;
    /** Der Herstellerbarcode — mit Lieferant gehört er diesem, sonst der Karte. */
    manufacturerBarcode: string | null;
    serialRequired: boolean;
}

export type WarehouseImportIssueLevel = 'error' | 'warning';

export interface WarehouseImportIssue {
    level: WarehouseImportIssueLevel;
    code: string;
    field?: string;
    params?: Record<string, string | number>;
}

export interface WarehouseImportResult {
    created: number;
    skipped: number;
    failed: Array<{ row: number; code: string }>;
    firstCode: string | null;
    lastCode: string | null;
}

export interface WarehouseImport {
    id: string;
    tenantId: string;
    status: WarehouseImportStatus;
    fileName: string | null;
    rowCount: number;
    rows: WarehouseImportRow[];
    requestedById: string | null;
    requestedByName: string | null;
    decidedById: string | null;
    decidedByName: string | null;
    decidedAt: Date | null;
    note: string | null;
    result: WarehouseImportResult | null;
    createdAt: Date;
    updatedAt: Date;
}

/** Was ein neuer Code braucht: die Gruppe und ob die Karte schon einen Barcode trägt. */
export interface WarehouseCodeGrant {
    erpCode: string;
    /** Neu vergeben, oder `null`, wenn die Karte ihren Barcode behält. */
    barcode: string | null;
}

/** Eine neue Karte aus dem Aktarım: die Felder und (freiwillig) die Gruppe. */
export interface WarehouseImportCreate {
    row: number;
    fields: WarehouseProductFields;
}
