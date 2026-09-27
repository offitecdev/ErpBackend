import type {
    Bom,
    BomArea,
    BomKind,
    BomIncomingLine,
    BomLineChange,
    BomLineDraft,
    BomOrderAction,
    BomOrderActionLine,
    BomPurchaseKind,
    BomPurchaseLineRecord,
    BomPurchaseLink,
    BomPurchaseRevision,
    BomRevision,
    BomRevisionLine,
    BomSerialFact,
    BomSettings,
    BomStatus,
    BomStockProduct,
    BomTemplate,
    BomTemplateInput,
    BomTemplateSummary,
} from '../entities/ProductionBom';

/**
 * ── DIE DATENBANKSEITE DER BOM (27.09.2026) ─────────────────────────────────
 *
 *   · IBomTemplateRepository  — die Vorlagen und ihre Zeilen
 *   · IBomRepository          — die BOMs der Geräte, ihre Nummern, der Verbrauch
 *   · IBomStockReader         — was die BOM vom Depo liest (Karten, Nummern)
 *                               und die EINE Stelle, an der sie dort schreibt:
 *                               Seriennummern zuordnen / freigeben
 *   · IBomPurchaseRepository  — Bestellungen ↔ BOM, Angebots-PDF, erwartete Ware
 *   · IBomProductionDirectory — Gerät, Projekt, Liefertermin, Personen der Stufe
 *   · IBomSettingsRepository  — «üretim modül ayarları»
 */

export interface IBomTemplateRepository {
    list(tenantId: string): Promise<BomTemplateSummary[]>;
    get(tenantId: string, id: string): Promise<BomTemplate | null>;
    create(tenantId: string, input: BomTemplateInput, userId: string | null, exampleKey?: string | null): Promise<BomTemplate>;
    update(tenantId: string, id: string, input: BomTemplateInput, userId: string): Promise<BomTemplate | null>;
    /** Weich: die BOMs der Geräte behalten ihre Kopie. */
    remove(tenantId: string, id: string, userId: string): Promise<boolean>;
    /** Gab es dieses Beispiel schon einmal (auch gelöscht)? */
    exampleKeys(tenantId: string): Promise<Set<string>>;
}

export interface BomCreateInput {
    productionProjectId: string;
    productionItemId: string;
    area: BomArea;
    kind: BomKind;
    /** Alt-BOM: ihre Haupt-BOM. */
    parentBomId: string | null;
    templateId: string | null;
    templateName: string;
    mainCard: string | null;
    codePrefix: string;
    lines: BomLineDraft[];
}

export interface BomConsumePlan {
    lines: Array<{
        lineId: string;
        productId: string;
        /** Karten ohne Seriennummer: so viel geht vom Bestand. */
        quantity: number;
        /** Karten mit Seriennummer: genau diese Nummern verlassen die Karte. */
        serialIds: string[];
        serialNumbers: string[];
    }>;
}

export interface IBomRepository {
    listForDevice(tenantId: string, productionItemId: string): Promise<Bom[]>;
    get(tenantId: string, id: string): Promise<Bom | null>;
    getMany(tenantId: string, ids: string[]): Promise<Bom[]>;
    /** Neue BOM mit frischer Nummer (Vorsatz + Zähler, nie doppelt) in EINEM Vorgang. */
    create(tenantId: string, input: BomCreateInput, userId: string): Promise<Bom>;
    replaceLines(tenantId: string, id: string, lines: BomLineDraft[], userId: string): Promise<Bom | null>;
    setStatus(
        tenantId: string,
        id: string,
        from: BomStatus[],
        patch: { status: BomStatus; approvedAt?: Date | null; approvedById?: string | null; completedAt?: Date | null; completedById?: string | null },
        userId: string,
    ): Promise<Bom | null>;
    remove(tenantId: string, id: string): Promise<boolean>;
    /** Die Haupt-BOM eines Geräts im Bereich — oder keine. */
    findMain(tenantId: string, productionItemId: string, area: BomArea): Promise<Bom | null>;
    /** So viele Alt-BOMs hängen an dieser Haupt-BOM. */
    countChildren(tenantId: string, parentBomId: string): Promise<number>;
    /** So viele BOMs stammen je Vorlage aus ihr. */
    usageByTemplate(tenantId: string): Promise<Map<string, number>>;
    /**
     * Offene Zeilen freigegebener/abgeschlossener, nicht verbrauchter BOMs der
     * Firma für diese Karten — ohne Liefertermin (den liest das Verzeichnis).
     */
    openDemandRows(tenantId: string, productIds: string[]): Promise<Array<{
        lineId: string;
        bomId: string;
        productId: string;
        productionProjectId: string;
        productionItemId: string;
        quantity: number;
        consumedQuantity: number;
        approvedAt: Date | null;
        bomSortOrder: number;
        lineSortOrder: number;
    }>>;
    /**
     * «Stoktan düş»: Bestand ab, Nummern von der Karte, Verbrauch schreiben,
     * `consumedQuantity` und `consumedAt` — alles in EINEM Vorgang. `null` =
     * die BOM war schon verbraucht (zwei gleichzeitige Klicks buchen nie doppelt).
     */
    consume(tenantId: string, id: string, plan: BomConsumePlan, userId: string): Promise<Bom | null>;
}

