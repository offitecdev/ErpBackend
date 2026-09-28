/**
 * ── BOM DER PRODUKTION (27.09.2026, Vorgabe Samet) ──────────────────────────
 *
 * «Üretimde BOM Liste alanında … her bom için bom şablonları olur, bom şablon
 *  adı, bom şablon kategorisi elektrik, makineden biri … bir rezerve sistemi
 *  de olması lazım … BOM TAMAMLA.»
 *
 * Eine VORLAGE ist eine Liste von Depo-Karten mit Mengen; auf dem Gerät wird
 * daraus eine BOM (Kopie). Die Kategorie der Vorlage ist der Bereich des
 * Geräts: Makine ↔ Mekanik, Elektrik ↔ Elektrik.
 *
 * Tabellen: prisma/schema/productionBom.prisma.
 */
import type { ProductionBuiltInArea } from './ProductionTask';

/** Die BOM hängt an den FESTEN Bereichen (Mekanik / Elektrik), nicht an eigenen einer Vorlage. */
export type BomArea = ProductionBuiltInArea;
/** «bom şablon kategorisi elektrik, makineden biri». */
export type BomCategory = 'MACHINE' | 'ELECTRICAL';
export const BOM_CATEGORIES: readonly BomCategory[] = ['MACHINE', 'ELECTRICAL'];

/** Makine ↔ Mekanik, Elektrik ↔ Elektrik. */
export const CATEGORY_OF_AREA: Record<BomArea, BomCategory> = { MECHANICAL: 'MACHINE', ELECTRICAL: 'ELECTRICAL' };
export const AREA_OF_CATEGORY: Record<BomCategory, BomArea> = { MACHINE: 'MECHANICAL', ELECTRICAL: 'ELECTRICAL' };

/**
 * DRAFT      Zeilen werden zusammengestellt, nichts ist reserviert.
 * APPROVED   «bom onaylanınca … rezerve olmalı» — die Zeilen sind fest, die
 *            Reservierungen laufen, bestellt wird, was fehlt. ENDGÜLTIG
 *            (27.09.2026: «bom onaylanırsa geri dönüş yok, revize olması
 *            lazım»): zurück in den Entwurf geht es nie, geändert wird über
 *            eine Revision (BomRevision).
 * COMPLETED  «tüm bomları sipariş edip siparişleri onaylayınca rezerveler tam
 *            anlamıyla oluşunca BOM TAMAMLA» — alles ist da und reserviert.
 * Der Verbrauch («proje bitince rezerveler stoktan düşmeli») ist KEIN Stand,
 * sondern ein Zeitpunkt an der BOM (`consumedAt`).
 */
export type BomStatus = 'DRAFT' | 'APPROVED' | 'COMPLETED';

/**
 * «Her zaman bir ana BOM olmak zorundadır, bu ana BOM'un altında alt BOM'lar
 *  olmalıdır» (27.09.2026). MAIN = die Haupt-BOM eines Geräts im Bereich,
 * genau eine (BOM-MEK-00001 / BOM-ELK-00001); SUB = eine Alt-BOM darunter,
 * ihr Kod kommt aus den Einstellungen. Jede führt ihren eigenen Weg
 * (freigeben, bestellen, abschliessen); die Haupt-BOM schliesst erst ab,
 * wenn alle Alt-BOMs abgeschlossen sind.
 */
export type BomKind = 'MAIN' | 'SUB';

/** «Ana BOM kod şudur: BOM-MEK-00001, BOM-ELK-00001.» */
export const MAIN_BOM_PREFIX: Record<BomArea, string> = { MECHANICAL: 'BOM-MEK', ELECTRICAL: 'BOM-ELK' };

/** Ein Alt-BOM-Kod der Einstellungen: Vorsatz und Name (MAK-COOL · Soğutma devresi). */
export interface BomCode {
    prefix: string;
    name: string;
}

/** Einheiten der Zeilen (Depo-Karten führen keine eigene Einheit). */
export const BOM_UNITS = ['PCS', 'M', 'KG', 'SET', 'PACK'] as const;
export type BomUnit = typeof BOM_UNITS[number];

