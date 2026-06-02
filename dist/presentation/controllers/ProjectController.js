"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectController = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const SmtpMailService_1 = require("../../infrastructure/services/SmtpMailService");
const nanoid_1 = require("nanoid");
const smtp = new SmtpMailService_1.SmtpMailService();
class ProjectController {
    createProjectUseCase;
    addReportUseCase;
    requestVariationUseCase;
    approveVariationUseCase;
    addExpenseUseCase;
    projectRepository;
    reportRepository;
    materialRepository;
    constructor(createProjectUseCase, addReportUseCase, requestVariationUseCase, approveVariationUseCase, addExpenseUseCase, projectRepository, reportRepository, materialRepository) {
        this.createProjectUseCase = createProjectUseCase;
        this.addReportUseCase = addReportUseCase;
        this.requestVariationUseCase = requestVariationUseCase;
        this.approveVariationUseCase = approveVariationUseCase;
        this.addExpenseUseCase = addExpenseUseCase;
        this.projectRepository = projectRepository;
        this.reportRepository = reportRepository;
        this.materialRepository = materialRepository;
    }
    async list(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const filter = { tenantId };
            if (req.query.status)
                filter.status = req.query.status;
            if (req.query.managerId)
                filter.managerId = req.query.managerId;
            if (req.query.search)
                filter.search = req.query.search;
            const projects = await this.projectRepository.findAll(filter);
            res.status(200).json(projects);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getById(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadi." });
            }
            res.status(200).json(project);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async update(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadi." });
            }
            const allowed = ['projectName', 'managerId', 'status', 'startDate', 'endDate', 'plannedBudget', 'overtimeHourlyRate'];
            const patch = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined)
                    patch[key] = req.body[key];
            }
            if (patch.startDate)
                patch.startDate = new Date(patch.startDate);
            if (patch.endDate)
                patch.endDate = new Date(patch.endDate);
            if (patch.plannedBudget !== undefined)
                patch.plannedBudget = Number(patch.plannedBudget);
            if (patch.overtimeHourlyRate !== undefined)
                patch.overtimeHourlyRate = Number(patch.overtimeHourlyRate);
            const updated = await this.projectRepository.updateProject(project.id, patch);
            res.status(200).json(updated);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async activate(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadi." });
            }
            if (project.status !== 'AWAITING_APPROVAL') {
                return res.status(400).json({ error: "Sadece onay bekleyen projeler aktiflestirilebilir." });
            }
            const updated = await this.projectRepository.updateProject(project.id, {
                status: 'ACTIVE',
                startDate: req.body.startDate ? new Date(req.body.startDate) : new Date()
            });
            res.status(200).json({ message: "Proje aktiflestirildi.", project: updated });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async listMaterials(req, res) {
        try {
            const materials = await this.materialRepository.list(req.user.tenantId);
            res.status(200).json(materials);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async createMaterial(req, res) {
        try {
            const name = String(req.body.name || '').trim();
            const serialId = String(req.body.serialId || '').trim();
            const unitCost = Number(req.body.unitCost || 0);
            const stockQuantity = Number(req.body.stockQuantity || 0);
            if (!name)
                return res.status(400).json({ error: "Malzeme adi zorunludur." });
            if (!serialId)
                return res.status(400).json({ error: "Seri kodu zorunludur." });
            if (unitCost < 0 || stockQuantity < 0)
                return res.status(400).json({ error: "Fiyat ve stok negatif olamaz." });
            const material = await this.materialRepository.createMaterial(req.user.tenantId, name, serialId, unitCost, stockQuantity);
            res.status(201).json(material);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateMaterial(req, res) {
        try {
            const material = await this.materialRepository.findById(req.params.materialId);
            if (!material || material.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Malzeme bulunamadi." });
            }
            const patch = {};
            if (req.body.name !== undefined)
                patch.name = String(req.body.name).trim();
            if (req.body.serialId !== undefined)
                patch.serialId = String(req.body.serialId).trim();
            if (req.body.unitCost !== undefined)
                patch.unitCost = Number(req.body.unitCost);
            if (req.body.stockQuantity !== undefined)
                patch.stockQuantity = Number(req.body.stockQuantity);
            if (req.body.isActive !== undefined)
                patch.isActive = Boolean(req.body.isActive);
            if (patch.name === '')
                return res.status(400).json({ error: "Malzeme adi zorunludur." });
            if (patch.serialId === '')
                return res.status(400).json({ error: "Seri kodu zorunludur." });
            if (patch.unitCost < 0 || patch.stockQuantity < 0)
                return res.status(400).json({ error: "Fiyat ve stok negatif olamaz." });
            const updated = await this.materialRepository.updateMaterial(material.id, patch);
            res.status(200).json(updated);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async deleteMaterial(req, res) {
        try {
            const material = await this.materialRepository.findById(req.params.materialId);
            if (!material || material.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Malzeme bulunamadi." });
            }
            await this.materialRepository.softDeleteMaterial(material.id);
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async createFromTender(req, res) {
        try {
            const { tenderId, managerId, overtimeHourlyRate } = req.body;
            const employeeId = req.user.id;
            const project = await this.createProjectUseCase.execute(tenderId, employeeId, managerId, req.user.tenantId, Number(overtimeHourlyRate || 0));
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || 'http://localhost:5173';
            const bookingLink = `${frontendUrl}/booking/${project.bookingToken}`;
            res.status(201).json({
                message: "Sipariş/proje oluşturuldu. Teklif mailindeki saat planları projeye kilitli randevu olarak aktarıldı.",
                project,
                bookingLink
            });
        }
        catch (error) {
            res.status(403).json({ error: error.message });
        }
    }
    async sendBookingMail(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadi." });
            }
            if (!project.bookingToken) {
                return res.status(400).json({ error: "Bu proje icin randevu tokeni yok." });
            }
            const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId: req.user.tenantId } });
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || 'http://localhost:5173';
            const bookingLink = `${frontendUrl}/booking/${project.bookingToken}`;
            const customerEmail = project.customer?.mainEmail || "";
            const to = String(req.body.to || customerEmail || "").trim();
            const fromEmail = String(req.body.fromEmail || settings?.fromEmail || req.user.email || "").trim();
            const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
            const subject = String(req.body.subject || `${project.projectName} - Montaj randevusu`).trim();
            const message = req.body.message || "Lutfen size uygun montaj saatini secin.";
            if (!to)
                return res.status(400).json({ error: "Alıcı e-posta adresi zorunludur." });
            if (!fromEmail)
                return res.status(400).json({ error: "Gönderici e-posta adresi zorunludur." });
            const html = `
                <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
                    <p>${message}</p>
                    <p><a href="${bookingLink}" style="display:inline-block;background:#1d4ed8;color:white;padding:10px 14px;border-radius:6px;text-decoration:none">Randevu saatini sec</a></p>
                    <p style="font-size:12px;color:#64748b">${bookingLink}</p>
                </div>
            `;
            const result = await smtp.send(settings || {}, {
                fromEmail,
                fromName,
                to,
                subject,
                text: `${message}\n\n${bookingLink}`,
                html,
                replyTo: req.body.replyTo || settings?.replyTo || null
            });
            res.status(200).json({
                message: result.preview
                    ? "SMTP ayari olmadigi icin randevu maili onizleme olarak hazirlandi."
                    : "Randevu maili gonderildi.",
                bookingLink,
                ...result
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async addReport(req, res) {
        try {
            const input = {
                projectId: req.params.id,
                employeeId: req.user.id,
                workDate: req.body.workDate,
                startedAt: req.body.startedAt,
                endedAt: req.body.endedAt,
                operationsDone: req.body.operationsDone,
                technicalNotes: req.body.technicalNotes
            };
            const report = await this.addReportUseCase.execute(input);
            res.status(201).json({ message: "Saha raporu kaydedildi.", report });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateReport(req, res) {
        try {
            const report = await this.reportRepository.findById(req.params.reportId);
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            const project = await this.projectRepository.findById(report.projectId);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            const input = {
                projectId: report.projectId,
                employeeId: req.user.id,
                workDate: req.body.workDate,
                startedAt: req.body.startedAt,
                endedAt: req.body.endedAt,
                operationsDone: req.body.operationsDone,
                technicalNotes: req.body.technicalNotes
            };
            const updated = await this.addReportUseCase.update(req.params.reportId, input);
            res.status(200).json({ message: "Saha raporu güncellendi.", report: updated });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async signReport(req, res) {
        try {
            const reportId = req.params.reportId;
            const { signatureBase64 } = req.body;
            await this.reportRepository.signReport(reportId, signatureBase64);
            res.status(200).json({ message: "Rapor müşteri tarafından imzalandı." });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async requestExtraMaterial(req, res) {
        try {
            const projectId = req.params.id;
            const employeeId = req.user.id;
            const { materialId, quantity, description } = req.body;
            const extraMaterial = await this.requestVariationUseCase.execute(projectId, employeeId, materialId, quantity, description);
            res.status(201).json({ message: "Ek malzeme projeye eklendi.", extraMaterial });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async approveVariation(req, res) {
        try {
            const variationId = req.params.variationId;
            const managerId = req.user.id;
            const { isApproved } = req.body;
            const result = await this.approveVariationUseCase.execute(variationId, managerId, isApproved);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async addExpense(req, res) {
        try {
            const projectId = req.params.id;
            const { expenseType, amount, description } = req.body;
            const expense = await this.addExpenseUseCase.execute(projectId, expenseType, amount, description);
            res.status(201).json({ message: "Harici gider eklendi.", expense });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    parseAppointmentBody(body) {
        const startTime = new Date(body.startTime);
        const endTime = new Date(body.endTime);
        if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || endTime <= startTime) {
            throw new Error("Geçerli bir başlangıç ve bitiş saati girin.");
        }
        return {
            startTime,
            endTime,
            notes: body.notes === undefined ? undefined : String(body.notes || "").trim() || null
        };
    }
    async findProjectAppointmentConflict(projectId, startTime, endTime, appointmentId) {
        return await prisma_client_1.default.appointment.findFirst({
            where: {
                projectId,
                ...(appointmentId ? { id: { not: appointmentId } } : {}),
                startTime: { lt: endTime },
                endTime: { gt: startTime }
            }
        });
    }
    async createAppointment(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            const parsed = this.parseAppointmentBody(req.body);
            const conflict = await this.findProjectAppointmentConflict(project.id, parsed.startTime, parsed.endTime);
            if (conflict)
                return res.status(409).json({ error: "Bu proje için saat planı çakışıyor." });
            const appointment = await prisma_client_1.default.appointment.create({
                data: {
                    id: (0, nanoid_1.nanoid)(10),
                    tenantId: project.tenantId,
                    projectId: project.id,
                    customerId: project.customerId,
                    startTime: parsed.startTime,
                    endTime: parsed.endTime,
                    notes: parsed.notes ?? null,
                    status: "BOOKED",
                    isLocked: true
                }
            });
            res.status(201).json(appointment);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateAppointment(req, res) {
        try {
            const appointment = await prisma_client_1.default.appointment.findUnique({
                where: { id: req.params.appointmentId },
                include: { project: true }
            });
            if (!appointment?.project || appointment.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }
            const parsed = this.parseAppointmentBody(req.body);
            const conflict = await this.findProjectAppointmentConflict(appointment.projectId, parsed.startTime, parsed.endTime, appointment.id);
            if (conflict)
                return res.status(409).json({ error: "Bu proje için saat planı çakışıyor." });
            const updated = await prisma_client_1.default.appointment.update({
                where: { id: appointment.id },
                data: {
                    startTime: parsed.startTime,
                    endTime: parsed.endTime,
                    notes: parsed.notes ?? appointment.notes,
                    status: "BOOKED",
                    isLocked: true
                }
            });
            res.status(200).json(updated);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async deleteAppointment(req, res) {
        try {
            const appointment = await prisma_client_1.default.appointment.findUnique({
                where: { id: req.params.appointmentId },
                include: { project: true }
            });
            if (!appointment?.project || appointment.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }
            await prisma_client_1.default.appointment.delete({ where: { id: appointment.id } });
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.ProjectController = ProjectController;
//# sourceMappingURL=ProjectController.js.map