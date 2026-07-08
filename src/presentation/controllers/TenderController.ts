

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
import { findTechnicianScheduleConflict, validateTechnicians, listTechnicianOptions } from './technicianSchedule';

const smtp = new SmtpMailService();

const normalizeIdList = (value: unknown) =>
    Array.isArray(value)
        ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
        : [];

// Validation error whose message is safe to show the user. Carries status 400 so
// controller catch blocks can distinguish it from unexpected/internal errors and
// avoid leaking raw Prisma messages.
class TenderValidationError extends Error {
    status = 400;
    constructor(message: string) {
        super(message);
        this.name = 'TenderValidationError';
    }
}

// Validates a numeric field that may appear in a request body. Throws
// TenderValidationError for NaN / Infinity / -Infinity / non-numeric input, or
// values outside [min, max]. `undefined` (field absent) is always allowed; `null`
// is allowed only when allowNull is set (callers treat null as "clear/default").
const assertNumericField = (
    value: unknown,
    label: string,
    opts: { min?: number; max?: number; allowNull?: boolean } = {}
): void => {
    if (value === undefined) return;
    if (value === null) {
        if (opts.allowNull) return;
        throw new TenderValidationError(`${label} boş bırakılamaz.`);
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
        throw new TenderValidationError(`${label} geçerli bir sayı olmalıdır.`);
    }
    if (typeof value === 'string' && value.trim() === '') {
        throw new TenderValidationError(`${label} geçerli bir sayı olmalıdır.`);
    }
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
        throw new TenderValidationError(`${label} geçerli bir sayı olmalıdır.`);
    }
    if (opts.min !== undefined && num < opts.min) {
        throw new TenderValidationError(`${label} en az ${opts.min} olmalıdır.`);
    }
    if (opts.max !== undefined && num > opts.max) {
        throw new TenderValidationError(`${label} en fazla ${opts.max} olabilir.`);
    }
};

// Standard numeric rules shared by add/update position endpoints.
const validatePositionNumericFields = (body: {
    quantity?: unknown; unitPrice?: unknown; discount?: unknown; taxRate?: unknown;
}): void => {
    assertNumericField(body.quantity, "Miktar", { min: 0, allowNull: true });
    assertNumericField(body.unitPrice, "Birim fiyat", { min: 0, allowNull: true });
    assertNumericField(body.discount, "İndirim", { min: 0, max: 100, allowNull: true });
    assertNumericField(body.taxRate, "KDV oranı", { min: 0, allowNull: true });
};

// Mail hardening helpers (used by sendOfferMail).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (value: string) => EMAIL_RE.test(value);
// Strip CR/LF so a value placed into an SMTP header cannot inject extra headers.
const stripHeaderValue = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
const escapeHtml = (value: string) =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

