import { IAttendanceLogRepository } from "../../../domain/repositories/IAttendanceLogRepository";
import { parseBreakPeriods, type BreakPeriod } from "../../utils/attendanceBreaks";

export class EndBreakUseCase {
    constructor(private attendanceLogRepository: IAttendanceLogRepository) {}

    async execute(employeeId: string) {
        const activeLog = await this.attendanceLogRepository.findActiveCheckIn(employeeId);
        if (!activeLog) {
            throw new Error("Aktif giriş kaydı yok.");
        }

        const periods = parseBreakPeriods(activeLog.breakPeriodsJson);
        let closed = false;
        const next: BreakPeriod[] = periods.map((p) => {
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
            breakPeriodsJson: next as unknown as object,
        });
    }
}