export interface IBomStockReader {
    products(tenantId: string, productIds: string[]): Promise<Map<string, BomStockProduct>>;
    serials(tenantId: string, productIds: string[]): Promise<BomSerialFact[]>;
    /** Suche nach ERP-Code, Modellnummer, Name, Marke oder einem Barcode. */
    search(tenantId: string, query: string, limit: number): Promise<BomStockProduct[]>;
    assignSerials(
        tenantId: string,
        assignments: Array<{
            serialId: string;
            productionProjectId: string;
            productionItemId: string;
            projectNumber: string | null;
            projectName: string | null;
            deviceName: string | null;
        }>,
    ): Promise<number>;
    releaseSerials(tenantId: string, serialIds: string[]): Promise<number>;
    /** Lieferant an die Karte hängen (aus «Yeni tedarikçi» der Bestellung), falls er fehlt. */
    addSupplierToProduct(tenantId: string, productId: string, supplier: { supplierId: string | null; name: string }): Promise<void>;
}

export interface BomPurchaseOrderRow {
    id: string;
    referenceNumber: string;
    status: string;
    supplierId: string | null;
    supplierName: string;
    quoteNumber: string | null;
    currency: string;
    totalNet: number;
    emailSentAt: Date | null;
    createdAt: Date;
    items: Array<Record<string, unknown>>;
}

export interface IBomPurchaseRepository {
    linksForBom(tenantId: string, bomId: string): Promise<BomPurchaseLink[]>;
    linksForBoms(tenantId: string, bomIds: string[]): Promise<BomPurchaseLink[]>;
    linkForOrder(tenantId: string, purchaseOrderId: string): Promise<BomPurchaseLink | null>;
    orders(tenantId: string, purchaseOrderIds: string[]): Promise<BomPurchaseOrderRow[]>;
    /** Positionen bestellter BOM-Ware, die noch kommt (nur Bestellungen, keine Anfragen). */
    incoming(tenantId: string, productIds: string[]): Promise<BomIncomingLine[]>;
    createLink(
        tenantId: string,
        input: {
            purchaseOrderId: string;
            bomId: string;
            productionProjectId: string;
            productionItemId: string;
            kind: BomPurchaseKind;
            sourcePurchaseOrderId: string | null;
            lines: BomPurchaseLineRecord[];
            /** Die BOM-Revision, für die der Beleg gilt (Vorgabe 0). */
            bomRevision?: number;
        },
        userId: string,
    ): Promise<BomPurchaseLink>;
    setQuoteFile(
        tenantId: string,
        purchaseOrderId: string,
        file: { ref: string; name: string; type: string; size: number } | null,
        userId: string,
    ): Promise<BomPurchaseLink | null>;
    removeLink(tenantId: string, purchaseOrderId: string): Promise<BomPurchaseLink | null>;
    /** Verknüpfungen, deren Bestellung es nicht mehr gibt — sie werden beim Lesen geheilt. */
    pruneOrphans(tenantId: string, links: BomPurchaseLink[]): Promise<BomPurchaseLink[]>;
}

export interface BomDeviceFacts {
    id: string;
    productionProjectId: string;
    name: string;
    kind: string;
    quantity: number;
    positionNumber: string | null;
    isActive: boolean;
}

export interface BomProjectFacts {
    id: string;
    projectNumber: string;
    projectName: string;
    customerName: string | null;
    sourceStatus: string | null;
    isActive: boolean;
}

export interface IBomProductionDirectory {
    device(tenantId: string, itemId: string): Promise<BomDeviceFacts | null>;
    devices(tenantId: string, itemIds: string[]): Promise<Map<string, BomDeviceFacts>>;
    project(tenantId: string, projectId: string): Promise<BomProjectFacts | null>;
    projects(tenantId: string, projectIds: string[]): Promise<Map<string, BomProjectFacts>>;
    /** Liefertermin je Projekt (Offerte der Quelle, sonst Projektende). */
    deliveryDates(tenantId: string, projectIds: string[]): Promise<Map<string, Date | null>>;
    /** Wer an diesem Gerät eine Aufgabe der Stufe BOM im Bereich hat. */
    bomStageAssignees(tenantId: string, itemId: string, area: BomArea): Promise<string[]>;
    personName(id: string): Promise<string | null>;
    /** Mehrere Namen in einer Abfrage (Kennung → «Vorname Nachname»). */
    personNames(ids: string[]): Promise<Map<string, string>>;
}