/** Wie eine Zeile auf ihre Depo-Karte zeigt — mit dem Abzug beim Einfügen. */
export interface BomProductRef {
    productId: string;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
}

export interface BomTemplateLine extends BomProductRef {
    id: string;
    quantity: number;
    unit: BomUnit;
    note: string | null;
    sortOrder: number;
}

export interface BomTemplate {
    id: string;
    tenantId: string;
    name: string;
    category: BomCategory;
    mainCard: string;
    codePrefix: string;
    description: string | null;
    exampleKey: string | null;
    sortOrder: number;
    createdById: string | null;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
    lines: BomTemplateLine[];
}

export interface BomTemplateSummary {
    id: string;
    name: string;
    category: BomCategory;
    mainCard: string;
    codePrefix: string;
    lineCount: number;
    /** So viele BOMs auf Geräten stammen aus dieser Vorlage. */
    usedBy: number;
    exampleKey: string | null;
    sortOrder: number;
    updatedAt: Date;
}

/** Eine Zeile, wie sie gespeichert wird (Vorlage wie Gerät). */
export interface BomLineDraft extends BomProductRef {
    quantity: number;
    unit: BomUnit;
    note: string | null;
}

export interface BomTemplateInput {
    name: string;
    category: BomCategory;
    mainCard: string;
    codePrefix: string;
    description: string | null;
    lines: BomLineDraft[];
}

export interface BomLine extends BomProductRef {
    id: string;
    bomId: string;
    unit: BomUnit;
    quantity: number;
    consumedQuantity: number;
    note: string | null;
    sortOrder: number;
}

export interface Bom {
    id: string;
    tenantId: string;
    productionProjectId: string;
    productionItemId: string;
    area: BomArea;
    kind: BomKind;
    /** Bei einer Alt-BOM: die Haupt-BOM darüber. */
    parentBomId: string | null;
    templateId: string | null;
    templateName: string;
    mainCard: string | null;
    bomNumber: string;
    status: BomStatus;
    /** Die GELTENDE Revision (0 = die erste Freigabe). */
    revision: number;
    approvedAt: Date | null;
    approvedById: string | null;
    completedAt: Date | null;
    completedById: string | null;
    consumedAt: Date | null;
    consumedById: string | null;
    sortOrder: number;
    createdById: string | null;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
    lines: BomLine[];
}

/* ── Was die Reservierung über das Depo wissen muss ───────────────────────── */

/** Eine Depo-Karte, wie die BOM sie liest (nur lesend). */
export interface BomStockProduct {
    productId: string;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    description: string | null;
    serialRequired: boolean;
    /** Bestand der Karte (bei Seriennummernpflicht = Zahl der Nummern). */
    quantity: number;
    /** «minimum alış» — die Bestellung geht nie darunter. */
    minimumOrderQuantity: number | null;
    materialGroupId: string | null;
    suppliers: Array<{ supplierId: string | null; name: string }>;
    purchasePrice: number | null;
    currency: string | null;
}

/** Eine Seriennummer einer Karte mit ihrer Zuordnung (depo_seri_numaralari). */
export interface BomSerialFact {
    id: string;
    productId: string;
    serialNumber: string;
    productionProjectId: string | null;
    productionItemId: string | null;
    createdAt: Date;
}

/**
 * Ein offener Bedarf: eine Zeile einer freigegebenen (oder abgeschlossenen,
 * noch nicht verbrauchten) BOM — über ALLE Geräte der Firma, denn der
 * frühere Liefertermin geht vor.
 */
export interface BomDemand {
    lineId: string;
    bomId: string;
    productId: string;
    productionProjectId: string;
    productionItemId: string;
    /** Bedarf − schon verbraucht. */
    openQuantity: number;
    /** Liefertermin des Projekts («termini önce olan projeye»). */
    deliveryDate: Date | null;
    approvedAt: Date | null;
    bomSortOrder: number;
    lineSortOrder: number;
}

