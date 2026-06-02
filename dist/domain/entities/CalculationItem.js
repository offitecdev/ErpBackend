"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalculationItem = void 0;
class CalculationItem {
    id;
    positionId;
    materialCost;
    laborCost;
    overheadCost;
    riskAmount;
    additionalCost;
    profitMargin;
    totalCalculatedPrice;
    constructor(id, positionId, materialCost, laborCost, overheadCost, riskAmount, additionalCost, profitMargin, totalCalculatedPrice) {
        this.id = id;
        this.positionId = positionId;
        this.materialCost = materialCost;
        this.laborCost = laborCost;
        this.overheadCost = overheadCost;
        this.riskAmount = riskAmount;
        this.additionalCost = additionalCost;
        this.profitMargin = profitMargin;
        this.totalCalculatedPrice = totalCalculatedPrice;
    }
}
exports.CalculationItem = CalculationItem;
//# sourceMappingURL=CalculationItem.js.map