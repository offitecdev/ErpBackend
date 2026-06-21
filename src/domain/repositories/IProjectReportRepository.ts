import { ProjectReport, ReportMaterial } from "../entities/Project";

export interface IProjectReportRepository {
    createReport(report: Partial<ProjectReport>): Promise<ProjectReport>;
    findById(id: string): Promise<ProjectReport | null>;
    getReportsByProjectId(projectId: string): Promise<ProjectReport[]>;
    signReport(reportId: string, signatureBase64: string): Promise<void>;
    addMaterialsToReport(reportId: string, materials: Partial<ReportMaterial>[]): Promise<void>;
    replaceImages(reportId: string, images: string[], uploadedById?: string | null): Promise<void>;
}