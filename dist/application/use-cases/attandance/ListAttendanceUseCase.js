"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ListAttendanceUseCase = void 0;
class ListAttendanceUseCase {
    attendanceLogRepository;
    constructor(attendanceLogRepository) {
        this.attendanceLogRepository = attendanceLogRepository;
    }
    async execute(filter) {
        if (!filter.tenantId) {
            throw new Error("Tenant ID zorunludur.");
        }
        return await this.attendanceLogRepository.findAll(filter);
    }
}
exports.ListAttendanceUseCase = ListAttendanceUseCase;
//# sourceMappingURL=ListAttendanceUseCase.js.map