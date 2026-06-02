"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApproveLeaveRequestUseCase = void 0;
class ApproveLeaveRequestUseCase {
    leaveRequestRepository;
    constructor(leaveRequestRepository) {
        this.leaveRequestRepository = leaveRequestRepository;
    }
    async execute(leaveRequestId, managerId, isApproved) {
        const request = await this.leaveRequestRepository.findById(leaveRequestId);
        if (!request) {
            throw new Error("İzin talebi bulunamadı.");
        }
        if (request.status !== "Pending") {
            throw new Error("Bu izin talebi zaten değerlendirilmiş.");
        }
        const newStatus = isApproved ? "Approved" : "Rejected";
        return await this.leaveRequestRepository.updateStatus(leaveRequestId, newStatus, managerId);
    }
}
exports.ApproveLeaveRequestUseCase = ApproveLeaveRequestUseCase;
//# sourceMappingURL=ApproveLeaveRequestUseCase.js.map