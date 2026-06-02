"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ListLeavesUseCase = void 0;
class ListLeavesUseCase {
    leaveRequestRepository;
    constructor(leaveRequestRepository) {
        this.leaveRequestRepository = leaveRequestRepository;
    }
    async execute(filter) {
        if (!filter.tenantId && !filter.employeeId) {
            throw new Error("tenantId veya employeeId zorunludur.");
        }
        return await this.leaveRequestRepository.findAll(filter);
    }
}
exports.ListLeavesUseCase = ListLeavesUseCase;
//# sourceMappingURL=ListLeavesUseCase.js.map