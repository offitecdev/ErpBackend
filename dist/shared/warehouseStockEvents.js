"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitWarehouseStockChanged = exports.onWarehouseStockChanged = void 0;
const handlers = [];
const onWarehouseStockChanged = (handler) => {
    handlers.push(handler);
};
exports.onWarehouseStockChanged = onWarehouseStockChanged;
const emitWarehouseStockChanged = (event) => {
    const productIds = [...new Set(event.productIds.filter(Boolean))];
    if (!productIds.length)
        return;
    for (const handler of handlers) {
        try {
            handler({ tenantId: event.tenantId, productIds });
        }
        catch (error) {
            console.warn('[warehouseStockEvents] handler failed', error?.message);
        }
    }
};
exports.emitWarehouseStockChanged = emitWarehouseStockChanged;
//# sourceMappingURL=warehouseStockEvents.js.map