"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegieController = void 0;
const serviceTenantScope_1 = require("./serviceTenantScope");
class RegieController {
    createCallUseCase;
    createReportUseCase;
    signAndBillUseCase;
    regieRepo;
    constructor(createCallUseCase, createReportUseCase, signAndBillUseCase, regieRepo) {
        this.createCallUseCase = createCallUseCase;
        this.createReportUseCase = createReportUseCase;
        this.signAndBillUseCase = signAndBillUseCase;
        this.regieRepo = regieRepo;
    }
    async createCall(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const customer = await (0, serviceTenantScope_1.getCustomerInServiceTenantScope)(req.body.customerId, tenantId);
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async listCalls(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(tenantId);
            const calls = await this.regieRepo.listCalls(tenantIds, req.query.status);
            res.status(200).json(calls);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateCall(req, res) {
        try {
            const callId = String(req.params.callId || "");
            if (!callId) {
                res.status(400).json({ error: "Cagri ID zorunludur." });
                return;
            }
            const tenantId = req.user.tenantId;
            const current = await this.regieRepo.getCallById(callId);
            if (!current) {
                res.status(404).json({ error: "Cagri bulunamadi." });
                return;
            }
            if (!(await (0, serviceTenantScope_1.isTenantInServiceTenantScope)(current.tenantId, tenantId))) {
                res.status(403).json({ error: "Bu cagri icin yetkiniz yok." });
                return;
            }
            const assignmentHistory = Array.isArray(current.assignmentHistoryJson)
                ? [...current.assignmentHistoryJson]
                : [];
            if (req.body.assignedTechId !== undefined || req.body.alternativeTechId !== undefined) {
                const assignedTechId = req.body.assignedTechId === undefined ? current.assignedTechId : req.body.assignedTechId || null;
                const alternativeTechId = req.body.alternativeTechId === undefined ? current.alternativeTechId : req.body.alternativeTechId || null;
                const normalizedAlternativeTechId = alternativeTechId && alternativeTechId !== assignedTechId ? alternativeTechId : null;
                assignmentHistory.push({
                    assignedTechId,
                    alternativeTechId: normalizedAlternativeTechId,
                    at: new Date().toISOString(),
                    action: "CALL_UPDATED",
                    byEmployeeId: req.user.id,
                });
            }
            const assignedTechId = req.body.assignedTechId === undefined ? current.assignedTechId : req.body.assignedTechId || null;
            const alternativeTechId = req.body.alternativeTechId === undefined ? current.alternativeTechId : req.body.alternativeTechId || null;
            const normalizedAlternativeTechId = alternativeTechId && alternativeTechId !== assignedTechId ? alternativeTechId : null;
            const updated = await this.regieRepo.updateCall(callId, {
                assignedTechId,
                alternativeTechId: normalizedAlternativeTechId,
                siteName: req.body.siteName === undefined ? current.siteName : req.body.siteName || null,
                priority: req.body.priority === undefined ? current.priority : req.body.priority || null,
                status: req.body.status === undefined ? current.status : req.body.status,
                assignmentHistoryJson: assignmentHistory,
            });
            res.status(200).json(updated);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async listReports(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(tenantId);
            const reports = await this.regieRepo.listReports(tenantIds);
            res.status(200).json(reports);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async submitReport(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const call = await this.regieRepo.getCallById(req.body.callId);
            if (!call || !(await (0, serviceTenantScope_1.isTenantInServiceTenantScope)(call.tenantId, tenantId))) {
                res.status(403).json({ error: "Bu cagri icin yetkiniz yok." });
                return;
            }
            const report = await this.createReportUseCase.execute({
                tenantId: call.tenantId,
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async signReport(req, res) {
        try {
            const reportId = String(req.params.reportId || "");
            const { signatureBase64 } = req.body;
            if (typeof reportId !== "string" || !reportId) {
                res.status(400).json({ error: "Rapor ID zorunludur." });
                return;
            }
            if (typeof signatureBase64 !== "string" || !signatureBase64) {
                res.status(400).json({ error: "Imza zorunludur." });
                return;
            }
            const report = await this.regieRepo.getReportById(reportId);
            const reportTenantId = report?.call?.tenantId;
            if (!report || !(await (0, serviceTenantScope_1.isTenantInServiceTenantScope)(reportTenantId, req.user.tenantId))) {
                res.status(403).json({ error: "Bu rapor icin yetkiniz yok." });
                return;
            }
            const result = await this.signAndBillUseCase.signReport(reportId, signatureBase64);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async generateBill(req, res) {
        try {
            const reportId = String(req.params.reportId || "");
            const tenantId = req.user.tenantId;
            if (typeof reportId !== "string" || !reportId) {
                res.status(400).json({ error: "Rapor ID zorunludur." });
                return;
            }
            const report = await this.regieRepo.getReportById(reportId);
            const reportTenantId = report?.call?.tenantId;
            if (!report || !(await (0, serviceTenantScope_1.isTenantInServiceTenantScope)(reportTenantId, tenantId))) {
                res.status(403).json({ error: "Bu rapor icin yetkiniz yok." });
                return;
            }
            const workOrder = await this.signAndBillUseCase.createWorkOrderForReport(reportId, reportTenantId);
            res.status(201).json({ message: "Is emri (Auftrag) basariyla olusturuldu.", workOrder });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.RegieController = RegieController;
//# sourceMappingURL=RegieController.js.map