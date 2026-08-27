

import { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';
import { ImportTenderUseCase } from '../../application/use-cases/tender/ImportTenderUseCase';
import { ImportSalesOrderCsvUseCase } from '../../application/use-cases/tender/ImportSalesOrderCsvUseCase';
import { CalculatePositionCostUseCase } from '../../application/use-cases/tender/CalculatePositionCostUseCase';
import { formatCustomerAddress } from '../../application/utils/customerAddress';
import { normalizePaymentStages, serializePaymentStages, stripStageDates, validatePaymentStages } from '../../application/utils/paymentSchedule';
import { ITenderRepository } from '../../domain/repositories/ITenderRepository';
import { IPositionRepository } from '../../domain/repositories/IPositionRepository';
import { ICustomerActivityRepository } from '../../domain/repositories/ICustomerActivityRepository';
import { TenderActivityLogRepository } from '../../infrastructure/repositories/TenderActivityLogRepository';
import prisma from '../../infrastructure/database/prisma.client';
import { SmtpMailService } from '../../infrastructure/services/SmtpMailService';
import { dispatchMail } from '../../infrastructure/services/outlook/MailDispatchService';
import { getArticleThumbnails, getPositionThumbnails } from '../../infrastructure/services/PdfImageThumbnailService';
import { buildSignatureParts } from '../../infrastructure/services/mailSignature';
import { findTechnicianScheduleConflict, validateTechnicians, listTechnicianOptions } from './technicianSchedule';
import { MAX_TOTAL_DISCOUNTS, normalizeDiscountList, resolveLineDiscount } from './tender.discounts';
import { findTenantRootIdCached } from '../../shared/tenantTree';
import { withdrawOspOfferStatus } from '../../infrastructure/services/OspClient';
import { nextDocumentNumber } from '../../shared/documentNumber';
import { tenderDocumentStorageService } from '../../infrastructure/services/TenderDocumentStorageService';

// Versand läuft über dispatchMail: verbundenes Outlook-Postfach des Benutzers,
// sonst SMTP des Mandanten; jede Kundenmail landet zudem als MailMessage in der
// Kundenkommunikation (siehe outlook/MailDispatchService.ts).
void SmtpMailService;

// Prisma şeması Position'ın bağımlı tablolarını (CalculationItem, article/
// material mapping) onDelete: Cascade ilan ediyor; bu bayrak canlı FK'ların
// gerçekten cascade edip etmediğini İLK FK hatasında bir kez öğrenir. Cascade
// dünyasında satır silme tek ifadedir; değilse alt tablolar önce elle silinir.
let positionChildRowsNeedManualCleanup = false;

const isForeignKeyConstraintError = (error: unknown): boolean => {
    const seen = new Set<unknown>();
    let current: any = error;
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        const code = current.errno ?? current.code ?? current.meta?.code;
        if (code === 1451 || code === '1451' || code === 'ER_ROW_IS_REFERENCED_2') return true;
        if (/foreign key constraint/i.test(String(current.message || ''))) return true;
        current = current.cause ?? current.meta?.cause ?? null;
    }
    return false;
};

const normalizeIdList = (value: unknown) =>
    Array.isArray(value)
        ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
        : [];

const isSourceSalesOrder = (value: unknown) => {
    const normalized = String(value || '')
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    return [
        'verkaufsauftrag',
        'sales_order',
        'sale_order',
        'sales order',
        'sale order',
        'sipariste',
        'siparis',
        'auftrag',
    ].includes(normalized);
};

// Validation error whose message is safe to show the user. Carries status 400 so
// controller catch blocks can distinguish it from unexpected/internal errors and
// avoid leaking raw Prisma messages.
/**
 * Normalises the offer's closing images into the JSON string held by the
 * `closingImages` column. Accepts either an array (from the panel) or an
 * already-serialised string, and enforces the size caps: a data URI is roughly
 * 4/3 the size of the file it encodes, so 6 MB of image is ~8 MB of text.
 */
const normalizeClosingImages = (raw: unknown): string | null => {
    let list: string[] = [];
    if (Array.isArray(raw)) {
        list = raw.map((item) => String(item)).filter(Boolean);
    } else if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) list = parsed.map((item) => String(item)).filter(Boolean);
        } catch {
            if (raw.startsWith('data:')) list = [raw];
        }
    }
    if (list.length === 0) return null;

    const MAX_PER_IMAGE = 7_000_000;   // ~5 MB binary, base64-encoded
    const MAX_TOTAL = 35_000_000;
    if (list.some((image) => image.length > MAX_PER_IMAGE)) {
        throw new TenderValidationError("Görsel çok büyük (maks. 5 MB).");
    }
    if (list.reduce((sum, image) => sum + image.length, 0) > MAX_TOTAL) {
        throw new TenderValidationError("Görsellerin toplam boyutu çok büyük.");
    }
    return JSON.stringify(list);
};

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

// En fazla kaç CC adresi saklanır (satın alma siparişi mailindeki sınırın aynısı).
const MAX_TENDER_CC = 10;

/**
 * Teklifin CC listesi — takvimdeki `sanitizeCcEmails`in sertleştirilmiş hâli:
 * başlık enjeksiyonuna karşı CR/LF kırpılır, biçim doğrulanır, tekrarlar
 * (büyük/küçük harf duyarsız) atılır ve liste 10 adresle sınırlanır.
 */
const sanitizeTenderCcEmails = (raw: unknown): string[] => {
    const values = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const email = stripHeaderValue(String(value ?? ""));
        if (!email || !isValidEmail(email)) continue;
        const key = email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(email);
        if (out.length >= MAX_TENDER_CC) break;
    }
    return out;
};

/**
 * Kayıtlı CC listesini gönderime hazırlar: ALICININ KENDİSİ elenir (aynı adrese
 * iki kopya gitmesin) ve liste yine 10 adresle sınırlıdır.
 */
