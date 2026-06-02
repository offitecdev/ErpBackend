"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateAttendanceUseCase = void 0;
class UpdateAttendanceUseCase {
    attendanceLogRepository;
    constructor(attendanceLogRepository) {
        this.attendanceLogRepository = attendanceLogRepository;
    }
    async execute(logId, checkInTime, checkOutTime, editedById) {
        const updates = {
            isManualEdit: true,
            editedById,
        };
        if (checkInTime) {
            updates.checkInTime = new Date(checkInTime);
        }
        if (checkOutTime) {
            updates.checkOutTime = new Date(checkOutTime);
        }
        return await this.attendanceLogRepository.update(logId, updates);
    }
}
exports.UpdateAttendanceUseCase = UpdateAttendanceUseCase;
//# sourceMappingURL=UpdateAttendanceUseCase.js.map