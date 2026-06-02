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
        let updateCount = 0;
        for (const shipment of delayedCandidates) {
            if (shipment.status === 'UNPAID' && shipment.autoMarkDelayed) {
                await this.shipmentRepository.update(shipment.id, { status: 'DELAYED' });
                updateCount++;
            }
        }
        return updateCount;
    }
}
exports.CheckDelayedShipmentsUseCase = CheckDelayedShipmentsUseCase;
//# sourceMappingURL=CheckDelayedShipmentsUseCase.js.map