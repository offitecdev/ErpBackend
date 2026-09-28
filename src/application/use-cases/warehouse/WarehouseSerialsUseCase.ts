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
import { bookGoodsIn, isUniqueViolation, supplierOfCode, undoGoodsIn } from './WarehouseProductsUseCase';
import { emitWarehouseStockChanged } from '../../../shared/warehouseStockEvents';
import { warehouseGoodsInHandler, type WarehouseGoodsInResult } from '../../../shared/warehouseGoodsIn';
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

    /**
     * `goodsIn: true` (28.09.2026, das Fenster «Ürün ekle»): das Stück ist
     * Wareneingang — die BOM schreibt es der wartenden Bestellung gut und
     * reserviert die Nummer gleich (sonst tut das das Depo-Ereignis).
     */
    async add(
        tenantId: string,
        userId: string,
        productId: string,
        body: unknown,
    ): Promise<{ serial: WarehouseSerialDto; product: WarehouseProductDto; goodsIn: WarehouseGoodsInResult | null }> {
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
        // Aus «Ürün ekle» ist sie Wareneingang: gutschreiben + reservieren in einem.
        let goodsIn: WarehouseGoodsInResult | null = null;
        if (!target.productionProjectId) {
            const handler = input.goodsIn === true ? warehouseGoodsInHandler() : null;
            if (handler) {
                goodsIn = await bookGoodsIn(() => handler.book({
                    tenantId,
                    userId,
                    productId,
                    quantity: 1,
                    serials: [serialNumber],
                    supplier: supplierOfCode(product, input.code),
                }));
            }
            if (!goodsIn) emitWarehouseStockChanged({ tenantId, productIds: [productId] });
        }
        // Nach der Reservierung neu lesen: die Nummer nennt jetzt Projekt und Gerät.
        const current = goodsIn ? (await this.products.getSerial(tenantId, created.id)) ?? created : created;
        const [updated, live] = await Promise.all([
            this.products.get(tenantId, productId),
            this.live(tenantId, [current]),
        ]);
        return { serial: serialDto(current, live), product: productDto(updated ?? product), goodsIn };
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

    /**
     * `receipt` (28.09.2026): die Nummer kam eben über «Ürün ekle» als
     * Wareneingang — «Geri al» nimmt sie auch der Bestellung wieder weg. Ohne
     * `receipt` (die Karte selbst) bleibt jede Bestellung, wie sie ist.
     */
    async delete(tenantId: string, userId: string, serialId: string, receipt?: unknown): Promise<{ product: WarehouseProductDto | null }> {
        const receiptId = typeof receipt === 'string' ? receipt.trim().slice(0, 32) : '';
        const handler = receiptId ? warehouseGoodsInHandler() : null;
        let removed: Awaited<ReturnType<IWarehouseProductRepository['deleteSerial']>> = null;
        const remove = async () => {
            removed = await this.products.deleteSerial(tenantId, serialId);
            if (!removed) throw warehouseError('SERIAL_NOT_FOUND', 'Seriennummer nicht gefunden.', { status: 404 });
        };
        if (handler) {
            const serial = await this.products.getSerial(tenantId, serialId);
            if (!serial) throw warehouseError('SERIAL_NOT_FOUND', 'Seriennummer nicht gefunden.', { status: 404 });
            await undoGoodsIn(() => handler.undo({
                tenantId,
                userId,
                productId: serial.productId,
                entries: [{ receiptId, quantity: 1, serials: [serial.serialNumber] }],
            }, remove));
        } else {
            await remove();
        }
        const productId = (removed as { productId: string } | null)?.productId;
        const product = productId ? await this.products.get(tenantId, productId) : null;
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
