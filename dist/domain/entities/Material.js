"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Material = void 0;
class Material {
    id;
    tenantId;
    serialId;
    name;
    stockQuantity;
    unitCost;
    isActive;
    constructor(id, tenantId, serialId, name, stockQuantity, unitCost, isActive) {
        this.id = id;
        this.tenantId = tenantId;
        this.serialId = serialId;
        this.name = name;
        this.stockQuantity = stockQuantity;
        this.unitCost = unitCost;
        this.isActive = isActive;
    }
}
exports.Material = Material;
//# sourceMappingURL=Material.js.map