import { LeaveRequest } from "../entities/LeaveRequest";

export interface ILeaveFilter {
    tenantId?: string;
    employeeId?: string;
    status?: string;
}

export interface ILeaveRequestRepository {
    create(request: Partial<LeaveRequest>): Promise<LeaveRequest>;
    updateStatus(id:string,status:'Approved' | 'Rejected' , approverId?: string): Promise<LeaveRequest>;
    findById(id: string): Promise<LeaveRequest | null>;
    findOverlappingRequests(employeeId: string, startDate: Date, endDate: Date): Promise<LeaveRequest[]>;
    findAll(filter: ILeaveFilter): Promise<any[]>;
}

