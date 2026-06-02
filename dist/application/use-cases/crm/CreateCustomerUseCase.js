"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateCustomerUseCase = void 0;
class CreateCustomerUseCase {
    customerRepository;
    constructor(customerRepository) {
        this.customerRepository = customerRepository;
    }
    async execute(data) {
        if (!data.companyName)
            throw new Error("Company name is required");
        if (!data.tenantId)
            throw new Error("Tenant ID is required");
        return await this.customerRepository.createCustomer(data);
    }
}
exports.CreateCustomerUseCase = CreateCustomerUseCase;
//# sourceMappingURL=CreateCustomerUseCase.js.map