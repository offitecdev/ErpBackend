"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkOrder = void 0;
class WorkOrder {
    id;
    tenantId;
    customerId;
    orderNumber;
    orderType;
    totalAmount;
    isBilled;
    createdAt;
    constructor(id, tenantId, customerId, orderNumber, orderType, totalAmount, isBilled, createdAt) {
        this.id = id;
        this.tenantId = tenantId;
        this.customerId = customerId;
        this.orderNumber = orderNumber;
        this.orderType = orderType;
        this.totalAmount = totalAmount;
        this.isBilled = isBilled;
        this.createdAt = createdAt;
    }
}
exports.WorkOrder = WorkOrder;
//# sourceMappingURL=WorkOrder.js.map