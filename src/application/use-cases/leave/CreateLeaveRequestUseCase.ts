import { ILeaveRequestRepository } from "../../../domain/repositories/ILeaveRequestRepository";
import { LeaveRequest } from "../../../domain/entities/LeaveRequest";

interface CreateLeaveRequestDTO {
    employeeId: string;
    leaveTypeId: string;
    startDate: Date;
    endDate: Date;
    description?: string | null;
}

export class CreateLeaveRequestUseCase {
    constructor(private leaveRequestRepository: ILeaveRequestRepository) {}

    async execute(data: CreateLeaveRequestDTO): Promise<LeaveRequest> {
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);

        if (start > end) {
            throw new Error("Başlangıç tarihi bitiş tarihinden sonra olamaz.");
        }

        const overlaps = await this.leaveRequestRepository.findOverlappingRequests(
            data.employeeId,
            start,
            end
        );

        if (overlaps.length > 0) {
            throw new Error("Bu tarih aralığında zaten bir izin talebi mevcut.");
        } 
        
        const diffTime = Math.abs(end.getTime() - start.getTime());
        const totalDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

        return await this.leaveRequestRepository.create({
            employeeId: data.employeeId,
            leaveTypeId: data.leaveTypeId,
            startDate: start,
            endDate: end,
            totalDays: totalDays,
            status: 'Pending',
            description: data.description 
        });
    }
}
