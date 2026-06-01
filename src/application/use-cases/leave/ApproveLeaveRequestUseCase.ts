import { ILeaveRequestRepository } from "../../../domain/repositories/ILeaveRequestRepository";

export class ApproveLeaveRequestUseCase {
    constructor(private leaveRequestRepository: ILeaveRequestRepository) {}

    async execute(leaveRequestId: string, managerId: string, isApproved: boolean) {
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
