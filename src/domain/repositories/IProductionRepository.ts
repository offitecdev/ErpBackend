import type {
    ProductionAssignment,
    ProductionItem,
    ProductionOrderLine,
    ProductionProject,
    ProductionProjectOrder,
    ProductionTransferSettings,
    PurchaseOrderView,
    SalesSourceSnapshot,
} from '../entities/Production';
import type { ExistingProductionIds, SnapshotPlan } from '../services/production';

/** Einstellungen → Firmenübertragungen. */
export interface IProductionSettingsRepository {
    get(tenantId: string): Promise<ProductionTransferSettings | null>;
    save(tenantId: string, sourceTenantIds: string[], updatedById: string): Promise<ProductionTransferSettings>;
    markSynced(tenantId: string, at: Date): Promise<void>;
}

/** Die Verkaufsseite der Quellfirmen — nur lesend (die Grenze zum Verkauf). */
export interface ISalesSourceReader {
    read(sourceTenantIds: string[]): Promise<SalesSourceSnapshot>;
}

export interface ProductionProjectFilter {
    includeInactive?: boolean;
    ids?: string[];
    search?: string;
}

/** Produktionsprojekte, ihre Aufträge und Geräte. */
export interface IProductionProjectRepository {
    existingIds(tenantId: string): Promise<ExistingProductionIds>;
    /** Schreibt den Abgleich; alles, was er nicht mehr trägt, wird stillgelegt. */
    applySnapshot(tenantId: string, plan: SnapshotPlan, syncedAt: Date): Promise<void>;
    listProjects(tenantId: string, filter?: ProductionProjectFilter): Promise<ProductionProject[]>;
    getProject(tenantId: string, id: string): Promise<ProductionProject | null>;
    listOrders(tenantId: string, projectIds: string[]): Promise<ProductionProjectOrder[]>;
    listItems(tenantId: string, filter: { projectIds?: string[]; itemIds?: string[] }): Promise<ProductionItem[]>;
}

export interface ProductionLineFilter {
    projectIds?: string[];
    itemIds?: string[];
    purchaseOrderIds?: string[];
    search?: string;
}

/**
 * Ein laufender Datenbankvorgang, in dem die Produktion mitgeräumt werden
 * kann: löscht das Lager eine Bestellung, gehen ihre Produktionszeilen im
 * SELBEN Vorgang mit — entweder beides oder keines (Vorgabe Samet,
 * 22.09.2026: «sipariş silinirse … hem projeden hem de sipariş
 * onaylananlardan kalkacak»).
 */
export interface ProductionWriteClient {
    productionOrderLine: { deleteMany(args: any): Promise<unknown> };
    productionPurchaseAssignment: { deleteMany(args: any): Promise<unknown> };
}

/** Bestellung ↔ Projekt, und die Zeilen bestätigter Bestellungen. */
export interface IProductionPurchaseRepository {
    getAssignment(tenantId: string, purchaseOrderId: string): Promise<ProductionAssignment | null>;
    listAssignments(tenantId: string, filter: { purchaseOrderIds?: string[]; projectIds?: string[] }): Promise<ProductionAssignment[]>;
    saveAssignment(tenantId: string, assignment: ProductionAssignment, updatedById: string): Promise<void>;
    /**
     * Zuordnung UND Zeilen einer Bestellung entfernen (Bestellung gelöscht).
     * Mit `tx` geschieht das im Vorgang des Löschenden.
     */
    removeForPurchaseOrder(tenantId: string, purchaseOrderId: string, tx?: ProductionWriteClient): Promise<void>;
    /** Dasselbe für mehrere Bestellungen auf einmal (Aufräumen beim Lesen). */
    removeForPurchaseOrders(tenantId: string, purchaseOrderIds: string[]): Promise<void>;
    replaceLines(tenantId: string, purchaseOrderId: string, lines: Array<Omit<ProductionOrderLine, 'id'>>): Promise<void>;
    deleteLines(tenantId: string, purchaseOrderId: string): Promise<void>;
    listLines(tenantId: string, filter?: ProductionLineFilter): Promise<ProductionOrderLine[]>;
}

/** Die Lieferantenbestellungen, wie das Modul sie liest (Tabelle des Lagers). */
export interface IPurchaseOrderReader {
    findByIds(tenantId: string, ids: string[]): Promise<PurchaseOrderView[]>;
}

export interface TenantDirectoryEntry {
    id: string;
    name: string;
    parentTenantId: string | null;
    isActive: boolean;
}

/** Alle Firmen der Installation — für die Wahl der Quellfirmen. */
export interface ITenantDirectory {
    list(): Promise<TenantDirectoryEntry[]>;
}
