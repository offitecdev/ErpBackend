

import { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { ImportTenderUseCase } from '../../application/use-cases/tender/ImportTenderUseCase';
import { ImportSalesOrderCsvUseCase } from '../../application/use-cases/tender/ImportSalesOrderCsvUseCase';
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
        private importSalesOrderCsvUseCase: ImportSalesOrderCsvUseCase,
        private calculatePositionCostUseCase: CalculatePositionCostUseCase,
        private tenderRepository: ITenderRepository,
        private positionRepository: IPositionRepository,
        private customerActivityRepo: ICustomerActivityRepository,
        private tenderLogRepo: TenderActivityLogRepository
    ) {}

    private normalizeTenderRef(value?: string) {
        const raw = String(value || '').trim();
        try {
            return decodeURIComponent(raw).trim();
        } catch {
            return raw;
        }
    }

    private async tenantRootId(tenantId: string): Promise<string | null> {
        let current = await (prisma as any).tenant.findUnique({
            where: { id: tenantId },
            select: { id: true, parentTenantId: true, isActive: true }
        });
        if (!current?.isActive) return null;

        for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
            const parent = await (prisma as any).tenant.findUnique({
                where: { id: current.parentTenantId },
                select: { id: true, parentTenantId: true, isActive: true }
            });
            if (!parent?.isActive) return null;
            current = parent;
        }

        return current.id;
    }

    private async canAccessTenant(targetTenantId: string, requestTenantId: string) {
        if (targetTenantId === requestTenantId) return true;
        const [targetRootId, requestRootId] = await Promise.all([
            this.tenantRootId(targetTenantId),
            this.tenantRootId(requestTenantId)
        ]);
        return Boolean(targetRootId && requestRootId && targetRootId === requestRootId);
    }

    private async findTenderForTenant(rawRef: string, tenantId: string) {
        const tenderRef = this.normalizeTenderRef(rawRef);
        if (!tenderRef) return null;

        const byId = await this.tenderRepository.findById(tenderRef);
        if (byId && await this.canAccessTenant(byId.tenantId, tenantId)) return byId;

        const byNumber = await (prisma as any).tender.findMany({
            where: { tenderNumber: tenderRef },
            take: 50,
            select: { id: true, tenantId: true }
        });
        for (const candidate of byNumber) {
            if (await this.canAccessTenant(candidate.tenantId, tenantId)) {
                return this.tenderRepository.findById(candidate.id);
            }
        }
        return null;
    }

    private async findCustomerForTenant(customerId: string, tenantId: string) {
        const customer = await (prisma as any).customer.findUnique({
            where: { id: customerId },
            select: {
                id: true,
                tenantId: true,
                companyName: true,
                address: true,
                mainEmail: true,
                mainPhone: true,
                taxNumber: true
            }
        });
        if (!customer) return null;
        if (!await this.canAccessTenant(customer.tenantId, tenantId)) return null;
        return customer;
    }

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

            if (!tenderNumber || !format) {
                return res.status(400).json({ error: "Teklif numarası ve format zorunludur." });
            }
            if (format !== 'SIA451' && format !== 'CRBX') {
                return res.status(400).json({ error: "Format SIA451 veya CRBX olmalıdır." });
            }
            if (customerId) {
                const customer = await this.findCustomerForTenant(customerId, tenantId);
                if (!customer) return res.status(404).json({ error: "Müşteri bulunamadı." });
            }

            const tender = await this.tenderRepository.create({
                id: nanoid(10),
                tenantId,
                customerId: customerId || null,
                tenderNumber,
                version: 1,
                format,
                status: 'Draft',
                createdByEmployeeId: employeeId,
                validUntil: validUntil ? new Date(validUntil) : null
            });

            if (customerId) {
                await this.customerActivityRepo.create({
                    customerId,
                    employeeId,
                    activityType: "TENDER_CREATED",
                    description: `${tenderNumber} numaralı yeni teklif oluşturuldu (manuel). Versiyon: 1`,
                    referenceId: tender.id,
                    activityDate: new Date()
                });
            }

            await this.tenderLogRepo.create({
                tenantId: tender.tenantId,
                tenderId: tender.id,
                employeeId,
                actionType: "TENDER_CREATED",
                fieldName: null,
                oldValue: null,
                newValue: tenderNumber,
                description: `${tenderNumber} numaralı teklif oluşturuldu.`
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
                quantity, unit, npkCode, parentPositionId,
                rowType, sourceArticleId, displayOrder, unitPrice, discount, taxRate, imageUrl
            } = req.body;

            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            if (tender.tenantId !== tenantId) return res.status(404).json({ error: "Teklif bulunamadı." });
            if (tender.status !== 'Draft') {
                return res.status(403).json({ error: "Sadece taslak teklifler üzerinde satır eklenebilir." });
            }

            const normalizedRowType = String(rowType || 'SECTION').toUpperCase();
            const allowedRowTypes = new Set(['SECTION', 'TITLE', 'DESCRIPTION', 'PRODUCT', 'CUSTOM']);
            const safeRowType = allowedRowTypes.has(normalizedRowType) ? normalizedRowType : 'SECTION';
            const requestedParentPositionId = parentPositionId || null;
            const parent = requestedParentPositionId
                ? await (prisma as any).position.findFirst({
                    where: { id: requestedParentPositionId, tenderId, tenantId },
                    select: { id: true, positionNumber: true, hierarchyLevel: true }
                })
                : null;
            if (requestedParentPositionId && !parent) {
                return res.status(404).json({ error: "Üst satır bulunamadı." });
            }
            const effectiveParentPositionId = parent?.id || null;
            const effectiveHierarchyLevel = parent ? Number(parent.hierarchyLevel || 0) + 1 : 0;

            const siblingMax = await (prisma as any).position.aggregate({
                where: { tenderId, parentPositionId: effectiveParentPositionId },
                _max: { displayOrder: true }
            });
            const nextDisplayOrder = displayOrder !== undefined
                ? Number(displayOrder) || 0
                : Number(siblingMax._max.displayOrder ?? 0) + 1000;
            const siblingCount = await (prisma as any).position.count({
                where: { tenderId, parentPositionId: effectiveParentPositionId }
            });
            const internalPositionNumber = positionNumber
                || (parent ? `${parent.positionNumber}.${siblingCount + 1}` : String((siblingCount + 1) * 100));

            const sourceArticle = safeRowType === 'PRODUCT' && sourceArticleId
                ? await (prisma as any).article.findFirst({
                    where: { id: sourceArticleId, tenantId },
                    select: {
                        id: true,
                        articleCode: true,
                        name: true,
                        description: true,
                        baseCost: true,
                        salePrice: true,
                        unit: true,
                        imageUrl: true,
                    }
                })
                : null;
            if (safeRowType === 'PRODUCT' && sourceArticleId && !sourceArticle) {
                return res.status(404).json({ error: "Stok ürünü bulunamadı." });
            }

            const defaults: Record<string, string> = {
                SECTION: "Yeni bölüm",
                TITLE: "Başlık",
                DESCRIPTION: "Yeni satır",
                PRODUCT: sourceArticle?.name || "Ürün",
                CUSTOM: "Yeni satır",
            };
            const isProduct = safeRowType === 'PRODUCT';
            const isPricedRow = safeRowType === 'PRODUCT' || safeRowType === 'CUSTOM';
            const canHaveImage = isPricedRow || safeRowType === 'DESCRIPTION';
            const hasExplicitShortDescription = shortDescription !== undefined && shortDescription !== null;
            const cleanedShortDescription = hasExplicitShortDescription ? String(shortDescription).trim() : "";
            const resolvedShortDescription = isProduct
                ? (sourceArticle?.name || cleanedShortDescription || defaults.PRODUCT)
                : (hasExplicitShortDescription ? cleanedShortDescription : defaults[safeRowType]);
            const resolvedLongDescription = isProduct
                ? (sourceArticle?.description || longDescription || null)
                : (longDescription !== undefined ? (longDescription || null) : null);
            const resolvedUnit = isPricedRow
                ? (isProduct ? (sourceArticle?.unit || unit || null) : (unit || null))
                : null;
            const resolvedUnitPrice = !isPricedRow
                ? null
                : (isProduct && sourceArticle
                    ? (unitPrice !== undefined && unitPrice !== null
                        ? Number(unitPrice)
                        : (Number(sourceArticle.salePrice || 0) > 0 ? Number(sourceArticle.salePrice || 0) : Number(sourceArticle.baseCost || 0)))
                    : (unitPrice !== undefined ? (unitPrice === null ? null : Number(unitPrice)) : null));
            const resolvedImageUrl = canHaveImage
                ? (isProduct
                    ? (sourceArticle?.imageUrl || imageUrl || null)
                    : (imageUrl !== undefined ? (imageUrl || null) : null))
                : null;

            const newPosId = nanoid(10);
            await this.positionRepository.createMany([{
                id: newPosId,
                tenantId,
                tenderId,
                parentPositionId: effectiveParentPositionId,
                rowType: safeRowType,
                sourceArticleId: isProduct ? (sourceArticle?.id || sourceArticleId || null) : null,
                displayOrder: nextDisplayOrder,
                positionNumber: internalPositionNumber,
                shortDescription: resolvedShortDescription,
                longDescription: resolvedLongDescription,
                quantity: isPricedRow ? Number(quantity ?? (isProduct ? 1 : 0)) : 0,
                unit: resolvedUnit,
                npkCode: npkCode || null,
                hierarchyLevel: effectiveHierarchyLevel,
                unitPrice: resolvedUnitPrice,
                discount: isPricedRow && discount !== undefined ? Number(discount || 0) : 0,
                taxRate: isPricedRow && taxRate !== undefined ? Number(taxRate || 0) : 0,
                imageUrl: resolvedImageUrl,
            } as any]);

            await this.tenderLogRepo.create({
                tenantId,
                tenderId,
                positionId: newPosId,
                employeeId: (req as any).user!.id,
                actionType: "POSITION_CREATED",
                fieldName: null,
                oldValue: null,
                newValue: resolvedShortDescription || defaults[safeRowType],
                description: `${isProduct ? 'Ürün' : 'Satır'} eklendi: ${resolvedShortDescription || defaults[safeRowType]}`
            });

            const created = await this.positionRepository.findById(newPosId, { includeImages: true });
            res.status(201).json({ message: "Satır eklendi.", positionId: newPosId, position: created });
        } catch (error: any) {
            console.error('[addPosition] error:', error);
            res.status(400).json({ error: error.message });
        }
    }

    async updateMeta(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const { customerId, format, validUntil } = req.body;

            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender || !await this.canAccessTenant(tender.tenantId, tenantId)) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            if (tender.status !== "Draft") {
                return res.status(403).json({ error: "Sadece taslak teklif bilgileri düzenlenebilir." });
            }

            const data: any = {};
            if (format !== undefined) {
                if (format !== "SIA451" && format !== "CRBX") {
                    return res.status(400).json({ error: "Format SIA451 veya CRBX olmalıdır." });
                }
                data.format = format;
            }
            if (validUntil !== undefined) {
                data.validUntil = validUntil ? new Date(validUntil) : null;
            }
            if (customerId !== undefined) {
                if (customerId) {
                    const customer = await this.findCustomerForTenant(customerId, tenantId);
                    if (!customer) return res.status(404).json({ error: "Müşteri bulunamadı." });
                    data.customerId = customer.id;
                } else {
                    data.customerId = null;
                }
            }
            if (Object.keys(data).length === 0) {
                return res.status(400).json({ error: "Güncellenecek alan bulunamadı." });
            }

            await (prisma as any).tender.update({
                where: { id: tender.id },
                data
            });

            if (data.customerId) {
                await (prisma as any).offerScheduleSlot.updateMany({
                    where: { tenderId: tender.id },
                    data: { customerId: data.customerId }
                });
            }

            if (data.customerId && data.customerId !== tender.customerId) {
                await this.customerActivityRepo.create({
                    customerId: data.customerId,
                    employeeId,
                    activityType: "TENDER_CUSTOMER_CHANGED",
                    description: `${tender.tenderNumber} numaralı taslak teklif bu müşteriye bağlandı.`,
                    referenceId: tender.id,
                    activityDate: new Date()
                });
            }

            if (customerId !== undefined && data.customerId !== tender.customerId) {
                await this.tenderLogRepo.create({
                    tenantId: tender.tenantId,
                    tenderId: tender.id,
                    employeeId,
                    actionType: "TENDER_META_UPDATED",
                    fieldName: "customerId",
                    oldValue: tender.customerId || null,
                    newValue: data.customerId || null,
                    description: "Teklif müşterisi güncellendi."
                });
            }

            const updated = await this.tenderRepository.findById(tender.id);
            res.status(200).json(updated);
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
                rowType, sourceArticleId, displayOrder,
            } = req.body;

            const tender = await this.tenderRepository.findById(tenderId);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            if (tender.status !== 'Draft') {
                return res.status(403).json({ error: "Sadece taslak tekliflerdeki satırlar güncellenebilir." });
            }

            const before = await this.positionRepository.findById(positionId);
            if (!before) return res.status(404).json({ error: "Satır bulunamadı." });
            if (before.tenderId !== tenderId || before.tenantId !== tenantId) {
                return res.status(404).json({ error: "Satır bu teklife ait değil." });
            }

            const targetRowType = rowType !== undefined
                ? String(rowType || '').toUpperCase()
                : String((before as any).rowType || 'SECTION').toUpperCase();
            const targetCanPrice = targetRowType === 'PRODUCT' || targetRowType === 'CUSTOM';
            const targetCanHaveImage = targetCanPrice || targetRowType === 'DESCRIPTION';

            const patch: any = {};
            if (shortDescription !== undefined) patch.shortDescription = shortDescription;
            if (longDescription !== undefined) patch.longDescription = longDescription;
            if (targetCanPrice) {
                if (quantity !== undefined) patch.quantity = Number(quantity);
                if (unit !== undefined) patch.unit = unit;
                if (unitPrice !== undefined) patch.unitPrice = unitPrice === null ? null : Number(unitPrice);
                if (discount !== undefined) patch.discount = discount === null ? null : Number(discount);
                if (taxRate !== undefined) patch.taxRate = taxRate === null ? null : Number(taxRate);
            } else {
                patch.quantity = 0;
                patch.unit = null;
                patch.unitPrice = null;
                patch.discount = 0;
                patch.taxRate = 0;
            }
            if (imageUrl !== undefined) patch.imageUrl = targetCanHaveImage ? (imageUrl || null) : null;
            if (rowType !== undefined && !targetCanHaveImage) patch.imageUrl = null;
            if (npkCode !== undefined) patch.npkCode = npkCode;
            if (rowType !== undefined) patch.rowType = targetRowType;
            if (sourceArticleId !== undefined || !targetCanPrice) {
                patch.sourceArticleId = targetRowType === 'PRODUCT' ? (sourceArticleId || null) : null;
            }
            if (displayOrder !== undefined) patch.displayOrder = Number(displayOrder);

            const updated = await this.positionRepository.updatePosition(positionId, patch);

            // When manual pricing is set, sync totalCalculatedPrice
            // without overwriting existing cost breakdown (material/labor/overhead/risk/profit).
            const pricingChanged = targetCanPrice && (
                quantity !== undefined ||
                unitPrice !== undefined ||
                discount !== undefined
            );

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
                longDescription: "Satır içeriği",
                quantity: "Miktar",
                unit: "Birim",
                unitPrice: "Birim fiyat",
                discount: "İndirim",
                taxRate: "KDV",
                imageUrl: "Görsel",
                npkCode: "Eski kod",
                rowType: "Satır tipi",
                sourceArticleId: "Kaynak ürün",
                displayOrder: "Sıra",
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
                return res.status(400).json({ error: "İhale ID ve satır ID zorunludur." });
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
            if (tender.customerId) {
                await this.customerActivityRepo.create({
                    customerId: tender.customerId,
                    employeeId: employeeId,
                    activityType: "TENDER_APPROVED",
                    description: `${tender.tenderNumber} numaralı teklif onaylandı ve fiyatları kilitlendi.`,
                    referenceId: tender.id,
                    activityDate: new Date()
                });
            }

            await this.tenderLogRepo.create({
                tenantId: tender.tenantId,
                tenderId,
                employeeId,
                actionType: "TENDER_APPROVED",
                fieldName: null,
                oldValue: tender.status,
                newValue: "Approved",
                description: `${tender.tenderNumber} numaralı teklif onaylandı.`
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
            if (!tender.customerId) {
                return res.status(400).json({ error: "Saat planı eklemeden önce müşteri seçin." });
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

            if (tender.customerId) {
                await this.customerActivityRepo.create({
                    customerId: tender.customerId,
                    employeeId: (req as any).user!.id,
                    activityType: "OFFER_MAIL_SENT",
                    description: `${tender.tenderNumber} teklif PDF'i randevu saatleriyle birlikte ${to} adresine gönderildi.`,
                    referenceId: tender.id,
                    activityDate: new Date()
                });
            }

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
                return res.status(403).json({ error: "Sadece taslak tekliflerdeki satırlar silinebilir." });
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
                description: `${before?.shortDescription ?? 'Satır'} silindi.`
            });
            res.status(200).json({ message: "Satır silindi." });
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

    async importSalesOrderCsv(req: Request, res: Response) {
        try {
            const { csvContent, fileName } = req.body;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;

            if (!csvContent || typeof csvContent !== "string") {
                return res.status(400).json({ error: "CSV içeriği zorunludur." });
            }

            const result = await this.importSalesOrderCsvUseCase.execute({
                tenantId,
                employeeId,
                csvContent,
                fileName: fileName || null,
            });
            res.status(201).json({
                message: "Satış siparişi CSV dosyası içe aktarıldı.",
                tender: result.tenders[0] || null,
                tenders: result.tenders,
                summary: result.summary,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getChatterSummary(req: Request, res: Response) {
        try {
            const tenderRef = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const tender = await this.findTenderForTenant(tenderRef, tenantId);
            if (!tender) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }

            const [noteCount, documentCount, logCount] = await prisma.$transaction([
                prisma.tenderActivityLog.count({
                    where: { tenderId: tender.id, actionType: "TENDER_NOTE" }
                }),
                prisma.document.count({
                    where: { tenantId: tender.tenantId, relatedEntityId: tender.id, entityType: "TENDER" }
                }),
                prisma.tenderActivityLog.count({
                    where: { tenderId: tender.id }
                })
            ]);

            res.status(200).json({ noteCount, documentCount, logCount });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async addNote(req: Request, res: Response) {
        try {
            const tenderRef = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const noteText = String(req.body.noteText || "").trim();

            if (!noteText) return res.status(400).json({ error: "Not içeriği boş olamaz." });

            const tender = await this.findTenderForTenant(tenderRef, tenantId);
            if (!tender) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }

            const log = await this.tenderLogRepo.create({
                tenantId: tender.tenantId,
                tenderId: tender.id,
                employeeId,
                actionType: "TENDER_NOTE",
                fieldName: "note",
                oldValue: null,
                newValue: noteText,
                description: noteText
            });

            res.status(201).json(log);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getDocuments(req: Request, res: Response) {
        try {
            const tenderRef = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const tender = await this.findTenderForTenant(tenderRef, tenantId);
            if (!tender) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }

            const documents = await prisma.document.findMany({
                where: { tenantId: tender.tenantId, relatedEntityId: tender.id, entityType: "TENDER" },
                orderBy: { fileName: "asc" }
            });
            res.status(200).json(documents);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async addDocument(req: Request, res: Response) {
        try {
            const tenderRef = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const fileName = String(req.body.fileName || "").trim();
            const fileUrl = String(req.body.fileUrl || "").trim();
            const fileType = String(req.body.fileType || "").trim().toLowerCase();
            const category = String(req.body.category || "tender").trim() || "tender";

            if (!fileName || !fileUrl || !fileType) {
                return res.status(400).json({ error: "Dosya adı, URL ve tür zorunludur." });
            }
            const allowed = fileType === "application/pdf"
                || fileType === "image/png"
                || fileType === "image/jpeg"
                || /\.pdf$/i.test(fileName)
                || /\.png$/i.test(fileName)
                || /\.jpe?g$/i.test(fileName);
            if (!allowed) {
                return res.status(400).json({ error: "Sadece PDF, PNG veya JPG dosyası eklenebilir." });
            }

            const tender = await this.findTenderForTenant(tenderRef, tenantId);
            if (!tender) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }

            const document = await prisma.document.create({
                data: {
                    id: nanoid(8),
                    tenantId: tender.tenantId,
                    relatedEntityId: tender.id,
                    entityType: "TENDER",
                    fileName,
                    fileUrl,
                    fileType,
                    category,
                    uploadedByEmployeeId: employeeId
                }
            });

            await this.tenderLogRepo.create({
                tenantId: tender.tenantId,
                tenderId: tender.id,
                employeeId,
                actionType: "TENDER_ATTACHMENT",
                fieldName: "attachment",
                oldValue: null,
                newValue: fileName,
                description: `Ek dosya eklendi: ${fileName}`
            });

            res.status(201).json(document);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
