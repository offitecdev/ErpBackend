
import { IShipmentRepository } from "../../../domain/repositories/IShipmentRepository";

export class CheckDelayedShipmentsUseCase {
    constructor(private shipmentRepository: IShipmentRepository) {}

    async execute(tenantId: string): Promise<number> {
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
