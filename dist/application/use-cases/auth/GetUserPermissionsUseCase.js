"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetUserPermissionsUseCase = void 0;
class GetUserPermissionsUseCase {
    roleRepository;
    constructor(roleRepository) {
        this.roleRepository = roleRepository;
    }
    async execute(employeeId) {
        return await this.roleRepository.getEmployeePermissions(employeeId);
    }
}
exports.GetUserPermissionsUseCase = GetUserPermissionsUseCase;
//# sourceMappingURL=GetUserPermissionsUseCase.js.map