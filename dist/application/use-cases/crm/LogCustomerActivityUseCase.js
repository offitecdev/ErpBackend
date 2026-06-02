"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogCustomerActivityUseCase = void 0;
class LogCustomerActivityUseCase {
    customerActivityRepository;
    constructor(customerActivityRepository) {
        this.customerActivityRepository = customerActivityRepository;
    }
    async execute(data) {
        if (!data.customerId || !data.employeeId || !data.activityType) {
            throw new Error("Missing required fields: customerId, employeeId, activityType");
        }
        return await this.customerActivityRepository.create(data);
    }
}
exports.LogCustomerActivityUseCase = LogCustomerActivityUseCase;
//# sourceMappingURL=LogCustomerActivityUseCase.js.map