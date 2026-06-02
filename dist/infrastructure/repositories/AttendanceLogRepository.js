"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AttendanceLogRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const AttendanceLog_1 = require("../../domain/entities/AttendanceLog");
class AttendanceLogRepository {
    mapToEntity(data) {
        return new AttendanceLog_1.AttendanceLog(data.id, data.employeeId, data.logDate, data.checkInTime, data.checkOutTime, data.isManualEdit, data.editedById, data.breakPeriodsJson ?? null, data.netWorkSeconds ?? null);
    }
    async create(logData) {
        const data = await prisma_client_1.default.attendanceLog.create({
            data: logData
        });
        return this.mapToEntity(data);
    }
    async update(id, logData) {
        const data = await prisma_client_1.default.attendanceLog.update({
            where: { id },
            data: logData
        });
        return this.mapToEntity(data);
    }
    async findActiveCheckIn(employeeId) {
        const data = await prisma_client_1.default.attendanceLog.findFirst({
            where: {
                employeeId,
                checkOutTime: null
            }
        });
        return data ? this.mapToEntity(data) : null;
    }
    async findByDate(tenantId, date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);
        return await prisma_client_1.default.attendanceLog.findMany({
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
    async findByEmployeeId(employeeId) {
        return await prisma_client_1.default.attendanceLog.findMany({
            where: { employeeId },
            orderBy: [
                { logDate: 'desc' },
                { checkInTime: 'desc' }
            ],
            take: 30
        });
    }
    async findByEmployeeAndDate(employeeId, date) {
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);
        /* Önce aktif (checkout yapılmamış) kaydı ara */
        const active = await prisma_client_1.default.attendanceLog.findFirst({
            where: {
                employeeId,
                checkOutTime: null,
                logDate: { gte: startOfDay, lte: endOfDay },
            },
            orderBy: { checkInTime: 'desc' },
        });
        if (active)
            return this.mapToEntity(active);
        /* Aktif yoksa en son kaydı döndür */
        const latest = await prisma_client_1.default.attendanceLog.findFirst({
            where: {
                employeeId,
                logDate: { gte: startOfDay, lte: endOfDay },
            },
            orderBy: { checkInTime: 'desc' },
        });
        return latest ? this.mapToEntity(latest) : null;
    }
    async findAll(filter) {
        const whereClause = {
            employee: { tenantId: filter.tenantId }
        };
        if (filter.employeeId)
            whereClause.employeeId = filter.employeeId;
        if (filter.date) {
            const startOfDay = new Date(filter.date);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(filter.date);
            endOfDay.setHours(23, 59, 59, 999);
            whereClause.logDate = { gte: startOfDay, lte: endOfDay };
        }
        else if (filter.startDate && filter.endDate) {
            whereClause.logDate = {};
            if (filter.startDate) {
                const start = new Date(filter.startDate);
                start.setHours(0, 0, 0, 0);
                whereClause.logDate.gte = start;
            }
            if (filter.endDate) {
                const end = new Date(filter.endDate);
                end.setHours(23, 59, 59, 999);
                whereClause.logDate.lte = end;
            }
        }
        return await prisma_client_1.default.attendanceLog.findMany({
            where: whereClause,
            include: {
                employee: { select: { firstName: true, lastName: true, email: true, departmentId: true } }
            },
            orderBy: [{ logDate: 'desc' }, { checkInTime: 'desc' }]
        });
    }
}
exports.AttendanceLogRepository = AttendanceLogRepository;
//# sourceMappingURL=AttendanceLogRepository.js.map