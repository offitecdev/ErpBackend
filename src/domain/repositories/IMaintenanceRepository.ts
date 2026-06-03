
import { MaintenanceContract, MaintenanceTask, MaintenanceReport, MaintenanceMaterial, TaskStatus } from "../entities/Maintenance";

export type TenantScope = string | string[];

export interface IMaintenanceRepository {

    createContract(contract: Partial<MaintenanceContract>): Promise<MaintenanceContract>;
    getContractById(id: string): Promise<MaintenanceContract | null>;
    listContracts(tenantId: TenantScope, customerId?: string): Promise<MaintenanceContract[]>;
    
    createTask(task: Partial<MaintenanceTask>): Promise<MaintenanceTask>;
    getTaskById(id: string): Promise<MaintenanceTask | null>;
    updateTask(id: string, patch: Partial<MaintenanceTask>): Promise<MaintenanceTask>;
    updateTaskStatus(id: string, status: TaskStatus): Promise<MaintenanceTask>;
    getTasksByDateRange(tenantId: TenantScope, startDate: Date, endDate: Date): Promise<MaintenanceTask[]>;
    
    createReport(report: Partial<MaintenanceReport>): Promise<MaintenanceReport>;
    getReportByTaskId(taskId: string): Promise<MaintenanceReport | null>;
    getReportById(reportId: string): Promise<MaintenanceReport | null>;
    listReports(tenantId: TenantScope): Promise<MaintenanceReport[]>;
    signReport(reportId: string, signatureBase64: string): Promise<MaintenanceReport>;
    
    addMaterialToReport(material: Partial<MaintenanceMaterial>): Promise<MaintenanceMaterial>;
}
