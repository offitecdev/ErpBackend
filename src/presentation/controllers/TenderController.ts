

import { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { ImportTenderUseCase } from '../../application/use-cases/tender/ImportTenderUseCase';
import { CalculatePositionCostUseCase } from '../../application/use-cases/tender/CalculatePositionCostUseCase';
import { ITenderRepository } from '../../domain/repositories/ITenderRepository';
import { IPositionRepository } from '../../domain/repositories/IPositionRepository';
import { ICustomerActivityRepository } from '../../domain/repositories/ICustomerActivityRepository';
import { TenderActivityLogRepository } from '../../infrastructure/repositories/TenderActivityLogRepository';
import prisma from '../../infrastructure/database/prisma.client';
import { SmtpMailService } from '../../infrastructure/services/SmtpMailService';

const smtp = new SmtpMailService();

export class TenderController {
    constructor(
        private importTenderUseCase: ImportTenderUseCase,
        private calculatePositionCostUseCase: CalculatePositionCostUseCase,
        private tenderRepository: ITenderRepository,
        private positionRepository: IPositionRepository,
        private customerActivityRepo: ICustomerActivityRepository,
        private tenderLogRepo: TenderActivityLogRepository
    ) {}

    async list(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const filter: any = { tenantId };
            if (req.query.customerId) filter.customerId = req.query.customerId as string;
            if (req.query.status) filter.status = req.query.status as 'Draft' | 'Approved' | 'Exported';
            if (req.query.search) filter.search = req.query.search as string;
            if (req.query.page) filter.page = Math.max(1, Number(req.query.page) || 1);
            if (req.query.pageSize) filter.pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

            const tenders = await this.tenderRepository.findAll(filter);
            res.status(200).json(tenders);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createManual(req: Request, res: Response) {
        try {
            const { customerId, tenderNumber, format, validUntil } = req.body;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;

            if (!customerId || !tenderNumber || !format) {
                return res.status(400).json({ error: "Müşteri ID, teklif numarası ve format zorunludur." });
            }
            if (format !== 'SIA451' && format !== 'CRBX') {
                return res.status(400).json({ error: "Format SIA451 veya CRBX olmalıdır." });
            }

            const tender = await this.tenderRepository.create({
                id: nanoid(10),
                tenantId,
                customerId,
                tenderNumber,
                version: 1,
                format,
                status: 'Draft',
                createdByEmployeeId: employeeId,
                validUntil: validUntil ? new Date(validUntil) : null
            });

            await this.customerActivityRepo.create({
                customerId,
                employeeId,
                activityType: "TENDER_CREATED",
                description: `${tenderNumber} numaralı yeni teklif oluşturuldu (manuel). Versiyon: 1`,
                referenceId: tender.id,
                activityDate: new Date()
            });

            res.status(201).json(tender);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async addPosition(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const {
                positionNumber, shortDescription, longDescription,
                quantity, unit, npkCode, hierarchyLevel, parentPositionId
            } = req.body;

            if (!positionNumber || !shortDescription) {
                return res.status(400).json({ error: "Pozisyon numarası ve kısa açıklama zorunludur." });
            }

            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            if (tender.status !== 'Draft') {
                return res.status(403).json({ error: "Sadece taslak (Draft) teklifler üzerinde pozisyon eklenebilir." });
            }

            const newPosId = nanoid(10);
            await this.positionRepository.createMany([{
                id: newPosId,
                tenantId,
                tenderId,
                parentPositionId: parentPositionId || null,
                positionNumber,
                shortDescription,
                longDescription: longDescription || null,
                quantity: Number(quantity ?? 0),
                unit: unit || null,
                npkCode: npkCode || null,
                hierarchyLevel: Number(hierarchyLevel ?? 0)
            }]);

            await this.tenderLogRepo.create({
                tenantId,
                tenderId,
                positionId: newPosId,
                employeeId: (req as any).user!.id,
                actionType: "POSITION_CREATED",
                fieldName: null,
                oldValue: null,
                newValue: shortDescription,
                description: `${positionNumber} pozisyonu eklendi: ${shortDescription}`
            });

            res.status(201).json({ message: "Pozisyon eklendi.", positionId: newPosId });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updatePosition(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const positionId = req.params.positionId as string;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const {
                shortDescription, longDescription, quantity, unit,
                unitPrice, discount, taxRate, imageUrl, npkCode,
            } = req.body;

            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            if (tender.status !== 'Draft') {
                return res.status(403).json({ error: "Sadece taslak tekliflerdeki pozisyonlar güncellenebilir." });
            }

            const before = await this.positionRepository.findById(positionId);
            if (!before) return res.status(404).json({ error: "Pozisyon bulunamadı." });

            const patch: any = {};
            if (shortDescription !== undefined) patch.shortDescription = shortDescription;
            if (longDescription !== undefined) patch.longDescription = longDescription;
            if (quantity !== undefined) patch.quantity = Number(quantity);
            if (unit !== undefined) patch.unit = unit;
            if (unitPrice !== undefined) patch.unitPrice = unitPrice === null ? null : Number(unitPrice);
            if (discount !== undefined) patch.discount = discount === null ? null : Number(discount);
            if (taxRate !== undefined) patch.taxRate = taxRate === null ? null : Number(taxRate);
            if (imageUrl !== undefined) patch.imageUrl = imageUrl;
            if (npkCode !== undefined) patch.npkCode = npkCode;

            const updated = await this.positionRepository.updatePosition(positionId, patch);

            // When manual pricing is set, sync totalCalculatedPrice
            // without overwriting existing cost breakdown (material/labor/overhead/risk/profit).
            const pricingChanged =
                quantity !== undefined ||
                unitPrice !== undefined ||
                discount !== undefined;

            if (pricingChanged) {
                const qty = Number(updated.quantity ?? 0);
                const price = updated.unitPrice == null ? null : Number(updated.unitPrice);
                const disc = Number(updated.discount ?? 0);
                if (qty > 0 && price != null) {
                    const gross = qty * price;
                    const net = gross * (1 - disc / 100);
                    const existing = await this.positionRepository.getCalculationByPositionId(positionId);
                    if (existing) {
                        await this.positionRepository.saveCalculation({
                            id: existing.id,
                            positionId,
                            materialCost: existing.materialCost,
                            laborCost: existing.laborCost,
                            overheadCost: existing.overheadCost,
                            riskAmount: existing.riskAmount,
                            additionalCost: (existing as any).additionalCost || 0,
                            profitMargin: existing.profitMargin,
                            totalCalculatedPrice: net,
                        } as any);
                    } else {
                        await this.positionRepository.saveCalculation({
                            positionId,
                            materialCost: 0,
                            laborCost: 0,
                            overheadCost: 0,
                            riskAmount: 0,
                            additionalCost: 0,
                            profitMargin: 0,
                            totalCalculatedPrice: net,
                        } as any);
                    }
                }
            }

            const labels: Record<string, string> = {
                shortDescription: "Açıklama",
                longDescription: "Uzun açıklama",
                quantity: "Miktar",
                unit: "Birim",
                unitPrice: "Birim fiyat",
                discount: "İndirim",
                taxRate: "KDV",
                imageUrl: "Görsel",
                npkCode: "NPK kodu",
            };
            const priceFields = ['quantity', 'unitPrice', 'discount', 'taxRate'];
            const changedLogs = Object.keys(patch)
                .filter((field) => String((before as any)[field] ?? '') !== String((updated as any)[field] ?? ''))
                .map((field) => ({
                    tenantId,
                    tenderId,
                    positionId,
                    employeeId,
                    actionType: priceFields.includes(field) ? "POSITION_PRICE_UPDATED" : "POSITION_UPDATED",
                    fieldName: field,
                    oldValue: (before as any)[field] == null ? null : String((before as any)[field]),
                    newValue: (updated as any)[field] == null ? null : String((updated as any)[field]),
                    description: `${labels[field] ?? field} değiştirildi: ${(before as any)[field] ?? 'boş'} -> ${(updated as any)[field] ?? 'boş'}`
                }));
            await this.tenderLogRepo.createMany(changedLogs);

            res.status(200).json(updated);
        } catch (error: any) {
            console.error('[updatePosition] error:', error);
            res.status(400).json({ error: error.message });
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            if (tender.status !== 'Draft') {
                return res.status(403).json({ error: "Sadece taslak (Draft) teklifler silinebilir." });
            }
            await this.tenderRepository.delete(tenderId);
            res.status(200).json({ message: "Teklif silindi." });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async import(req: Request, res: Response) {
        try {
            const { customerId, xmlContent, format } = req.body;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;

            if (!customerId || !xmlContent || !format) {
                return res.status(400).json({ error: "Müşteri ID, XML içeriği ve Format (SIA451/CRBX) zorunludur." });
            }

            const result = await this.importTenderUseCase.execute(tenantId, customerId, employeeId, xmlContent, format);
            res.status(201).json({ message: "İhale başarıyla içe aktarıldı.", tender: result });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async calculateCost(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const positionId = req.params.positionId as string;
            const costs = req.body; 

            if (!tenderId || !positionId) {
                return res.status(400).json({ error: "İhale ID ve Pozisyon ID zorunludur." });
            }

            const result = await this.calculatePositionCostUseCase.execute(positionId, tenderId, costs);
            res.status(200).json({ message: "Hesaplama kaydedildi.", calculation: result });
        } catch (error: any) {
            res.status(403).json({ error: error.message }); 
        }
    }

    async createVersion(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const employeeId = (req as any).user!.id;

            if (!tenderId) {
                return res.status(400).json({ error: "İhale ID zorunludur." });
            }

            const newTender = await this.tenderRepository.createNextVersion(tenderId, employeeId);
            res.status(201).json({ message: "Yeni versiyon başarıyla oluşturuldu.", tender: newTender });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async approve(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const employeeId = (req as any).user!.id; // İşlemi yapan kişi
            
            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            
            const approvedTender = await this.tenderRepository.updateStatus(tenderId, 'Approved');
            
            // CRM Zaman Çizelgesine Otomatik Düş!
            await this.customerActivityRepo.create({
                customerId: tender.customerId,
                employeeId: employeeId,
                activityType: "TENDER_APPROVED",
                description: `${tender.tenderNumber} numaralı teklif onaylandı ve fiyatları kilitlendi.`,
                referenceId: tender.id,
                activityDate: new Date()
            });

            res.status(200).json({ message: "İhale onaylandı.", tender: approvedTender });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getScheduleSlots(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender || tender.tenantId !== (req as any).user!.tenantId) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }

            const slots = await (prisma as any).offerScheduleSlot.findMany({
                where: { tenderId },
                orderBy: { startTime: 'asc' }
            });
            res.status(200).json(slots);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createScheduleSlot(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender: any = await this.tenderRepository.findById(tenderId);
            if (!tender || tender.tenantId !== (req as any).user!.tenantId) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }

            const startTime = new Date(req.body.startTime);
            const endTime = new Date(req.body.endTime);
            if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || endTime <= startTime) {
                return res.status(400).json({ error: "Geçerli bir başlangıç ve bitiş saati girin." });
            }

            const conflict = await (prisma as any).offerScheduleSlot.findFirst({
                where: {
                    tenderId,
                    startTime: { lt: endTime },
                    endTime: { gt: startTime }
                }
            });
            if (conflict) {
                return res.status(409).json({ error: "Bu teklif için saat planı çakışıyor." });
            }

            const slot = await (prisma as any).offerScheduleSlot.create({
                data: {
                    id: nanoid(10),
                    tenantId: tender.tenantId,
                    tenderId,
                    customerId: tender.customerId,
                    startTime,
                    endTime,
                    notes: req.body.notes || null
                }
            });
            res.status(201).json(slot);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateScheduleSlot(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const slotId = req.params.slotId as string;
            const tender: any = await this.tenderRepository.findById(tenderId);
            if (!tender || tender.tenantId !== (req as any).user!.tenantId) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            if (tender.projectId) {
                return res.status(400).json({ error: "Projeye dönüşmüş teklifin saat planı teklif ekranından güncellenemez. Lütfen proje randevu ekranını kullanın." });
            }

            const slot = await (prisma as any).offerScheduleSlot.findUnique({ where: { id: slotId } });
            if (!slot || slot.tenderId !== tenderId) return res.status(404).json({ error: "Saat planı bulunamadı." });

            const startTime = new Date(req.body.startTime);
            const endTime = new Date(req.body.endTime);
            if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || endTime <= startTime) {
                return res.status(400).json({ error: "Geçerli bir başlangıç ve bitiş saati girin." });
            }

            const conflict = await (prisma as any).offerScheduleSlot.findFirst({
                where: {
                    tenderId,
                    id: { not: slotId },
                    startTime: { lt: endTime },
                    endTime: { gt: startTime }
                }
            });
            if (conflict) {
                return res.status(409).json({ error: "Bu teklif için saat planı çakışıyor." });
            }

            const updated = await (prisma as any).offerScheduleSlot.update({
                where: { id: slotId },
                data: {
                    startTime,
                    endTime,
                    notes: req.body.notes || null
                }
            });
            res.status(200).json(updated);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteScheduleSlot(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const slotId = req.params.slotId as string;
            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender || tender.tenantId !== (req as any).user!.tenantId) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }

            const slot = await (prisma as any).offerScheduleSlot.findUnique({ where: { id: slotId } });
            if (!slot || slot.tenderId !== tenderId) return res.status(404).json({ error: "Saat planı bulunamadı." });
            if (tender.projectId) return res.status(400).json({ error: "Siparişe dönüşmüş teklifin saat planı silinemez." });

            await (prisma as any).offerScheduleSlot.delete({ where: { id: slotId } });
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async sendOfferMail(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender: any = await this.tenderRepository.findById(tenderId);
            if (!tender || tender.tenantId !== (req as any).user!.tenantId) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }

            const settings = await prisma.mailSetting.findUnique({ where: { tenantId: tender.tenantId } });
            const slots = await (prisma as any).offerScheduleSlot.findMany({
                where: { tenderId },
                orderBy: { startTime: 'asc' }
            });
            if (slots.length === 0) {
                return res.status(400).json({ error: "Teklif mailinden önce en az bir tarih/saat planı ekleyin." });
            }

            const to = String(req.body.to || tender.customerEmail || "").trim();
            const fromEmail = String(req.body.fromEmail || settings?.fromEmail || (req as any).user!.email || "").trim();
            const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
            const subject = String(req.body.subject || `${tender.tenderNumber} teklifiniz`).trim();
            const message = String(req.body.message || "Teklifimizi ve planlanan çalışma saatlerini ekte bulabilirsiniz. Uygun görmeniz halinde bu e-postaya yanıt verebilirsiniz.").trim();

            if (!to) return res.status(400).json({ error: "Alıcı e-posta adresi zorunludur." });
            if (!fromEmail) return res.status(400).json({ error: "Gönderici e-posta adresi zorunludur." });

            const scheduleText = slots.map((slot: any) => {
                const start = new Date(slot.startTime);
                const end = new Date(slot.endTime);
                return `- ${start.toLocaleDateString('tr-TR')} ${start.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`;
            }).join("\n");

            const html = `
                <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
                    <p>${message.replace(/\n/g, "<br />")}</p>
                    <p><strong>Planlanan tarih ve saatler</strong></p>
                    <ul>${slots.map((slot: any) => `<li>${new Date(slot.startTime).toLocaleString('tr-TR')} - ${new Date(slot.endTime).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</li>`).join("")}</ul>
                </div>
            `;

            const result = await smtp.send(settings || {}, {
                fromEmail,
                fromName,
                to,
                subject,
                text: `${message}\n\nPlanlanan tarih ve saatler:\n${scheduleText}`,
                html,
                replyTo: req.body.replyTo || settings?.replyTo || null,
                attachments: Array.isArray(req.body.attachments) ? req.body.attachments : []
            });

            await (prisma as any).tender.update({
                where: { id: tenderId },
                data: {
                    offerMailSentAt: new Date(),
                    offerMailRecipient: to
                }
            });

            await this.customerActivityRepo.create({
                customerId: tender.customerId,
                employeeId: (req as any).user!.id,
                activityType: "OFFER_MAIL_SENT",
                description: `${tender.tenderNumber} teklif PDF'i randevu saatleriyle birlikte ${to} adresine gönderildi.`,
                referenceId: tender.id,
                activityDate: new Date()
            });

            res.status(200).json({
                message: result.preview ? "SMTP ayarı olmadığı için teklif maili önizleme olarak hazırlandı." : "Teklif maili gönderildi.",
                ...result
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async acceptOfferByToken(req: Request, res: Response) {
        try {
            const token = req.params.token as string;
            const tender: any = await (prisma as any).tender.findUnique({ where: { offerAcceptanceToken: token } });
            if (!tender) return res.status(404).send("Teklif kabul bağlantısı geçersiz.");

            await (prisma as any).tender.update({
                where: { id: tender.id },
                data: { offerAcceptedAt: tender.offerAcceptedAt || new Date() }
            });

            res.status(200).send(`
                <html><head><meta charset="utf-8"><title>Teklif kabul edildi</title></head>
                <body style="font-family:Arial,sans-serif;padding:32px;color:#0f172a">
                    <h1>Teklif kabul edildi</h1>
                    <p>Teşekkür ederiz. Offitec ekibi sipariş/proje kaydını manuel olarak oluşturacaktır.</p>
                </body></html>
            `);
        } catch (error: any) {
            res.status(400).send(error.message);
        }
    }

    async markOfferAccepted(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender || tender.tenantId !== (req as any).user!.tenantId) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            const updated = await (prisma as any).tender.update({
                where: { id: tenderId },
                data: { offerAcceptedAt: new Date() }
            });
            res.status(200).json({ message: "Müşteri kabulü kaydedildi.", tender: updated });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async export(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            
            if (!tenderId) {
                return res.status(400).json({ error: "İhale ID zorunludur." });
            }

            const tender = await this.tenderRepository.findById(tenderId);
            
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            
            if (tender.status === 'Draft') {
                return res.status(403).json({ error: "[BLOCKED] Onaylanmamış (Draft) teklifler dışa aktarılamaz. Lütfen önce onaylayın." });
            }

            const exportedTender = await this.tenderRepository.updateStatus(tenderId, 'Exported');
            
            res.status(200).json({ 
                message: "İhale başarıyla dışa aktarıldı.", 
                downloadUrl: `https://api.offitec.com/downloads/tenders/${tenderId}.crbx`,
                tender: exportedTender 
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getDetails(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            
            if (!tenderId) {
                return res.status(400).json({ error: "İhale ID zorunludur." });
            }

            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });

            const includeImages = req.query.includeImages === 'true';
            const positions = await this.positionRepository.findByTenderId(tenderId, { includeImages });
            const activities = await this.customerActivityRepo.getActivitiesByReference(tenderId);
            res.status(200).json({ tender, positions, activities });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deletePosition(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const positionId = req.params.positionId as string;

            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            if (tender.status !== 'Draft') {
                return res.status(403).json({ error: "Sadece taslak tekliflerdeki pozisyonlar silinebilir." });
            }

            const before = await this.positionRepository.findById(positionId);
            await this.positionRepository.deletePosition(positionId);
            await this.tenderLogRepo.create({
                tenantId: (req as any).user!.tenantId,
                tenderId,
                positionId,
                employeeId: (req as any).user!.id,
                actionType: "POSITION_DELETED",
                fieldName: null,
                oldValue: before?.shortDescription ?? positionId,
                newValue: null,
                description: `${before?.positionNumber ?? ''} ${before?.shortDescription ?? 'Pozisyon'} silindi.`
            });
            res.status(200).json({ message: "Pozisyon silindi." });
        } catch (error: any) {
            console.error('[deletePosition] error:', error);
            res.status(400).json({ error: error.message });
        }
    }

    async getActivities(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const activities = await this.customerActivityRepo.getActivitiesByReference(tenderId);
            res.status(200).json(activities);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getLogs(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const logs = await this.tenderLogRepo.findByTender(tenderId);
            res.status(200).json(logs);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