/** Eine Position einer BOM-Bestellung, die noch Ware bringt. */
export interface BomIncomingLine {
    purchaseOrderId: string;
    referenceNumber: string;
    status: string;
    confirmed: boolean;
    bomLineId: string;
    productId: string;
    quantity: number;
    received: number;
}

/** Was eine Zeile gerade hat — gerechnet, nie gespeichert. */
export interface BomLineCoverage {
    lineId: string;
    /** Bedarf − verbraucht. */
    open: number;
    /** Aus dem Bestand reserviert (Seriennummern: fest zugeordnet). */
    reserved: number;
    /** Was bestellte Ware bringen wird (eigene Bestellung zuerst). */
    incoming: number;
    /** … davon aus bestätigten Bestellungen. */
    incomingConfirmed: number;
    /** Weder im Bestand noch bestellt. */
    missing: number;
    /** Die reservierten Seriennummern. */
    serials: string[];
}

export type BomOrderBlock = 'NO_PRODUCT' | 'NO_ERP_CODE' | 'OPEN_ORDER';

/** Eine Zeile des Vorschlags «Sipariş oluştur». */
export interface BomOrderProposalLine {
    lineId: string;
    missing: number;
    minimum: number | null;
    /** max(fehlend, Mindestbestellmenge) — darunter geht es nicht. */
    floor: number;
    block: BomOrderBlock | null;
}

/** Eine Zeile, wie «Sipariş oluştur» sie bestellt. */
export interface BomOrderLineInput {
    lineId: string;
    quantity: number;
    supplierId: string | null;
    supplierName: string;
    note: string | null;
}

/**
 * Eine Zeile, wie «Fiyat talebi» sie anfragt (27.09.2026) — bei EINEM oder
 * MEHREREN Lieferanten; jeder Lieferant bekommt seine eigene Preisanfrage.
 */
export interface BomRequestLineInput {
    lineId: string;
    quantity: number;
    suppliers: Array<{ supplierId: string | null; supplierName: string }>;
}

/** Wie bestellt wurde (uretim_bom_siparisleri.lines). */
export interface BomPurchaseLineRecord {
    bomLineId: string;
    missing: number;
    minimum: number | null;
    ordered: number;
    note: string | null;
}

export type BomPurchaseKind = 'ORDER' | 'REQUEST';

export interface BomPurchaseLink {
    id: string;
    tenantId: string;
    purchaseOrderId: string;
    bomId: string;
    productionProjectId: string;
    productionItemId: string;
    kind: BomPurchaseKind;
    sourcePurchaseOrderId: string | null;
    lines: BomPurchaseLineRecord[];
    quoteFileRef: string | null;
    quoteFileName: string | null;
    quoteFileType: string | null;
    quoteFileSize: number | null;
    quoteUploadedAt: Date | null;
    quoteUploadedById: string | null;
    /** Die BOM-Revision, für die der Beleg gilt (angelegt oder zuletzt nachgezogen). */
    bomRevision: number;
    /** Wie oft eine BOM-Revision die Bestellung beim Lieferanten geändert hat. */
    orderRevision: number;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
}

/* ── Revisionen (27.09.2026, Vorgabe Samet) ─────────────────────────────────
   «Bom onaylanırsa geri dönüş yok, revize olması lazım … eski bom kayıt
    edilmeli.» Eine freigegebene BOM ändert sich nur noch über eine Revision:
    Rev.0 ist die erste Freigabe, jede weitere ein eigener Datensatz. Die
    Revision im Entwurf ist eine Arbeitskopie — die BOM gilt unverändert
    weiter, bis sie freigegeben ist. */

export type BomRevisionStatus = 'DRAFT' | 'APPROVED';

/** Eine Zeile einer Revision — `id` ist die Kennung der BOM-Zeile (bleibt je Karte). */
export interface BomRevisionLine extends BomProductRef {
    id: string;
    unit: BomUnit;
    quantity: number;
    note: string | null;
}

