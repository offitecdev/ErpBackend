"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PurchaseProposal = exports.StockMovement = exports.StockBalance = exports.Location = void 0;
class Location {
    id;
    tenantId;
    locationName;
    locationType;
    isActive;
    parentLocationId;
    constructor(id, tenantId, locationName, locationType, isActive, parentLocationId) {
        this.id = id;
        this.tenantId = tenantId;
        this.locationName = locationName;
        this.locationType = locationType;
        this.isActive = isActive;
        this.parentLocationId = parentLocationId;
    }
}
exports.Location = Location;
class StockBalance {
    id;
    tenantId;
    articleId;
    locationId;
    currentQuantity;
    reservedQuantity;
    updatedAt;
    constructor(id, tenantId, articleId, locationId, currentQuantity, reservedQuantity, updatedAt) {
        this.id = id;
        this.tenantId = tenantId;
        this.articleId = articleId;
        this.locationId = locationId;
        this.currentQuantity = currentQuantity;
        this.reservedQuantity = reservedQuantity;
        this.updatedAt = updatedAt;
    }
}
exports.StockBalance = StockBalance;
class StockMovement {
    id;
    tenantId;
    articleId;
    movementType;
    quantity;
    employeeId;
    transactionDate;
    sourceLocationId;
    destinationLocationId;
    referenceId;
    description;
    unitCost;
    supplierId;
    constructor(id, tenantId, articleId, movementType, quantity, employeeId, transactionDate, sourceLocationId, destinationLocationId, referenceId, description, unitCost, supplierId) {
        this.id = id;
        this.tenantId = tenantId;
        this.articleId = articleId;
        this.movementType = movementType;
        this.quantity = quantity;
        this.employeeId = employeeId;
        this.transactionDate = transactionDate;
        this.sourceLocationId = sourceLocationId;
        this.destinationLocationId = destinationLocationId;
        this.referenceId = referenceId;
        this.description = description;
        this.unitCost = unitCost;
        this.supplierId = supplierId;
    }
}
exports.StockMovement = StockMovement;
class PurchaseProposal {
    id;
    tenantId;
    articleId;
    proposedQuantity;
    status;
    createdAt;
    supplierId;
    resolvedAt;
    resolvedByEmployeeId;
    constructor(id, tenantId, articleId, proposedQuantity, status, createdAt, supplierId, resolvedAt, resolvedByEmployeeId) {
        this.id = id;
        this.tenantId = tenantId;
        this.articleId = articleId;
        this.proposedQuantity = proposedQuantity;
        this.status = status;
        this.createdAt = createdAt;
        this.supplierId = supplierId;
        this.resolvedAt = resolvedAt;
        this.resolvedByEmployeeId = resolvedByEmployeeId;
    }
}
exports.PurchaseProposal = PurchaseProposal;
//# sourceMappingURL=Inventory.js.map