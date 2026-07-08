"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddCustomerLocationUseCase = void 0;
class AddCustomerLocationUseCase {
    locationRepository;
    constructor(locationRepository) {
        this.locationRepository = locationRepository;
    }
    async execute(data) {
        if (!data.customerId || !data.name) {
            throw new Error("Müşteri ID ve Standort adı zorunludur.");
        }
        return await this.locationRepository.create(data);
    }
}
exports.AddCustomerLocationUseCase = AddCustomerLocationUseCase;
//# sourceMappingURL=AddCustomerLocationUseCase.js.map