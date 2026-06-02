"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LeaveRequestRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const LeaveRequest_1 = require("../../domain/entities/LeaveRequest");
class LeaveRequestRepository {
    mapToEntity(data) {
        return new LeaveRequest_1.LeaveRequest(data.id, data.employeeId, data.leaveTypeId, data.startDate, data.endDate, data.totalDays, data.status, data.description, data.approvedById, data.createdAt);
    }
    async create(requestData) {
        const data = await prisma_client_1.default.leaveRequest.create({
            data: {
                id: requestData.id,
                employeeId: requestData.employeeId,
                leaveTypeId: requestData.leaveTypeId,
                startDate: requestData.startDate,
                endDate: requestData.endDate,
                totalDays: requestData.totalDays,
                status: requestData.status || 'Pending',
                description: requestData.description ?? null,
                approvedById: requestData.approvedById ?? null,
            }
        });
        return this.mapToEntity(data);
    }
    async updateStatus(id, status, approvedById) {
        const data = await prisma_client_1.default.leaveRequest.update({
            where: { id },
            data: {
                status,
                approvedById
            }
        });
        return this.mapToEntity(data);
    }
    async findById(id) {
        const data = await prisma_client_1.default.leaveRequest.findUnique({ where: { id } });
        return data ? this.mapToEntity(data) : null;
    }
    async findOverlappingRequests(employeeId, startDate, endDate) {
        const data = await prisma_client_1.default.leaveRequest.findMany({
            where: {
                employeeId,
                status: { not: 'Rejected' },
                OR: [
                    {
                        startDate: { lte: endDate },
                        endDate: { gte: startDate }
                    }
                ]
            }
        });
        return data.map(d => this.mapToEntity(d));
    }
    async findAll(filter) {
        const whereClause = {};
        if (filter.employeeId) {
            whereClause.employeeId = filter.employeeId;
        }
        else if (filter.tenantId) {
            whereClause.employee = { tenantId: filter.tenantId };
        }
        if (filter.status) {
            whereClause.status = filter.status;
        }
        return await prisma_client_1.default.leaveRequest.findMany({
            where: whereClause,
            include: {
                employee: { select: { firstName: true, lastName: true, departmentId: true } },
                leaveType: { select: { typeName: true } }
            },
            orderBy: { startDate: 'desc' }
        });
    }
}
exports.LeaveRequestRepository = LeaveRequestRepository;
//# sourceMappingURL=LeaveRequestRepository.js.map