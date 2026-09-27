import type { IWarehouseDirectory } from '../../../domain/repositories/IWarehouseRepository';
import type { WarehouseProductionTarget } from '../../../domain/entities/Warehouse';
import { warehouseError } from '../../../domain/services/warehouse';

/**
 * ── PROJEKT UND GERÄT EINES STÜCKS ──────────────────────────────────────────
 * Eine Seriennummer darf einem Produktionsprojekt und — freiwillig — einem
 * seiner Geräte zugeordnet sein (Vorgabe: «seri numarası ve proje ismi ve
 * cihaz ismi»). Geprüft wird gegen `uretim_*` derselben Firma; Nummer und
 * Namen werden als Abzug mitgeschrieben.
 */

export const NO_TARGET: WarehouseProductionTarget = {
    productionProjectId: null,
    productionItemId: null,
    projectNumber: null,
    projectName: null,
    deviceName: null,
};

const idOf = (raw: unknown): string | null => {
    if (raw === null || raw === undefined) return null;
    const value = String(raw).trim();
    return value && value.length <= 191 ? value : null;
};

export class WarehouseTargetResolver {
    constructor(private directory: IWarehouseDirectory) {}

    /**
     * Ein Gerät ohne Projekt nimmt das Projekt des Geräts; ein Projekt ohne
     * Gerät ist erlaubt. Leer = keine Zuordnung.
     */
    async resolve(tenantId: string, projectRaw: unknown, itemRaw: unknown): Promise<WarehouseProductionTarget> {
        let projectId = idOf(projectRaw);
        const itemId = idOf(itemRaw);
        if (!projectId && !itemId) return NO_TARGET;

        const device = itemId ? await this.directory.getDevice(tenantId, itemId) : null;
        if (itemId && !device) {
            throw warehouseError('DEVICE_NOT_IN_PROJECT', 'Das Gerät gehört nicht zu diesem Projekt.', { status: 400 });
        }
        if (!projectId && device) projectId = device.productionProjectId;
        if (device && device.productionProjectId !== projectId) {
            throw warehouseError('DEVICE_NOT_IN_PROJECT', 'Das Gerät gehört nicht zu diesem Projekt.', { status: 400 });
        }

        const project = projectId ? await this.directory.getProject(tenantId, projectId) : null;
        if (!project) {
            throw warehouseError('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });
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
