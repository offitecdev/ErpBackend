import { Request, Response } from 'express';
import { CreateProjectFromTenderUseCase } from '../../application/use-cases/project/CreateProjectFromTenderUseCase';
import { AddProjectReportUseCase, ReportInput } from '../../application/use-cases/project/AddProjectReportUseCase';
import { RequestExtraMaterialUseCase } from '../../application/use-cases/project/RequestExtraMaterialUseCase';
import { ApproveVariationUseCase } from '../../application/use-cases/project/ApproveVariationUseCase';
import { AddProjectExpenseUseCase } from '../../application/use-cases/project/AddProjectExpenseUseCase';
import { ProjectRepository } from '../../infrastructure/repositories/ProjectRepository';
import { ProjectReportRepository } from '../../infrastructure/repositories/ProjectReportRepository';
import { MaterialRepository } from '../../infrastructure/repositories/MaterialRepository';
import prisma from '../../infrastructure/database/prisma.client';
import { SmtpMailService } from '../../infrastructure/services/SmtpMailService';
import { nanoid } from 'nanoid';

const smtp = new SmtpMailService();

export class ProjectController {
    constructor(
        private createProjectUseCase: CreateProjectFromTenderUseCase,
        private addReportUseCase: AddProjectReportUseCase,
        private requestVariationUseCase: RequestExtraMaterialUseCase,
        private approveVariationUseCase: ApproveVariationUseCase,
        private addExpenseUseCase: AddProjectExpenseUseCase,
        private projectRepository: ProjectRepository,
        private reportRepository: ProjectReportRepository,
        private materialRepository: MaterialRepository
    ) {}

