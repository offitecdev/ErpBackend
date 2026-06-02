"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateEmployeeUseCase = void 0;
class UpdateEmployeeUseCase {
    employeeRepository;
    constructor(employeeRepository) {
        this.employeeRepository = employeeRepository;
    }
    async execute(id, data) {
        const existing = await this.employeeRepository.findById(id);
        if (!existing) {
            throw new Error("Personel bulunamadı.");
        }
        if (data.terminationDate && !data.isActive) {
            data.isActive = false;
        }
        return await this.employeeRepository.update(id, data);
    }
}
exports.UpdateEmployeeUseCase = UpdateEmployeeUseCase;
//# sourceMappingURL=UpdateEmployeeUseCase.js.map