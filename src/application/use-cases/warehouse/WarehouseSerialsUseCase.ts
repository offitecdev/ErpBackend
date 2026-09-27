import type {
    IWarehouseDirectory,
    IWarehouseProductRepository,
} from '../../../domain/repositories/IWarehouseRepository';
import type { WarehouseProductionTarget } from '../../../domain/entities/Warehouse';
import { serialFromInput, warehouseError } from '../../../domain/services/warehouse';
import {
    productDto,
    serialDto,
    targetIdsOf,
    type WarehouseProductDto,
    type WarehouseSerialDto,
} from './warehouseReadModel';
import { isUniqueViolation } from './WarehouseProductsUseCase';
import { emitWarehouseStockChanged } from '../../../shared/warehouseStockEvents';
import { WarehouseTargetResolver } from './warehouseTargets';

const has = (input: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(input, key);

/**
 * ── DIE SERIENNUMMERN EINER KARTE (26.09.2026) ──────────────────────────────
 *
 * «Seri numarası gerekli ise … seri numaraları tabında seri numarası ve proje
 *  ismi ve cihaz ismi olması gerekmektedir.»
 *
 * Nur Karten mit Seriennummernpflicht nehmen Nummern an. Jede Nummer ist ein
 * Stück: Anlegen und Löschen zählen die Menge der Karte neu (im selben
 * Vorgang, siehe PrismaWarehouseProductRepository). Eine Nummer steht an
 * einer Karte nur einmal; an zwei verschiedenen Karten darf sie vorkommen
 * (zwei Hersteller, zufällig dieselbe Nummer) — der Scan fragt dann nach.
 */
export class WarehouseSerialsUseCase {
    private targets: WarehouseTargetResolver;

    constructor(
        private products: IWarehouseProductRepository,
        private directory: IWarehouseDirectory,
    ) {
        this.targets = new WarehouseTargetResolver(directory);
    }

    async add(
        tenantId: string,
        userId: string,
        productId: string,
        body: unknown,
    ): Promise<{ serial: WarehouseSerialDto; product: WarehouseProductDto }> {
        const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const product = await this.products.get(tenantId, productId);
        if (!product) throw warehouseError('NOT_FOUND', 'Produktkarte nicht gefunden.', { status: 404 });
        if (!product.serialRequired) {
            throw warehouseError('SERIALS_DISABLED', 'Diese Karte führt keine Seriennummern.', { status: 409 });
        }

        const serialNumber = serialFromInput(input.serialNumber);
        const [taken, target] = await Promise.all([
            this.products.existingSerials(tenantId, productId, [serialNumber]),
            this.targets.resolve(tenantId, input.productionProjectId, input.productionItemId),
        ]);
        if (taken.length) {
            throw warehouseError('SERIAL_TAKEN', 'Diese Seriennummer ist an der Karte schon erfasst.', {
                status: 409,
                params: { serial: taken[0] ?? serialNumber },
            });
        }

        let created;
        try {
            created = await this.products.addSerial(tenantId, productId, { serialNumber, ...target }, userId);
        } catch (error) {
            if (isUniqueViolation(error, 'serialNumber')) {
                throw warehouseError('SERIAL_TAKEN', 'Diese Seriennummer ist an der Karte schon erfasst.', {
                    status: 409,
                    params: { serial: serialNumber },
                });
            }
            throw error;
        }

        // Eine freie Nummer geht an die wartende BOM-Zeile mit dem frühesten
        // Liefertermin (BOM der Produktion, 27.09.2026) — im Hintergrund.
        if (!target.productionProjectId) emitWarehouseStockChanged({ tenantId, productIds: [productId] });
        const [updated, live] = await Promise.all([
            this.products.get(tenantId, productId),
            this.live(tenantId, [created]),
        ]);
        return { serial: serialDto(created, live), product: productDto(updated ?? product) };
    }

    /** Nummer berichtigen und/oder Projekt/Gerät (neu) zuordnen. */
    async update(tenantId: string, serialId: string, body: unknown): Promise<WarehouseSerialDto> {
        const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const serial = await this.products.getSerial(tenantId, serialId);
        if (!serial) throw warehouseError('SERIAL_NOT_FOUND', 'Seriennummer nicht gefunden.', { status: 404 });

        const patch: { serialNumber?: string; target?: WarehouseProductionTarget } = {};
        if (has(input, 'serialNumber')) {
            const next = serialFromInput(input.serialNumber);
            if (next !== serial.serialNumber) {
                const taken = await this.products.existingSerials(tenantId, serial.productId, [next], serial.id);
                if (taken.length) {
                    throw warehouseError('SERIAL_TAKEN', 'Diese Seriennummer ist an der Karte schon erfasst.', {
                        status: 409,
                        params: { serial: taken[0] ?? next },
                    });
                }
                patch.serialNumber = next;
            }
        }
        if (has(input, 'productionProjectId') || has(input, 'productionItemId')) {
            patch.target = await this.targets.resolve(
                tenantId,
                has(input, 'productionProjectId') ? input.productionProjectId : serial.productionProjectId,
                has(input, 'productionItemId') ? input.productionItemId : null,
            );
        }

        let updated;
        try {
            updated = await this.products.updateSerial(tenantId, serialId, patch);
        } catch (error) {
            if (isUniqueViolation(error, 'serialNumber')) {
                throw warehouseError('SERIAL_TAKEN', 'Diese Seriennummer ist an der Karte schon erfasst.', {
                    status: 409,
                    params: { serial: patch.serialNumber ?? '' },
                });
            }
            throw error;
        }
        if (!updated) throw warehouseError('SERIAL_NOT_FOUND', 'Seriennummer nicht gefunden.', { status: 404 });
        return serialDto(updated, await this.live(tenantId, [updated]));
    }

    async delete(tenantId: string, serialId: string): Promise<{ product: WarehouseProductDto | null }> {
        const removed = await this.products.deleteSerial(tenantId, serialId);
        if (!removed) throw warehouseError('SERIAL_NOT_FOUND', 'Seriennummer nicht gefunden.', { status: 404 });
        const product = await this.products.get(tenantId, removed.productId);
        return { product: product ? productDto(product) : null };
    }

    private live(tenantId: string, serials: Parameters<typeof targetIdsOf>[0]) {
        const { projectIds, itemIds } = targetIdsOf(serials);
        if (!projectIds.length && !itemIds.length) {
            return Promise.resolve({ projects: new Map(), devices: new Map() });
        }
        return this.directory.names(tenantId, projectIds, itemIds);
    }
}
