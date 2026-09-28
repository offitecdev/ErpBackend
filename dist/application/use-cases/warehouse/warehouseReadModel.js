"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.importSummaryDto = exports.settingsDto = exports.groupLabel = exports.plainGroupDto = exports.catalogDto = exports.groupDto = exports.targetIdsOf = exports.serialDto = exports.productDto = void 0;
const warehouseCodes_1 = require("../../../domain/services/warehouseCodes");
/** Die Liste zeigt die Beschreibung einzeilig — mehr als ein Satz reist nicht mit. */
const LIST_DESCRIPTION_CHARS = 280;
const productDto = (product, options = {}) => {
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
exports.productDto = productDto;
const serialDto = (serial, live) => {
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
exports.serialDto = serialDto;
/** Die Kennungen, deren lebende Namen eine Liste von Seriennummern braucht. */
const targetIdsOf = (serials) => ({
    projectIds: [...new Set(serials.map((serial) => serial.productionProjectId).filter((id) => Boolean(id)))],
    itemIds: [...new Set(serials.map((serial) => serial.productionItemId).filter((id) => Boolean(id)))],
});
exports.targetIdsOf = targetIdsOf;
const groupDto = (group) => ({
    id: group.id,
    categoryId: group.categoryId,
    name: group.name,
    code: group.code,
    prefix: group.code && group.categoryCode ? (0, warehouseCodes_1.erpPrefix)(group.categoryCode, group.code) : null,
    lastNumber: group.lastNumber,
    nextCode: (0, warehouseCodes_1.nextErpCode)(group),
    productCount: group.productCount,
    uncodedCount: group.uncodedCount,
    locked: group.productCount - group.uncodedCount > 0,
});
exports.groupDto = groupDto;
const catalogDto = (tree) => ({
    categories: tree.categories.map((category) => {
        const groups = category.groups.map(exports.groupDto);
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
exports.catalogDto = catalogDto;
/** Eine einzelne Gruppe nach Anlegen/Ändern (ohne Zählungen). */
const plainGroupDto = (group) => (0, exports.groupDto)({ ...group, productCount: 0, uncodedCount: 0 });
exports.plainGroupDto = plainGroupDto;
/** «ELK-PLC — Elektrik › PLC»: so steht eine Gruppe in der Excel-Vorlage. */
const groupLabel = (group) => group.code
    ? `${group.categoryCode}-${group.code} — ${group.categoryName} › ${group.name}`
    : `${group.categoryName} › ${group.name}`;
exports.groupLabel = groupLabel;
const settingsDto = (settings) => ({
    label: settings.label,
    barcodePrefix: warehouseCodes_1.GS1_INTERNAL_PREFIX,
    barcodesIssued: settings.barcodeLastNumber,
});
exports.settingsDto = settingsDto;
const importSummaryDto = (entry) => ({
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
exports.importSummaryDto = importSummaryDto;
//# sourceMappingURL=warehouseReadModel.js.map