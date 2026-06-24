import { ICustomerLocationRepository } from "../../../domain/repositories/ICustomerLocationRepository";
import { CustomerLocation } from "../../../domain/entities/CustomerLocation";

export class AddCustomerLocationUseCase {
    constructor(private locationRepository: ICustomerLocationRepository) {}

    async execute(data: Partial<CustomerLocation>): Promise<CustomerLocation> {
        if (!data.customerId || !data.name) {
            throw new Error("Müşteri ID ve Standort adı zorunludur.");
        }
        return await this.locationRepository.create(data);
    }
}
