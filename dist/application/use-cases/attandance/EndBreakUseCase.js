"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EndBreakUseCase = void 0;
const attendanceBreaks_1 = require("../../utils/attendanceBreaks");
class EndBreakUseCase {
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
        let closed = false;
        const next = periods.map((p) => {
            if (!closed && p.end === null) {
                closed = true;
                return { ...p, end: new Date().toISOString() };
            }
            return p;
        });
        if (!closed) {
            throw new Error("Aktif mola yok.");
        }
        return await this.attendanceLogRepository.update(activeLog.id, {
            breakPeriodsJson: next,
        });
    }
}
exports.EndBreakUseCase = EndBreakUseCase;
//# sourceMappingURL=EndBreakUseCase.js.map