import { IAttendanceLogRepository } from "../../../domain/repositories/IAttendanceLogRepository";

export class ListAttendanceUseCase {
    constructor(private attendanceLogRepository: IAttendanceLogRepository) {}

    async execute(filter: any) {
        if (!filter.tenantId) {
            throw new Error("Tenant ID zorunludur.");
        }
        return await this.attendanceLogRepository.findAll(filter);
    }
}