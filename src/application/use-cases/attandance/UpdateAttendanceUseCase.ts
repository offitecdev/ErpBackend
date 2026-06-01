import { IAttendanceLogRepository } from "../../../domain/repositories/IAttendanceLogRepository";

export class UpdateAttendanceUseCase {
    constructor(private attendanceLogRepository: IAttendanceLogRepository) {}

    async execute(logId: string, checkInTime: string, checkOutTime: string, editedById: string) {
        const updates: any = {
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