    async list(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const filter: any = { tenantId };
            if (req.query.status) filter.status = req.query.status;
            if (req.query.managerId) filter.managerId = req.query.managerId;
            if (req.query.search) filter.search = req.query.search;
            const projects = await this.projectRepository.findAll(filter);
            res.status(200).json(projects);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getById(req: Request, res: Response) {
        try {
            const project = await this.projectRepository.findById(req.params.id as string);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadi." });
            }
            res.status(200).json(project);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async update(req: Request, res: Response) {
        try {
            const project = await this.projectRepository.findById(req.params.id as string);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadi." });
            }

            const allowed = ['projectName', 'managerId', 'status', 'startDate', 'endDate', 'plannedBudget', 'overtimeHourlyRate'];
            const patch: any = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined) patch[key] = req.body[key];
            }
            if (patch.startDate) patch.startDate = new Date(patch.startDate);
            if (patch.endDate) patch.endDate = new Date(patch.endDate);
            if (patch.plannedBudget !== undefined) patch.plannedBudget = Number(patch.plannedBudget);
            if (patch.overtimeHourlyRate !== undefined) patch.overtimeHourlyRate = Number(patch.overtimeHourlyRate);

            const updated = await this.projectRepository.updateProject(project.id, patch);
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async activate(req: Request, res: Response) {
        try {
            const project = await this.projectRepository.findById(req.params.id as string);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async listMaterials(req: Request, res: Response) {
        try {
            const materials = await this.materialRepository.list(req.user!.tenantId);
            res.status(200).json(materials);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createMaterial(req: Request, res: Response) {
        try {
            const name = String(req.body.name || '').trim();
            const serialId = String(req.body.serialId || '').trim();
            const unitCost = Number(req.body.unitCost || 0);
            const stockQuantity = Number(req.body.stockQuantity || 0);

            if (!name) return res.status(400).json({ error: "Malzeme adi zorunludur." });
            if (!serialId) return res.status(400).json({ error: "Seri kodu zorunludur." });
            if (unitCost < 0 || stockQuantity < 0) return res.status(400).json({ error: "Fiyat ve stok negatif olamaz." });

            const material = await this.materialRepository.createMaterial(req.user!.tenantId, name, serialId, unitCost, stockQuantity);
            res.status(201).json(material);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateMaterial(req: Request, res: Response) {
        try {
            const material = await this.materialRepository.findById(req.params.materialId as string);
            if (!material || (material as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Malzeme bulunamadi." });
            }

            const patch: any = {};
            if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
            if (req.body.serialId !== undefined) patch.serialId = String(req.body.serialId).trim();
            if (req.body.unitCost !== undefined) patch.unitCost = Number(req.body.unitCost);
            if (req.body.stockQuantity !== undefined) patch.stockQuantity = Number(req.body.stockQuantity);
            if (req.body.isActive !== undefined) patch.isActive = Boolean(req.body.isActive);

            if (patch.name === '') return res.status(400).json({ error: "Malzeme adi zorunludur." });
            if (patch.serialId === '') return res.status(400).json({ error: "Seri kodu zorunludur." });
            if (patch.unitCost < 0 || patch.stockQuantity < 0) return res.status(400).json({ error: "Fiyat ve stok negatif olamaz." });

            const updated = await this.materialRepository.updateMaterial(material.id, patch);
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteMaterial(req: Request, res: Response) {
        try {
            const material = await this.materialRepository.findById(req.params.materialId as string);
            if (!material || (material as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Malzeme bulunamadi." });
            }

            await this.materialRepository.softDeleteMaterial(material.id);
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createFromTender(req: Request, res: Response) {
        try {
            const { tenderId, managerId, overtimeHourlyRate } = req.body;
            const employeeId = (req as any).user!.id;
            
            const project = await this.createProjectUseCase.execute(tenderId, employeeId, managerId, req.user!.tenantId, Number(overtimeHourlyRate || 0));
            

            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || 'http://localhost:5173';
            const bookingLink = `${frontendUrl}/booking/${project.bookingToken}`;
            
            res.status(201).json({ 
                message: "Sipariş/proje oluşturuldu. Teklif mailindeki saat planları projeye kilitli randevu olarak aktarıldı.", 
                project,
                bookingLink 
            });
        } catch (error: any) {
            res.status(403).json({ error: error.message }); 
        }
    }

    async sendBookingMail(req: Request, res: Response) {
        try {
            const project = await this.projectRepository.findById(req.params.id as string);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadi." });
            }
            if (!project.bookingToken) {
                return res.status(400).json({ error: "Bu proje icin randevu tokeni yok." });
            }

            const settings = await prisma.mailSetting.findUnique({ where: { tenantId: req.user!.tenantId } });
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || 'http://localhost:5173';
            const bookingLink = `${frontendUrl}/booking/${project.bookingToken}`;
            const customerEmail = (project as any).customer?.mainEmail || "";
            const to = String(req.body.to || customerEmail || "").trim();
            const fromEmail = String(req.body.fromEmail || settings?.fromEmail || req.user!.email || "").trim();
            const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
            const subject = String(req.body.subject || `${project.projectName} - Montaj randevusu`).trim();
            const message = req.body.message || "Lutfen size uygun montaj saatini secin.";

            if (!to) return res.status(400).json({ error: "Alıcı e-posta adresi zorunludur." });
            if (!fromEmail) return res.status(400).json({ error: "Gönderici e-posta adresi zorunludur." });

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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async addReport(req: Request, res: Response) {
        try {
            const input: ReportInput = {
                projectId: req.params.id as string,
                employeeId: (req as any).user!.id,
                workDate: req.body.workDate,
                startedAt: req.body.startedAt,
                endedAt: req.body.endedAt,
                operationsDone: req.body.operationsDone,
                technicalNotes: req.body.technicalNotes
            };

            const report = await this.addReportUseCase.execute(input);
            res.status(201).json({ message: "Saha raporu kaydedildi.", report });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateReport(req: Request, res: Response) {
        try {
            const report = await this.reportRepository.findById(req.params.reportId as string);
            if (!report) return res.status(404).json({ error: "Saha raporu bulunamadı." });

            const project = await this.projectRepository.findById((report as any).projectId);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }

            const input: ReportInput = {
                projectId: (report as any).projectId,
                employeeId: (req as any).user!.id,
                workDate: req.body.workDate,
                startedAt: req.body.startedAt,
                endedAt: req.body.endedAt,
                operationsDone: req.body.operationsDone,
                technicalNotes: req.body.technicalNotes
            };

            const updated = await (this.addReportUseCase as any).update(req.params.reportId as string, input);
            res.status(200).json({ message: "Saha raporu güncellendi.", report: updated });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async signReport(req: Request, res: Response) {
        try {
            const reportId = req.params.reportId as string;
            const { signatureBase64 } = req.body;
            await this.reportRepository.signReport(reportId, signatureBase64);
            res.status(200).json({ message: "Rapor müşteri tarafından imzalandı." });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async requestExtraMaterial(req: Request, res: Response) {
        try {
            const projectId = req.params.id as string;
            const employeeId = (req as any).user!.id;
            const { materialId, quantity, description } = req.body;

            const extraMaterial = await this.requestVariationUseCase.execute(projectId, employeeId, materialId, quantity, description);
            res.status(201).json({ message: "Ek malzeme projeye eklendi.", extraMaterial });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async approveVariation(req: Request, res: Response) {
        try {
            const variationId = req.params.variationId as string;
            const managerId = (req as any).user!.id;
            const { isApproved } = req.body;

            const result = await this.approveVariationUseCase.execute(variationId, managerId, isApproved);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async addExpense(req: Request, res: Response) {
        try {
            const projectId = req.params.id as string;
            const { expenseType, amount, description } = req.body;

            const expense = await this.addExpenseUseCase.execute(projectId, expenseType, amount, description);
            res.status(201).json({ message: "Harici gider eklendi.", expense });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    private parseAppointmentBody(body: any) {
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

    private async findProjectAppointmentConflict(projectId: string, startTime: Date, endTime: Date, appointmentId?: string) {
        return await (prisma as any).appointment.findFirst({
            where: {
                projectId,
                ...(appointmentId ? { id: { not: appointmentId } } : {}),
                startTime: { lt: endTime },
                endTime: { gt: startTime }
            }
        });
    }

    async createAppointment(req: Request, res: Response) {
        try {
            const project = await this.projectRepository.findById(req.params.id as string);
            if (!project || (project as any).tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }

            const parsed = this.parseAppointmentBody(req.body);
            const conflict = await this.findProjectAppointmentConflict(project.id, parsed.startTime, parsed.endTime);
            if (conflict) return res.status(409).json({ error: "Bu proje için saat planı çakışıyor." });

            const appointment = await (prisma as any).appointment.create({
                data: {
                    id: nanoid(10),
                    tenantId: (project as any).tenantId,
                    projectId: project.id,
                    customerId: (project as any).customerId,
                    startTime: parsed.startTime,
                    endTime: parsed.endTime,
                    notes: parsed.notes ?? null,
                    status: "BOOKED",
                    isLocked: true
                }
            });

            res.status(201).json(appointment);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateAppointment(req: Request, res: Response) {
        try {
            const appointment = await (prisma as any).appointment.findUnique({
                where: { id: req.params.appointmentId as string },
                include: { project: true }
            });
            if (!appointment?.project || appointment.project.tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }

            const parsed = this.parseAppointmentBody(req.body);
            const conflict = await this.findProjectAppointmentConflict(appointment.projectId, parsed.startTime, parsed.endTime, appointment.id);
            if (conflict) return res.status(409).json({ error: "Bu proje için saat planı çakışıyor." });

            const updated = await (prisma as any).appointment.update({
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
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteAppointment(req: Request, res: Response) {
        try {
            const appointment = await (prisma as any).appointment.findUnique({
                where: { id: req.params.appointmentId as string },
                include: { project: true }
            });
            if (!appointment?.project || appointment.project.tenantId !== req.user!.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }

            await (prisma as any).appointment.delete({ where: { id: appointment.id } });
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