export interface IBomSettingsRepository {
    get(tenantId: string): Promise<BomSettings>;
    save(tenantId: string, settings: BomSettings, userId: string): Promise<BomSettings>;
}

/**
 * ── DIE REVISIONEN (27.09.2026) ─────────────────────────────────────────────
 * Rev.0 = Abzug der ersten Freigabe, danach je Revision ein Datensatz; die
 * Revision im Entwurf ist die Arbeitskopie. Freigegeben wird sie in EINEM
 * Vorgang mit den Zeilen der BOM und ihren Bestellungen (IBomRevisionWriter).
 */
export interface IBomRevisionRepository {
    /** Alle Revisionen dieser BOMs (älteste zuerst). */
    listForBoms(tenantId: string, bomIds: string[]): Promise<BomRevision[]>;
    get(tenantId: string, bomId: string, revision: number): Promise<BomRevision | null>;
    draftOf(tenantId: string, bomId: string): Promise<BomRevision | null>;
    /** Rev.0 als Abzug der geltenden Zeilen — nur, wenn es sie noch nicht gibt. */
    ensureBaseline(tenantId: string, bom: Bom): Promise<void>;
    /** Die Revision im Entwurf; `null`, wenn schon eine offen ist (zwei Klicks legen nie zwei an). */
    createDraft(
        tenantId: string,
        input: { bomId: string; revision: number; reason: string; lines: BomRevisionLine[] },
        userId: string,
    ): Promise<BomRevision | null>;
    saveDraftLines(tenantId: string, bomId: string, lines: BomRevisionLine[], userId: string): Promise<BomRevision | null>;
    deleteDraft(tenantId: string, bomId: string): Promise<boolean>;
    /** Die alten Fassungen dieser Bestellungen — ohne den Abzug der Bestellung selbst. */
    purchaseRevisions(tenantId: string, purchaseOrderIds: string[]): Promise<Array<Omit<BomPurchaseRevision, 'previousOrder'>>>;
    /** Dasselbe für alle Bestellungen dieser BOMs (ein Rundgang für die Ansicht). */
    purchaseRevisionsForBoms(tenantId: string, bomIds: string[]): Promise<Array<Omit<BomPurchaseRevision, 'previousOrder'>>>;
    /** Die Archivzeilen einer gelöschten Bestellung entfernen — ihre Angebote liefert die Antwort. */
    removePurchaseRevisions(tenantId: string, purchaseOrderId: string): Promise<Array<{ quoteFileRef: string | null }>>;
    purchaseRevision(tenantId: string, purchaseOrderId: string, number: number): Promise<BomPurchaseRevision | null>;
}

/** Eine Bestellung, wie die Freigabe einer Revision sie ändert. */
export interface BomRevisionOrderWrite {
    purchaseOrderId: string;
    mode: 'UPDATE' | 'REVISE' | 'DELETE';
    /** Die neue Menge/Einheit je Position (`index` in `PurchaseOrder.items`); Menge 0 = die Position fällt weg. */
    items: Array<{ index: number; bomLineId: string; quantity: number; unit: string | null }>;
    /** REVISE: die neue Revision der Bestellung. */
    orderRevision: number | null;
    statusAfter: string;
    /** REVISE: was sich änderte (für das Archiv und das PDF). */
    changes: BomOrderActionLine[];
}

export interface BomRevisionApplyInput {
    tenantId: string;
    userId: string;
    bom: Pick<Bom, 'id' | 'kind' | 'parentBomId' | 'revision'>;
    draftId: string;
    newRevision: number;
    lines: BomRevisionLine[];
    changes: BomLineChange[];
    orderActions: BomOrderAction[];
    orders: BomRevisionOrderWrite[];
}

export interface BomRevisionApplyResult {
    /** Die geänderten Bestellungen (für den Abgleich der Produktion). */
    updated: Array<{ id: string; referenceNumber: string; status: string; supplierName: string; currency: string; items: string; tenantId: string }>;
    /** Gelöschte Entwürfe — ihre Angebote liegen noch in der Ablage. */
    deleted: Array<{ id: string; quoteFileRef: string | null }>;
}

export interface IBomRevisionWriter {
    /**
     * Die Revision freigeben: BOM (Revision, Stand), ihre Zeilen, der Datensatz
     * der Revision, die Haupt-BOM darüber und die Bestellungen — alles in EINEM
     * Vorgang. `null` = die BOM hat sich inzwischen geändert (Revision, Stand).
     */
    apply(input: BomRevisionApplyInput): Promise<BomRevisionApplyResult | null>;
}
