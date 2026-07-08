"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckDelayedShipmentsUseCase = void 0;
class CheckDelayedShipmentsUseCase {
    shipmentRepository;
    constructor(shipmentRepository) {
        this.shipmentRepository = shipmentRepository;
    }
    async execute(tenantId) {
        const delayedCandidates = await this.shipmentRepository.findAll({
            tenantId,
            isEtaPassed: true
        });
        const idsToDelay = delayedCandidates
            .filter((shipment) => shipment.status === 'UNPAID' && shipment.autoMarkDelayed)
            .map((shipment) => shipment.id);
        // Single bulk update instead of one UPDATE per shipment.
        return await this.shipmentRepository.markManyDelayed(idsToDelay);
    }
}
exports.CheckDelayedShipmentsUseCase = CheckDelayedShipmentsUseCase;
//# sourceMappingURL=CheckDelayedShipmentsUseCase.js.map