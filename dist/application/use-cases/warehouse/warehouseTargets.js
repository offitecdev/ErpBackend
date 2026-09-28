"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WarehouseTargetResolver = exports.NO_TARGET = void 0;
const warehouse_1 = require("../../../domain/services/warehouse");
/**
 * ── PROJEKT UND GERÄT EINES STÜCKS ──────────────────────────────────────────
 * Eine Seriennummer darf einem Produktionsprojekt und — freiwillig — einem
 * seiner Geräte zugeordnet sein (Vorgabe: «seri numarası ve proje ismi ve
 * cihaz ismi»). Geprüft wird gegen `uretim_*` derselben Firma; Nummer und
 * Namen werden als Abzug mitgeschrieben.
 */
exports.NO_TARGET = {
    productionProjectId: null,
    productionItemId: null,
    projectNumber: null,
    projectName: null,
    deviceName: null,
};
const idOf = (raw) => {
    if (raw === null || raw === undefined)
        return null;
    const value = String(raw).trim();
    return value && value.length <= 191 ? value : null;
};
class WarehouseTargetResolver {
    directory;
    constructor(directory) {
        this.directory = directory;
    }
    /**
     * Ein Gerät ohne Projekt nimmt das Projekt des Geräts; ein Projekt ohne
     * Gerät ist erlaubt. Leer = keine Zuordnung.
     */
    async resolve(tenantId, projectRaw, itemRaw) {
        let projectId = idOf(projectRaw);
        const itemId = idOf(itemRaw);
        if (!projectId && !itemId)
            return exports.NO_TARGET;
        const device = itemId ? await this.directory.getDevice(tenantId, itemId) : null;
        if (itemId && !device) {
            throw (0, warehouse_1.warehouseError)('DEVICE_NOT_IN_PROJECT', 'Das Gerät gehört nicht zu diesem Projekt.', { status: 400 });
        }
        if (!projectId && device)
            projectId = device.productionProjectId;
        if (device && device.productionProjectId !== projectId) {
            throw (0, warehouse_1.warehouseError)('DEVICE_NOT_IN_PROJECT', 'Das Gerät gehört nicht zu diesem Projekt.', { status: 400 });
        }
        const project = projectId ? await this.directory.getProject(tenantId, projectId) : null;
        if (!project) {
            throw (0, warehouse_1.warehouseError)('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });
        }
        return {
            productionProjectId: project.id,
            productionItemId: device?.id ?? null,
            projectNumber: project.projectNumber.slice(0, 64) || null,
            projectName: project.projectName.slice(0, 255) || null,
            deviceName: device ? device.name.slice(0, 500) : null,
        };
    }
}
exports.WarehouseTargetResolver = WarehouseTargetResolver;
//# sourceMappingURL=warehouseTargets.js.map