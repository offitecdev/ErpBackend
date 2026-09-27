import type {
    WarehouseCategory,
    WarehouseCategoryWithGroups,
    WarehouseCodeConflict,
    WarehouseDeviceOption,
    WarehouseImport,
    WarehouseImportCreate,
    WarehouseImportResult,
    WarehouseImportRow,
    WarehouseImportStatus,
    WarehouseLabelSettings,
    WarehouseMaterialGroup,
    WarehouseProduct,
    WarehouseProductFields,
    WarehouseProductFilter,
    WarehouseProductPage,
    WarehouseProductionTarget,
    WarehouseProjectOption,
    WarehouseSerial,
    WarehouseSerialDraft,
    WarehouseSettings,
    WarehouseSupplierOption,
} from '../entities/Warehouse';

/**
 * ── DIE DATENBANKSEITE DES DEPOS ─────────────────────────────────────────────
 *
 * Fünf Schnittstellen, fünf Grenzen:
 *   · IWarehouseProductRepository — die Karten und ihre Seriennummern; vergibt
 *                                   ERP-Code und Barcode im selben Vorgang
 *   · IWarehouseGroupRepository   — Hauptkategorien und Materialgruppen
 *   · IWarehouseSettingsRepository— Etikett der Firma
 *   · IWarehouseImportRepository  — Excel-Aktarımlar und ihre Freigabe
 *   · IWarehouseDirectory         — was das Depo von ANDEREN Modulen nur liest:
 *                                   Lieferanten, Produktionsprojekte/-geräte,
 *                                   Namen von Personen
 * Dazu der Bote (IWarehouseNotifier): Glocke der Verwaltung und der
 * einreichenden Person.
 */

/**
 * Was ein Speichern mit dem ERP-Code tut:
 *   keep  — Code und Barcode bleiben, wie sie sind
 *   issue — neuer Code aus der Gruppe der Karte; Barcode nur, falls noch keiner
 *   clear — die Karte hat keine Gruppe mehr: Code weg, Barcode bleibt
 */
export type WarehouseCodeAction = 'keep' | 'issue' | 'clear';

export interface IWarehouseProductRepository {
    list(tenantId: string, filter: WarehouseProductFilter): Promise<WarehouseProductPage>;
    get(tenantId: string, id: string): Promise<WarehouseProduct | null>;
    /**
     * Andere Karten, deren Codes mit dieser Karte zusammenstossen (auch in
     * der UPC-/EAN-Schreibweise): unser Barcode, die Herstellerbarcodes (ohne
     * Lieferant oder je Lieferant — jeder gehört genau EINER Karte) und der
     * ERP-Code.
     */
    findConflicts(
        tenantId: string,
        codes: { erpCode: string | null; ownBarcode: string | null; makerBarcodes: string[] },
        excludeId?: string,
    ): Promise<WarehouseCodeConflict[]>;
    /**
     * Neue Karte samt Seriennummern in EINEM Vorgang (Menge = Zahl der Nummern,
     * falls Pflicht). Mit `issueCode` zieht derselbe Vorgang ERP-Code und
     * Barcode aus der Gruppe der Karte.
     */
    create(
        tenantId: string,
        fields: WarehouseProductFields,
        serials: WarehouseSerialDraft[],
        userId: string,
        options: { issueCode: boolean },
    ): Promise<WarehouseProduct>;
    /**
     * Felder schreiben; bei Seriennummernpflicht zählt der Vorgang die Menge
     * neu. `writeSuppliers`: die Lieferantenliste wurde geändert und wird im
     * selben Vorgang ersetzt. `serials`: Nummern, die mit dem Speichern
     * dazukommen (Pflicht gerade eingeschaltet) — im selben Vorgang.
     */
    update(
        tenantId: string,
        id: string,
        fields: WarehouseProductFields,
        userId: string,
        code: WarehouseCodeAction,
        options?: { writeSuppliers?: boolean; serials?: WarehouseSerialDraft[] },
    ): Promise<WarehouseProduct | null>;
    delete(tenantId: string, id: string): Promise<boolean>;
    /**
     * Bestand ändern (Karten OHNE Seriennummernpflicht): + bucht ein, − nimmt
     * einen Scan zurück. Unter 0 geht es nicht.
     */
    adjustQuantity(tenantId: string, id: string, delta: number, userId: string): Promise<'ok' | 'missing' | 'below-zero'>;
    /** Karten einer Gruppe ohne ERP-Code bekommen ihn — in der Reihenfolge des Anlegens. */
    assignMissingCodes(tenantId: string, groupId: string): Promise<number>;

