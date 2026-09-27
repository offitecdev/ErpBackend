import type {
    WarehouseCategoryWithGroups,
    WarehouseDeviceOption,
    WarehouseImport,
    WarehouseImportIssue,
    WarehouseImportResult,
    WarehouseImportRow,
    WarehouseLabelSettings,
    WarehouseMaterialGroup,
    WarehouseMaterialGroupWithCount,
    WarehouseProduct,
    WarehouseProjectOption,
    WarehouseSerial,
} from '../../../domain/entities/Warehouse';
import { erpPrefix, GS1_INTERNAL_PREFIX, nextErpCode } from '../../../domain/services/warehouseCodes';

/**
 * ── WAS DAS DEPO NACH AUSSEN ZEIGT ───────────────────────────────────────────
 * Die Antworten der Wege unter /warehouse. Zeitstempel als ISO-Text,
 * Lieferant und Gruppe als kleine Objekte, Projekt und Gerät einer
 * Seriennummer mit ihren LEBENDEN Namen (Abzug nur, wo die Quelle fehlt).
 */

export interface WarehouseGroupRefDto {
    id: string;
    name: string;
    /** Kürzel der Gruppe (PLC) — leer beim Altbestand. */
    code: string | null;
    category: { id: string; name: string; code: string } | null;
}

