import { Request, Response } from 'express';
import { CreateServiceCallUseCase } from '../../application/use-cases/regie/CreateServiceCallUseCase';
import { CreateServiceReportUseCase } from '../../application/use-cases/regie/CreateServiceReportUseCase';
import { SignAndBillRegieUseCase } from '../../application/use-cases/regie/SignAndBillRegieUseCase';
import { IRegieRepository } from '../../domain/repositories/IRegieRepository';
import { getCustomerInServiceTenantScope, getServiceTenantScope, isTenantInServiceTenantScope } from './serviceTenantScope';

export class RegieController {
    constructor(
        private createCallUseCase: CreateServiceCallUseCase,
        private createReportUseCase: CreateServiceReportUseCase,
        private signAndBillUseCase: SignAndBillRegieUseCase,
        private regieRepo: IRegieRepository
    ) {}

    async createCall(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const customer = await getCustomerInServiceTenantScope(req.body.customerId, tenantId);
            if (!customer) {
                res.status(400).json({ error: "Secili musteri bu sirket kapsaminda bulunamadi." });
                return;
            }

            const call = await this.createCallUseCase.execute({
                tenantId: customer.tenantId,
                customerId: req.body.customerId,
                reportedIssue: req.body.reportedIssue,
                assignedTechId: req.body.assignedTechId,
                alternativeTechId: req.body.alternativeTechId,
                siteName: req.body.siteName,
                priority: req.body.priority,
            });
            res.status(201).json({ message: "Ariza/Regie kaydi olusturuldu.", call });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listCalls(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const tenantIds = await getServiceTenantScope(tenantId);
            const calls = await this.regieRepo.listCalls(tenantIds, req.query.status as any);
            res.status(200).json(calls);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateCall(req: Request, res: Response) {
        try {
            const callId = String(req.params.callId || "");
            if (!callId) {
                res.status(400).json({ error: "Cagri ID zorunludur." });
                return;
            }
            const tenantId = (req as any).user!.tenantId;
            const current = await this.regieRepo.getCallById(callId);
            if (!current) {
                res.status(404).json({ error: "Cagri bulunamadi." });
                return;
            }
            if (!(await isTenantInServiceTenantScope((current as any).tenantId, tenantId))) {
                res.status(403).json({ error: "Bu cagri icin yetkiniz yok." });
                return;
            }

            const assignmentHistory = Array.isArray((current as any).assignmentHistoryJson)
                ? [...(current as any).assignmentHistoryJson]
                : [];

            if (req.body.assignedTechId !== undefined || req.body.alternativeTechId !== undefined) {
                const assignedTechId = req.body.assignedTechId === undefined ? (current as any).assignedTechId : req.body.assignedTechId || null;
                const alternativeTechId = req.body.alternativeTechId === undefined ? (current as any).alternativeTechId : req.body.alternativeTechId || null;
                const normalizedAlternativeTechId = alternativeTechId && alternativeTechId !== assignedTechId ? alternativeTechId : null;

                assignmentHistory.push({
                    assignedTechId,
                    alternativeTechId: normalizedAlternativeTechId,
                    at: new Date().toISOString(),
                    action: "CALL_UPDATED",
                    byEmployeeId: (req as any).user!.id,
                });
            }

            const assignedTechId = req.body.assignedTechId === undefined ? (current as any).assignedTechId : req.body.assignedTechId || null;
            const alternativeTechId = req.body.alternativeTechId === undefined ? (current as any).alternativeTechId : req.body.alternativeTechId || null;
            const normalizedAlternativeTechId = alternativeTechId && alternativeTechId !== assignedTechId ? alternativeTechId : null;

            const updated = await this.regieRepo.updateCall(callId, {
                assignedTechId,
                alternativeTechId: normalizedAlternativeTechId,
                siteName: req.body.siteName === undefined ? (current as any).siteName : req.body.siteName || null,
                priority: req.body.priority === undefined ? (current as any).priority : req.body.priority || null,
                status: req.body.status === undefined ? (current as any).status : req.body.status,
                assignmentHistoryJson: assignmentHistory,
            } as any);

            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listReports(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const tenantIds = await getServiceTenantScope(tenantId);
            const reports = await this.regieRepo.listReports(tenantIds);
            res.status(200).json(reports);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async submitReport(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const call = await this.regieRepo.getCallById(req.body.callId);
            if (!call || !(await isTenantInServiceTenantScope((call as any).tenantId, tenantId))) {
                res.status(403).json({ error: "Bu cagri icin yetkiniz yok." });
                return;
            }

            const report = await this.createReportUseCase.execute({
                tenantId: (call as any).tenantId,
                employeeId,
                callId: req.body.callId,
                workDone: req.body.workDone,
                workingMinutes: req.body.workingMinutes,
                gasAmount: req.body.gasAmount,
                isWarranty: req.body.isWarranty,
                materials: req.body.materials,
                observations: req.body.observations,
                recommendations: req.body.recommendations,
                beforePhotoUrls: req.body.beforePhotoUrls,
                afterPhotoUrls: req.body.afterPhotoUrls,
                fileUrls: req.body.fileUrls,
            });

            res.status(201).json({ message: "Ariza raporu kaydedildi. Imza bekleniyor.", report });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async signReport(req: Request, res: Response) {
        try {
            const reportId = String(req.params.reportId || "");
            const { signatureBase64 } = req.body as { signatureBase64?: string };

            if (typeof reportId !== "string" || !reportId) {
                res.status(400).json({ error: "Rapor ID zorunludur." });
                return;
            }

            if (typeof signatureBase64 !== "string" || !signatureBase64) {
                res.status(400).json({ error: "Imza zorunludur." });
                return;
            }

            const report = await this.regieRepo.getReportById(reportId);
            const reportTenantId = (report as any)?.call?.tenantId;
            if (!report || !(await isTenantInServiceTenantScope(reportTenantId, (req as any).user!.tenantId))) {
                res.status(403).json({ error: "Bu rapor icin yetkiniz yok." });
                return;
            }

            const result = await this.signAndBillUseCase.signReport(reportId, signatureBase64);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async generateBill(req: Request, res: Response) {
        try {
            const reportId = String(req.params.reportId || "");
            const tenantId = (req as any).user!.tenantId;

            if (typeof reportId !== "string" || !reportId) {
                res.status(400).json({ error: "Rapor ID zorunludur." });
                return;
            }

            const report = await this.regieRepo.getReportById(reportId);
            const reportTenantId = (report as any)?.call?.tenantId;
            if (!report || !(await isTenantInServiceTenantScope(reportTenantId, tenantId))) {
                res.status(403).json({ error: "Bu rapor icin yetkiniz yok." });
                return;
            }

            const workOrder = await this.signAndBillUseCase.createWorkOrderForReport(reportId, reportTenantId);
            res.status(201).json({ message: "Is emri (Auftrag) basariyla olusturuldu.", workOrder });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