    listSerials(tenantId: string, productId: string): Promise<WarehouseSerial[]>;
    getSerial(tenantId: string, id: string): Promise<WarehouseSerial | null>;
    /** Diese Nummern gibt es an der Karte schon (Vergleich wie die Datenbank: ohne Gross/Klein). */
    existingSerials(tenantId: string, productId: string, serialNumbers: string[], excludeId?: string): Promise<string[]>;
    addSerial(tenantId: string, productId: string, draft: WarehouseSerialDraft, userId: string): Promise<WarehouseSerial>;
    updateSerial(
        tenantId: string,
        id: string,
        patch: { serialNumber?: string; target?: WarehouseProductionTarget },
    ): Promise<WarehouseSerial | null>;
    deleteSerial(tenantId: string, id: string): Promise<WarehouseSerial | null>;

    /** Scan: Karten mit einem dieser Codes als ERP-Code, Barcode, Herstellerbarcode oder Barcode eines Lieferanten. */
    findByCode(tenantId: string, codes: string[], limit: number): Promise<WarehouseProduct[]>;
    /** Scan: Seriennummern mit genau diesem Wert (über alle Karten). */
    findSerialsByNumber(tenantId: string, serialNumber: string, limit: number): Promise<WarehouseSerial[]>;
    /** Mehrere Karten auf einmal (Scan-Treffer über Seriennummern). */
    getMany(tenantId: string, ids: string[]): Promise<WarehouseProduct[]>;
    /** Zahl der Seriennummern je Karte. */
    serialCounts(tenantId: string, productIds: string[]): Promise<Map<string, number>>;

    /** Aktarım: Namen, die schon auf einer Karte stehen (klein geschrieben). */
    existingNames(tenantId: string, names: string[]): Promise<Set<string>>;
    /** Aktarım: welche dieser Codes schon UNSER Barcode einer Karte sind (Code → Kartenname). */
    ownBarcodes(tenantId: string, codes: string[]): Promise<Map<string, string>>;
    /** Aktarım: welche dieser Codes schon Herstellerbarcode einer Karte sind — auch je Lieferant (Code → Kartenname). */
    manufacturerBarcodeOwners(tenantId: string, codes: string[]): Promise<Map<string, string>>;
}

export interface IWarehouseGroupRepository {
    /** Alle Hauptkategorien mit ihren Gruppen (+ Zahl der Karten) und die Karten ohne Gruppe. */
    tree(tenantId: string): Promise<{ categories: WarehouseCategoryWithGroups[]; ungroupedCount: number }>;
    /** Alle Gruppen samt Kürzeln (Aktarım: Gruppentext → Gruppe). */
    listGroups(tenantId: string): Promise<WarehouseMaterialGroup[]>;

    getCategory(tenantId: string, id: string): Promise<WarehouseCategory | null>;
    findCategory(tenantId: string, by: { name?: string; code?: string }, excludeId?: string): Promise<WarehouseCategory | null>;
    createCategory(tenantId: string, input: { name: string; code: string }): Promise<WarehouseCategory>;
    /** Ein neues Kürzel setzt die Zähler der Gruppen auf 0 (es gibt dann noch keinen Code). */
    updateCategory(tenantId: string, id: string, patch: { name?: string; code?: string }): Promise<WarehouseCategory | null>;
    deleteCategory(tenantId: string, id: string): Promise<boolean>;
    groupCount(tenantId: string, categoryId: string): Promise<number>;
    /** Karten mit ERP-Code in den Gruppen dieser Kategorie. */
    codedInCategory(tenantId: string, categoryId: string): Promise<number>;

    getGroup(tenantId: string, id: string): Promise<WarehouseMaterialGroup | null>;
    findGroup(tenantId: string, categoryId: string, by: { name?: string; code?: string }, excludeId?: string): Promise<WarehouseMaterialGroup | null>;
    createGroup(tenantId: string, input: { categoryId: string; name: string; code: string }): Promise<WarehouseMaterialGroup>;
    /** Neues Kürzel oder neue Kategorie setzen den Zähler auf 0. */
    updateGroup(
        tenantId: string,
        id: string,
        patch: { name?: string; code?: string; categoryId?: string },
    ): Promise<WarehouseMaterialGroup | null>;
    productCount(tenantId: string, id: string): Promise<number>;
    /** Karten der Gruppe mit ERP-Code. */
    codedCount(tenantId: string, id: string): Promise<number>;
    deleteGroup(tenantId: string, id: string): Promise<boolean>;
}

