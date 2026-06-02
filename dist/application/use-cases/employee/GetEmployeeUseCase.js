"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetEmployeeUseCase = void 0;
class GetEmployeeUseCase {
    employeeRepository;
    constructor(employeeRepository) {
        this.employeeRepository = employeeRepository;
    }
    async execute(filter) {
        if (!filter.tenantId) {
            throw new Error("Tenant ID is required");
        }
        return await this.employeeRepository.findAll(filter);
    }
}
exports.GetEmployeeUseCase = GetEmployeeUseCase;
//# sourceMappingURL=GetEmployeeUseCase.js.map