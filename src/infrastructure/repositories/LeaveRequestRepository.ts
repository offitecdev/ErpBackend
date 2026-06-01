import prisma from "../database/prisma.client";
import { ILeaveRequestRepository, ILeaveFilter } from "../../domain/repositories/ILeaveRequestRepository";
import { LeaveRequest } from "../../domain/entities/LeaveRequest";

export class LeaveRequestRepository implements ILeaveRequestRepository {

    private mapToEntity(data: any): LeaveRequest {
        return new LeaveRequest(
            data.id,
            data.employeeId,
            data.leaveTypeId,
            data.startDate,
            data.endDate,
            data.totalDays,
            data.status,
            data.description,
            data.approvedById,
            data.createdAt
        )
    }

    async create(requestData: Partial<LeaveRequest>): Promise<LeaveRequest> {
        const data = await prisma.leaveRequest.create({
            data: {
                id: requestData.id as string,
                employeeId: requestData.employeeId!,
                leaveTypeId: requestData.leaveTypeId!,
                startDate: requestData.startDate!,
                endDate: requestData.endDate!,
                totalDays: requestData.totalDays!,
                status: requestData.status || 'Pending',
                description: requestData.description ?? null,
                approvedById: requestData.approvedById ?? null,
            }
        });
        return this.mapToEntity(data);
    }

    async updateStatus(id: string, status: 'Approved' | 'Rejected', approvedById: string): Promise<LeaveRequest> {
        const data = await prisma.leaveRequest.update({
            where: { id },
            data: {
                status,
                approvedById
            }
        });
        return this.mapToEntity(data);
    }

    async findById(id: string): Promise<LeaveRequest | null> {
        const data = await prisma.leaveRequest.findUnique({ where: { id } });
        return data ? this.mapToEntity(data) : null;
    }

    async findOverlappingRequests(employeeId: string, startDate: Date, endDate: Date): Promise<LeaveRequest[]> {
        const data = await prisma.leaveRequest.findMany({
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

    async findAll(filter: ILeaveFilter): Promise<any[]> {
        const whereClause: any = {};

        if (filter.employeeId) {
            whereClause.employeeId = filter.employeeId;
        } else if (filter.tenantId) {
            whereClause.employee = { tenantId: filter.tenantId };
        }

        if (filter.status) {
            whereClause.status = filter.status;
        }

        return await prisma.leaveRequest.findMany({
            where: whereClause,
            include: {
                employee: { select: { firstName: true, lastName: true, departmentId: true } },
                leaveType: { select: { typeName: true } }
            },
            orderBy: { startDate: 'desc' }
        });
    }
}
