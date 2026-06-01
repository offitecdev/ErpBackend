import { ILeaveRequestRepository, ILeaveFilter } from "../../../domain/repositories/ILeaveRequestRepository";

export class ListLeavesUseCase {
    constructor(private leaveRequestRepository: ILeaveRequestRepository) {}

    async execute(filter: ILeaveFilter): Promise<any[]> {
        if (!filter.tenantId && !filter.employeeId) {
            throw new Error("tenantId veya employeeId zorunludur.");
        }
        return await this.leaveRequestRepository.findAll(filter);
    }
}