export interface WarehouseProductDto {
    id: string;
    erpCode: string | null;
    materialGroup: WarehouseGroupRefDto | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    /** Der erste Lieferant (für Liste und Sortierung) — oder keiner. */
    supplier: { id: string | null; name: string } | null;
    /**
     * Alle Lieferanten, jeder mit seinem Barcode des Produkts (dritter und
     * vierter Durchgang). `id` fehlt bei einem frei geschriebenen Namen.
     */
    suppliers: Array<{ id: string | null; name: string; barcode: string | null }>;
    description: string | null;
    quantity: number;
    purchasePrice: number | null;
    /** Mindestbestellmenge — darunter wird nie bestellt (BOM). */
    minimumOrderQuantity: number | null;
    currency: string | null;
    barcode: string | null;
    /** Herstellerbarcode ohne Lieferant (die der Lieferanten stehen in `suppliers`). */
    manufacturerBarcode: string | null;
    serialRequired: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface WarehouseSerialDto {
    id: string;
    productId: string;
    serialNumber: string;
    project: { id: string; number: string; name: string; isActive: boolean } | null;
    device: { id: string; name: string; positionNumber: string | null; isActive: boolean } | null;
    createdAt: string;
}

export interface WarehouseProductDetailDto {
    product: WarehouseProductDto;
    serials: WarehouseSerialDto[];
}

export type WarehouseMatchKind = 'serial' | 'barcode' | 'manufacturerBarcode' | 'supplierBarcode' | 'erpCode';

export interface WarehouseLookupMatchDto {
    matchedBy: WarehouseMatchKind;
    product: WarehouseProductDto;
    /** Nur bei `matchedBy = serial`: das Stück mit Projekt und Gerät. */
    serial: WarehouseSerialDto | null;
    /** Nur bei `matchedBy = supplierBarcode`: der Lieferant, dessen Barcode gelesen wurde. */
    supplier: { id: string | null; name: string } | null;
}

export interface WarehouseLookupDto {
    code: string;
    matches: WarehouseLookupMatchDto[];
}

/** Die Liste zeigt die Beschreibung einzeilig — mehr als ein Satz reist nicht mit. */
const LIST_DESCRIPTION_CHARS = 280;

export const productDto = (product: WarehouseProduct, options: { preview?: boolean } = {}): WarehouseProductDto => {
    const description = product.description
        && options.preview
        && product.description.length > LIST_DESCRIPTION_CHARS
        ? `${product.description.slice(0, LIST_DESCRIPTION_CHARS).trimEnd()}…`
        : product.description;
    return {
        id: product.id,
        erpCode: product.erpCode,
        materialGroup: product.materialGroupId
            ? {
                id: product.materialGroupId,
                name: product.materialGroupName ?? '',
                code: product.materialGroupCode,
                category: product.categoryId
                    ? { id: product.categoryId, name: product.categoryName ?? '', code: product.categoryCode ?? '' }
                    : null,
            }
            : null,
        name: product.name,
        brand: product.brand,
        modelNumber: product.modelNumber,
        supplier: product.suppliers[0]
            ? { id: product.suppliers[0].supplierId, name: product.suppliers[0].name }
            : product.supplierName ? { id: product.supplierId, name: product.supplierName } : null,
        suppliers: product.suppliers.map((entry) => ({ id: entry.supplierId, name: entry.name, barcode: entry.barcode })),
        description,
        quantity: product.quantity,
        purchasePrice: product.purchasePrice,
        minimumOrderQuantity: product.minimumOrderQuantity,
        currency: product.currency,
        barcode: product.barcode,
        manufacturerBarcode: product.manufacturerBarcode,
        serialRequired: product.serialRequired,
        createdAt: product.createdAt.toISOString(),
        updatedAt: product.updatedAt.toISOString(),
    };
};

export interface LiveNames {
    projects: Map<string, WarehouseProjectOption>;
    devices: Map<string, WarehouseDeviceOption>;
}

export const serialDto = (serial: WarehouseSerial, live: LiveNames): WarehouseSerialDto => {
    const project = serial.productionProjectId ? live.projects.get(serial.productionProjectId) : undefined;
    const device = serial.productionItemId ? live.devices.get(serial.productionItemId) : undefined;
    return {
        id: serial.id,
        productId: serial.productId,
        serialNumber: serial.serialNumber,
        project: serial.productionProjectId
            ? {
                id: serial.productionProjectId,
                number: project?.projectNumber ?? serial.projectNumber ?? '',
                name: project?.projectName ?? serial.projectName ?? '',
                isActive: project?.isActive ?? false,
            }
            : null,
        device: serial.productionItemId
            ? {
                id: serial.productionItemId,
                name: device?.name ?? serial.deviceName ?? '',
                positionNumber: device?.positionNumber ?? null,
                isActive: device?.isActive ?? false,
            }
            : null,
        createdAt: serial.createdAt.toISOString(),
    };
};

/** Die Kennungen, deren lebende Namen eine Liste von Seriennummern braucht. */
export const targetIdsOf = (serials: WarehouseSerial[]): { projectIds: string[]; itemIds: string[] } => ({
    projectIds: [...new Set(serials.map((serial) => serial.productionProjectId).filter((id): id is string => Boolean(id)))],
    itemIds: [...new Set(serials.map((serial) => serial.productionItemId).filter((id): id is string => Boolean(id)))],
});

/* ── Kategorien und Gruppen ─────────────────────────────────────────────── */

export interface WarehouseGroupDto {
    id: string;
    categoryId: string;
    name: string;
    code: string | null;
    /** «ELK-PLC-» — leer, solange die Gruppe kein Kürzel hat. */
    prefix: string | null;
    lastNumber: number;
    nextCode: string | null;
    productCount: number;
    uncodedCount: number;
    /** Kürzel und Kategorie stehen fest: es gibt schon Karten mit Code. */
    locked: boolean;
}

export interface WarehouseCategoryDto {
    id: string;
    name: string;
    code: string;
    productCount: number;
    locked: boolean;
    groups: WarehouseGroupDto[];
}

export interface WarehouseCatalogDto {
    categories: WarehouseCategoryDto[];
    ungroupedCount: number;
}

export const groupDto = (group: WarehouseMaterialGroupWithCount): WarehouseGroupDto => ({
    id: group.id,
    categoryId: group.categoryId,
    name: group.name,
    code: group.code,
    prefix: group.code && group.categoryCode ? erpPrefix(group.categoryCode, group.code) : null,
    lastNumber: group.lastNumber,
    nextCode: nextErpCode(group),
    productCount: group.productCount,
    uncodedCount: group.uncodedCount,
    locked: group.productCount - group.uncodedCount > 0,
});

export const catalogDto = (tree: { categories: WarehouseCategoryWithGroups[]; ungroupedCount: number }): WarehouseCatalogDto => ({
    categories: tree.categories.map((category) => {
        const groups = category.groups.map(groupDto);
        return {
            id: category.id,
            name: category.name,
            code: category.code,
            productCount: groups.reduce((sum, group) => sum + group.productCount, 0),
            locked: groups.some((group) => group.locked),
            groups,
        };
    }),
    ungroupedCount: tree.ungroupedCount,
});

/** Eine einzelne Gruppe nach Anlegen/Ändern (ohne Zählungen). */
export const plainGroupDto = (group: WarehouseMaterialGroup): WarehouseGroupDto =>
    groupDto({ ...group, productCount: 0, uncodedCount: 0 });

/** «ELK-PLC — Elektrik › PLC»: so steht eine Gruppe in der Excel-Vorlage. */
export const groupLabel = (group: Pick<WarehouseMaterialGroup, 'categoryCode' | 'code' | 'categoryName' | 'name'>): string =>
    group.code
        ? `${group.categoryCode}-${group.code} — ${group.categoryName} › ${group.name}`
        : `${group.categoryName} › ${group.name}`;

/* ── Einstellungen ──────────────────────────────────────────────────────── */

export interface WarehouseSettingsDto {
    label: WarehouseLabelSettings;
    /** GS1-Bereich der firmeninternen Barcodes. */
    barcodePrefix: string;
    barcodesIssued: number;
}

export const settingsDto = (settings: { label: WarehouseLabelSettings; barcodeLastNumber: number }): WarehouseSettingsDto => ({
    label: settings.label,
    barcodePrefix: GS1_INTERNAL_PREFIX,
    barcodesIssued: settings.barcodeLastNumber,
});

/* ── Excel-Aktarım ──────────────────────────────────────────────────────── */

export interface WarehouseImportRowDto extends WarehouseImportRow {
    groupId: string | null;
    groupLabel: string | null;
    issues: WarehouseImportIssue[];
}

export interface WarehouseImportSummaryDto {
    id: string;
    status: WarehouseImport['status'];
    fileName: string | null;
    rowCount: number;
    requestedBy: { id: string | null; name: string | null };
    decidedBy: { id: string | null; name: string | null } | null;
    decidedAt: string | null;
    note: string | null;
    result: WarehouseImportResult | null;
    createdAt: string;
}

export interface WarehouseImportDetailDto extends WarehouseImportSummaryDto {
    rows: WarehouseImportRowDto[];
}

export const importSummaryDto = (entry: Omit<WarehouseImport, 'rows'>): WarehouseImportSummaryDto => ({
    id: entry.id,
    status: entry.status,
    fileName: entry.fileName,
    rowCount: entry.rowCount,
    requestedBy: { id: entry.requestedById, name: entry.requestedByName },
    decidedBy: entry.decidedById || entry.decidedByName ? { id: entry.decidedById, name: entry.decidedByName } : null,
    decidedAt: entry.decidedAt ? entry.decidedAt.toISOString() : null,
    note: entry.note,
    result: entry.result,
    createdAt: entry.createdAt.toISOString(),
});
