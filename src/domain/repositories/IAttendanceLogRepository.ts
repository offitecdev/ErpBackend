import { AttendanceLog } from '../entities/AttendanceLog';

export interface IAttendanceFilter{
    tenantId: string;
    employeeId?: string;
    startDate?: string;
    endDate?: string;
    date?: string;
}

export interface IAttendanceLogRepository{
    create(log:Partial<AttendanceLog>): Promise<AttendanceLog>;
    update(id: string, log: Partial<AttendanceLog>): Promise<AttendanceLog>;
    findActiveCheckIn(employeeId: string): Promise<AttendanceLog | null>;
    findByDate(tenantId: string, date: string): Promise<any[]>;
    findByEmployeeId(employeeId: string): Promise<any[]>;
    findAll(filter: IAttendanceFilter):Promise<any[]>;
}

