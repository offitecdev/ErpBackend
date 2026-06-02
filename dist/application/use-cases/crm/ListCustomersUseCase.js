"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ListCustomersUseCase = void 0;
class ListCustomersUseCase {
    customerRepository;
    constructor(customerRepository) {
        this.customerRepository = customerRepository;
    }
    async execute(filter) {
        if (!filter.tenantId) {
            throw new Error("Tenant ID zorunludur.");
        }
        return await this.customerRepository.findAll(filter);
    }
}
exports.ListCustomersUseCase = ListCustomersUseCase;
//# sourceMappingURL=ListCustomersUseCase.js.map