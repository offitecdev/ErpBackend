"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StartBreakUseCase = void 0;
const attendanceBreaks_1 = require("../../utils/attendanceBreaks");
class StartBreakUseCase {
    attendanceLogRepository;
    constructor(attendanceLogRepository) {
        this.attendanceLogRepository = attendanceLogRepository;
    }
    async execute(employeeId) {
        const activeLog = await this.attendanceLogRepository.findActiveCheckIn(employeeId);
        if (!activeLog) {
            throw new Error("Aktif giriş kaydı yok.");
        }
        const periods = (0, attendanceBreaks_1.parseBreakPeriods)(activeLog.breakPeriodsJson);
        if ((0, attendanceBreaks_1.hasOpenBreak)(periods)) {
            throw new Error("Zaten moladasınız.");
        }
        periods.push({ start: new Date().toISOString(), end: null });
        return await this.attendanceLogRepository.update(activeLog.id, {
            breakPeriodsJson: periods,
        });
    }
}
exports.StartBreakUseCase = StartBreakUseCase;
//# sourceMappingURL=StartBreakUseCase.js.map