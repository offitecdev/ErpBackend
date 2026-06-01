import prisma from "../database/prisma.client";
import { IAttendanceFilter, IAttendanceLogRepository } from "../../domain/repositories/IAttendanceLogRepository";
import { AttendanceLog } from "../../domain/entities/AttendanceLog";

export class AttendanceLogRepository implements IAttendanceLogRepository {

    private mapToEntity(data: any): AttendanceLog {
        return new AttendanceLog(
            data.id,
            data.employeeId,
            data.logDate,
            data.checkInTime,
            data.checkOutTime,
            data.isManualEdit,
            data.editedById,
            data.breakPeriodsJson ?? null,
            data.netWorkSeconds ?? null
        );
    }

    async create(logData: Partial<AttendanceLog>): Promise<AttendanceLog> {
        const data = await prisma.attendanceLog.create({
            data: logData as any
        });
        return this.mapToEntity(data);
    }

    async update(id: string, logData: Partial<AttendanceLog>): Promise<AttendanceLog> {
        const data = await prisma.attendanceLog.update({
            where: { id },
            data: logData as any
        });
        return this.mapToEntity(data);
    }

    async findActiveCheckIn(employeeId: string): Promise<AttendanceLog | null> {
        const data = await prisma.attendanceLog.findFirst({
            where: {
                employeeId,
                checkOutTime: null
            }
        });
        return data ? this.mapToEntity(data) : null;
    }

    async findByDate(tenantId: string, date: string): Promise<any[]> {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        return await prisma.attendanceLog.findMany({
            where: {
                employee: { tenantId },
                logDate: { gte: startOfDay, lte: endOfDay }
            },
            include: {
                employee: { select: { firstName: true, lastName: true } }
            },
            orderBy: { checkInTime: 'asc' }
        });
    }

    async findByEmployeeId(employeeId: string): Promise<any[]> {
        return await prisma.attendanceLog.findMany({
            where: { employeeId },
            orderBy: [
                { logDate: 'desc' },
                { checkInTime: 'desc' }
            ],
            take: 30
        });
    }

    async findByEmployeeAndDate(employeeId: string, date: string): Promise<AttendanceLog | null> {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

        /* Önce aktif (checkout yapılmamış) kaydı ara */
        const active = await prisma.attendanceLog.findFirst({
            where: {
                employeeId,
                checkOutTime: null,
                logDate: { gte: startOfDay, lte: endOfDay },
            },
            orderBy: { checkInTime: 'desc' },
        });
        if (active) return this.mapToEntity(active);

        /* Aktif yoksa en son kaydı döndür */
        const latest = await prisma.attendanceLog.findFirst({
            where: {
                employeeId,
                logDate: { gte: startOfDay, lte: endOfDay },
            },
            orderBy: { checkInTime: 'desc' },
        });
        return latest ? this.mapToEntity(latest) : null;
    }

    async findAll(filter:IAttendanceFilter): Promise<any[]> {
        const whereClause: any = {
            employee: { tenantId: filter.tenantId }
        };
        if (filter.employeeId) whereClause.employeeId = filter.employeeId;

        if (filter.date) {
            const startOfDay = new Date(filter.date);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(filter.date);
            endOfDay.setHours(23, 59, 59, 999);
            whereClause.logDate = { gte: startOfDay, lte: endOfDay };
        } else if (filter.startDate && filter.endDate) {
            whereClause.logDate = {};
            if(filter.startDate){
            const start = new Date(filter.startDate);
            start.setHours(0, 0, 0, 0);
            whereClause.logDate.gte = start;
            }
            if(filter.endDate){
            const end = new Date(filter.endDate);
            end.setHours(23, 59, 59, 999);
            whereClause.logDate.lte = end;
            }

        }

            return await prisma.attendanceLog.findMany({
            where: whereClause,
            include: {
                employee: { select: { firstName: true, lastName: true, email: true, departmentId: true } }
            },
            orderBy:[{ logDate: 'desc' }, { checkInTime: 'desc' }]
        });
    }
}