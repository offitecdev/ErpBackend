"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Position = void 0;
class Position {
    id;
    tenantId;
    tenderId;
    positionNumber;
    shortDescription;
    hierarchyLevel;
    quantity;
    parentPositionId;
    npkCode;
    longDescription;
    unit;
    constructor(id, tenantId, tenderId, positionNumber, shortDescription, hierarchyLevel, quantity = 0, parentPositionId, npkCode, longDescription, unit) {
        this.id = id;
        this.tenantId = tenantId;
        this.tenderId = tenderId;
        this.positionNumber = positionNumber;
        this.shortDescription = shortDescription;
        this.hierarchyLevel = hierarchyLevel;
        this.quantity = quantity;
        this.parentPositionId = parentPositionId;
        this.npkCode = npkCode;
        this.longDescription = longDescription;
        this.unit = unit;
    }
}
exports.Position = Position;
//# sourceMappingURL=Position.js.map