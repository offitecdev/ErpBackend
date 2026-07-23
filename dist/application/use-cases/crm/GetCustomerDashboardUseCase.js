"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetCustomerDashboardUseCase = void 0;
class GetCustomerDashboardUseCase {
    customerRepository;
    constructor(customerRepository) {
        this.customerRepository = customerRepository;
    }
    async execute(customerId, tenantId, summaryOnly = false) {
        const dashboard = await this.customerRepository.getCustomerDashboard(customerId, tenantId, summaryOnly);
        if (!dashboard)
            throw new Error("Müşteri bulunamadı.");
        return dashboard;
    }
}
exports.GetCustomerDashboardUseCase = GetCustomerDashboardUseCase;
//# sourceMappingURL=GetCustomerDashboardUseCase.js.map