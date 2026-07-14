

import { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { ImportTenderUseCase } from '../../application/use-cases/tender/ImportTenderUseCase';
import { ImportSalesOrderCsvUseCase } from '../../application/use-cases/tender/ImportSalesOrderCsvUseCase';
import { CalculatePositionCostUseCase } from '../../application/use-cases/tender/CalculatePositionCostUseCase';
import { formatCustomerAddress } from '../../application/utils/customerAddress';
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

const clampPositionLogText = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    const text = String(value);
    const maxBytes = 60000;
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    return Buffer.from(text, 'utf8').subarray(0, maxBytes - 32).toString('utf8') + '\n...[log truncated]';
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

// ── Rich (HTML) mail messages ────────────────────────────────────────────────
// The offer-mail composer sends formatted HTML. Only the formatting tags the
// editor can produce survive; everything else (scripts, links, images, event
// handlers) is stripped before the message is embedded in the mail template.
const looksLikeHtmlMessage = (value: string) => /<([a-z][a-z0-9]*)\b[^>]*>/i.test(value);

const MAIL_HTML_ALLOWED_TAGS = /^(b|strong|i|em|u|s|strike|ul|ol|li|br|p|div|span|font|h2|h3)$/i;

const sanitizeMailHtml = (html: string): string =>
    html.replace(/<\s*(\/?)\s*([a-z][a-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (_m, closing, tag, attrs) => {
        if (!MAIL_HTML_ALLOWED_TAGS.test(tag)) return '';
        const lower = String(tag).toLowerCase();
        if (closing) return `</${lower}>`;
        let safeAttrs = '';
        if (lower === 'font') {
            const color = String(attrs).match(/\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
            const colorValue = color?.[1] ?? color?.[2] ?? color?.[3];
            if (colorValue && /^#?[a-z0-9(),.%\s-]+$/i.test(colorValue)) safeAttrs += ` color="${colorValue}"`;
            const size = String(attrs).match(/\bsize\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
            const sizeValue = size?.[1] ?? size?.[2] ?? size?.[3];
            if (sizeValue && /^[1-7]$/.test(sizeValue)) safeAttrs += ` size="${sizeValue}"`;
        }
        const style = String(attrs).match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const styleValue = style?.[1] ?? style?.[2];
        if (styleValue) {
            const kept = styleValue
                .split(';')
                .map((rule: string) => rule.trim())
                .filter((rule: string) => /^(color|font-size)\s*:\s*[a-z0-9#(),.%\s-]+$/i.test(rule))
                .join('; ');
            if (kept) safeAttrs += ` style="${kept}"`;
        }
        return `<${lower}${safeAttrs}>`;
    });

// Plain-text mirror of an HTML message, for the e-mail's text/plain part.
const stripHtmlToText = (html: string): string =>
    html
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/(p|div|li|ul|ol|h[1-6])\s*>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();

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
                addressName: true,
                address: true,
                postalCode: true,
                city: true,
                country: true,
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
        // Backward compatibility for clients that still send one POST per row:
        // run the same low-round-trip transaction used by the batch endpoint and
        // adapt its response back to the historical singular shape.
        if (!Array.isArray(req.body?.positions)) {
            const position = req.body;
            req.body = {
                positions: [{ clientId: `single-${nanoid(8)}`, position }],
            };
            (req as any).singlePositionResponse = true;
            return this.addPositionsBatch(req, res);
        }

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

            // Per-customer default discount: when the client sends no explicit discount
            // for a product line, fall back to the customer's saved discount for this article.
            let resolvedDiscount = safeRowType === 'PRODUCT' || safeRowType === 'CUSTOM'
                ? (discount !== undefined && discount !== null ? Number(discount || 0) : 0)
                : 0;
            if (safeRowType === 'PRODUCT' && sourceArticle && tender.customerId && (discount === undefined || discount === null)) {
                const customerDiscount = await (prisma as any).customerProductDiscount.findFirst({
                    where: { customerId: tender.customerId, articleId: sourceArticle.id },
                    select: { discount: true },
                });
                if (customerDiscount) resolvedDiscount = Number(customerDiscount.discount || 0);
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
            // Article-linked products do NOT copy the article's base64 image into the
            // position (that duplicated megabytes per row and made every save slow) —
            // the PDF resolves product images by sourceArticleId on demand. Only rows
            // without a source article keep an explicitly provided image.
            const resolvedImageUrl = canHaveImage
                ? (isProduct
                    ? (sourceArticle ? null : (imageUrl || null))
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
                        discount: resolvedDiscount,
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

            // Image-less response: the client never needs the base64 image back after
            // a save (PDF export fetches images separately, on demand).
            const created = await this.positionRepository.findById(newPosId);
            res.status(201).json({ message: "Satır eklendi.", positionId: newPosId, position: created });
        } catch (error: any) {
            if (error?.status === 400) {
                return res.status(400).json({ error: error.message });
            }
            console.error('[addPosition] error:', error);
            res.status(400).json({ error: "Satır eklenirken bir hata oluştu." });
        }
    }

    /**
     * Persists all locally staged TenderDetail rows in one transaction.
     *
     * The single-row endpoint deliberately locks the tender while deriving row
     * ordering. Calling it concurrently for every staged row therefore queues
     * those requests behind the same lock and repeats all validation/relation
     * queries. This endpoint validates shared data once and persists creates,
     * heterogeneous updates, totals, subtree deletes and audit logs atomically.
     */
    async addPositionsBatch(req: Request, res: Response) {
        const requestStartedAt = Date.now();
        try {
            const tenderId = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const rawEntries = req.body?.positions ?? [];
            const rawUpdates = req.body?.updates ?? [];
            const rawDeleteIds = req.body?.deleteIds ?? [];
            const rawMeta = req.body?.meta ?? {};

            if (
                !Array.isArray(rawEntries)
                || !Array.isArray(rawUpdates)
                || !Array.isArray(rawDeleteIds)
                || !rawMeta
                || typeof rawMeta !== 'object'
                || Array.isArray(rawMeta)
            ) {
                throw new TenderValidationError("Geçersiz toplu satır verisi gönderildi.");
            }
            if (
                rawEntries.length === 0
                && rawUpdates.length === 0
                && rawDeleteIds.length === 0
                && Object.keys(rawMeta).length === 0
            ) {
                throw new TenderValidationError("Kaydedilecek satır bulunamadı.");
            }
            if (rawEntries.length + rawUpdates.length + rawDeleteIds.length > 200) {
                throw new TenderValidationError("Tek seferde en fazla 200 satır kaydedilebilir.");
            }

            const seenClientIds = new Set<string>();
            const entries = rawEntries.map((entry: any) => {
                const clientId = String(entry?.clientId || '').trim();
                const position = entry?.position;
                if (!clientId || !position || typeof position !== 'object' || Array.isArray(position)) {
                    throw new TenderValidationError("Geçersiz satır verisi gönderildi.");
                }
                if (seenClientIds.has(clientId)) {
                    throw new TenderValidationError("Aynı geçici satır kimliği birden fazla kez gönderilemez.");
                }
                seenClientIds.add(clientId);
                validatePositionNumericFields(position);

                const normalizedRowType = String(position.rowType || 'SECTION').toUpperCase();
                const allowedRowTypes = new Set(['SECTION', 'TITLE', 'DESCRIPTION', 'PRODUCT', 'CUSTOM']);
                return {
                    clientId,
                    position,
                    safeRowType: allowedRowTypes.has(normalizedRowType) ? normalizedRowType : 'SECTION',
                    requestedParentPositionId: position.parentPositionId || null,
                };
            });

            const seenUpdateIds = new Set<string>();
            const updates = rawUpdates.map((entry: any) => {
                const positionId = String(entry?.positionId || '').trim();
                const patch = entry?.patch;
                if (!positionId || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
                    throw new TenderValidationError("Geçersiz satır güncellemesi gönderildi.");
                }
                if (seenUpdateIds.has(positionId)) {
                    throw new TenderValidationError("Aynı satır birden fazla kez güncellenemez.");
                }
                seenUpdateIds.add(positionId);
                validatePositionNumericFields(patch);
                return { positionId, input: patch };
            });

            const deleteIds = [...new Set<string>(
                rawDeleteIds.map((value: unknown) => String(value || '').trim()).filter(Boolean),
            )];
            if (deleteIds.length !== rawDeleteIds.length) {
                throw new TenderValidationError("Geçersiz veya yinelenen silme isteği gönderildi.");
            }
            if (deleteIds.some((positionId) => seenUpdateIds.has(positionId))) {
                throw new TenderValidationError("Bir satır aynı kayıtta hem güncellenip hem silinemez.");
            }

            const metaData: Record<string, any> = {};
            if (rawMeta.billingAddress !== undefined) metaData.billingAddress = rawMeta.billingAddress ? String(rawMeta.billingAddress) : null;
            if (rawMeta.installationAddress !== undefined) metaData.installationAddress = rawMeta.installationAddress ? String(rawMeta.installationAddress) : null;
            if (rawMeta.deliveryAddress !== undefined) metaData.deliveryAddress = rawMeta.deliveryAddress ? String(rawMeta.deliveryAddress) : null;
            if (rawMeta.commissionNumber !== undefined) metaData.commissionNumber = rawMeta.commissionNumber ? String(rawMeta.commissionNumber) : null;
            if (rawMeta.priceList !== undefined) metaData.priceList = rawMeta.priceList ? String(rawMeta.priceList) : null;
            if (rawMeta.currency !== undefined) {
                if (rawMeta.currency === null || rawMeta.currency === '') {
                    metaData.currency = null;
                } else {
                    const normalizedCurrency = String(rawMeta.currency).toUpperCase();
                    if (!['CHF', 'EUR', 'USD', 'GBP', 'TRY'].includes(normalizedCurrency)) {
                        throw new TenderValidationError("Geçersiz para birimi.");
                    }
                    metaData.currency = normalizedCurrency;
                }
            }
            if (rawMeta.directDiscount !== undefined) {
                const value = rawMeta.directDiscount === null || rawMeta.directDiscount === ''
                    ? 0
                    : Number(rawMeta.directDiscount);
                if (!Number.isFinite(value) || value < 0 || value > 100) {
                    throw new TenderValidationError("İndirim 0 ile 100 arasında olmalıdır.");
                }
                metaData.directDiscount = value;
            }
            if (rawMeta.billingSameAsInstallation !== undefined) {
                metaData.billingSameAsInstallation = Boolean(rawMeta.billingSameAsInstallation);
            }
            if (rawMeta.internalDeliveryDate !== undefined) {
                metaData.internalDeliveryDate = rawMeta.internalDeliveryDate ? new Date(rawMeta.internalDeliveryDate) : null;
            }
            if (rawMeta.validUntil !== undefined) {
                metaData.validUntil = rawMeta.validUntil ? new Date(rawMeta.validUntil) : null;
            }
            if (rawMeta.format !== undefined) {
                if (rawMeta.format !== 'SIA451' && rawMeta.format !== 'CRBX') {
                    throw new TenderValidationError("Format SIA451 veya CRBX olmalıdır.");
                }
                metaData.format = rawMeta.format;
            }
            const requestedCustomerId = rawMeta.customerId !== undefined
                ? (rawMeta.customerId ? String(rawMeta.customerId) : null)
                : undefined;

            const sourceArticleIds = [...new Set<string>(
                entries
                    .filter((entry) => entry.safeRowType === 'PRODUCT' && entry.position.sourceArticleId)
                    .map((entry) => String(entry.position.sourceArticleId)),
            )];
            const parentIds = [...new Set<string>(
                entries
                    .map((entry) => entry.requestedParentPositionId)
                    .filter((value): value is string => Boolean(value)),
            )];
            const affectedPositionIds = [...new Set<string>([
                ...updates.map((entry) => entry.positionId),
                ...deleteIds,
            ])];

            // All validation reads are independent. Fetch them in one DB round
            // instead of paying their network latency sequentially.
            const [tender, sourceArticles, parents, affectedPositions, hierarchyRows, metaCustomer] = await Promise.all([
                (prisma as any).tender.findFirst({
                    where: { id: tenderId, tenantId },
                    select: { id: true, tenantId: true, status: true, customerId: true, tenderNumber: true },
                }),
                sourceArticleIds.length > 0
                    ? (prisma as any).article.findMany({
                        where: { id: { in: sourceArticleIds }, tenantId },
                        select: {
                            id: true,
                            name: true,
                            description: true,
                            baseCost: true,
                            salePrice: true,
                            unit: true,
                        },
                    })
                    : Promise.resolve([]),
                parentIds.length > 0
                    ? (prisma as any).position.findMany({
                        where: { id: { in: parentIds }, tenderId, tenantId },
                        select: { id: true, positionNumber: true, hierarchyLevel: true },
                    })
                    : Promise.resolve([]),
                affectedPositionIds.length > 0
                    ? (prisma as any).position.findMany({
                        where: { id: { in: affectedPositionIds }, tenderId, tenantId },
                        select: {
                            id: true,
                            tenantId: true,
                            tenderId: true,
                            parentPositionId: true,
                            rowType: true,
                            sourceArticleId: true,
                            displayOrder: true,
                            npkCode: true,
                            positionNumber: true,
                            shortDescription: true,
                            longDescription: true,
                            quantity: true,
                            unit: true,
                            hierarchyLevel: true,
                            unitPrice: true,
                            discount: true,
                            taxRate: true,
                        },
                    })
                    : Promise.resolve([]),
                deleteIds.length > 0
                    ? (prisma as any).position.findMany({
                        where: { tenderId, tenantId },
                        select: { id: true, parentPositionId: true },
                    })
                    : Promise.resolve([]),
                requestedCustomerId
                    ? this.findCustomerForTenant(requestedCustomerId, tenantId)
                    : Promise.resolve(null),
            ]);

            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });
            if (tender.status !== 'Draft') {
                return res.status(403).json({ error: "Sadece taslak teklifler üzerinde satır değişikliği yapılabilir." });
            }
            if (affectedPositions.length !== affectedPositionIds.length) {
                return res.status(404).json({ error: "Güncellenecek veya silinecek satırlardan biri bulunamadı." });
            }
            if (requestedCustomerId && !metaCustomer) {
                return res.status(404).json({ error: "Müşteri bulunamadı." });
            }
            if (requestedCustomerId !== undefined) {
                metaData.customerId = requestedCustomerId;
            }

            const sourceArticleMap = new Map<string, any>(
                sourceArticles.map((article: any) => [article.id, article]),
            );
            const missingArticleId = sourceArticleIds.find((articleId) => !sourceArticleMap.has(articleId));
            if (missingArticleId) {
                return res.status(404).json({ error: "Stok ürünü bulunamadı." });
            }

            const parentMap = new Map<string, any>(parents.map((parent: any) => [parent.id, parent]));
            const missingParentId = parentIds.find((parentId) => !parentMap.has(parentId));
            if (missingParentId) {
                return res.status(404).json({ error: "Üst satır bulunamadı." });
            }

            const discountedArticleIds = tender.customerId
                ? [...new Set<string>(
                    entries
                        .filter((entry) =>
                            entry.safeRowType === 'PRODUCT'
                            && entry.position.sourceArticleId
                            && (entry.position.discount === undefined || entry.position.discount === null),
                        )
                        .map((entry) => String(entry.position.sourceArticleId)),
                )]
                : [];
            const customerDiscounts = discountedArticleIds.length > 0
                ? await (prisma as any).customerProductDiscount.findMany({
                    where: { customerId: tender.customerId, articleId: { in: discountedArticleIds } },
                    select: { articleId: true, discount: true },
                })
                : [];
            const customerDiscountMap = new Map<string, number>(
                customerDiscounts.map((item: any) => [item.articleId, Number(item.discount || 0)]),
            );

            const defaults: Record<string, string> = {
                SECTION: "Yeni bölüm",
                TITLE: "Başlık",
                DESCRIPTION: "Yeni satır",
                PRODUCT: "Ürün",
                CUSTOM: "Yeni satır",
            };

            const prepared = entries.map((entry) => {
                const { position, safeRowType } = entry;
                const sourceArticle = safeRowType === 'PRODUCT' && position.sourceArticleId
                    ? sourceArticleMap.get(String(position.sourceArticleId))
                    : null;
                const parent = entry.requestedParentPositionId
                    ? parentMap.get(entry.requestedParentPositionId)
                    : null;
                const isProduct = safeRowType === 'PRODUCT';
                const isPricedRow = isProduct || safeRowType === 'CUSTOM';
                const canHaveImage = isPricedRow || safeRowType === 'DESCRIPTION';
                const hasExplicitShortDescription = position.shortDescription !== undefined
                    && position.shortDescription !== null;
                const cleanedShortDescription = hasExplicitShortDescription
                    ? String(position.shortDescription).trim()
                    : '';
                const resolvedShortDescription = isProduct
                    ? (cleanedShortDescription || sourceArticle?.name || defaults.PRODUCT)
                    : (hasExplicitShortDescription ? cleanedShortDescription : defaults[safeRowType]);
                const resolvedLongDescription = isProduct
                    ? (position.longDescription !== undefined
                        ? (position.longDescription || null)
                        : (sourceArticle?.description || null))
                    : (position.longDescription !== undefined ? (position.longDescription || null) : null);
                const resolvedUnit = isPricedRow
                    ? (isProduct ? (sourceArticle?.unit || position.unit || null) : (position.unit || null))
                    : null;
                const resolvedUnitPrice = !isPricedRow
                    ? null
                    : (isProduct && sourceArticle
                        ? (position.unitPrice !== undefined && position.unitPrice !== null
                            ? Number(position.unitPrice)
                            : (Number(sourceArticle.salePrice || 0) > 0
                                ? Number(sourceArticle.salePrice || 0)
                                : Number(sourceArticle.baseCost || 0)))
                        : (position.unitPrice !== undefined
                            ? (position.unitPrice === null ? null : Number(position.unitPrice))
                            : null));
                const explicitDiscount = position.discount !== undefined && position.discount !== null;
                const resolvedDiscount = isPricedRow
                    ? (explicitDiscount
                        ? Number(position.discount || 0)
                        : (isProduct && sourceArticle
                            ? (customerDiscountMap.get(sourceArticle.id) ?? 0)
                            : 0))
                    : 0;
                const resolvedImageUrl = canHaveImage
                    ? (isProduct
                        ? (sourceArticle ? null : (position.imageUrl || null))
                        : (position.imageUrl !== undefined ? (position.imageUrl || null) : null))
                    : null;

                return {
                    clientId: entry.clientId,
                    parent,
                    requestedDisplayOrder: position.displayOrder,
                    requestedPositionNumber: position.positionNumber,
                    data: {
                        id: nanoid(10),
                        tenantId,
                        tenderId,
                        parentPositionId: parent?.id || null,
                        rowType: safeRowType,
                        sourceArticleId: isProduct ? (sourceArticle?.id || position.sourceArticleId || null) : null,
                        displayOrder: 0,
                        positionNumber: '',
                        shortDescription: resolvedShortDescription,
                        longDescription: resolvedLongDescription,
                        quantity: isPricedRow ? Number(position.quantity ?? (isProduct ? 1 : 0)) : 0,
                        unit: resolvedUnit,
                        npkCode: position.npkCode || null,
                        hierarchyLevel: parent ? Number(parent.hierarchyLevel || 0) + 1 : 0,
                        unitPrice: resolvedUnitPrice,
                        discount: resolvedDiscount,
                        taxRate: isPricedRow && position.taxRate !== undefined ? Number(position.taxRate || 0) : 0,
                        imageUrl: resolvedImageUrl,
                    },
                };
            });

            const affectedPositionMap = new Map<string, any>(
                affectedPositions.map((position: any) => [position.id, position]),
            );
            const updateLabels: Record<string, string> = {
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
            const priceFields = new Set(['quantity', 'unitPrice', 'discount', 'taxRate']);
            const preparedUpdates = updates.map(({ positionId, input }) => {
                const before = affectedPositionMap.get(positionId)!;
                const targetRowType = input.rowType !== undefined
                    ? String(input.rowType || '').toUpperCase()
                    : String(before.rowType || 'SECTION').toUpperCase();
                const allowedRowTypes = new Set(['SECTION', 'TITLE', 'DESCRIPTION', 'PRODUCT', 'CUSTOM']);
                if (!allowedRowTypes.has(targetRowType)) {
                    throw new TenderValidationError("Geçersiz satır tipi.");
                }
                const targetCanPrice = targetRowType === 'PRODUCT' || targetRowType === 'CUSTOM';
                const targetCanHaveImage = targetCanPrice || targetRowType === 'DESCRIPTION';
                const patch: Record<string, any> = {};

                if (input.shortDescription !== undefined) patch.shortDescription = String(input.shortDescription);
                if (input.longDescription !== undefined) patch.longDescription = input.longDescription || null;
                if (targetCanPrice) {
                    if (input.quantity !== undefined) patch.quantity = Number(input.quantity);
                    if (input.unit !== undefined) patch.unit = input.unit || null;
                    if (input.unitPrice !== undefined) patch.unitPrice = input.unitPrice === null ? null : Number(input.unitPrice);
                    if (input.discount !== undefined) patch.discount = input.discount === null ? null : Number(input.discount);
                    if (input.taxRate !== undefined) patch.taxRate = input.taxRate === null ? null : Number(input.taxRate);
                } else {
                    patch.quantity = 0;
                    patch.unit = null;
                    patch.unitPrice = null;
                    patch.discount = 0;
                    patch.taxRate = 0;
                }
                if (input.imageUrl !== undefined) patch.imageUrl = targetCanHaveImage ? (input.imageUrl || null) : null;
                if (input.rowType !== undefined && !targetCanHaveImage) patch.imageUrl = null;
                if (input.npkCode !== undefined) patch.npkCode = input.npkCode || null;
                if (input.rowType !== undefined) patch.rowType = targetRowType;
                if (input.sourceArticleId !== undefined || !targetCanPrice) {
                    patch.sourceArticleId = targetRowType === 'PRODUCT' ? (input.sourceArticleId || null) : null;
                }
                if (input.displayOrder !== undefined) patch.displayOrder = Number(input.displayOrder);
                if (Object.keys(patch).length === 0) {
                    throw new TenderValidationError("Güncellenecek satır alanı bulunamadı.");
                }

                const nextPosition = { ...before, ...patch };
                const logs = Object.keys(patch)
                    .filter((field) => field !== 'imageUrl')
                    .filter((field) => String(before[field] ?? '') !== String(nextPosition[field] ?? ''))
                    .map((field) => ({
                        tenantId,
                        tenderId,
                        positionId,
                        employeeId,
                        actionType: priceFields.has(field) ? 'POSITION_PRICE_UPDATED' : 'POSITION_UPDATED',
                        fieldName: field,
                        oldValue: clampPositionLogText(before[field]),
                        newValue: clampPositionLogText(nextPosition[field]),
                        description: clampPositionLogText(`${updateLabels[field] ?? field} değiştirildi: ${before[field] ?? 'boş'} -> ${nextPosition[field] ?? 'boş'}`),
                    }));
                if (patch.imageUrl !== undefined) {
                    logs.push({
                        tenantId,
                        tenderId,
                        positionId,
                        employeeId,
                        actionType: 'POSITION_UPDATED',
                        fieldName: 'imageUrl',
                        oldValue: null,
                        newValue: null,
                        description: patch.imageUrl ? 'Görsel güncellendi.' : 'Görsel kaldırıldı.',
                    });
                }

                const pricingChanged = targetCanPrice && (
                    input.quantity !== undefined
                    || input.unitPrice !== undefined
                    || input.discount !== undefined
                );
                const qty = Number(nextPosition.quantity ?? 0);
                const price = nextPosition.unitPrice == null ? null : Number(nextPosition.unitPrice);
                const discount = Number(nextPosition.discount ?? 0);
                const calculatedTotal = pricingChanged
                    ? (qty > 0 && price !== null ? qty * price * (1 - discount / 100) : 0)
                    : null;

                return { positionId, patch, nextPosition, logs, calculatedTotal };
            });

            const childrenByParent = new Map<string, string[]>();
            hierarchyRows.forEach((row: any) => {
                if (!row.parentPositionId) return;
                const children = childrenByParent.get(row.parentPositionId) ?? [];
                children.push(row.id);
                childrenByParent.set(row.parentPositionId, children);
            });
            const allDeleteIds = new Set<string>();
            const deleteQueue = [...deleteIds];
            while (deleteQueue.length > 0) {
                const current = deleteQueue.shift()!;
                if (allDeleteIds.has(current)) continue;
                allDeleteIds.add(current);
                deleteQueue.push(...(childrenByParent.get(current) ?? []));
            }
            if (preparedUpdates.some((entry) => allDeleteIds.has(entry.positionId))) {
                throw new TenderValidationError("Silinecek bir satır veya alt satırı aynı kayıtta güncellenemez.");
            }
            const deleteLogs = deleteIds.map((positionId) => {
                const before = affectedPositionMap.get(positionId)!;
                return {
                    tenantId,
                    tenderId,
                    positionId,
                    employeeId,
                    actionType: 'POSITION_DELETED',
                    fieldName: null,
                    oldValue: clampPositionLogText(before.shortDescription ?? positionId),
                    newValue: null,
                    description: clampPositionLogText(`${before.shortDescription ?? 'Satır'} silindi.`),
                };
            });

            const needsDerivedOrdering = prepared.some((item) =>
                item.requestedDisplayOrder === undefined || !item.requestedPositionNumber,
            );
            const customerChanged = requestedCustomerId !== undefined && requestedCustomerId !== tender.customerId;
            const metaTenderLogs = customerChanged
                ? [{
                    tenantId,
                    tenderId,
                    positionId: null,
                    employeeId,
                    actionType: 'TENDER_META_UPDATED',
                    fieldName: 'customerId',
                    oldValue: tender.customerId || null,
                    newValue: requestedCustomerId || null,
                    description: 'Teklif müşterisi güncellendi.',
                }]
                : [];
            const validationFinishedAt = Date.now();

            const applyWrites = async (tx: any) => {
                // TenderDetail supplies both ordering values. A lock is only
                // necessary for legacy callers that ask the server to derive them.
                if (needsDerivedOrdering) {
                    await tx.$queryRaw`SELECT id FROM Tender WHERE id = ${tenderId} FOR UPDATE`;
                }
                if (Object.keys(metaData).length > 0) {
                    // updateMany, not update: the response is built from metaData
                    // itself, and update would wrap the write in an implicit
                    // transaction plus a SELECT-back — 3 extra round-trips to a
                    // remote DB for a row nobody reads.
                    await tx.tender.updateMany({ where: { id: tenderId }, data: metaData });
                    if (metaData.customerId) {
                        await tx.offerScheduleSlot.updateMany({
                            where: { tenderId },
                            data: { customerId: metaData.customerId },
                        });
                    }
                    if (customerChanged && requestedCustomerId) {
                        await tx.customerActivity.create({
                            data: {
                                id: nanoid(),
                                customerId: requestedCustomerId,
                                employeeId,
                                activityType: 'TENDER_CUSTOMER_CHANGED',
                                description: `${tender.tenderNumber} numaralı taslak teklif bu müşteriye bağlandı.`,
                                referenceId: tenderId,
                                activityDate: new Date(),
                            },
                        });
                    }
                }
                const existingRows = needsDerivedOrdering
                    ? await tx.position.findMany({
                        where: { tenderId },
                        select: { parentPositionId: true, displayOrder: true },
                    })
                    : [];
                const siblingStats = new Map<string, { count: number; maxOrder: number }>();
                existingRows.forEach((row: any) => {
                    const key = row.parentPositionId || '';
                    const current = siblingStats.get(key) ?? { count: 0, maxOrder: 0 };
                    current.count += 1;
                    current.maxOrder = Math.max(current.maxOrder, Number(row.displayOrder || 0));
                    siblingStats.set(key, current);
                });

                prepared.forEach((item) => {
                    const key = item.data.parentPositionId || '';
                    const stats = siblingStats.get(key) ?? { count: 0, maxOrder: 0 };
                    item.data.displayOrder = item.requestedDisplayOrder !== undefined
                        ? Number(item.requestedDisplayOrder) || 0
                        : stats.maxOrder + 1000;
                    item.data.positionNumber = item.requestedPositionNumber
                        ? String(item.requestedPositionNumber)
                        : (item.parent
                            ? `${item.parent.positionNumber}.${stats.count + 1}`
                            : String((stats.count + 1) * 100));
                    stats.count += 1;
                    stats.maxOrder = Math.max(stats.maxOrder, item.data.displayOrder);
                    siblingStats.set(key, stats);
                });

                if (prepared.length > 0) {
                    await tx.position.createMany({ data: prepared.map((item) => item.data) });
                }

                if (preparedUpdates.length > 0) {
                    // Heterogeneous patches are written with one parameterized CASE
                    // update instead of one Prisma round-trip per position.
                    const mutableFields = [
                        'shortDescription', 'longDescription', 'quantity', 'unit',
                        'unitPrice', 'discount', 'taxRate', 'imageUrl', 'npkCode',
                        'rowType', 'sourceArticleId', 'displayOrder',
                    ];
                    const parameters: any[] = [];
                    const assignments = mutableFields.flatMap((field) => {
                        const matching = preparedUpdates.filter((entry) =>
                            Object.prototype.hasOwnProperty.call(entry.patch, field),
                        );
                        if (matching.length === 0) return [];
                        const cases = matching.map((entry) => {
                            parameters.push(entry.positionId, entry.patch[field]);
                            return 'WHEN ? THEN ?';
                        }).join(' ');
                        return [`\`${field}\` = CASE \`id\` ${cases} ELSE \`${field}\` END`];
                    });
                    const updateIds = preparedUpdates.map((entry) => entry.positionId);
                    parameters.push(tenantId, tenderId, ...updateIds);
                    await tx.$executeRawUnsafe(
                        `UPDATE \`Position\` SET ${assignments.join(', ')} WHERE \`tenantId\` = ? AND \`tenderId\` = ? AND \`id\` IN (${updateIds.map(() => '?').join(', ')})`,
                        ...parameters,
                    );

                    const calculationUpdates = preparedUpdates.filter((entry) => entry.calculatedTotal !== null);
                    if (calculationUpdates.length > 0) {
                        const valuesSql = calculationUpdates.map(() => '(?, ?, 0, 0, 0, 0, 0, 0, ?)').join(', ');
                        const calculationParameters = calculationUpdates.flatMap((entry) => [
                            nanoid(10),
                            entry.positionId,
                            entry.calculatedTotal,
                        ]);
                        await tx.$executeRawUnsafe(
                            `INSERT INTO \`CalculationItem\` (\`id\`, \`positionId\`, \`materialCost\`, \`laborCost\`, \`overheadCost\`, \`riskAmount\`, \`additionalCost\`, \`profitMargin\`, \`totalCalculatedPrice\`) VALUES ${valuesSql} ON DUPLICATE KEY UPDATE \`totalCalculatedPrice\` = VALUES(\`totalCalculatedPrice\`)`,
                            ...calculationParameters,
                        );
                    }
                }

                const allDeleteIdList = [...allDeleteIds];
                if (allDeleteIdList.length > 0) {
                    await tx.positionArticleMapping.deleteMany({ where: { positionId: { in: allDeleteIdList } } });
                    await tx.positionMaterialMapping.deleteMany({ where: { positionId: { in: allDeleteIdList } } });
                    await tx.calculationItem.deleteMany({ where: { positionId: { in: allDeleteIdList } } });
                    const deleted = await tx.position.deleteMany({ where: { id: { in: allDeleteIdList }, tenderId, tenantId } });
                    if (deleted.count !== allDeleteIdList.length) {
                        throw new TenderValidationError("Bazı satırlar başka bir işlemde silindi; sayfayı yenileyip tekrar deneyin.");
                    }
                }
            };

            // The DB is remote, so each statement costs a full network
            // round-trip. When the unit of work boils down to a single
            // statement (meta-only save, or edits folded into the one CASE
            // update) it is already atomic on its own — skip the transaction
            // wrapper instead of paying BEGIN/COMMIT round-trips around it.
            const hasCalculationUpdate = preparedUpdates.some((entry) => entry.calculatedTotal !== null);
            const writeStatementCount =
                (Object.keys(metaData).length > 0
                    ? 1 + (metaData.customerId ? 1 : 0) + (customerChanged && requestedCustomerId ? 1 : 0)
                    : 0)
                + (prepared.length > 0 ? 1 : 0)
                + (preparedUpdates.length > 0 ? (hasCalculationUpdate ? 2 : 1) : 0)
                + (allDeleteIds.size > 0 ? 4 : 0);
            if (needsDerivedOrdering || writeStatementCount > 1) {
                await (prisma as any).$transaction(applyWrites, { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 15000 });
            } else {
                await applyWrites(prisma);
            }
            const writeFinishedAt = Date.now();

            // Activity logs are informational: write them after the unit of
            // work commits, off the response's critical path. A failed log
            // write must not fail (or slow down) an otherwise successful save.
            const activityLogs = [
                ...prepared.map((item) => ({
                    id: nanoid(12),
                    tenantId,
                    tenderId,
                    positionId: item.data.id,
                    mappingId: null,
                    articleId: null,
                    employeeId,
                    actionType: 'POSITION_CREATED',
                    fieldName: null,
                    oldValue: null,
                    newValue: item.data.shortDescription,
                    description: `${item.data.rowType === 'PRODUCT' ? 'Ürün' : 'Satır'} eklendi: ${item.data.shortDescription}`,
                })),
                ...preparedUpdates.flatMap((entry) => entry.logs).map((log) => ({
                    id: nanoid(12),
                    mappingId: null,
                    articleId: null,
                    ...log,
                })),
                ...deleteLogs.map((log) => ({
                    id: nanoid(12),
                    mappingId: null,
                    articleId: null,
                    ...log,
                })),
                ...metaTenderLogs.map((log) => ({
                    id: nanoid(12),
                    mappingId: null,
                    articleId: null,
                    ...log,
                })),
            ];
            if (activityLogs.length > 0) {
                void (prisma as any).tenderActivityLog.createMany({ data: activityLogs })
                    .catch((logError: unknown) => console.error('[addPositionsBatch] activity log write failed:', logError));
            }
            res.setHeader(
                'Server-Timing',
                `validation;dur=${validationFinishedAt - requestStartedAt}, db-write;dur=${writeFinishedAt - validationFinishedAt}, total;dur=${writeFinishedAt - requestStartedAt}`,
            );

            const createdPositions = prepared.map((item) => ({
                clientId: item.clientId,
                positionId: item.data.id,
                position: {
                    id: item.data.id,
                    tenantId: item.data.tenantId,
                    tenderId: item.data.tenderId,
                    parentPositionId: item.data.parentPositionId,
                    rowType: item.data.rowType,
                    sourceArticleId: item.data.sourceArticleId,
                    displayOrder: item.data.displayOrder,
                    npkCode: item.data.npkCode,
                    positionNumber: item.data.positionNumber,
                    shortDescription: item.data.shortDescription,
                    longDescription: item.data.longDescription,
                    quantity: item.data.quantity,
                    unit: item.data.unit,
                    hierarchyLevel: item.data.hierarchyLevel,
                    unitPrice: item.data.unitPrice,
                    discount: item.data.discount,
                    taxRate: item.data.taxRate,
                    calculation: null,
                    articleMappings: [],
                    materialMappings: [],
                },
            }));
            const updatedPositions = preparedUpdates.map((entry) => {
                const position = { ...entry.nextPosition };
                delete position.imageUrl;
                return position;
            });
            const updatedTender = Object.keys(metaData).length > 0
                ? {
                    id: tenderId,
                    ...metaData,
                    ...(requestedCustomerId !== undefined
                        ? {
                            customerName: metaCustomer?.companyName ?? null,
                            customerAddress: formatCustomerAddress(metaCustomer),
                            customerEmail: metaCustomer?.mainEmail ?? null,
                            customerPhone: metaCustomer?.mainPhone ?? null,
                            customerTaxNumber: metaCustomer?.taxNumber ?? null,
                        }
                        : {}),
                }
                : null;

            if ((req as any).singlePositionResponse) {
                const created = createdPositions[0]!;
                return res.status(201).json({
                    message: "Satır eklendi.",
                    positionId: created.positionId,
                    position: created.position,
                });
            }
            if ((req as any).singleUpdateResponse) {
                return res.status(200).json(updatedPositions[0]);
            }
            if ((req as any).singleDeleteResponse) {
                return res.status(200).json({ message: "Satır silindi." });
            }

            res.status(prepared.length > 0 ? 201 : 200).json({
                message: `${prepared.length} satır eklendi, ${preparedUpdates.length} satır güncellendi, ${deleteIds.length} satır silindi.`,
                positions: createdPositions,
                updatedPositions,
                deletedPositionIds: deleteIds,
                updatedTender,
            });
        } catch (error: any) {
            if (error?.status === 400) {
                return res.status(400).json({ error: error.message });
            }
            console.error('[addPositionsBatch] error:', error);
            res.status(400).json({ error: "Satırlar eklenirken bir hata oluştu." });
        }
    }

    async updateMeta(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const { customerId, format, validUntil, billingAddress, installationAddress, deliveryAddress, billingSameAsInstallation, internalDeliveryDate, commissionNumber, priceList, currency, directDiscount } = req.body;

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
            if (installationAddress !== undefined) {
                data.installationAddress = installationAddress ? String(installationAddress) : null;
            }
            if (deliveryAddress !== undefined) {
                data.deliveryAddress = deliveryAddress ? String(deliveryAddress) : null;
            }
            if (commissionNumber !== undefined) {
                data.commissionNumber = commissionNumber ? String(commissionNumber) : null;
            }
            if (priceList !== undefined) {
                data.priceList = priceList ? String(priceList) : null;
            }
            if (currency !== undefined) {
                if (currency === null || currency === "") {
                    data.currency = null;
                } else {
                    const allowedCurrencies = ["CHF", "EUR", "USD", "GBP", "TRY"];
                    const normalizedCurrency = String(currency).toUpperCase();
                    if (!allowedCurrencies.includes(normalizedCurrency)) {
                        return res.status(400).json({ error: "Geçersiz para birimi." });
                    }
                    data.currency = normalizedCurrency;
                }
            }
            if (directDiscount !== undefined) {
                const parsedDirectDiscount = directDiscount === null || directDiscount === '' ? 0 : Number(directDiscount);
                if (!Number.isFinite(parsedDirectDiscount) || parsedDirectDiscount < 0 || parsedDirectDiscount > 100) {
                    return res.status(400).json({ error: "İndirim 0 ile 100 arasında olmalıdır." });
                }
                data.directDiscount = parsedDirectDiscount;
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
        if (!Array.isArray(req.body?.updates)) {
            const patch = req.body;
            req.body = {
                positions: [],
                updates: [{ positionId: req.params.positionId as string, patch }],
                deleteIds: [],
            };
            (req as any).singleUpdateResponse = true;
            return this.addPositionsBatch(req, res);
        }

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

            // One narrow lookup replaces the former tender query plus the full
            // position-detail query (calculation and mapping collections included).
            const before = await (prisma as any).position.findFirst({
                where: {
                    id: positionId,
                    tenderId,
                    tenantId,
                    tender: { is: { status: 'Draft' } },
                },
                select: {
                    id: true,
                    tenantId: true,
                    tenderId: true,
                    rowType: true,
                    shortDescription: true,
                    longDescription: true,
                    quantity: true,
                    unit: true,
                    unitPrice: true,
                    discount: true,
                    taxRate: true,
                    npkCode: true,
                    sourceArticleId: true,
                    displayOrder: true,
                },
            });
            if (!before) {
                // Keep the common Draft path to one query. Only the exceptional
                // not-found/non-Draft path pays for this status distinction.
                const existing = await (prisma as any).position.findFirst({
                    where: { id: positionId, tenderId, tenantId },
                    select: { id: true, tender: { select: { status: true } } },
                });
                if (existing?.tender.status !== undefined && existing.tender.status !== 'Draft') {
                    return res.status(403).json({ error: "Sadece taslak tekliflerdeki satırlar güncellenebilir." });
                }
                return res.status(404).json({ error: "Satır veya ihale bulunamadı." });
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
            const nextPosition = { ...before, ...patch };
            // imageUrl is excluded from the value diff: it is a LONGTEXT base64
            // blob and `before` is intentionally image-less. It gets a value-less log.
            const changedLogs = Object.keys(patch)
                .filter((field) => field !== 'imageUrl')
                .filter((field) => String((before as any)[field] ?? '') !== String((nextPosition as any)[field] ?? ''))
                .map((field) => ({
                    tenantId,
                    tenderId,
                    positionId,
                    employeeId,
                    actionType: priceFields.includes(field) ? "POSITION_PRICE_UPDATED" : "POSITION_UPDATED",
                    fieldName: field,
                    oldValue: (before as any)[field] == null ? null : String((before as any)[field]),
                    newValue: (nextPosition as any)[field] == null ? null : String((nextPosition as any)[field]),
                    description: `${labels[field] ?? field} değiştirildi: ${(before as any)[field] ?? 'boş'} -> ${(nextPosition as any)[field] ?? 'boş'}`
                }));
            if (patch.imageUrl !== undefined) {
                changedLogs.push({
                    tenantId,
                    tenderId,
                    positionId,
                    employeeId,
                    actionType: "POSITION_UPDATED",
                    fieldName: "imageUrl",
                    oldValue: null,
                    newValue: null,
                    description: patch.imageUrl ? "Görsel güncellendi." : "Görsel kaldırıldı."
                });
            }

            // Validation is complete, so the position update, audit insert and
            // optional calculation upsert can share the second DB round.
            const writes: Promise<any>[] = [
                this.positionRepository.updatePosition(positionId, patch),
                this.tenderLogRepo.createMany(changedLogs),
            ];

            // When manual pricing is set, sync totalCalculatedPrice without
            // overwriting the existing cost breakdown.
            const pricingChanged = targetCanPrice && (
                quantity !== undefined ||
                unitPrice !== undefined ||
                discount !== undefined
            );

            if (pricingChanged) {
                const qty = Number(nextPosition.quantity ?? 0);
                const price = nextPosition.unitPrice == null ? null : Number(nextPosition.unitPrice);
                const disc = Number(nextPosition.discount ?? 0);
                if (qty > 0 && price != null) {
                    const gross = qty * price;
                    const net = gross * (1 - disc / 100);
                    // One UPSERT replaces getCalculation + saveCalculation's own
                    // existence read + update/create (three sequential queries).
                    writes.push((prisma as any).calculationItem.upsert({
                        where: { positionId },
                        update: { totalCalculatedPrice: net },
                        create: {
                            id: nanoid(10),
                            positionId,
                            materialCost: 0,
                            laborCost: 0,
                            overheadCost: 0,
                            riskAmount: 0,
                            additionalCost: 0,
                            profitMargin: 0,
                            totalCalculatedPrice: net,
                        },
                    }));
                }
            }

            const [updated] = await Promise.all(writes);

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

    // ── Tenant-wide offer-mail drafts ────────────────────────────────────────
    // Reusable subject + message templates shared by ALL tenders' mail composers.

    async listMailDrafts(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const drafts = await (prisma as any).tenderMailDraft.findMany({
                where: { tenantId },
                orderBy: { updatedAt: 'desc' },
            });
            res.status(200).json(drafts);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createMailDraft(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const { subject, message } = req.body;
            const draft = await (prisma as any).tenderMailDraft.create({
                data: {
                    id: nanoid(10),
                    tenantId,
                    subject: String(subject ?? '').slice(0, 191),
                    message: message ? String(message) : null,
                    createdBy: (req as any).user!.id || null,
                },
            });
            res.status(201).json(draft);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateMailDraft(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const draftId = req.params.draftId as string;
            const existing = await (prisma as any).tenderMailDraft.findFirst({
                where: { id: draftId, tenantId },
                select: { id: true },
            });
            if (!existing) return res.status(404).json({ error: "Taslak bulunamadı." });

            const { subject, message } = req.body;
            const data: any = {};
            if (subject !== undefined) data.subject = String(subject ?? '').slice(0, 191);
            if (message !== undefined) data.message = message ? String(message) : null;
            if (Object.keys(data).length === 0) {
                return res.status(400).json({ error: "Güncellenecek alan bulunamadı." });
            }
            const draft = await (prisma as any).tenderMailDraft.update({
                where: { id: draftId },
                data,
            });
            res.status(200).json(draft);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteMailDraft(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const draftId = req.params.draftId as string;
            const existing = await (prisma as any).tenderMailDraft.findFirst({
                where: { id: draftId, tenantId },
                select: { id: true },
            });
            if (!existing) return res.status(404).json({ error: "Taslak bulunamadı." });
            await (prisma as any).tenderMailDraft.delete({ where: { id: draftId } });
            res.status(200).json({ message: "Taslak silindi.", draftId });
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
            const isHtmlMessage = looksLikeHtmlMessage(message);
            // HTML markup inflates the raw length; the cap guards payload size, not
            // visible text, so it scales with the format.
            if (message.length > (isHtmlMessage ? 20000 : 5000)) {
                return res.status(400).json({ error: "Mesaj çok uzun." });
            }
            const messageHtml = isHtmlMessage
                ? sanitizeMailHtml(message)
                : `${escapeHtml(message).replace(/\n/g, "<br />")}`;
            const messageText = isHtmlMessage ? stripHtmlToText(message) : message;

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
                    <p>${messageHtml}</p>
                    ${scheduleHtml}
                </div>
            `;

            const result = await smtp.send(settings || {}, {
                fromEmail,
                fromName,
                to,
                subject,
                text: slots.length > 0 ? `${messageText}\n\nPlanlanan tarih ve saatler:\n${scheduleText}` : messageText,
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

            const includeImages = req.query.includeImages === 'true';
            // light=true: plain position figures only (no mappings, long descriptions
            // or activities) — used by read-only summaries like the project positions tab.
            const light = req.query.light === 'true';

            // The three queries are independent; run them concurrently and only check
            // the access result before responding, instead of paying for them in series.
            const [tender, positions, activities] = await Promise.all([
                this.getAccessibleTender(tenderId, (req as any).user!),
                this.positionRepository.findByTenderId(tenderId, { includeImages, light }),
                light ? Promise.resolve([]) : this.customerActivityRepo.getActivitiesByReference(tenderId),
            ]);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });

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
            const positionIds = normalizeIdList(req.body?.positionIds);
            if (ids.length === 0 && positionIds.length === 0) return res.status(200).json([]);

            // Article images (product rows) + per-position uploaded images (manual
            // products / description rows) — both only ever fetched here, for the PDF.
            const [articleRows, positionRows] = await Promise.all([
                ids.length > 0
                    ? (prisma as any).article.findMany({
                        where: { tenantId, id: { in: ids }, imageUrl: { not: null } },
                        select: { id: true, imageUrl: true },
                    })
                    : [],
                positionIds.length > 0
                    ? (prisma as any).position.findMany({
                        where: { tenantId, tenderId, id: { in: positionIds }, imageUrl: { not: null } },
                        select: { id: true, imageUrl: true },
                    })
                    : [],
            ]);
            res.status(200).json([...articleRows, ...positionRows]);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deletePosition(req: Request, res: Response) {
        if (!Array.isArray(req.body?.deleteIds)) {
            req.body = {
                positions: [],
                updates: [],
                deleteIds: [req.params.positionId as string],
            };
            (req as any).singleDeleteResponse = true;
            return this.addPositionsBatch(req, res);
        }

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
