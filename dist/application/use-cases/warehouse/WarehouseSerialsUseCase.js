"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WarehouseSerialsUseCase = void 0;
const warehouse_1 = require("../../../domain/services/warehouse");
const warehouseReadModel_1 = require("./warehouseReadModel");
const WarehouseProductsUseCase_1 = require("./WarehouseProductsUseCase");
const warehouseStockEvents_1 = require("../../../shared/warehouseStockEvents");
const warehouseGoodsIn_1 = require("../../../shared/warehouseGoodsIn");
const warehouseTargets_1 = require("./warehouseTargets");
const has = (input, key) => Object.prototype.hasOwnProperty.call(input, key);
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
class WarehouseSerialsUseCase {
    products;
    directory;
    targets;
    constructor(products, directory) {
        this.products = products;
        this.directory = directory;
        this.targets = new warehouseTargets_1.WarehouseTargetResolver(directory);
    }
    /**
     * `goodsIn: true` (28.09.2026, das Fenster «Ürün ekle»): das Stück ist
     * Wareneingang — die BOM schreibt es der wartenden Bestellung gut und
     * reserviert die Nummer gleich (sonst tut das das Depo-Ereignis).
     */
    async add(tenantId, userId, productId, body) {
        const input = (body && typeof body === 'object' ? body : {});
        const product = await this.products.get(tenantId, productId);
        if (!product)
            throw (0, warehouse_1.warehouseError)('NOT_FOUND', 'Produktkarte nicht gefunden.', { status: 404 });
        if (!product.serialRequired) {
            throw (0, warehouse_1.warehouseError)('SERIALS_DISABLED', 'Diese Karte führt keine Seriennummern.', { status: 409 });
        }
        const serialNumber = (0, warehouse_1.serialFromInput)(input.serialNumber);
        const [taken, target] = await Promise.all([
            this.products.existingSerials(tenantId, productId, [serialNumber]),
            this.targets.resolve(tenantId, input.productionProjectId, input.productionItemId),
        ]);
        if (taken.length) {
            throw (0, warehouse_1.warehouseError)('SERIAL_TAKEN', 'Diese Seriennummer ist an der Karte schon erfasst.', {
                status: 409,
                params: { serial: taken[0] ?? serialNumber },
            });
        }
        let created;
        try {
            created = await this.products.addSerial(tenantId, productId, { serialNumber, ...target }, userId);
        }
        catch (error) {
            if ((0, WarehouseProductsUseCase_1.isUniqueViolation)(error, 'serialNumber')) {
                throw (0, warehouse_1.warehouseError)('SERIAL_TAKEN', 'Diese Seriennummer ist an der Karte schon erfasst.', {
                    status: 409,
                    params: { serial: serialNumber },
                });
            }
            throw error;
        }
        // Eine freie Nummer geht an die wartende BOM-Zeile mit dem frühesten
        // Liefertermin (BOM der Produktion, 27.09.2026) — im Hintergrund.
        // Aus «Ürün ekle» ist sie Wareneingang: gutschreiben + reservieren in einem.
        let goodsIn = null;
        if (!target.productionProjectId) {
            const handler = input.goodsIn === true ? (0, warehouseGoodsIn_1.warehouseGoodsInHandler)() : null;
            if (handler) {
                goodsIn = await (0, WarehouseProductsUseCase_1.bookGoodsIn)(() => handler.book({
                    tenantId,
                    userId,
                    productId,
                    quantity: 1,
                    serials: [serialNumber],
                    supplier: (0, WarehouseProductsUseCase_1.supplierOfCode)(product, input.code),
                }));
            }
            if (!goodsIn)
                (0, warehouseStockEvents_1.emitWarehouseStockChanged)({ tenantId, productIds: [productId] });
        }
        // Nach der Reservierung neu lesen: die Nummer nennt jetzt Projekt und Gerät.
        const current = goodsIn ? (await this.products.getSerial(tenantId, created.id)) ?? created : created;
        const [updated, live] = await Promise.all([
            this.products.get(tenantId, productId),
            this.live(tenantId, [current]),
        ]);
        return { serial: (0, warehouseReadModel_1.serialDto)(current, live), product: (0, warehouseReadModel_1.productDto)(updated ?? product), goodsIn };
    }
    /** Nummer berichtigen und/oder Projekt/Gerät (neu) zuordnen. */
    async update(tenantId, serialId, body) {
        const input = (body && typeof body === 'object' ? body : {});
        const serial = await this.products.getSerial(tenantId, serialId);
        if (!serial)
            throw (0, warehouse_1.warehouseError)('SERIAL_NOT_FOUND', 'Seriennummer nicht gefunden.', { status: 404 });
        const patch = {};
        if (has(input, 'serialNumber')) {
            const next = (0, warehouse_1.serialFromInput)(input.serialNumber);
            if (next !== serial.serialNumber) {
                const taken = await this.products.existingSerials(tenantId, serial.productId, [next], serial.id);
                if (taken.length) {
                    throw (0, warehouse_1.warehouseError)('SERIAL_TAKEN', 'Diese Seriennummer ist an der Karte schon erfasst.', {
                        status: 409,
                        params: { serial: taken[0] ?? next },
                    });
                }
                patch.serialNumber = next;
            }
        }
        if (has(input, 'productionProjectId') || has(input, 'productionItemId')) {
            patch.target = await this.targets.resolve(tenantId, has(input, 'productionProjectId') ? input.productionProjectId : serial.productionProjectId, has(input, 'productionItemId') ? input.productionItemId : null);
        }
        let updated;
        try {
            updated = await this.products.updateSerial(tenantId, serialId, patch);
        }
        catch (error) {
            if ((0, WarehouseProductsUseCase_1.isUniqueViolation)(error, 'serialNumber')) {
                throw (0, warehouse_1.warehouseError)('SERIAL_TAKEN', 'Diese Seriennummer ist an der Karte schon erfasst.', {
                    status: 409,
                    params: { serial: patch.serialNumber ?? '' },
                });
            }
            throw error;
        }
        if (!updated)
            throw (0, warehouse_1.warehouseError)('SERIAL_NOT_FOUND', 'Seriennummer nicht gefunden.', { status: 404 });
        return (0, warehouseReadModel_1.serialDto)(updated, await this.live(tenantId, [updated]));
    }
    /**
     * `receipt` (28.09.2026): die Nummer kam eben über «Ürün ekle» als
     * Wareneingang — «Geri al» nimmt sie auch der Bestellung wieder weg. Ohne
     * `receipt` (die Karte selbst) bleibt jede Bestellung, wie sie ist.
     */
    async delete(tenantId, userId, serialId, receipt) {
        const receiptId = typeof receipt === 'string' ? receipt.trim().slice(0, 32) : '';
        const handler = receiptId ? (0, warehouseGoodsIn_1.warehouseGoodsInHandler)() : null;
        let removed = null;
        const remove = async () => {
            removed = await this.products.deleteSerial(tenantId, serialId);
            if (!removed)
                throw (0, warehouse_1.warehouseError)('SERIAL_NOT_FOUND', 'Seriennummer nicht gefunden.', { status: 404 });
        };
        if (handler) {
            const serial = await this.products.getSerial(tenantId, serialId);
            if (!serial)
                throw (0, warehouse_1.warehouseError)('SERIAL_NOT_FOUND', 'Seriennummer nicht gefunden.', { status: 404 });
            await (0, WarehouseProductsUseCase_1.undoGoodsIn)(() => handler.undo({
                tenantId,
                userId,
                productId: serial.productId,
                entries: [{ receiptId, quantity: 1, serials: [serial.serialNumber] }],
            }, remove));
        }
        else {
            await remove();
        }
        const productId = removed?.productId;
        const product = productId ? await this.products.get(tenantId, productId) : null;
        return { product: product ? (0, warehouseReadModel_1.productDto)(product) : null };
    }
    live(tenantId, serials) {
        const { projectIds, itemIds } = (0, warehouseReadModel_1.targetIdsOf)(serials);
        if (!projectIds.length && !itemIds.length) {
            return Promise.resolve({ projects: new Map(), devices: new Map() });
        }
        return this.directory.names(tenantId, projectIds, itemIds);
    }
}
exports.WarehouseSerialsUseCase = WarehouseSerialsUseCase;
//# sourceMappingURL=WarehouseSerialsUseCase.js.map