// Technicians (responsible + additional) are returned the same way the project
// appointment endpoints return them, so the proposal and project screens render
// the same shape.
const OFFER_SLOT_TECHNICIAN_INCLUDE = {
    assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
    technicianAssignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } } },
} as const;

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

        // Resolve the tender's own tenant first, then load it scoped to that tenant.
        // This preserves parent/child (tenant-tree) access while the repository
        // query itself is always tenant-scoped.
        const byIdLight = await (prisma as any).tender.findUnique({
            where: { id: tenderRef },
            select: { id: true, tenantId: true }
        });
        if (byIdLight && await this.canAccessTenant(byIdLight.tenantId, tenantId)) {
            return this.tenderRepository.findById(byIdLight.id, byIdLight.tenantId);
        }

        const byNumber = await (prisma as any).tender.findMany({
            where: { tenderNumber: tenderRef },
            take: 50,
            select: { id: true, tenantId: true }
        });
        if (byNumber.length) {
            // The request-side tenant root is constant across candidates, so resolve it
            // once instead of re-walking the tenant tree for every candidate.
            const requestRootId = await this.tenantRootId(tenantId);
            for (const candidate of byNumber) {
                if (candidate.tenantId === tenantId) {
                    return this.tenderRepository.findById(candidate.id, candidate.tenantId);
                }
                if (!requestRootId) continue;
                const candidateRootId = await this.tenantRootId(candidate.tenantId);
                if (candidateRootId && candidateRootId === requestRootId) {
                    return this.tenderRepository.findById(candidate.id, candidate.tenantId);
                }
            }
        }
        return null;
    }

    // Single source of truth for tender access. Resolves the tender's own tenant,
    // verifies the caller can reach it (parent/sub-tenant aware, same as updateMeta),
    // then loads the full tender scoped to that tenant. Returns null when the tender
    // does not exist OR is not accessible — callers return 404 either way, so we do
    // not leak whether another tenant's tender exists.
    private async getAccessibleTender(tenderId: string, user: { tenantId: string }) {
        const raw = String(tenderId || '').trim();
        if (!raw) return null;
        const light = await (prisma as any).tender.findUnique({
            where: { id: raw },
            select: { tenantId: true }
        });
        if (!light) return null;
        if (!await this.canAccessTenant(light.tenantId, user.tenantId)) return null;
        return this.tenderRepository.findById(raw, light.tenantId);
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

            validatePositionNumericFields({ quantity, unitPrice, discount, taxRate });

            const tender = await this.tenderRepository.findById(tenderId, tenantId);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
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

            // displayOrder / positionNumber are derived from the sibling max/count
            // INSIDE the transaction below (under a tender row lock) so concurrent
            // addPosition calls cannot read the same values and collide.

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
            // Atomic numbering + insert. Read Committed + a FOR UPDATE lock on the
            // tender row serialize concurrent inserts for the same tender: a second
            // call blocks on the lock until the first commits, then reads the updated
            // max/count — so displayOrder and positionNumber can no longer duplicate.
            await (prisma as any).$transaction(async (tx: any) => {
                await tx.$queryRaw`SELECT id FROM Tender WHERE id = ${tenderId} FOR UPDATE`;

                const siblingMax = await tx.position.aggregate({
                    where: { tenderId, parentPositionId: effectiveParentPositionId },
                    _max: { displayOrder: true }
                });
                const nextDisplayOrder = displayOrder !== undefined
                    ? Number(displayOrder) || 0
                    : Number(siblingMax._max.displayOrder ?? 0) + 1000;
                const siblingCount = await tx.position.count({
                    where: { tenderId, parentPositionId: effectiveParentPositionId }
                });
                const internalPositionNumber = positionNumber
                    || (parent ? `${parent.positionNumber}.${siblingCount + 1}` : String((siblingCount + 1) * 100));

                await tx.position.createMany({
                    data: [{
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
                    }]
                });
            }, { isolationLevel: 'ReadCommitted' });

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
            if (error?.status === 400) {
                return res.status(400).json({ error: error.message });
            }
            console.error('[addPosition] error:', error);
            res.status(400).json({ error: "Satır eklenirken bir hata oluştu." });
        }
    }

    async updateMeta(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const { customerId, format, validUntil, billingAddress, deliveryAddress, billingSameAsInstallation, internalDeliveryDate } = req.body;

            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            if (tender.status !== "Draft") {
                return res.status(403).json({ error: "Sadece taslak teklif bilgileri düzenlenebilir." });
            }

            const data: any = {};
            if (billingAddress !== undefined) {
                data.billingAddress = billingAddress ? String(billingAddress) : null;
            }
            if (deliveryAddress !== undefined) {
                data.deliveryAddress = deliveryAddress ? String(deliveryAddress) : null;
            }
            if (billingSameAsInstallation !== undefined) {
                data.billingSameAsInstallation = !!billingSameAsInstallation;
            }
            if (internalDeliveryDate !== undefined) {
                data.internalDeliveryDate = internalDeliveryDate ? new Date(internalDeliveryDate) : null;
            }
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

            const updated = await this.tenderRepository.findById(tender.id, tender.tenantId);
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

            validatePositionNumericFields({ quantity, unitPrice, discount, taxRate });

            const tender = await this.tenderRepository.findById(tenderId, tenantId);
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
            if (error?.status === 400) {
                return res.status(400).json({ error: error.message });
            }
            console.error('[updatePosition] error:', error);
            res.status(400).json({ error: "Satır güncellenirken bir hata oluştu." });
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            if (tender.status !== 'Draft') {
                return res.status(403).json({ error: "Sadece taslak (Draft) teklifler silinebilir." });
            }
            await this.tenderRepository.delete(tenderId, tender.tenantId);
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

            if (!tenderId || !positionId) {
                return res.status(400).json({ error: "İhale ID ve satır ID zorunludur." });
            }

            // Sanitize cost inputs: every cost must be a finite number >= 0. Missing
            // or null fields default to 0. Requiring >= 0 also guarantees the summed
            // totalCalculatedPrice can never be negative.
            const rawCosts: any = req.body || {};
            const costFieldLabels: Array<[keyof typeof rawCosts, string]> = [
                ['materialCost', 'Malzeme maliyeti'],
                ['laborCost', 'İşçilik maliyeti'],
                ['overheadCost', 'Genel gider'],
                ['riskAmount', 'Risk tutarı'],
                ['additionalCost', 'Ek maliyet'],
                ['profitMargin', 'Kâr marjı'],
            ];
            const costs: any = {};
            for (const [key, label] of costFieldLabels) {
                assertNumericField(rawCosts[key], label, { min: 0, allowNull: true });
                const raw = rawCosts[key];
                costs[key] = raw === undefined || raw === null ? 0 : Number(raw);
            }

            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            const result = await this.calculatePositionCostUseCase.execute(positionId, tenderId, costs, tender.tenantId);
            res.status(200).json({ message: "Hesaplama kaydedildi.", calculation: result });
        } catch (error: any) {
            // Access/ownership/state errors carry an explicit HTTP status; anything
            // else is an unexpected failure and must not leak internals or masquerade
            // as a 403.
            const status = typeof error?.status === 'number' ? error.status : 500;
            const message = status >= 500 ? "İşlem sırasında beklenmeyen bir hata oluştu." : error.message;
            res.status(status).json({ error: message });
        }
    }

    async createVersion(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const employeeId = (req as any).user!.id;

            if (!tenderId) {
                return res.status(400).json({ error: "İhale ID zorunludur." });
            }

            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });

            const newTender = await this.tenderRepository.createNextVersion(tenderId, employeeId, tender.tenantId);
            res.status(201).json({ message: "Yeni versiyon başarıyla oluşturuldu.", tender: newTender });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async approve(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const employeeId = (req as any).user!.id; // İşlemi yapan kişi

            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });

            const approvedTender = await this.tenderRepository.updateStatus(tenderId, 'Approved', tender.tenantId);
            
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

    async listTechnicians(req: Request, res: Response) {
        try {
            res.status(200).json(await listTechnicianOptions((req as any).user!.tenantId));
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    private offerSlotTechnicianIdsFromBody(body: any, fallbackIds: string[] = []) {
        if (body.technicianIds !== undefined) return normalizeIdList(body.technicianIds);
        if (body.assignedTechId !== undefined) return normalizeIdList([body.assignedTechId]);
        return [...new Set(fallbackIds.filter(Boolean))];
    }

    private async replaceOfferSlotAssignments(slotId: string, technicianIds: string[]) {
        const ids = [...new Set(technicianIds.filter(Boolean))];
        await (prisma as any).$transaction(async (tx: any) => {
            await tx.offerScheduleSlotAssignment.deleteMany({ where: { slotId } });
            if (ids.length) {
                await tx.offerScheduleSlotAssignment.createMany({
                    data: ids.map((technicianId) => ({
                        id: nanoid(10),
                        slotId,
                        technicianId,
                    })),
                    skipDuplicates: true,
                });
            }
        });
    }

    async getScheduleSlots(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender = await this.tenderRepository.findById(tenderId, (req as any).user!.tenantId);
            if (!tender || tender.tenantId !== (req as any).user!.tenantId) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            if (!tender.customerId) {
                return res.status(400).json({ error: "Saat planı eklemeden önce müşteri seçin." });
            }

            const slots = await (prisma as any).offerScheduleSlot.findMany({
                where: { tenderId },
                orderBy: { startTime: 'asc' },
                include: OFFER_SLOT_TECHNICIAN_INCLUDE,
            });
            res.status(200).json(slots);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createScheduleSlot(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender: any = await this.tenderRepository.findById(tenderId, (req as any).user!.tenantId);
            if (!tender || tender.tenantId !== (req as any).user!.tenantId) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            if (tender.projectId) {
                return res.status(400).json({ error: "Projeye dönüşmüş teklifin saat planı teklif ekranından güncellenemez. Lütfen proje randevu ekranını kullanın." });
            }
            if (!tender.customerId) {
                return res.status(400).json({ error: "Saat planı eklemeden önce müşteri seçin." });
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

            // Same technician rules and conflict checks as the project module.
            const technicians = await validateTechnicians(this.offerSlotTechnicianIdsFromBody(req.body), tender.tenantId);
            const technicianIds = technicians.map((technician: any) => technician.id);
            const responsibleTechnician = technicians[0] || null;
            const techConflict = await findTechnicianScheduleConflict(technicianIds, startTime, endTime, tender.tenantId);
            if (techConflict) return res.status(409).json({ error: techConflict.message });

            const slot = await (prisma as any).offerScheduleSlot.create({
                data: {
                    id: nanoid(10),
                    tenantId: tender.tenantId,
                    tenderId,
                    customerId: tender.customerId,
                    assignedTechId: responsibleTechnician?.id || null,
                    startTime,
                    endTime,
                    notes: req.body.notes || null
                }
            });
            await this.replaceOfferSlotAssignments(slot.id, technicianIds);

            const created = await (prisma as any).offerScheduleSlot.findUnique({
                where: { id: slot.id },
                include: OFFER_SLOT_TECHNICIAN_INCLUDE,
            });
            res.status(201).json(created);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateScheduleSlot(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const slotId = req.params.slotId as string;
            const tender: any = await this.tenderRepository.findById(tenderId, (req as any).user!.tenantId);
            if (!tender || tender.tenantId !== (req as any).user!.tenantId) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            if (tender.projectId) {
                return res.status(400).json({ error: "Projeye dönüşmüş teklifin saat planı teklif ekranından güncellenemez. Lütfen proje randevu ekranını kullanın." });
            }

            const slot = await (prisma as any).offerScheduleSlot.findUnique({
                where: { id: slotId },
                include: { technicianAssignments: true },
            });
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

            // Same technician rules and conflict checks as the project module.
            const fallbackTechnicianIds = [
                slot.assignedTechId,
                ...((slot.technicianAssignments || []).map((assignment: any) => assignment.technicianId)),
            ].filter(Boolean);
            const technicians = await validateTechnicians(this.offerSlotTechnicianIdsFromBody(req.body, fallbackTechnicianIds), tender.tenantId);
            const technicianIds = technicians.map((technician: any) => technician.id);
            const responsibleTechnician = technicians[0] || null;
            const techConflict = await findTechnicianScheduleConflict(technicianIds, startTime, endTime, tender.tenantId, { slotId });
            if (techConflict) return res.status(409).json({ error: techConflict.message });

            await (prisma as any).offerScheduleSlot.update({
                where: { id: slotId },
                data: {
                    startTime,
                    endTime,
                    assignedTechId: responsibleTechnician?.id || null,
                    notes: req.body.notes || null
                }
            });
            await this.replaceOfferSlotAssignments(slotId, technicianIds);

            const updated = await (prisma as any).offerScheduleSlot.findUnique({
                where: { id: slotId },
                include: OFFER_SLOT_TECHNICIAN_INCLUDE,
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
            const tender = await this.tenderRepository.findById(tenderId, (req as any).user!.tenantId);
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
            const tender: any = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            if (!tender.customerId) {
                return res.status(400).json({ error: "Müşterisi olmayan teklif için mail gönderilemez." });
            }

            const settings = await prisma.mailSetting.findUnique({ where: { tenantId: tender.tenantId } });
            // A date/time plan is optional — the proposal mail can be sent without any
            // appointment. When slots exist they are still included in the mail below.
            const slots = await (prisma as any).offerScheduleSlot.findMany({
                where: { tenderId },
                orderBy: { startTime: 'asc' }
            });

            // Recipient allow-list: the tender customer's main e-mail plus that
            // customer's own contacts. The request may only pick from this set — it
            // can never send to an arbitrary address, so the endpoint is not usable
            // as an open mail relay.
            const contacts = await (prisma as any).customerContact.findMany({
                where: { customerId: tender.customerId },
                select: { email: true }
            });
            const allowedRecipients = new Map<string, string>(); // lowercased -> canonical
            const registerEmail = (value: unknown) => {
                const trimmed = String(value || "").trim();
                if (trimmed && isValidEmail(trimmed)) allowedRecipients.set(trimmed.toLowerCase(), trimmed);
            };
            registerEmail(tender.customerEmail);
            contacts.forEach((contact: any) => registerEmail(contact.email));

            if (allowedRecipients.size === 0) {
                return res.status(400).json({ error: "Bu müşteri için tanımlı geçerli bir e-posta adresi yok." });
            }

            const defaultTo = allowedRecipients.get(String(tender.customerEmail || "").trim().toLowerCase())
                || Array.from(allowedRecipients.values())[0]!;
            let to = defaultTo;
            if (req.body.to !== undefined && String(req.body.to).trim() !== "") {
                const requestedTo = stripHeaderValue(String(req.body.to));
                const canonical = allowedRecipients.get(requestedTo.toLowerCase());
                if (!canonical) {
                    return res.status(403).json({ error: "Alıcı yalnızca teklifin müşterisine ait bir e-posta adresi olabilir." });
                }
                to = canonical;
            }

            // Sender is taken from the tenant MailSetting (never from the request
            // body), so the From address cannot be spoofed. fromName may be supplied
            // but is length-limited and header-sanitized.
            const fromEmail = stripHeaderValue(String(settings?.fromEmail || (req as any).user!.email || ""));
            if (!fromEmail || !isValidEmail(fromEmail)) {
                return res.status(400).json({ error: "Gönderici e-posta adresi yapılandırılmamış." });
            }
            const rawFromName = settings?.fromName
                || (req.body.fromName !== undefined ? String(req.body.fromName) : "")
                || "Offitec ERP";
            const fromName = stripHeaderValue(rawFromName).slice(0, 100) || "Offitec ERP";

            const subject = stripHeaderValue(String(req.body.subject || `${tender.tenderNumber} teklifiniz`));
            if (!subject) return res.status(400).json({ error: "Konu boş olamaz." });
            if (subject.length > 200) return res.status(400).json({ error: "Konu 200 karakteri aşamaz." });

            const message = String(req.body.message || "Teklifimizi ve planlanan çalışma saatlerini ekte bulabilirsiniz. Uygun görmeniz halinde bu e-postaya yanıt verebilirsiniz.").trim();
            if (message.length > 5000) return res.status(400).json({ error: "Mesaj 5000 karakteri aşamaz." });

            // Attachments: only well-formed inline PDF/PNG/JPG payloads, count- and
            // size-limited, with sanitized filenames. No file paths/URLs are accepted.
            const rawAttachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
            if (rawAttachments.length > 5) {
                return res.status(400).json({ error: "En fazla 5 ek dosya gönderilebilir." });
            }
            const allowedAttachmentTypes = new Set(["application/pdf", "image/png", "image/jpeg"]);
            let totalAttachmentBytes = 0;
            const attachments: Array<{ filename: string; contentType: string; contentBase64: string }> = [];
            for (const item of rawAttachments) {
                if (!item || typeof item !== "object") {
                    return res.status(400).json({ error: "Geçersiz ek dosya." });
                }
                const contentType = String((item as any).contentType || "").trim().toLowerCase();
                const contentBase64 = typeof (item as any).contentBase64 === "string" ? (item as any).contentBase64 : "";
                const rawName = String((item as any).filename || "").trim();
                if (!rawName || !contentBase64) {
                    return res.status(400).json({ error: "Ek dosya adı ve içeriği zorunludur." });
                }
                if (!allowedAttachmentTypes.has(contentType)) {
                    return res.status(400).json({ error: "Sadece PDF, PNG veya JPG ek gönderilebilir." });
                }
                const filename = rawName.replace(/[\\/\r\n"]+/g, "_").slice(0, 120);
                totalAttachmentBytes += Math.floor(contentBase64.replace(/\s+/g, "").length * 3 / 4);
                attachments.push({ filename, contentType, contentBase64 });
            }
            if (totalAttachmentBytes > 15 * 1024 * 1024) {
                return res.status(400).json({ error: "Eklerin toplam boyutu 15 MB sınırını aşıyor." });
            }

            const scheduleText = slots.map((slot: any) => {
                const start = new Date(slot.startTime);
                const end = new Date(slot.endTime);
                return `- ${start.toLocaleDateString('tr-TR')} ${start.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`;
            }).join("\n");

            const scheduleHtml = slots.length > 0
                ? `<p><strong>Planlanan tarih ve saatler</strong></p>
                    <ul>${slots.map((slot: any) => `<li>${new Date(slot.startTime).toLocaleString('tr-TR')} - ${new Date(slot.endTime).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</li>`).join("")}</ul>`
                : "";

            const html = `
                <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
                    <p>${escapeHtml(message).replace(/\n/g, "<br />")}</p>
                    ${scheduleHtml}
                </div>
            `;

            const result = await smtp.send(settings || {}, {
                fromEmail,
                fromName,
                to,
                subject,
                text: slots.length > 0 ? `${message}\n\nPlanlanan tarih ve saatler:\n${scheduleText}` : message,
                html,
                replyTo: settings?.replyTo || null,
                attachments
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
                    description: `${tender.tenderNumber} teklif PDF'i ${to} adresine gönderildi.`,
                    referenceId: tender.id,
                    activityDate: new Date()
                });
            }

            res.status(200).json({
                message: result.preview ? "SMTP ayarı olmadığı için teklif maili önizleme olarak hazırlandı." : "Teklif maili gönderildi.",
                ...result
            });
        } catch (error: any) {
            if (error?.status === 400) {
                return res.status(400).json({ error: error.message });
            }
            console.error('[sendOfferMail] error:', error);
            // SMTP connect/auth failures are a mail-settings problem, not a server bug —
            // surface a clear, actionable message instead of a generic 500.
            if (typeof error?.message === "string" && error.message.startsWith("SMTP")) {
                return res.status(502).json({ error: "E-posta gönderilemedi: SMTP sunucusuna bağlanılamadı veya kullanıcı adı/parola hatalı. Lütfen mail ayarlarını kontrol edin." });
            }
            res.status(500).json({ error: "Teklif maili gönderilirken bir hata oluştu." });
        }
    }

    // DISABLED. Public offer acceptance is intentionally turned off.
    //
    // The previous implementation was unsafe: it was a public, unauthenticated GET
    // that mutated state (setting offerAcceptedAt) with no rate limiting or expiry,
    // and it matched on `offerAcceptanceToken` — a column that is never generated
    // anywhere in the codebase, so the flow could not work and only presented an
    // abuse surface (prefetch/scanner-triggered mutations if tokens were ever added).
    //
    // We now respond 410 Gone and change no data. Internal staff can still record a
    // customer's acceptance via the authenticated PATCH /tenders/:id/mark-offer-accepted.
    //
    // TODO: If a real customer-facing acceptance flow is required, implement it as:
    //   - generate a cryptographically random token (crypto.randomBytes)
    //   - store only a HASH of the token in the DB (never the raw token)
    //   - add an expiry timestamp and enforce it
    //   - make it one-time use (invalidate on first acceptance)
    //   - make the state-changing action a POST with an explicit confirmation step
    //     (GET must remain side-effect free so link prefetch/scanners cannot accept)
    //   - apply rate limiting (see RateLimitMiddleware) to the public endpoint
    async acceptOfferByToken(_req: Request, res: Response) {
        res.status(410).send(`
            <html><head><meta charset="utf-8"><title>Bağlantı kullanım dışı</title></head>
            <body style="font-family:Arial,sans-serif;padding:32px;color:#0f172a">
                <h1>Bu bağlantı artık kullanılamıyor</h1>
                <p>Çevrimiçi teklif kabul özelliği şu anda devre dışıdır. Lütfen teklifinizle ilgili olarak bizimle doğrudan iletişime geçin.</p>
            </body></html>
        `);
    }

    async markOfferAccepted(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender = await this.tenderRepository.findById(tenderId, (req as any).user!.tenantId);
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

            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);

            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });

            if (tender.status === 'Draft') {
                return res.status(403).json({ error: "[BLOCKED] Onaylanmamış (Draft) teklifler dışa aktarılamaz. Lütfen önce onaylayın." });
            }

            const exportedTender = await this.tenderRepository.updateStatus(tenderId, 'Exported', tender.tenantId);
            
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

            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });

            const includeImages = req.query.includeImages === 'true';
            const positions = await this.positionRepository.findByTenderId(tenderId, { includeImages });
            const activities = await this.customerActivityRepo.getActivitiesByReference(tenderId);
            res.status(200).json({ tender, positions, activities });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // PDF üretimi için SADECE gerekli görselleri döndürür: verilen ürün id'lerinin
    // (bu ihaledeki ürünler) görsel URL'leri. Tüm ihale detayı / tüm alanlar
    // ÇEKİLMEZ — böylece PDF üretimi hızlanır. Kiracıya göre kısıtlıdır.
    async getPdfImages(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            if (!tenderId) return res.status(400).json({ error: "İhale ID zorunludur." });

            const tenantId = (req as any).user!.tenantId;
            const tender = await this.tenderRepository.findById(tenderId, tenantId);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });

            const ids = normalizeIdList(req.body?.ids);
            if (ids.length === 0) return res.status(200).json([]);

            const rows = await (prisma as any).article.findMany({
                where: { tenantId, id: { in: ids }, imageUrl: { not: null } },
                select: { id: true, imageUrl: true },
            });
            res.status(200).json(rows);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deletePosition(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const positionId = req.params.positionId as string;

            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            if (tender.status !== 'Draft') {
                return res.status(403).json({ error: "Sadece taslak tekliflerdeki satırlar silinebilir." });
            }

            const before = await this.positionRepository.findById(positionId);
            if (!before) return res.status(404).json({ error: "Satır bulunamadı." });
            if ((before as any).tenderId !== tenderId || (before as any).tenantId !== tender.tenantId) {
                return res.status(404).json({ error: "Satır bu teklife ait değil." });
            }
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
            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            const activities = await this.customerActivityRepo.getActivitiesByReference(tenderId);
            res.status(200).json(activities);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getLogs(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
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