/**
 * Was sich an einer Zeile gegenüber der vorigen Revision ändert. EDITED =
 * nur Einheit oder Notiz (die Menge bleibt).
 */
export type BomChangeKind = 'ADDED' | 'REMOVED' | 'INCREASED' | 'DECREASED' | 'EDITED';

export interface BomLineChange {
    kind: BomChangeKind;
    lineId: string;
    productId: string;
    erpCode: string | null;
    name: string;
    unitBefore: BomUnit | null;
    unitAfter: BomUnit | null;
    /** Menge vorher (0 = neu). */
    before: number;
    /** Menge nachher (0 = entfernt). */
    after: number;
    noteBefore: string | null;
    noteAfter: string | null;
}

/**
 * Was eine Revision mit einer Bestellung macht:
 *   UPDATE   Entwurf (nie beim Lieferanten) — die Zeilen ändern sich direkt
 *   REVISE   beim Lieferanten — dieselbe Nummer, Revision +1, alte Fassung ins Archiv,
 *            die Bestätigung des Lieferanten ist neu nötig
 *   DELETE   Entwurf, dessen Zeilen alle wegfallen — er wird gelöscht
 *   CANCEL   beim Lieferanten, alle Zeilen fallen weg — bleibt stehen, bis der
 *            Einkauf die Stornierung geklärt hat (kommt die Ware doch, ist sie frei)
 *   KEEP     bleibt, wie sie ist (vom Einkauf so gewählt, oder die Ware ist da)
 */
export type BomOrderActionKind = 'UPDATE' | 'REVISE' | 'DELETE' | 'CANCEL' | 'KEEP';

export interface BomOrderActionLine {
    /** Die Stelle in `PurchaseOrder.items`. */
    index: number;
    bomLineId: string;
    code: string | null;
    name: string;
    unitBefore: string | null;
    unitAfter: string | null;
    before: number;
    after: number;
    received: number;
}

export interface BomOrderAction {
    purchaseOrderId: string;
    referenceNumber: string;
    supplierName: string;
    status: string;
    /** Die Mail ist hinausgegangen oder der Lieferant hat bestätigt. */
    atSupplier: boolean;
    action: BomOrderActionKind;
    /** Nur Minderungen beim Lieferanten: der Einkauf darf sie so lassen («tedarikçi kabul etmezse»). */
    canKeep: boolean;
    /** Die Revision der Bestellung danach (REVISE), sonst null. */
    orderRevision: number | null;
    statusAfter: string;
    lines: BomOrderActionLine[];
}

export interface BomRevision {
    id: string;
    tenantId: string;
    bomId: string;
    revision: number;
    status: BomRevisionStatus;
    reason: string | null;
    lines: BomRevisionLine[];
    changes: BomLineChange[];
    orderActions: BomOrderAction[];
    createdById: string | null;
    createdAt: Date;
    approvedById: string | null;
    approvedAt: Date | null;
    updatedAt: Date;
}

/** Die alte Fassung einer Bestellung (uretim_bom_siparis_revizyonlari). */
export interface BomPurchaseRevision {
    id: string;
    tenantId: string;
    purchaseOrderId: string;
    bomId: string;
    /** Die Revision, die hier ENTSTAND; `previousOrder` ist die Fassung davor. */
    number: number;
    bomRevision: number;
    changes: BomOrderActionLine[];
    previousOrder: Record<string, unknown>;
    previousStatus: string;
    quoteFileRef: string | null;
    quoteFileName: string | null;
    quoteFileType: string | null;
    quoteFileSize: number | null;
    quoteUploadedAt: Date | null;
    createdById: string | null;
    createdAt: Date;
}

/** Die Einstellungen der Firma («üretim modül ayarları»). */
export interface BomSettings {
    /** Höchstzahl der Alt-BOMs unter einer Haupt-BOM (je Gerät und Bereich). */
    maxPerArea: number;
    /** Die Alt-BOM-Kodes je Bereich («ayarlardan Mekanik ve Elektrik için ayrı ayrı»). */
    codes: Record<BomArea, BomCode[]>;
}
