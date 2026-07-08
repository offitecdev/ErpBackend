
import {
    MaintenanceAppointmentOption,
    MaintenanceContract,
    MaintenanceExpense,
    MaintenanceMaterial,
    MaintenanceReport,
    MaintenanceTask,
    MaintenanceTaskAssignment,
    TaskStatus,
} from "../entities/Maintenance";

export type TenantScope = string | string[];

export interface IMaintenanceRepository {

    createContract(contract: Partial<MaintenanceContract>): Promise<MaintenanceContract>;
    getNextContractCode(tenantId: string): Promise<string>;
    getContractById(id: string): Promise<MaintenanceContract | null>;
    listContracts(tenantId: TenantScope, customerId?: string): Promise<MaintenanceContract[]>;
    updateContract(id: string, patch: Partial<MaintenanceContract>): Promise<MaintenanceContract>;
    archiveContract(id: string): Promise<MaintenanceContract>;
    
    createTask(task: Partial<MaintenanceTask>): Promise<MaintenanceTask>;
    getTaskById(id: string): Promise<MaintenanceTask | null>;
    getTaskCalendarDetailById(id: string): Promise<MaintenanceTask | null>;
    getTaskByBookingToken(token: string): Promise<MaintenanceTask | null>;
    updateTask(id: string, patch: Partial<MaintenanceTask>): Promise<MaintenanceTask>;
    updateTaskStatus(id: string, status: TaskStatus): Promise<MaintenanceTask>;
    getTasksByDateRange(tenantId: TenantScope, startDate: Date, endDate: Date, lite?: boolean): Promise<MaintenanceTask[]>;
    getTasksAssignedToTechnician(tenantId: TenantScope, technicianId: string, startDate: Date, endDate: Date, lite?: boolean): Promise<MaintenanceTask[]>;
    replaceTaskAssignments(taskId: string, technicianIds: string[], createdById?: string): Promise<MaintenanceTaskAssignment[]>;
    findAssignmentConflict(technicianIds: string[], startTime: Date, endTime: Date, excludeTaskId?: string): Promise<MaintenanceTask | null>;
    findAppointmentOptionConflict(technicianIds: string[], startTime: Date, endTime: Date, excludeTaskId?: string, excludeOptionId?: string): Promise<MaintenanceAppointmentOption | null>;
    createAppointmentOptions(taskId: string, options: Partial<MaintenanceAppointmentOption>[]): Promise<MaintenanceAppointmentOption[]>;
    listAppointmentOptionsByToken(token: string): Promise<MaintenanceAppointmentOption[]>;
    confirmAppointmentOption(taskToken: string, optionId: string): Promise<MaintenanceTask>;
    disapproveAppointmentOptions(taskToken: string): Promise<MaintenanceTask>;
    approveAppointmentOptionForTask(taskId: string, optionId: string, managerId: string): Promise<MaintenanceTask>;
    
    createReport(report: Partial<MaintenanceReport>): Promise<MaintenanceReport>;
    getReportByTaskId(taskId: string): Promise<MaintenanceReport | null>;
    getReportById(reportId: string): Promise<MaintenanceReport | null>;
    listReports(tenantId: TenantScope): Promise<MaintenanceReport[]>;
    updateReport(reportId: string, patch: Partial<MaintenanceReport>): Promise<MaintenanceReport>;
    signReport(reportId: string, signatureBase64: string): Promise<MaintenanceReport>;
    
    addMaterialToReport(material: Partial<MaintenanceMaterial>): Promise<MaintenanceMaterial>;
    addExpense(expense: Partial<MaintenanceExpense>): Promise<MaintenanceExpense>;
}
