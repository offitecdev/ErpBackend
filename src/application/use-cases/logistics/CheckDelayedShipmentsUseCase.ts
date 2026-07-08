
import { IShipmentRepository } from "../../../domain/repositories/IShipmentRepository";

export class CheckDelayedShipmentsUseCase {
    constructor(private shipmentRepository: IShipmentRepository) {}

    async execute(tenantId: string): Promise<number> {
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
