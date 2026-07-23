"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenderRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Tender_1 = require("../../domain/entities/Tender");
const customerAddress_1 = require("../../application/utils/customerAddress");
const nanoid_1 = require("nanoid");
class TenderRepository {
    mapToEntity(data) {
        return new Tender_1.Tender(data.id, data.tenantId, data.customerId, data.tenderNumber, data.version, data.format, data.status, data.createdByEmployeeId, data.createdAt, data.projectId, data.validUntil, data.offerMailSentAt, data.offerAcceptedAt, data.offerMailRecipient, data.offerAcceptanceToken, data.sourceCreatedAt, data.orderDate, data.billingAddress, data.deliveryAddress, data.internalDeliveryDate, data.priceList, data.paymentTerms, data.commissionNumber, data.salespersonName, data.sourceStatus, data.sourceCompany, data.shippingTerms, data.shippingWeight, data.fiscalPosition, data.salesTeam, data.onlineSignature, data.onlinePayment, data.coverLetter, data.sourceTotal, data.sourceNetAmount, data.sourceTaxAmount, data.sourceRecurringTotal, data.sourceMargin, data.billingSameAsInstallation, data.installationAddress, data.directDiscount, data.currency);
    }
    async create(tenderData) {
        const data = await prisma_client_1.default.tender.create({
            data: tenderData
        });
        return this.mapToEntity(data);
    }
    async findById(id, tenantId) {
        // Scoped by both id and tenantId (findFirst, since the composite is not a
        // unique key). Cross-tenant ids simply resolve to null.
        const data = await prisma_client_1.default.tender.findFirst({
            where: { id, tenantId },
            include: {
                customer: { select: { id: true, companyName: true, addressName: true, address: true, postalCode: true, city: true, country: true, mainPhone: true, mainEmail: true, taxNumber: true } },
                createdBy: { select: { id: true, firstName: true, lastName: true, email: true } }
            }
        });
        if (!data)
            return null;
        const entity = this.mapToEntity(data);
        entity.customerName = data.customer?.companyName ?? null;
        // The customer's primary address (street / postal + city / country) formatted
        // as a single multi-line string — the default for the tender's address slot.
        entity.customerAddress = (0, customerAddress_1.formatCustomerAddress)(data.customer);
        entity.customerEmail = data.customer?.mainEmail ?? null;
        entity.customerPhone = data.customer?.mainPhone ?? null;
        entity.customerTaxNumber = data.customer?.taxNumber ?? null;
        entity.createdByName = data.createdBy
            ? `${data.createdBy.firstName} ${data.createdBy.lastName}`
            : null;
        entity.createdByEmail = data.createdBy?.email ?? null;
        return entity;
    }
    async findAll(filter) {
        const where = { tenantId: filter.tenantId };
        if (filter.customerId)
            where.customerId = filter.customerId;
        if (filter.status)
            where.status = filter.status;
        if (filter.search) {
            where.OR = [
                { tenderNumber: { contains: filter.search } },
            ];
        }
        // Kolon bazlı filtreler — üstteki genel arama ile AND'lenir (MySQL collation
        // varsayılan olarak büyük/küçük harf duyarsız, ayrıca `mode` gerekmez).
        if (filter.tenderNumber)
            where.tenderNumber = { contains: filter.tenderNumber };
        if (filter.customerName) {
            where.customer = { is: { companyName: { contains: filter.customerName } } };
        }
        if (filter.creatorName) {
            where.createdBy = {
                is: {
                    OR: [
                        { firstName: { contains: filter.creatorName } },
                        { lastName: { contains: filter.creatorName } },
                        { email: { contains: filter.creatorName } },
                    ],
                },
            };
        }
        // "Sipariş" durumu — projeye bağlanmış VEYA kaynağı bir satış siparişi olan
        // kayıtlar (frontend'deki isSourceSalesOrder ile aynı ham değerler). Genel
        // arama üstteki `where.OR`'u kullandığından bu koşul `where.AND`'e eklenir.
        const ORDER_SOURCE_VALUES = [
            'Verkaufsauftrag', 'Auftrag', 'sales order', 'sale order',
            'sales_order', 'sale_order', 'Sipariş', 'Siparişte', 'Siparis', 'Sipariste',
        ];
        const andConditions = [];
        if (filter.orderState === 'order') {
            andConditions.push({
                OR: [
                    { projectId: { not: null } },
                    { sourceStatus: { in: ORDER_SOURCE_VALUES } },
                ],
            });
        }
        else if (filter.orderState === 'draft') {
            andConditions.push({ projectId: null });
            // NULL sourceStatus, `notIn` ile üç değerli mantıkta elenirdi; açık NULL
            // dalıyla taslak kayıtların dışarıda kalması engellenir.
            andConditions.push({
                OR: [
                    { sourceStatus: null },
                    { sourceStatus: { notIn: ORDER_SOURCE_VALUES } },
                ],
            });
        }
        if (andConditions.length > 0)
            where.AND = andConditions;
        if (filter.mailSent === 'yes')
            where.offerMailSentAt = { not: null };
        else if (filter.mailSent === 'no')
            where.offerMailSentAt = null;
        // Sıralama — yalnızca DB kolonlarına (hesaplanan grandTotal hariç) izin ver.
        const sortDir = filter.sortDirection === 'asc' ? 'asc' : 'desc';
        let orderBy = { createdAt: 'desc' };
        switch (filter.sortBy) {
            case 'tenderNumber':
                orderBy = { tenderNumber: sortDir };
                break;
            case 'status':
                orderBy = { status: sortDir };
                break;
            case 'customerName':
                orderBy = { customer: { companyName: sortDir } };
                break;
            case 'createdAt':
                orderBy = { createdAt: sortDir };
                break;
        }
        const page = filter.page && filter.page > 0 ? filter.page : undefined;
        const pageSize = filter.pageSize && filter.pageSize > 0 ? Math.min(filter.pageSize, 100) : undefined;
        const [data, total] = await Promise.all([
            prisma_client_1.default.tender.findMany({
                where,
                select: {
                    id: true,
                    tenantId: true,
                    customerId: true,
                    tenderNumber: true,
                    version: true,
                    format: true,
                    status: true,
                    createdByEmployeeId: true,
                    createdAt: true,
                    projectId: true,
                    validUntil: true,
                    sourceCreatedAt: true,
                    orderDate: true,
                    billingAddress: true,
                    installationAddress: true,
                    deliveryAddress: true,
                    billingSameAsInstallation: true,
                    directDiscount: true,
                    internalDeliveryDate: true,
                    priceList: true,
                    paymentTerms: true,
                    commissionNumber: true,
                    currency: true,
                    salespersonName: true,
                    sourceStatus: true,
                    sourceCompany: true,
                    shippingTerms: true,
                    shippingWeight: true,
                    fiscalPosition: true,
                    salesTeam: true,
                    onlineSignature: true,
                    onlinePayment: true,
                    coverLetter: true,
                    sourceTotal: true,
                    sourceNetAmount: true,
                    sourceTaxAmount: true,
                    sourceRecurringTotal: true,
                    sourceMargin: true,
                    offerMailSentAt: true,
                    offerAcceptedAt: true,
                    offerMailRecipient: true,
                    offerAcceptanceToken: true,
                    customer: { select: { companyName: true } },
                    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                    positions: {
                        select: {
                            quantity: true,
                            unitPrice: true,
                            discount: true,
                            calculation: { select: { totalCalculatedPrice: true } },
                        }
                    }
                },
                orderBy,
                ...(page && pageSize ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
            }),
            page && pageSize ? prisma_client_1.default.tender.count({ where }) : Promise.resolve(0),
        ]);
        const items = data.map((d) => {
            const grandTotal = d.positions.reduce((sum, p) => {
                const qty = p.quantity ?? 0;
                const price = p.unitPrice;
                const disc = p.discount ?? 0;
                if (price != null && qty > 0) {
                    return sum + qty * price * (1 - disc / 100);
                }
                return sum + Math.max(0, p.calculation?.totalCalculatedPrice ?? 0);
            }, 0);
            const item = this.mapToEntity(d);
            item.customerName = d.customer?.companyName ?? null;
            item.createdByName = d.createdBy
                ? `${d.createdBy.firstName} ${d.createdBy.lastName}`.trim()
                : null;
            item.createdByEmail = d.createdBy?.email ?? null;
            item.positionCount = d.positions.length;
            item.grandTotal = grandTotal;
            return item;
        });
        if (page && pageSize) {
            return {
                items,
                total,
                page,
                pageSize,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
            };
        }
        return items;
    }
    async delete(id, tenantId) {
        await prisma_client_1.default.$transaction(async (tx) => {
            // Only delete when the tender belongs to this tenant.
            const owned = await tx.tender.findFirst({
                where: { id, tenantId },
                select: { id: true }
            });
            if (!owned) {
                throw new Error("Teklif bulunamadı veya bu şirkete ait değil.");
            }
            const positions = await tx.position.findMany({
                where: { tenderId: id },
                select: { id: true }
            });
            const positionIds = positions.map(p => p.id);
            if (positionIds.length > 0) {
                await tx.positionArticleMapping.deleteMany({ where: { positionId: { in: positionIds } } });
                await tx.calculationItem.deleteMany({ where: { positionId: { in: positionIds } } });
                await tx.position.deleteMany({ where: { tenderId: id } });
            }
            await tx.tender.delete({ where: { id } });
        });
    }
    async updateStatus(id, status, tenantId) {
        // Update only the row matching id + tenantId; if nothing matched the
        // tender either doesn't exist or belongs to another tenant.
        const result = await prisma_client_1.default.tender.updateMany({
            where: { id, tenantId },
            data: { status }
        });
        if (result.count === 0) {
            throw new Error("Teklif bulunamadı veya bu şirkete ait değil.");
        }
        const data = await prisma_client_1.default.tender.findUniqueOrThrow({ where: { id } });
        return this.mapToEntity(data);
    }
    async createNextVersion(tenderId, newCreatedBy, tenantId) {
        const existingTender = await prisma_client_1.default.tender.findFirst({
            where: { id: tenderId, tenantId },
            include: {
                positions: {
                    include: {
                        calculation: true,
                        articleMappings: true,
                    }
                }
            }
        });
        if (!existingTender)
            throw new Error("Kopyalanacak teklif bulunamadı.");
        const newTenderId = (0, nanoid_1.nanoid)(10);
        const newVersion = existingTender.version + 1;
        const result = await prisma_client_1.default.$transaction(async (tx) => {
            const createdTender = await tx.tender.create({
                data: {
                    id: newTenderId,
                    tenantId: existingTender.tenantId,
                    customerId: existingTender.customerId,
                    tenderNumber: existingTender.tenderNumber,
                    version: newVersion,
                    format: existingTender.format,
                    status: 'Draft',
                    createdByEmployeeId: newCreatedBy,
                    validUntil: existingTender.validUntil,
                    sourceCreatedAt: existingTender.sourceCreatedAt,
                    orderDate: existingTender.orderDate,
                    billingAddress: existingTender.billingAddress,
                    installationAddress: existingTender.installationAddress,
                    deliveryAddress: existingTender.deliveryAddress,
                    billingSameAsInstallation: existingTender.billingSameAsInstallation,
                    directDiscount: existingTender.directDiscount,
                    internalDeliveryDate: existingTender.internalDeliveryDate,
                    priceList: existingTender.priceList,
                    paymentTerms: existingTender.paymentTerms,
                    commissionNumber: existingTender.commissionNumber,
                    currency: existingTender.currency,
                    salespersonName: existingTender.salespersonName,
                    sourceStatus: existingTender.sourceStatus,
                    sourceCompany: existingTender.sourceCompany,
                    shippingTerms: existingTender.shippingTerms,
                    shippingWeight: existingTender.shippingWeight,
                    fiscalPosition: existingTender.fiscalPosition,
                    salesTeam: existingTender.salesTeam,
                    onlineSignature: existingTender.onlineSignature,
                    onlinePayment: existingTender.onlinePayment,
                    coverLetter: existingTender.coverLetter,
                    sourceTotal: existingTender.sourceTotal,
                    sourceNetAmount: existingTender.sourceNetAmount,
                    sourceTaxAmount: existingTender.sourceTaxAmount,
                    sourceRecurringTotal: existingTender.sourceRecurringTotal,
                    sourceMargin: existingTender.sourceMargin,
                    projectId: existingTender.projectId,
                }
            });
            const idMapping = new Map();
            for (const pos of existingTender.positions) {
                const newPosId = (0, nanoid_1.nanoid)(10);
                idMapping.set(pos.id, newPosId);
            }
            for (const pos of existingTender.positions) {
                const newPosId = idMapping.get(pos.id);
                const newParentId = pos.parentPositionId ? idMapping.get(pos.parentPositionId) || null : null;
                await tx.position.create({
                    data: {
                        id: newPosId,
                        tenantId: pos.tenantId,
                        tenderId: newTenderId,
                        parentPositionId: newParentId,
                        rowType: pos.rowType || 'SECTION',
                        sourceArticleId: pos.sourceArticleId || null,
                        displayOrder: pos.displayOrder ?? 0,
                        npkCode: pos.npkCode || null,
                        positionNumber: pos.positionNumber,
                        shortDescription: pos.shortDescription,
                        longDescription: pos.longDescription || null,
                        quantity: pos.quantity,
                        unit: pos.unit || null,
                        hierarchyLevel: pos.hierarchyLevel,
                        unitPrice: pos.unitPrice,
                        discount: pos.discount,
                        taxRate: pos.taxRate,
                        imageUrl: pos.imageUrl,
                    }
                });
                if (pos.calculation) {
                    await tx.calculationItem.create({
                        data: {
                            id: (0, nanoid_1.nanoid)(8),
                            positionId: newPosId,
                            materialCost: pos.calculation.materialCost,
                            laborCost: pos.calculation.laborCost,
                            overheadCost: pos.calculation.overheadCost,
                            riskAmount: pos.calculation.riskAmount,
                            additionalCost: pos.calculation.additionalCost || 0,
                            profitMargin: pos.calculation.profitMargin,
                            totalCalculatedPrice: pos.calculation.totalCalculatedPrice
                        }
                    });
                }
                if (pos.articleMappings && pos.articleMappings.length > 0) {
                    for (const mapping of pos.articleMappings) {
                        await tx.positionArticleMapping.create({
                            data: {
                                id: (0, nanoid_1.nanoid)(10),
                                positionId: newPosId,
                                articleId: mapping.articleId,
                                quantityMultiplier: mapping.quantityMultiplier,
                                discount: mapping.discount ?? 0,
                            }
                        });
                    }
                }
            }
            return createdTender;
        });
        return this.mapToEntity(result);
    }
}
exports.TenderRepository = TenderRepository;
//# sourceMappingURL=TenderRepository.js.map