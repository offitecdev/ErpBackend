"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateLeaveRequestUseCase = void 0;
class CreateLeaveRequestUseCase {
    leaveRequestRepository;
    constructor(leaveRequestRepository) {
        this.leaveRequestRepository = leaveRequestRepository;
    }
    async execute(data) {
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);
        if (start > end) {
            throw new Error("Başlangıç tarihi bitiş tarihinden sonra olamaz.");
        }
        const overlaps = await this.leaveRequestRepository.findOverlappingRequests(data.employeeId, start, end);
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
exports.CreateLeaveRequestUseCase = CreateLeaveRequestUseCase;
//# sourceMappingURL=CreateLeaveRequestUseCase.js.map