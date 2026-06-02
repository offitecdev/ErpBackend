"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetMeUseCase = void 0;
class GetMeUseCase {
    employeeRepo;
    constructor(employeeRepo) {
        this.employeeRepo = employeeRepo;
    }
    async execute(employeeId) {
        const employee = await this.employeeRepo.findById(employeeId);
        if (!employee)
            throw new Error("Kullanıcı bulunamadı.");
        const { passwordHash, ...safeEmployee } = employee;
        return safeEmployee;
    }
}
exports.GetMeUseCase = GetMeUseCase;
//# sourceMappingURL=GetMeUseCase.js.map