const tenderCcForSend = (raw: unknown, to: string): string[] => {
    const recipient = String(to || "").trim().toLowerCase();
    return sanitizeTenderCcEmails(raw).filter((email) => email.toLowerCase() !== recipient);
};
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

    // Şirket ağacı paylaşılan önbellekten yürünür (bkz. shared/tenantTree);
    // eskiden her seviye ayrı bir uzak sorgu turuydu.
    private async tenantRootId(tenantId: string): Promise<string | null> {
        return findTenantRootIdCached(tenantId);
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

        // Yeni kod ya da yeniden numaralandırmadan önceki kod ile çözümlenir.
        const byNumber = await (prisma as any).tender.findMany({
            where: { OR: [{ tenderNumber: tenderRef }, { legacyNumber: tenderRef }] },
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
    private async getAccessibleTender(
        tenderId: string,
        user: { tenantId: string },
        options?: { deferOrderPdfContent?: boolean; omitPdfContent?: boolean }
    ) {
        const raw = String(tenderId || '').trim();
        if (!raw) return null;

        // Detail requests explicitly defer PDF-only LONGTEXT fields. Apply that
        // to drafts as well as orders; the PDF tab already loads them lazily.
        const includePdfContent = !options?.omitPdfContent && !options?.deferOrderPdfContent;
        const direct = await this.tenderRepository.findById(raw, user.tenantId, { includePdfContent });
        if (direct) return direct;

        // Parent/child tenant access is the uncommon compatibility path. Only
        // it needs a separate owner lookup and tenant-tree check.
        const light = await (prisma as any).tender.findUnique({
            where: { id: raw },
            select: { tenantId: true }
        });
        if (!light) return null;
        if (!await this.canAccessTenant(light.tenantId, user.tenantId)) return null;
        return this.tenderRepository.findById(raw, light.tenantId, { includePdfContent });
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
                addressSupplement: true,
                postalCode: true,
                city: true,
                state: true,
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
            // Kolon bazlı filtreler + sıralama (Ürünler listesindeki desenle aynı).
            if (req.query.tenderNumber) filter.tenderNumber = req.query.tenderNumber as string;
            if (req.query.customerName) filter.customerName = req.query.customerName as string;
            if (req.query.creatorName) filter.creatorName = req.query.creatorName as string;
            if (req.query.orderState === 'draft' || req.query.orderState === 'order') filter.orderState = req.query.orderState;
            if (req.query.mailSent === 'yes' || req.query.mailSent === 'no') filter.mailSent = req.query.mailSent;
            if (req.query.sortBy) filter.sortBy = req.query.sortBy as 'tenderNumber' | 'customerName' | 'status' | 'createdAt';
            if (req.query.sortDirection) filter.sortDirection = req.query.sortDirection === 'asc' ? 'asc' : 'desc';
            if (req.query.page) filter.page = Math.max(1, Number(req.query.page) || 1);
            if (req.query.pageSize) filter.pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));
            // `fields=list` → yalnızca liste tablosunun kolonları döner. Bilinmeyen
            // değerler tam gövdeye düşer, eski çağıranlar etkilenmez.
            if (req.query.fields === 'list') filter.fields = 'list';

            const tenders = await this.tenderRepository.findAll(filter);
            res.status(200).json(tenders);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createManual(req: Request, res: Response) {
        try {
            const { customerId, format, validUntil } = req.body;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;

            // Teklif kodu artık YALNIZCA sunucuda üretilir (AN-2026-10001). Gövdede
            // `tenderNumber` gelse bile yok sayılır — eskiden frontend rastgele
            // bir numara (A-2026-4474) üretip gönderiyordu.
            if (!format) {
                return res.status(400).json({ error: "Format zorunludur." });
            }
            if (format !== 'SIA451' && format !== 'CRBX') {
                return res.status(400).json({ error: "Format SIA451 veya CRBX olmalıdır." });
            }
            if (customerId) {
                const customer = await this.findCustomerForTenant(customerId, tenantId);
                if (!customer) return res.status(404).json({ error: "Müşteri bulunamadı." });
            }

            const tenderNumber = await nextDocumentNumber(tenantId, 'QUOTE');

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
            // Von Hand erfasster Kunde (05.09.2026): Name / E-Mail / Adresse
            // gelten NUR für diese Offerte und gehen NIE in den Kundenstamm.
            // Ohne CRM-Kunden tragen sie die Offerte allein; mit CRM-Kunden sind
            // sie die hier geltende Abweichung (siehe TenderRepository).
            if (rawMeta.manualCustomerName !== undefined) metaData.manualCustomerName = rawMeta.manualCustomerName ? String(rawMeta.manualCustomerName).trim().slice(0, 190) : null;
            if (rawMeta.manualCustomerEmail !== undefined) metaData.manualCustomerEmail = rawMeta.manualCustomerEmail ? String(rawMeta.manualCustomerEmail).trim().slice(0, 190) : null;
            if (rawMeta.manualCustomerAddress !== undefined) metaData.manualCustomerAddress = rawMeta.manualCustomerAddress ? String(rawMeta.manualCustomerAddress) : null;
            if (rawMeta.customerReference !== undefined) metaData.customerReference = rawMeta.customerReference ? String(rawMeta.customerReference) : null;
            if (rawMeta.priceList !== undefined) metaData.priceList = rawMeta.priceList ? String(rawMeta.priceList) : null;
            // CC-Empfänger der Offerte (Speichern-Knopf läuft über DIESEN Endpunkt).
            if (rawMeta.ccEmails !== undefined) metaData.ccEmails = sanitizeTenderCcEmails(rawMeta.ccEmails);
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
            if (rawMeta.directDiscountLabel !== undefined) {
                const label = rawMeta.directDiscountLabel === null ? '' : String(rawMeta.directDiscountLabel).trim();
                if (label.length > 80) {
                    throw new TenderValidationError("İndirim adı en fazla 80 karakter olabilir.");
                }
                metaData.directDiscountLabel = label || null;
            }
            if (rawMeta.extraDiscount !== undefined) {
                const value = rawMeta.extraDiscount === null || rawMeta.extraDiscount === ''
                    ? 0
                    : Number(rawMeta.extraDiscount);
                if (!Number.isFinite(value) || value < 0 || value > 100) {
                    throw new TenderValidationError("İndirim 0 ile 100 arasında olmalıdır.");
                }
                metaData.extraDiscount = value;
            }
            if (rawMeta.extraDiscountLabel !== undefined) {
                const label = rawMeta.extraDiscountLabel === null ? '' : String(rawMeta.extraDiscountLabel).trim();
                if (label.length > 80) {
                    throw new TenderValidationError("İndirim adı en fazla 80 karakter olabilir.");
                }
                metaData.extraDiscountLabel = label || null;
            }
            // Belge düzeyi iskonto yığını. Liste geldiğinde `directDiscount`
            // onun birleşik yüzdesini taşır ve `extraDiscount` sıfırlanır —
            // aksi hâlde eski çift iskonto listenin ÜSTÜNE bir kez daha inerdi.
            if (rawMeta.totalDiscounts !== undefined) {
                metaData.totalDiscounts = normalizeDiscountList(rawMeta.totalDiscounts, MAX_TOTAL_DISCOUNTS);
                if (metaData.totalDiscounts) metaData.extraDiscount = 0;
            }
            if (rawMeta.paymentStages !== undefined) {
                if (rawMeta.paymentStages === null || rawMeta.paymentStages === '') {
                    metaData.paymentStages = null;
                } else {
                    // Array or JSON string, bare percents or {percent, date} —
                    // one normaliser handles every shape the clients send.
                    // Fälligkeiten gehören zum AUFTRAG: die Offerte hält nur die
                    // Prozente, ein mitgeschicktes Datum wird verworfen.
                    const stages = normalizePaymentStages(rawMeta.paymentStages);
                    const stageError = stages ? validatePaymentStages(stages, { requireDates: false }) : "Geçersiz ödeme planı.";
                    if (stageError) {
                        throw new TenderValidationError(stageError);
                    }
                    metaData.paymentStages = serializePaymentStages(stripStageDates(stages!));
                }
            }
            if (rawMeta.billingSameAsInstallation !== undefined) {
                metaData.billingSameAsInstallation = Boolean(rawMeta.billingSameAsInstallation);
            }
            // Optional PDF content blocks. This endpoint keeps its OWN whitelist
            // separate from PATCH /meta, so a field added there is silently
            // dropped here — which is what the Save button actually calls.
            if (rawMeta.coverLetter !== undefined) {
                metaData.coverLetter = rawMeta.coverLetter ? String(rawMeta.coverLetter) : null;
            }
            if (rawMeta.closingNote !== undefined) {
                metaData.closingNote = rawMeta.closingNote ? String(rawMeta.closingNote) : null;
            }
            if (rawMeta.closingImages !== undefined) {
                metaData.closingImages = normalizeClosingImages(rawMeta.closingImages);
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

            const summaryInput = req.body?.summary && typeof req.body.summary === 'object'
                ? req.body.summary as Record<string, unknown>
                : null;
            const summaryTenderLogs: any[] = [];
            if (summaryInput) {
                const previousGrandTotal = Number(summaryInput.previousGrandTotal);
                const nextGrandTotal = Number(summaryInput.nextGrandTotal);
                if (
                    Number.isFinite(previousGrandTotal)
                    && Number.isFinite(nextGrandTotal)
                    && previousGrandTotal >= 0
                    && nextGrandTotal >= 0
                    && Math.round(previousGrandTotal * 100) !== Math.round(nextGrandTotal * 100)
                ) {
                    summaryTenderLogs.push({
                        tenantId,
                        tenderId,
                        positionId: null,
                        employeeId,
                        actionType: 'TENDER_TOTAL_UPDATED',
                        fieldName: 'grandTotal',
                        oldValue: previousGrandTotal.toFixed(2),
                        newValue: nextGrandTotal.toFixed(2),
                        description: `Genel toplam değiştirildi: ${previousGrandTotal.toFixed(2)} -> ${nextGrandTotal.toFixed(2)}`,
                    });
                }
                const previousTotalDiscounts = String(summaryInput.previousTotalDiscounts ?? '').slice(0, 4000);
                const nextTotalDiscounts = String(summaryInput.nextTotalDiscounts ?? '').slice(0, 4000);
                if (previousTotalDiscounts !== nextTotalDiscounts) {
                    summaryTenderLogs.push({
                        tenantId,
                        tenderId,
                        positionId: null,
                        employeeId,
                        actionType: 'TENDER_DISCOUNT_UPDATED',
                        fieldName: 'totalDiscounts',
                        oldValue: previousTotalDiscounts || null,
                        newValue: nextTotalDiscounts || null,
                        description: 'Genel toplama uygulanan indirimler değiştirildi.',
                    });
                }
            }

            // Common fast-save path. Flat manual rows already have their final
            // order/number in the browser and simple edits already contain the
            // complete patch. Persist creates, updates and deletes as concurrent,
            // tenant/status-guarded statements instead of paying for validation
            // SELECTs + BEGIN + several writes + COMMIT. This also covers the
            // usual "2 rows added, 3 rows edited, 1 row deleted" Save request.
            const fastMutableFields = [
                'shortDescription', 'longDescription', 'quantity', 'unit',
                'unitPrice', 'discount', 'discounts', 'taxRate', 'npkCode',
                'sourceArticleId', 'displayOrder',
            ];
            const fastMutableFieldSet = new Set(fastMutableFields);
            const canFastCreateEntries = entries.every(({ position, safeRowType, requestedParentPositionId }) =>
                (safeRowType === 'PRODUCT' || safeRowType === 'CUSTOM')
                && !requestedParentPositionId
                && (!position.sourceArticleId || position.discount !== undefined)
                && position.displayOrder !== undefined
                && Boolean(String(position.positionNumber || '').trim())
                && (position.discounts === undefined || position.discounts === null)
                && (position.imageUrl === undefined || position.imageUrl === null || position.imageUrl === ''),
            );
            const canUseFastSave = Object.keys(metaData).length === 0
                && entries.length + updates.length + deleteIds.length > 0
                && canFastCreateEntries
                && updates.every(({ input }) =>
                    Object.keys(input).every((field) => fastMutableFieldSet.has(field))
                    && (input.discounts === undefined || input.discounts === null),
                );
            if (canUseFastSave) {
                const fastCreated = entries.map(({ clientId, position, safeRowType }) => {
                    const isPricedRow = safeRowType === 'PRODUCT' || safeRowType === 'CUSTOM';
                    const row = {
                        id: nanoid(10),
                        tenantId,
                        tenderId,
                        parentPositionId: null,
                        rowType: safeRowType,
                        sourceArticleId: safeRowType === 'PRODUCT' && position.sourceArticleId
                            ? String(position.sourceArticleId)
                            : null,
                        displayOrder: Number(position.displayOrder),
                        npkCode: position.npkCode ? String(position.npkCode) : null,
                        positionNumber: String(position.positionNumber).trim(),
                        shortDescription: String(position.shortDescription || (safeRowType === 'PRODUCT' ? 'Ürün' : 'Yeni satır')).trim(),
                        longDescription: position.longDescription || null,
                        quantity: isPricedRow ? Number(position.quantity ?? (safeRowType === 'PRODUCT' ? 1 : 0)) : 0,
                        unit: isPricedRow ? (position.unit || null) : null,
                        hierarchyLevel: 0,
                        imageUrl: null,
                        unitPrice: isPricedRow
                            ? (position.unitPrice === undefined || position.unitPrice === null ? null : Number(position.unitPrice))
                            : null,
                        discount: isPricedRow ? Number(position.discount ?? 0) : 0,
                        discounts: null,
                        taxRate: isPricedRow ? Number(position.taxRate ?? 0) : 0,
                    };
                    return { clientId, row };
                });

                let insertPromise: Promise<number> | null = null;
                if (fastCreated.length > 0) {
                    const insertParameters: any[] = [];
                    const insertSelects = fastCreated.map(({ row }) => {
                        insertParameters.push(
                            row.id, row.tenantId, row.tenderId, row.parentPositionId,
                            row.rowType, row.sourceArticleId, row.displayOrder, row.npkCode,
                            row.positionNumber, row.shortDescription, row.longDescription,
                            row.quantity, row.unit, row.hierarchyLevel, row.imageUrl,
                            row.unitPrice, row.discount, row.discounts, row.taxRate,
                            tenantId, tenderId,
                        );
                        return `SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                                FROM \`Tender\` AS t
                                WHERE t.\`tenantId\` = ? AND t.\`id\` = ? AND t.\`status\` = 'Draft'`;
                    });
                    insertPromise = prisma.$executeRawUnsafe(
                        `INSERT INTO \`Position\`
                            (\`id\`, \`tenantId\`, \`tenderId\`, \`parentPositionId\`, \`rowType\`,
                             \`sourceArticleId\`, \`displayOrder\`, \`npkCode\`, \`positionNumber\`,
                             \`shortDescription\`, \`longDescription\`, \`quantity\`, \`unit\`,
                             \`hierarchyLevel\`, \`imageUrl\`, \`unitPrice\`, \`discount\`, \`discounts\`, \`taxRate\`)
                         ${insertSelects.join('\nUNION ALL\n')}`,
                        ...insertParameters,
                    );
                }

                const parameters: any[] = [];
                const assignments = fastMutableFields.flatMap((field) => {
                    const matching = updates.filter(({ input }) =>
                        Object.prototype.hasOwnProperty.call(input, field),
                    );
                    if (matching.length === 0) return [];
                    const cases = matching.map(({ positionId, input }) => {
                        parameters.push(positionId, input[field]);
                        return 'WHEN ? THEN ?';
                    }).join(' ');
                    return [`p.\`${field}\` = CASE p.\`id\` ${cases} ELSE p.\`${field}\` END`];
                });
                const updateIds = updates.map(({ positionId }) => positionId);
                let updatePromise: Promise<number> | null = null;
                if (updateIds.length > 0) {
                    parameters.push(tenantId, tenderId, ...updateIds);
                    updatePromise = prisma.$executeRawUnsafe(
                        `UPDATE \`Position\` AS p
                         INNER JOIN \`Tender\` AS t
                            ON t.\`id\` = p.\`tenderId\`
                           AND t.\`tenantId\` = p.\`tenantId\`
                         SET ${assignments.join(', ')}
                         WHERE p.\`tenantId\` = ?
                           AND p.\`tenderId\` = ?
                           AND t.\`status\` = 'Draft'
                           AND p.\`id\` IN (${updateIds.map(() => '?').join(', ')})`,
                        ...parameters,
                    );
                }

                // Deletes ride the same guard: the doomed set is the requested ids
                // plus up to three nesting levels below them (a section's rows and
                // anything under those), matched entirely in SQL so no validation
                // read is needed. FK'lar cascade olduğu sürece tek ifadedir; ilk
                // FK hatasında bağımlı tabloların elle temizlenmesi gerektiği
                // öğrenilir ve o andan itibaren alt tablolar önce silinir.
                // Line 708 already rejected update+delete of the same id, so this
                // chain can run concurrently with the insert/update statements.
                let deletePromise: Promise<number> | null = null;
                if (deleteIds.length > 0) {
                    const deletePlaceholders = deleteIds.map(() => '?').join(', ');
                    const doomedJoins = `
                         INNER JOIN \`Tender\` AS t
                            ON t.\`id\` = p.\`tenderId\`
                           AND t.\`tenantId\` = p.\`tenantId\`
                         LEFT JOIN \`Position\` AS par ON par.\`id\` = p.\`parentPositionId\`
                         LEFT JOIN \`Position\` AS par2 ON par2.\`id\` = par.\`parentPositionId\``;
                    const doomedWhere = `p.\`tenantId\` = ?
                           AND p.\`tenderId\` = ?
                           AND t.\`status\` = 'Draft'
                           AND (p.\`id\` IN (${deletePlaceholders})
                                OR p.\`parentPositionId\` IN (${deletePlaceholders})
                                OR par.\`parentPositionId\` IN (${deletePlaceholders})
                                OR par2.\`parentPositionId\` IN (${deletePlaceholders}))`;
                    const doomedParameters = [tenantId, tenderId, ...deleteIds, ...deleteIds, ...deleteIds, ...deleteIds];
                    const clearDependentRows = () => prisma.$executeRawUnsafe(
                        `DELETE ci, pam
                         FROM \`Position\` AS p${doomedJoins}
                         LEFT JOIN \`CalculationItem\` AS ci ON ci.\`positionId\` = p.\`id\`
                         LEFT JOIN \`PositionArticleMapping\` AS pam ON pam.\`positionId\` = p.\`id\`
                         WHERE ${doomedWhere}`,
                        ...doomedParameters,
                    );
                    const deletePositionRows = () => prisma.$executeRawUnsafe(
                        `DELETE p
                         FROM \`Position\` AS p${doomedJoins}
                         WHERE ${doomedWhere}`,
                        ...doomedParameters,
                    );
                    deletePromise = (async () => {
                        if (positionChildRowsNeedManualCleanup) {
                            await clearDependentRows();
                            return deletePositionRows();
                        }
                        try {
                            return await deletePositionRows();
                        } catch (deleteError) {
                            if (!isForeignKeyConstraintError(deleteError)) throw deleteError;
                            positionChildRowsNeedManualCleanup = true;
                            console.warn('[addPositionsBatch.fast] Position child FKs do not cascade; falling back to manual cleanup.');
                            await clearDependentRows();
                            return deletePositionRows();
                        }
                    })();
                }

                const stageDurations: Array<[string, number]> = [];
                const timed = (name: string, promise: Promise<number> | null): Promise<number> => {
                    if (!promise) return Promise.resolve(0);
                    const stageStartedAt = Date.now();
                    return promise.finally(() => { stageDurations.push([name, Date.now() - stageStartedAt]); });
                };
                const [insertAffected, updateAffected, deleteAffected] = await Promise.all([
                    timed('ins', insertPromise),
                    timed('upd', updatePromise),
                    timed('del', deletePromise),
                ]);
                if (fastCreated.length > 0 && insertAffected !== fastCreated.length) {
                    throw new TenderValidationError('Satır eklenecek taslak teklif bulunamadı.');
                }
                if (fastCreated.length === 0 && updates.length > 0 && updateAffected === 0) {
                    throw new TenderValidationError('Güncellenecek taslak teklif satırı bulunamadı.');
                }
                if (deleteIds.length > 0 && deleteAffected < deleteIds.length) {
                    throw new TenderValidationError('Silinecek satırlardan bazıları bulunamadı; sayfayı yenileyip tekrar deneyin.');
                }

                const pricingTouched = fastCreated.length > 0 || updates.some(({ input }) =>
                    input.quantity !== undefined
                    || input.unitPrice !== undefined
                    || input.discount !== undefined,
                );
                if (pricingTouched) {
                    const pricingPositionIds = [
                        ...fastCreated.map(({ row }) => row.id),
                        ...updateIds,
                    ];
                    void prisma.$executeRawUnsafe(
                        `INSERT INTO \`CalculationItem\`
                            (\`id\`, \`positionId\`, \`materialCost\`, \`laborCost\`, \`overheadCost\`, \`riskAmount\`, \`additionalCost\`, \`profitMargin\`, \`totalCalculatedPrice\`)
                         SELECT CONCAT('calc-', LEFT(REPLACE(UUID(), '-', ''), 25)), p.\`id\`, 0, 0, 0, 0, 0, 0,
                                GREATEST(0, p.\`quantity\` * p.\`unitPrice\` * (1 - COALESCE(p.\`discount\`, 0) / 100))
                         FROM \`Position\` AS p
                         WHERE p.\`tenantId\` = ?
                           AND p.\`tenderId\` = ?
                           AND p.\`unitPrice\` IS NOT NULL
                           AND p.\`id\` IN (${pricingPositionIds.map(() => '?').join(', ')})
                         ON DUPLICATE KEY UPDATE \`totalCalculatedPrice\` = VALUES(\`totalCalculatedPrice\`)`,
                        tenantId,
                        tenderId,
                        ...pricingPositionIds,
                    ).catch((calculationError: unknown) => console.error('[addPositionsBatch.fast] calculation sync failed:', calculationError));
                }

                // The fast path never read the doomed rows, so the audit entry
                // cannot name them — a generic entry per id is the trade for
                // skipping the validation SELECT.
                const fastActivityLogs = [
                    ...summaryTenderLogs,
                    ...deleteIds.map((positionId) => ({
                        tenantId,
                        tenderId,
                        positionId,
                        employeeId,
                        actionType: 'POSITION_DELETED',
                        fieldName: null,
                        oldValue: null,
                        newValue: null,
                        description: 'Satır silindi.',
                    })),
                ];
                if (fastActivityLogs.length > 0) {
                    void (prisma as any).tenderActivityLog.createMany({
                        data: fastActivityLogs.map((log) => ({
                            id: nanoid(12),
                            mappingId: null,
                            articleId: null,
                            ...log,
                        })),
                    }).catch((logError: unknown) => console.error('[addPositionsBatch.fast] activity log failed:', logError));
                }

                res.setHeader('Server-Timing', [
                    `auth;dur=${Number((req as any).authDurMs ?? 0)}`,
                    `rbac;dur=${Number((req as any).rbacDurMs ?? 0)}`,
                    ...stageDurations.map(([name, dur]) => `${name};dur=${dur}`),
                    `fast-save;dur=${Date.now() - requestStartedAt}`,
                ].join(', '));
                if ((req as any).singlePositionResponse && fastCreated.length > 0) {
                    const created = fastCreated[0]!;
                    return res.status(201).json({
                        message: "Satır eklendi.",
                        positionId: created.row.id,
                        position: created.row,
                    });
                }
                if ((req as any).singleUpdateResponse && updates.length > 0) {
                    return res.status(200).json({ id: updates[0]!.positionId, ...updates[0]!.input });
                }
                if ((req as any).singleDeleteResponse) {
                    return res.status(200).json({ message: "Satır silindi." });
                }
                return res.status(fastCreated.length > 0 ? 201 : 200).json({
                    message: `${fastCreated.length} satır eklendi, ${updates.length} satır güncellendi, ${deleteIds.length} satır silindi.`,
                    positions: fastCreated.map(({ clientId, row }) => ({
                        clientId,
                        positionId: row.id,
                        position: row,
                    })),
                    updatedPositions: updates.map(({ positionId, input }) => ({ id: positionId, ...input })),
                    deletedPositionIds: deleteIds,
                    updatedTender: null,
                });
            }

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
                    select: {
                        id: true,
                        tenantId: true,
                        status: true,
                        customerId: true,
                        tenderNumber: true,
                        directDiscount: true,
                        extraDiscount: true,
                        totalDiscounts: true,
                    },
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
                            discounts: true,
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
                const baseDiscount = isPricedRow
                    ? (explicitDiscount
                        ? Number(position.discount || 0)
                        : (isProduct && sourceArticle
                            ? (customerDiscountMap.get(sourceArticle.id) ?? 0)
                            : 0))
                    : 0;
                // İskonto yığını varsa yüzde ondan TÜRETİLİR; istemcinin
                // gönderdiği `discount` yalnızca liste yokken geçerlidir.
                const resolvedQuantity = isPricedRow ? Number(position.quantity ?? (isProduct ? 1 : 0)) : 0;
                const stackedDiscounts = isPricedRow
                    ? resolveLineDiscount(position.discounts, { quantity: resolvedQuantity, unitPrice: resolvedUnitPrice })
                    : { discounts: null as string | null, discount: undefined as number | undefined };
                const resolvedDiscount = stackedDiscounts.discounts !== null
                    ? (stackedDiscounts.discount ?? 0)
                    : baseDiscount;
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
                        quantity: resolvedQuantity,
                        unit: resolvedUnit,
                        npkCode: position.npkCode || null,
                        hierarchyLevel: parent ? Number(parent.hierarchyLevel || 0) + 1 : 0,
                        unitPrice: resolvedUnitPrice,
                        discount: resolvedDiscount,
                        discounts: stackedDiscounts.discounts,
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
                discounts: "İndirimler",
                taxRate: "KDV",
                imageUrl: "Görsel",
                npkCode: "Eski kod",
                rowType: "Satır tipi",
                sourceArticleId: "Kaynak ürün",
                displayOrder: "Sıra",
            };
            const priceFields = new Set(['quantity', 'unitPrice', 'discount', 'discounts', 'taxRate']);
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
                    // İskonto yığını `discount` sütununu OTORİTER biçimde belirler.
                    // Miktar/fiyat da aynı kayıtta değişebildiği için yüzde,
                    // güncellemeden SONRAKİ tabana göre hesaplanır.
                    const baseMoved = input.quantity !== undefined || input.unitPrice !== undefined;
                    if (input.discounts !== undefined || (baseMoved && before.discounts)) {
                        const nextQuantity = patch.quantity !== undefined ? patch.quantity : before.quantity;
                        const nextUnitPrice = patch.unitPrice !== undefined ? patch.unitPrice : before.unitPrice;
                        // Taban değiştiyse liste gelmese bile yeniden türetilir:
                        // sabit tutarlı bir iskonto parasını korur, yüzdesi ise
                        // yeni tabana göre başka bir sayıdır.
                        const source = input.discounts !== undefined ? input.discounts : before.discounts;
                        const resolved = resolveLineDiscount(source, { quantity: nextQuantity, unitPrice: nextUnitPrice });
                        patch.discounts = resolved.discounts;
                        if (resolved.discounts !== null) patch.discount = resolved.discount ?? 0;
                    }
                } else {
                    patch.quantity = 0;
                    patch.unit = null;
                    patch.unitPrice = null;
                    patch.discount = 0;
                    patch.discounts = null;
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
                const pricingChanged = targetCanPrice && (
                    input.quantity !== undefined
                    || input.unitPrice !== undefined
                    || input.discount !== undefined
                    || input.discounts !== undefined
                );
                const beforeQuantity = Number(before.quantity ?? 0);
                const beforePrice = before.unitPrice == null ? null : Number(before.unitPrice);
                const beforeDiscount = Number(before.discount ?? 0);
                const previousTotal = beforeQuantity > 0 && beforePrice !== null
                    ? beforeQuantity * beforePrice * (1 - beforeDiscount / 100)
                    : 0;
                const qty = Number(nextPosition.quantity ?? 0);
                const price = nextPosition.unitPrice == null ? null : Number(nextPosition.unitPrice);
                const discount = Number(nextPosition.discount ?? 0);
                const calculatedTotal = pricingChanged
                    ? (qty > 0 && price !== null ? qty * price * (1 - discount / 100) : 0)
                    : null;

                // Miktar ve birim fiyat yerine kullanıcıya yansıyan sonucu bir
                // kez toplam tutar olarak kaydet; indirim değişikliklerini koru.
                const logs = Object.keys(patch)
                    .filter((field) => field !== 'imageUrl')
                    .filter((field) => !['quantity', 'unitPrice', 'taxRate'].includes(field))
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
                if (calculatedTotal !== null && Math.round(previousTotal * 100) !== Math.round(calculatedTotal * 100)) {
                    logs.push({
                        tenantId,
                        tenderId,
                        positionId,
                        employeeId,
                        actionType: 'POSITION_PRICE_UPDATED',
                        fieldName: 'lineTotal',
                        oldValue: previousTotal.toFixed(2),
                        newValue: calculatedTotal.toFixed(2),
                        description: `Toplam tutar değiştirildi: ${previousTotal.toFixed(2)} -> ${calculatedTotal.toFixed(2)}`,
                    });
                }
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
            const metaTenderLogs: any[] = customerChanged
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
            const discountMetaFields = summaryInput
                ? []
                : (Object.prototype.hasOwnProperty.call(metaData, 'totalDiscounts')
                    ? ['totalDiscounts']
                    : ['directDiscount', 'extraDiscount']);
            const discountMetaLabels: Record<string, string> = {
                directDiscount: 'Toplam indirimi',
                extraDiscount: 'Ek toplam indirimi',
                totalDiscounts: 'Toplamda uygulanan indirimler',
            };
            discountMetaFields.forEach((fieldName) => {
                if (!Object.prototype.hasOwnProperty.call(metaData, fieldName)) return;
                const oldValue = tender[fieldName] == null ? null : String(tender[fieldName]);
                const newValue = metaData[fieldName] == null ? null : String(metaData[fieldName]);
                if ((oldValue ?? '') === (newValue ?? '')) return;
                metaTenderLogs.push({
                    tenantId,
                    tenderId,
                    positionId: null,
                    employeeId,
                    actionType: 'TENDER_DISCOUNT_UPDATED',
                    fieldName,
                    oldValue,
                    newValue,
                    description: `${discountMetaLabels[fieldName]} değiştirildi.`,
                });
            });
            metaTenderLogs.push(...summaryTenderLogs);
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
                        'unitPrice', 'discount', 'discounts', 'taxRate', 'imageUrl', 'npkCode',
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
                    // One statement clears every dependent table (correct whether
                    // or not their FKs cascade) instead of three round-trips.
                    const deletePlaceholders = allDeleteIdList.map(() => '?').join(', ');
                    await tx.$executeRawUnsafe(
                        `DELETE ci, pam
                         FROM \`Position\` AS p
                         LEFT JOIN \`CalculationItem\` AS ci ON ci.\`positionId\` = p.\`id\`
                         LEFT JOIN \`PositionArticleMapping\` AS pam ON pam.\`positionId\` = p.\`id\`
                         WHERE p.\`tenantId\` = ? AND p.\`tenderId\` = ? AND p.\`id\` IN (${deletePlaceholders})`,
                        tenantId, tenderId, ...allDeleteIdList,
                    );
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
                + (allDeleteIds.size > 0 ? 2 : 0);
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
                `auth;dur=${Number((req as any).authDurMs ?? 0)}, rbac;dur=${Number((req as any).rbacDurMs ?? 0)}, validation;dur=${validationFinishedAt - requestStartedAt}, db-write;dur=${writeFinishedAt - validationFinishedAt}, total;dur=${writeFinishedAt - requestStartedAt}`,
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
                    // Eine gesetzte manuelle Angabe gilt vor dem Kundenstamm und
                    // wird deshalb sofort zurückgemeldet (dieselbe Reihenfolge
                    // wie in TenderRepository). Ein LÖSCHEN kann hier nicht
                    // aufgelöst werden — das übernimmt der optimistische Wert
                    // der Oberfläche bzw. das nächste Laden.
                    ...(metaData.manualCustomerName ? { customerName: metaData.manualCustomerName } : {}),
                    ...(metaData.manualCustomerAddress ? { customerAddress: metaData.manualCustomerAddress } : {}),
                    ...(metaData.manualCustomerEmail ? { customerEmail: metaData.manualCustomerEmail } : {}),
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
            const { customerId, format, validUntil, billingAddress, installationAddress, deliveryAddress, billingSameAsInstallation, internalDeliveryDate, commissionNumber, customerReference, priceList, currency, directDiscount, directDiscountLabel, extraDiscount, extraDiscountLabel, totalDiscounts, paymentStages, coverLetter, closingNote, closingImages, ccEmails, manualCustomerName, manualCustomerEmail, manualCustomerAddress } = req.body;

            const tender = await this.getAccessibleTender(tenderId, (req as any).user!);
            if (!tender) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            // CC listesi belgenin İÇERİĞİ değil, postalama bilgisidir: teklif
            // gönderildikten (ve siparişe döndükten) sonra da düzenlenebilmeli,
            // çünkü mailler o listeye gider. Yalnızca CC içeren yamalar bu
            // yüzden taslak kilidinden muaftır.
            const ccOnlyPatch = ccEmails !== undefined
                && Object.keys(req.body).filter((key) => (req.body as any)[key] !== undefined).length === 1;
            if (tender.status !== "Draft" && !ccOnlyPatch) {
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
            if (customerReference !== undefined) {
                data.customerReference = customerReference ? String(customerReference) : null;
            }
            if (priceList !== undefined) {
                data.priceList = priceList ? String(priceList) : null;
            }
            // Von Hand erfasster Kunde (05.09.2026) — gilt nur für DIESE Offerte
            // und wird nie in den Kundenstamm geschrieben; siehe addPositionsBatch.
            if (manualCustomerName !== undefined) {
                data.manualCustomerName = manualCustomerName ? String(manualCustomerName).trim().slice(0, 190) : null;
            }
            if (manualCustomerEmail !== undefined) {
                data.manualCustomerEmail = manualCustomerEmail ? String(manualCustomerEmail).trim().slice(0, 190) : null;
            }
            if (manualCustomerAddress !== undefined) {
                data.manualCustomerAddress = manualCustomerAddress ? String(manualCustomerAddress) : null;
            }
            // Teklifin CC listesi — müşteriye giden her mail (teklif maili ve
            // sipariş bildirimi) bu adresleri kopyalar. Boş liste = CC yok.
            if (ccEmails !== undefined) {
                data.ccEmails = sanitizeTenderCcEmails(ccEmails);
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
            // Optional PDF content blocks. Rich text (HTML) for the two texts and a
            // data URI for the image; an empty value clears the block, which is how
            // the user removes it from the document.
            if (coverLetter !== undefined) {
                data.coverLetter = coverLetter ? String(coverLetter) : null;
            }
            if (closingNote !== undefined) {
                data.closingNote = closingNote ? String(closingNote) : null;
            }
            if (closingImages !== undefined) {
                data.closingImages = normalizeClosingImages(closingImages);
            }
            if (directDiscountLabel !== undefined) {
                const label = directDiscountLabel === null ? '' : String(directDiscountLabel).trim();
                if (label.length > 80) {
                    return res.status(400).json({ error: "İndirim adı en fazla 80 karakter olabilir." });
                }
                data.directDiscountLabel = label || null;
            }
            if (extraDiscount !== undefined) {
                const parsedExtraDiscount = extraDiscount === null || extraDiscount === '' ? 0 : Number(extraDiscount);
                if (!Number.isFinite(parsedExtraDiscount) || parsedExtraDiscount < 0 || parsedExtraDiscount > 100) {
                    return res.status(400).json({ error: "İndirim 0 ile 100 arasında olmalıdır." });
                }
                data.extraDiscount = parsedExtraDiscount;
            }
            if (extraDiscountLabel !== undefined) {
                const label = extraDiscountLabel === null ? '' : String(extraDiscountLabel).trim();
                if (label.length > 80) {
                    return res.status(400).json({ error: "İndirim adı en fazla 80 karakter olabilir." });
                }
                data.extraDiscountLabel = label || null;
            }
            // Belge düzeyi iskonto yığını — `addPositionsBatch`'teki meta yolu
            // ile aynı kural: liste varsa eski ikinci iskonto sıfırlanır.
            if (totalDiscounts !== undefined) {
                data.totalDiscounts = normalizeDiscountList(totalDiscounts, MAX_TOTAL_DISCOUNTS);
                if (data.totalDiscounts) data.extraDiscount = 0;
            }
            if (paymentStages !== undefined) {
                if (paymentStages === null || paymentStages === '') {
                    data.paymentStages = null;
                } else {
                    // Ödeme tarihleri SİPARİŞE aittir; teklif yalnızca yüzdeleri
                    // tutar (gelen tarihler yazılmadan atılır).
                    const stages = normalizePaymentStages(paymentStages);
                    const stageError = stages ? validatePaymentStages(stages, { requireDates: false }) : "Geçersiz ödeme planı.";
                    if (stageError) {
                        return res.status(400).json({ error: stageError });
                    }
                    data.paymentStages = serializePaymentStages(stripStageDates(stages!));
                }
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
            // Aus OSP entstandene Offerte? Die Zeilen VOR dem Löschen merken —
            // danach ist die Verknüpfung (absichtlich) weg.
            const ospRows = await (prisma as any).ospDocument.findMany({
                where: { tenderId },
                select: { id: true, reference: true, tenantId: true },
            }).catch(() => [] as Array<{ id: string; reference: string; tenantId: string }>);
            await this.tenderRepository.delete(tenderId, tender.tenantId);
            res.status(200).json({ message: "Teklif silindi." });
            // §4b (Vertragsfassung (2)): die Anfrage bei der OSP ZURÜCKZIEHEN,
            // damit drüben kein Stand mehr steht, den nichts mehr trägt — und
            // die Zeile hier auf LISTED zurücksetzen ("Offerte erstellen" ist
            // durch das Löschen ja wieder der nächste Schritt). Best-Effort im
            // Hintergrund; das Ergebnis steht wie jede Meldung an der Zeile.
            void (async () => {
                for (const row of ospRows as Array<{ id: string; reference: string; tenantId: string }>) {
                    const setting = await (prisma as any).ospSetting.findUnique({
                        where: { tenantId: row.tenantId },
                    }).catch(() => null);
                    const result = setting ? await withdrawOspOfferStatus(setting, row.reference) : { ok: false, skipped: true as const };
                    await (prisma as any).ospDocument.update({
                        where: { id: row.id },
                        data: {
                            status: 'LISTED',
                            lastReportedStatus: null,
                            ...(result.ok
                                ? { lastReportAt: new Date(), lastReportError: null }
                                : result.skipped
                                    ? {}
                                    : { lastReportError: result.error || 'Rückzug bei der OSP fehlgeschlagen.' }),
                        },
                    }).catch(() => undefined);
                }
            })().catch(() => undefined);
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

    // ── Tenant-wide intro-text templates (Textbausteine) ─────────────────────
    // Reusable Einleitungstext templates for the offer's cover letter. Same
    // access model as the mail drafts: shared by ALL tenders of the tenant.

    async listTextTemplates(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const templates = await (prisma as any).tenderTextTemplate.findMany({
                where: { tenantId },
                orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
            });
            res.status(200).json(templates);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createTextTemplate(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const { title, content, isDefault } = req.body;
            const template = await (prisma as any).$transaction(async (tx: any) => {
                // Tek varsayılan olabilir: yeni kayıt varsayılan işaretlendiyse
                // eskisinin işareti kaldırılır.
                if (isDefault) {
                    await tx.tenderTextTemplate.updateMany({ where: { tenantId, isDefault: true }, data: { isDefault: false } });
                }
                return tx.tenderTextTemplate.create({
                    data: {
                        id: nanoid(10),
                        tenantId,
                        title: String(title ?? '').slice(0, 191),
                        content: content ? String(content) : null,
                        isDefault: Boolean(isDefault),
                        createdBy: (req as any).user!.id || null,
                    },
                });
            });
            res.status(201).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateTextTemplate(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const templateId = req.params.templateId as string;
            const existing = await (prisma as any).tenderTextTemplate.findFirst({
                where: { id: templateId, tenantId },
                select: { id: true },
            });
            if (!existing) return res.status(404).json({ error: "Şablon bulunamadı." });

            const { title, content, isDefault } = req.body;
            const data: any = {};
            if (title !== undefined) data.title = String(title ?? '').slice(0, 191);
            if (content !== undefined) data.content = content ? String(content) : null;
            if (isDefault !== undefined) data.isDefault = Boolean(isDefault);
            if (Object.keys(data).length === 0) {
                return res.status(400).json({ error: "Güncellenecek alan bulunamadı." });
            }
            const template = await (prisma as any).$transaction(async (tx: any) => {
                if (data.isDefault === true) {
                    await tx.tenderTextTemplate.updateMany({
                        where: { tenantId, isDefault: true, NOT: { id: templateId } },
                        data: { isDefault: false },
                    });
                }
                return tx.tenderTextTemplate.update({ where: { id: templateId }, data });
            });
            res.status(200).json(template);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async deleteTextTemplate(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const templateId = req.params.templateId as string;
            const existing = await (prisma as any).tenderTextTemplate.findFirst({
                where: { id: templateId, tenantId },
                select: { id: true },
            });
            if (!existing) return res.status(404).json({ error: "Şablon bulunamadı." });
            await (prisma as any).tenderTextTemplate.delete({ where: { id: templateId } });
            res.status(200).json({ message: "Şablon silindi.", templateId });
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
            if (rawAttachments.length > 1) {
                return res.status(400).json({ error: "Teklif e-postasına yalnızca ilgili PDF eklenebilir." });
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
            if (totalAttachmentBytes > 5 * 1024 * 1024) {
                return res.status(400).json({ error: "Ek dosya 5 MB sınırını aşıyor." });
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

            // Tenant e-posta imzası (Mail Ayarları'nda tanımlanır) gövdenin sonuna
            // eklenir; imza görseli CID'li inline ek olarak taşınır.
            const signature = buildSignatureParts(settings);

            const html = `
                <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
                    <p>${messageHtml}</p>
                    ${scheduleHtml}
                    ${signature.html}
                </div>
            `;

            const plainText = slots.length > 0
                ? `${messageText}\n\nPlanlanan tarih ve saatler:\n${scheduleText}`
                : messageText;

            // CC istekten DEĞİL, teklifin kayıtlı listesinden gelir: alıcı
            // tarafındaki açık relay koruması CC için de geçerli olsun diye
            // adresler yalnızca teklif üzerinde (yetkili bir düzenlemeyle)
            // tanımlanabilir.
            const cc = tenderCcForSend((tender as any).ccEmails, to);

            const result = await dispatchMail(
                { tenantId: tender.tenantId, employeeId: (req as any).user!.id },
                settings,
                {
                    fromEmail,
                    fromName,
                    to,
                    cc,
                    subject,
                    text: `${plainText}${signature.text}`,
                    html,
                    replyTo: settings?.replyTo || null,
                    attachments,
                    inlineImages: signature.inlineImages
                },
                { record: { customerId: tender.customerId, entityType: "TENDER", entityId: tender.id, entityLabel: tender.tenderNumber } },
            );

            await (prisma as any).tender.update({
                where: { id: tenderId },
                data: {
                    offerMailSentAt: new Date(),
                    offerMailRecipient: to
                }
            });

            if (tender.customerId) {
                const activity = await this.customerActivityRepo.create({
                    customerId: tender.customerId,
                    employeeId: (req as any).user!.id,
                    activityType: "OFFER_MAIL_SENT",
                    description: `${tender.tenderNumber} teklif PDF'i ${to} adresine gönderildi.`,
                    referenceId: tender.id,
                    activityDate: new Date()
                });
                // Dieselbe Sendung nur EINMAL im Interaktionsverlauf: die
                // MailMessage kennt ihre Aktivität, die Liste blendet diese aus.
                if (result.mailMessageId && (activity as any)?.id) {
                    await prisma.mailMessage.update({
                        where: { id: result.mailMessageId },
                        data: { activityId: String((activity as any).id) },
                    }).catch(() => undefined);
                }
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
            // Outlook-Versand (Graph) meldet 409 = neu verbinden, 502 = Versand fehlgeschlagen.
            if (error?.status === 409 || error?.status === 502) {
                return res.status(error.status).json({ error: error.message, code: error.code });
            }
            if (typeof error?.message === "string" && error.message.startsWith("SMTP")) {
                return res.status(502).json({ error: "E-posta gönderilemedi: SMTP sunucusuna bağlanılamadı veya kullanıcı adı/parola hatalı. Lütfen mail ayarlarını kontrol edin." });
            }
            res.status(500).json({ error: "Teklif maili gönderilirken bir hata oluştu." });
        }
    }

    /**
     * Vorschläge für das CC-Feld der Offerte: der Kunde selbst und seine
     * Kontaktpersonen. Bewusst am TENDER und nicht am Kunden aufgehängt — die
     * Offerte kennt ihren Kunden bereits, die Mandantenprüfung ist dieselbe wie
     * beim Lesen der Offerte, und ein Verkäufer braucht dafür keine
     * CRM-Schreibrechte. Mitarbeitende kommen aus dem Personalverzeichnis.
     */
    async listMailRecipients(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender: any = await this.getAccessibleTender(tenderId, (req as any).user!, { omitPdfContent: true });
            if (!tender) return res.status(404).json({ error: "Teklif bulunamadı." });

            const contacts = tender.customerId
                ? await (prisma as any).customerContact.findMany({
                    where: { customerId: tender.customerId },
                    select: { id: true, firstName: true, lastName: true, title: true, email: true },
                })
                : [];

            res.status(200).json({
                customer: tender.customerEmail
                    ? { name: tender.customerName || tender.customerEmail, email: tender.customerEmail }
                    : null,
                contacts: contacts
                    .filter((contact: any) => contact.email && isValidEmail(String(contact.email).trim()))
                    .map((contact: any) => ({
                        id: contact.id,
                        name: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || String(contact.email),
                        title: contact.title ?? null,
                        email: String(contact.email).trim(),
                    })),
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * ── AUFTRAGSBESTÄTIGUNG ──────────────────────────────────────────────────
     * Der Kunde wird informiert, sobald aus seiner Offerte ein Auftrag wird.
     * Ausgelöst wird das direkt nach `POST /sales-orders/from-tender` (der
     * Haken "Kunde benachrichtigen" im Auftragsdialog), darum liest der Endpunkt
     * die Auftragsnummer selbst aus der Datenbank statt sie zu glauben.
     *
     * Empfänger: der Kunde der Offerte (To, nur aus dessen eigenen Adressen —
     * dieselbe Allow-Liste wie die Offertmail, damit der Endpunkt kein offenes
     * Relay ist) mit der CC-Liste der Offerte in Kopie. Der Text ist deutsch:
     * er geht an den Kunden, nicht an den Bediener der Oberfläche.
     */
    async sendOrderMail(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tender: any = await this.getAccessibleTender(tenderId, (req as any).user!, { omitPdfContent: true });
            if (!tender) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            if (!tender.customerId) {
                return res.status(400).json({ error: "Müşterisi olmayan teklif için mail gönderilemez." });
            }

            const [settings, salesOrder, contacts] = await Promise.all([
                prisma.mailSetting.findUnique({ where: { tenantId: tender.tenantId } }),
                (prisma as any).salesOrder.findFirst({
                    where: { tenderId },
                    select: { orderNumber: true, totalAmount: true, orderDate: true, createdAt: true },
                }),
                (prisma as any).customerContact.findMany({
                    where: { customerId: tender.customerId },
                    select: { email: true },
                }),
            ]);
            if (!salesOrder) {
                return res.status(400).json({ error: "Bu teklife bağlı bir sipariş bulunamadı." });
            }

            // Alıcı: teklif mailindeki kuralın aynısı — yalnızca müşterinin
            // kendi adresleri.
            const allowedRecipients = new Map<string, string>();
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
            const cc = tenderCcForSend(tender.ccEmails, to);

            const fromEmail = stripHeaderValue(String(settings?.fromEmail || (req as any).user!.email || ""));
            if (!fromEmail || !isValidEmail(fromEmail)) {
                return res.status(400).json({ error: "Gönderici e-posta adresi yapılandırılmamış." });
            }
            const fromName = stripHeaderValue(String(settings?.fromName || "Offitec ERP")).slice(0, 100) || "Offitec ERP";

            const subject = stripHeaderValue(String(req.body.subject || `Auftragsbestätigung ${salesOrder.orderNumber}`));
            if (!subject) return res.status(400).json({ error: "Konu boş olamaz." });
            if (subject.length > 200) return res.status(400).json({ error: "Konu 200 karakteri aşamaz." });

            const message = String(
                req.body.message
                || "Guten Tag\n\nVielen Dank für Ihren Auftrag — wir haben ihn erfasst und bestätigen Ihnen die Ausführung.\n"
                + "Die zugehörige Offerte finden Sie als PDF im Anhang.\n\n"
                + "Für Fragen stehen wir Ihnen gerne zur Verfügung.\n\nFreundliche Grüsse",
            ).trim();
            if (message.length > 5000) {
                return res.status(400).json({ error: "Mesaj çok uzun." });
            }

            // Ek: yalnızca tek bir PDF/PNG/JPG (teklif PDF'i), 5 MB sınırı —
            // teklif mailindeki denetimin aynısı.
            const rawAttachments = Array.isArray(req.body.attachments) ? req.body.attachments : [];
            if (rawAttachments.length > 1) {
                return res.status(400).json({ error: "Sipariş e-postasına yalnızca ilgili PDF eklenebilir." });
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
            if (totalAttachmentBytes > 5 * 1024 * 1024) {
                return res.status(400).json({ error: "Ek dosya 5 MB sınırını aşıyor." });
            }

            // Belgenin kimliğini taşıyan satırlar — mailin gövdesinde küçük bir
            // liste olarak; hepsi kaçışlanır (mesajın kendisi düz metindir).
            const detailRows: Array<[string, string]> = [
                ["Auftrag", String(salesOrder.orderNumber || "")],
                ["Offerte", String(tender.tenderNumber || "")],
            ];
            if (tender.commissionNumber) detailRows.push(["Kommission", String(tender.commissionNumber)]);
            if (tender.customerReference) detailRows.push(["Referenz", String(tender.customerReference)]);
            const orderDate = salesOrder.orderDate || salesOrder.createdAt;
            if (orderDate) detailRows.push(["Datum", new Date(orderDate).toLocaleDateString("de-CH")]);

            const signature = buildSignatureParts(settings);
            const detailsHtml = `
                <table style="border-collapse:collapse;margin:12px 0">
                    ${detailRows.map(([label, value]) => `
                        <tr>
                            <td style="padding:2px 16px 2px 0;color:#64748b">${escapeHtml(label)}</td>
                            <td style="padding:2px 0;font-weight:600">${escapeHtml(value)}</td>
                        </tr>`).join("")}
                </table>`;
            const html = `
                <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
                    <p>${escapeHtml(message).replace(/\n/g, "<br />")}</p>
                    ${detailsHtml}
                    ${signature.html}
                </div>
            `;
            const detailsText = detailRows.map(([label, value]) => `${label}: ${value}`).join("\n");

            const result = await dispatchMail(
                { tenantId: tender.tenantId, employeeId: (req as any).user!.id },
                settings,
                {
                    fromEmail,
                    fromName,
                    to,
                    cc,
                    subject,
                    text: `${message}\n\n${detailsText}${signature.text}`,
                    html,
                    replyTo: settings?.replyTo || null,
                    attachments,
                    inlineImages: signature.inlineImages,
                },
                { record: { customerId: tender.customerId, entityType: "ORDER", entityId: tender.id, entityLabel: salesOrder.orderNumber } },
            );

            // SMTP yapılandırılmamışsa gerçek gönderim yoktur (preview); müşteri
            // geçmişine yalnızca gerçekten giden mail yazılır.
            if (!result.preview) {
                const activity = await this.customerActivityRepo.create({
                    customerId: tender.customerId,
                    employeeId: (req as any).user!.id,
                    activityType: "ORDER_MAIL_SENT",
                    description: `${salesOrder.orderNumber} sipariş bildirimi ${to} adresine gönderildi.`,
                    referenceId: tender.id,
                    activityDate: new Date(),
                });
                if (result.mailMessageId && (activity as any)?.id) {
                    await prisma.mailMessage.update({
                        where: { id: result.mailMessageId },
                        data: { activityId: String((activity as any).id) },
                    }).catch(() => undefined);
                }
            }

            res.status(200).json({
                message: result.preview
                    ? "SMTP ayarı olmadığı için sipariş maili önizleme olarak hazırlandı."
                    : "Sipariş maili gönderildi.",
                to,
                cc,
                orderNumber: salesOrder.orderNumber,
                ...result,
            });
        } catch (error: any) {
            if (error?.status === 400) {
                return res.status(400).json({ error: error.message });
            }
            console.error('[sendOrderMail] error:', error);
            // Outlook-Versand (Graph) meldet 409 = neu verbinden, 502 = Versand fehlgeschlagen.
            if (error?.status === 409 || error?.status === 502) {
                return res.status(error.status).json({ error: error.message, code: error.code });
            }
            if (typeof error?.message === "string" && error.message.startsWith("SMTP")) {
                return res.status(502).json({ error: "E-posta gönderilemedi: SMTP sunucusuna bağlanılamadı veya kullanıcı adı/parola hatalı. Lütfen mail ayarlarını kontrol edin." });
            }
            res.status(500).json({ error: "Sipariş maili gönderilirken bir hata oluştu." });
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
            const includeActivities = !light && req.query.includeActivities !== 'false';
            const deferOrderPdfContent = req.query.deferOrderPdfContent === 'true';

            // These queries are independent. The app deliberately excludes activities:
            // it loads them from /activities only when the chatter panel is opened.
            // Read-only summaries never need PDF blocks, and sales-order detail defers
            // those multi-megabyte fields until PDF view/export/mail time.
            const [tender, positions, activities] = await Promise.all([
                this.getAccessibleTender(tenderId, (req as any).user!, {
                    deferOrderPdfContent,
                    omitPdfContent: light,
                }),
                this.positionRepository.findByTenderId(tenderId, { includeImages, light }),
                includeActivities
                    ? this.customerActivityRepo.getActivitiesByReference(tenderId)
                    : Promise.resolve([]),
            ]);
            if (!tender) return res.status(404).json({ error: "İhale bulunamadı." });

            res.status(200).json({ tender, positions, activities });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // The detail screen keeps PDF-only LONGTEXT fields out of the critical path
    // for read-only sales orders. Load them explicitly only when a PDF workflow
    // needs them.
    async getPdfContent(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            if (!tenderId) return res.status(400).json({ error: "İhale ID zorunludur." });

            const requestTenantId = (req as any).user!.tenantId;
            const owner = await (prisma as any).tender.findUnique({
                where: { id: tenderId },
                select: { tenantId: true },
            });
            if (!owner || !await this.canAccessTenant(owner.tenantId, requestTenantId)) {
                return res.status(404).json({ error: "İhale bulunamadı." });
            }

            const content = await (prisma as any).tender.findFirst({
                where: { id: tenderId, tenantId: owner.tenantId },
                select: {
                    coverLetter: true,
                    closingNote: true,
                    closingImages: true,
                },
            });
            if (!content) return res.status(404).json({ error: "İhale bulunamadı." });
            res.status(200).json(content);
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

            const ids = normalizeIdList(req.body?.ids);
            const positionIds = normalizeIdList(req.body?.positionIds);
            if (ids.length === 0 && positionIds.length === 0) return res.status(200).json([]);

            // The ownership guard reads ONLY the id. `tenderRepository.findById`
            // would select every Tender column — including the LongText PDF
            // content blocks (`closingImages` alone can be megabytes of base64
            // data URIs) plus the customer/creator joins — none of which this
            // endpoint uses. Loading them turned a ~150 ms lookup into a
            // multi-second one on offers that carry closing images.
            // The image queries are independent of the guard and already scoped
            // by tenantId (and tenderId), so they run concurrently and their
            // result is simply discarded when the guard fails.
            //
            // Article images (product rows) + per-position uploaded images (manual
            // products / description rows) — both only ever fetched here, for the PDF.
            //
            // Articles are read in two steps on purpose: this first query touches
            // no LongText at all, it only asks WHICH articles have an image and
            // what version it is. `getArticleThumbnails` then reads the originals
            // for the ids it has no cached thumbnail for — usually none.
            const [owned, articleVersions, positionRows] = await Promise.all([
                (prisma as any).tender.findFirst({
                    where: { id: tenderId, tenantId },
                    select: { id: true },
                }),
                ids.length > 0
                    ? (prisma as any).article.findMany({
                        // `not: ''` matters: articles saved without a picture hold an
                        // empty string rather than NULL, and used to be returned as
                        // image rows the PDF then threw away.
                        where: { tenantId, id: { in: ids }, imageUrl: { not: null, notIn: [''] } },
                        select: { id: true, updatedAt: true },
                    })
                    : [],
                positionIds.length > 0
                    ? (prisma as any).position.findMany({
                        where: { tenantId, tenderId, id: { in: positionIds }, imageUrl: { not: null, notIn: [''] } },
                        select: { id: true },
                    })
                    : [],
            ]);
            if (!owned) return res.status(404).json({ error: "İhale bulunamadı." });

            // Downscaled to the 24 mm square the PDF draws them into — see
            // PdfImageThumbnailService for why the originals never travel.
            const [articleThumbs, positionThumbs] = await Promise.all([
                getArticleThumbnails(tenantId, articleVersions),
                getPositionThumbnails(tenantId, tenderId, positionRows),
            ]);

            res.status(200).json([...articleThumbs, ...positionThumbs]);
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

    /** Returns exactly what the visible log tab needs, in one round trip. */
    async getChatter(req: Request, res: Response) {
        try {
            const tenderRef = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const normalizedRef = this.normalizeTenderRef(tenderRef);
            const directTender = normalizedRef
                ? await (prisma as any).tender.findFirst({
                    where: { id: normalizedRef, tenantId },
                    select: { id: true, tenantId: true },
                })
                : null;
            const tender = directTender ?? await this.findTenderForTenant(tenderRef, tenantId);
            if (!tender) return res.status(404).json({ error: "Teklif bulunamadı." });

            const [logs, documents] = await Promise.all([
                this.tenderLogRepo.findByTender(tender.id),
                prisma.document.findMany({
                    where: { tenantId: tender.tenantId, relatedEntityId: tender.id, entityType: "TENDER" },
                    orderBy: { fileName: "asc" },
                    select: {
                        id: true,
                        tenantId: true,
                        relatedEntityId: true,
                        entityType: true,
                        fileName: true,
                        fileType: true,
                        category: true,
                        uploadedByEmployeeId: true,
                    },
                }),
            ]);

            res.status(200).json({
                logs,
                documents,
            });
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

            // Validate tenant ownership and create the note in one database
            // round-trip. The old path loaded the entire tender graph before
            // inserting this tiny record.
            const normalizedRef = this.normalizeTenderRef(tenderRef);
            if (normalizedRef) {
                const id = nanoid(12);
                const createdAt = new Date();
                const inserted = await prisma.$executeRaw(Prisma.sql`
                    INSERT INTO TenderActivityLog
                        (id, tenantId, tenderId, positionId, mappingId, articleId,
                         employeeId, actionType, fieldName, oldValue, newValue,
                         description, createdAt)
                    SELECT
                        ${id}, tender.tenantId, tender.id, NULL, NULL, NULL,
                        ${employeeId}, 'TENDER_NOTE', 'note', NULL, ${noteText},
                        ${noteText}, ${createdAt}
                    FROM Tender AS tender
                    WHERE tender.id = ${normalizedRef}
                      AND tender.tenantId = ${tenantId}
                    LIMIT 1
                `);

                if (inserted === 1) {
                    return res.status(201).json({
                        id,
                        tenantId,
                        tenderId: normalizedRef,
                        positionId: null,
                        mappingId: null,
                        articleId: null,
                        employeeId,
                        actionType: "TENDER_NOTE",
                        fieldName: "note",
                        oldValue: null,
                        newValue: noteText,
                        description: noteText,
                        createdAt,
                    });
                }
            }

            // Keep legacy tender numbers and tenant-tree access compatible.
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
                orderBy: { fileName: "asc" },
                select: {
                    id: true,
                    tenantId: true,
                    relatedEntityId: true,
                    entityType: true,
                    fileName: true,
                    fileType: true,
                    category: true,
                    uploadedByEmployeeId: true,
                },
            });
            res.status(200).json(documents);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getDocumentContent(req: Request, res: Response) {
        try {
            const tenderRef = req.params.id as string;
            const documentId = req.params.documentId as string;
            const tenantId = (req as any).user!.tenantId;
            const normalizedRef = this.normalizeTenderRef(tenderRef);
            let document: any = null;
            if (normalizedRef) {
                const documents = await prisma.$queryRaw<any[]>(Prisma.sql`
                    SELECT document.*
                    FROM Document AS document
                    INNER JOIN Tender AS tender
                        ON tender.id = document.relatedEntityId
                       AND tender.tenantId = document.tenantId
                    WHERE tender.id = ${normalizedRef}
                      AND tender.tenantId = ${tenantId}
                      AND document.id = ${documentId}
                      AND document.entityType = 'TENDER'
                    LIMIT 1
                `);
                document = documents[0] ?? null;
            }
            if (!document) {
                // Legacy tender numbers and parent/child tenant access remain
                // compatible; the normal canonical-id path above is one query.
                const tender = await this.findTenderForTenant(tenderRef, tenantId);
                if (!tender) return res.status(404).json({ error: "Teklif bulunamadı." });
                document = await prisma.document.findFirst({
                    where: {
                        id: documentId,
                        tenantId: tender.tenantId,
                        relatedEntityId: tender.id,
                        entityType: "TENDER",
                    },
                });
            }
            if (!document) return res.status(404).json({ error: "Dosya bulunamadı." });
            if (tenderDocumentStorageService.isManagedReference(document.fileUrl)) {
                const file = await tenderDocumentStorageService.read(document.fileUrl);
                return res.status(200).json({
                    ...document,
                    fileUrl: `data:${document.fileType};base64,${file.toString('base64')}`,
                });
            }
            res.status(200).json(document);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async addDocument(req: Request, res: Response) {
        let storedFileReference: string | null = null;
        try {
            const tenderRef = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const employeeId = (req as any).user!.id;
            const uploadedFile = req.file;
            const fileName = String(uploadedFile?.originalname || req.body.fileName || "").trim();
            const fileType = String(uploadedFile?.mimetype || req.body.fileType || "").trim().toLowerCase();
            let fileUrl = String(req.body.fileUrl || "").trim();
            const category = String(req.body.category || "tender").trim() || "tender";

            if (!fileName || (!uploadedFile && !fileUrl) || !fileType) {
                return res.status(400).json({ error: "Dosya adı, dosya ve tür zorunludur." });
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

            const dataPayload = fileUrl.includes(',') ? fileUrl.slice(fileUrl.indexOf(',') + 1) : fileUrl;
            const approximateBytes = uploadedFile
                ? uploadedFile.buffer.length
                : Math.floor(dataPayload.replace(/\s+/g, '').length * 3 / 4);
            if (approximateBytes > 5 * 1024 * 1024) {
                return res.status(400).json({ error: "Dosya boyutu 5 MB sınırını aşamaz." });
            }

            if (uploadedFile) {
                storedFileReference = await tenderDocumentStorageService.store(
                    tenantId,
                    uploadedFile.buffer,
                    fileType,
                );
                fileUrl = storedFileReference;
            }

            const normalizedRef = this.normalizeTenderRef(tenderRef);
            if (normalizedRef) {
                const documentId = nanoid(8);
                const inserted = await prisma.$executeRaw(Prisma.sql`
                    INSERT INTO Document
                        (id, tenantId, relatedEntityId, entityType, fileName,
                         fileUrl, fileType, category, uploadedByEmployeeId)
                    SELECT
                        ${documentId}, tender.tenantId, tender.id, 'TENDER',
                        ${fileName}, ${fileUrl}, ${fileType}, ${category}, ${employeeId}
                    FROM Tender AS tender
                    WHERE tender.id = ${normalizedRef}
                      AND tender.tenantId = ${tenantId}
                    LIMIT 1
                `);

                if (inserted === 1) {
                    // The attachment is durable now. Audit logging does not need
                    // to hold the upload response open for another remote DB trip.
                    void this.tenderLogRepo.create({
                        tenantId,
                        tenderId: normalizedRef,
                        employeeId,
                        actionType: "TENDER_ATTACHMENT",
                        fieldName: "attachment",
                        oldValue: null,
                        newValue: fileName,
                        description: `Ek dosya eklendi: ${fileName}`,
                    }).catch((error) => console.error('[TenderController.addDocument] audit log failed:', error));

                    // Do not echo the base64 file back to the browser. Preview
                    // content is fetched only when the user opens the document.
                    return res.status(201).json({
                        id: documentId,
                        tenantId,
                        relatedEntityId: normalizedRef,
                        entityType: "TENDER",
                        fileName,
                        fileUrl: "",
                        fileType,
                        category,
                        uploadedByEmployeeId: employeeId,
                    });
                }
            }

            const tender = await this.findTenderForTenant(tenderRef, tenantId);
            if (!tender) {
                if (storedFileReference) {
                    await tenderDocumentStorageService.remove(storedFileReference);
                    storedFileReference = null;
                }
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

            void this.tenderLogRepo.create({
                tenantId: tender.tenantId,
                tenderId: tender.id,
                employeeId,
                actionType: "TENDER_ATTACHMENT",
                fieldName: "attachment",
                oldValue: null,
                newValue: fileName,
                description: `Ek dosya eklendi: ${fileName}`
            }).catch((error) => console.error('[TenderController.addDocument] audit log failed:', error));

            res.status(201).json(document);
        } catch (error: any) {
            if (storedFileReference) {
                await tenderDocumentStorageService.remove(storedFileReference).catch((cleanupError) => {
                    console.error('[TenderController.addDocument] file cleanup failed:', cleanupError);
                });
            }
            res.status(400).json({ error: error.message });
        }
    }
}
