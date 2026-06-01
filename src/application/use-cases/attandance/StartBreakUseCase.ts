import { IAttendanceLogRepository } from "../../../domain/repositories/IAttendanceLogRepository";
import { hasOpenBreak, parseBreakPeriods } from "../../utils/attendanceBreaks";

export class StartBreakUseCase {
    constructor(private attendanceLogRepository: IAttendanceLogRepository) {}

    async execute(employeeId: string) {
        const activeLog = await this.attendanceLogRepository.findActiveCheckIn(employeeId);
        if (!activeLog) {
            throw new Error("Aktif giriş kaydı yok.");
        }

        const periods = parseBreakPeriods(activeLog.breakPeriodsJson);
        if (hasOpenBreak(periods)) {
            throw new Error("Zaten moladasınız.");
        }

        periods.push({ start: new Date().toISOString(), end: null });

        return await this.attendanceLogRepository.update(activeLog.id, {
            breakPeriodsJson: periods as unknown as object,
        });
    }
}