export interface IWarehouseSettingsRepository {
    get(tenantId: string): Promise<WarehouseSettings>;
    saveLabel(tenantId: string, label: WarehouseLabelSettings): Promise<WarehouseSettings>;
}

export interface IWarehouseImportRepository {
    /** Die letzten Aktarımlar (ohne Zeilen), neueste zuerst. */
    list(tenantId: string, limit: number): Promise<Array<Omit<WarehouseImport, 'rows'>>>;
    get(tenantId: string, id: string): Promise<WarehouseImport | null>;
    pendingCount(tenantId: string): Promise<number>;
    create(
        tenantId: string,
        input: { fileName: string | null; rows: WarehouseImportRow[]; requestedById: string; requestedByName: string | null },
    ): Promise<WarehouseImport>;
    /** Ablehnen oder zurückziehen — nur solange der Aktarım noch wartet. */
    close(
        tenantId: string,
        id: string,
        input: { status: Extract<WarehouseImportStatus, 'REJECTED' | 'CANCELLED'>; decidedById: string; decidedByName: string | null; note: string | null },
    ): Promise<boolean>;
    /**
     * Freigeben und ausführen in EINEM Vorgang: der Aktarım wird nur genommen,
     * wenn er noch wartet (zwei gleichzeitige Freigaben legen nichts doppelt
     * an); die Karten entstehen mit Code und Barcode. `null` = schon entschieden.
     */
    execute(
        tenantId: string,
        id: string,
        input: {
            creates: WarehouseImportCreate[];
            failed: Array<{ row: number; code: string }>;
            decidedById: string;
            decidedByName: string | null;
            createdById: string;
        },
    ): Promise<WarehouseImportResult | null>;
}

export interface IWarehouseDirectory {
    /** Lieferantenliste der Firma + auf Karten frei geschriebene Namen. */
    searchSuppliers(tenantId: string, query: string | undefined, limit: number): Promise<WarehouseSupplierOption[]>;
    getSupplier(tenantId: string, id: string): Promise<WarehouseSupplierOption | null>;
    /** Lieferanten der Liste mit diesen Kennungen (für die Lieferanten einer Karte). */
    suppliersByIds(tenantId: string, ids: string[]): Promise<Map<string, WarehouseSupplierOption>>;
    /** Lieferanten der Liste mit genau diesen Namen (ohne Gross/Klein) — Aktarım. */
    suppliersByName(tenantId: string, names: string[]): Promise<Map<string, WarehouseSupplierOption>>;
    /** Produktionsprojekte (uretim_projeler) — aktive zuerst, neueste zuerst. */
    listProjects(tenantId: string, search: string | undefined, limit: number): Promise<WarehouseProjectOption[]>;
    getProject(tenantId: string, id: string): Promise<WarehouseProjectOption | null>;
    /** Die aktiven Geräte (kind DEVICE) eines Produktionsprojekts. */
    listDevices(tenantId: string, projectId: string): Promise<WarehouseDeviceOption[]>;
    getDevice(tenantId: string, id: string): Promise<WarehouseDeviceOption | null>;
    /** Lebende Namen für die Anzeige (Projekte und Geräte, auch stillgelegte). */
    names(
        tenantId: string,
        projectIds: string[],
        itemIds: string[],
    ): Promise<{ projects: Map<string, WarehouseProjectOption>; devices: Map<string, WarehouseDeviceOption> }>;
    /** Vor- und Nachname einer Person (für Aktarım und Glocke). */
    personName(id: string): Promise<string | null>;
}

/** Die Glocke: wer über einen Aktarım Bescheid bekommt. Wirft nie. */
export interface IWarehouseNotifier {
    importRequested(input: {
        tenantId: string;
        importId: string;
        rowCount: number;
        fileName: string | null;
        actorId: string;
        actorName: string | null;
    }): Promise<void>;
    importDecided(input: {
        tenantId: string;
        importId: string;
        requesterId: string | null;
        outcome: 'DONE' | 'REJECTED';
        actorId: string;
        actorName: string | null;
        created: number;
        note: string | null;
    }): Promise<void>;
}
