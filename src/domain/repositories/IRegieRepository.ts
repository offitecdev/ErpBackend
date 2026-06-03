import { ServiceCall, ServiceReport, ServiceMaterial } from "../entities/Regie";
import { TaskStatus } from "../entities/Maintenance";

export type TenantScope = string | string[];

export interface IRegieRepository {

    createCall(call: Partial<ServiceCall>): Promise<ServiceCall>;
    getCallById(id: string): Promise<ServiceCall | null>;
    listCalls(tenantId: TenantScope, status?: TaskStatus): Promise<ServiceCall[]>;
    updateCall(id: string, patch: Partial<ServiceCall>): Promise<ServiceCall>;
    updateCallStatus(id: string, status: TaskStatus): Promise<ServiceCall>;
    

    createReport(report: Partial<ServiceReport>): Promise<ServiceReport>;
    getReportByCallId(callId: string): Promise<ServiceReport | null>;
    getReportById(reportId: string): Promise<ServiceReport | null>;
    listReports(tenantId: TenantScope): Promise<ServiceReport[]>;
    signReport(reportId: string, signatureBase64: string): Promise<ServiceReport>;
    linkOrderToReport(reportId: string, orderId: string): Promise<void>;
    
    addMaterialToReport(material: Partial<ServiceMaterial>): Promise<ServiceMaterial>;
    getMaterialsByReportId(reportId: string): Promise<ServiceMaterial[]>;
}
