"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenderRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Tender_1 = require("../../domain/entities/Tender");
const nanoid_1 = require("nanoid");
class TenderRepository {
    mapToEntity(data) {
        return new Tender_1.Tender(data.id, data.tenantId, data.customerId, data.tenderNumber, data.version, data.format, data.status, data.createdByEmployeeId, data.createdAt, data.projectId, data.validUntil, data.offerMailSentAt, data.offerAcceptedAt, data.offerMailRecipient, data.offerAcceptanceToken, data.sourceCreatedAt, data.orderDate, data.billingAddress, data.deliveryAddress, data.internalDeliveryDate, data.priceList, data.paymentTerms, data.commissionNumber, data.salespersonName, data.sourceStatus, data.sourceCompany, data.shippingTerms, data.shippingWeight, data.fiscalPosition, data.salesTeam, data.onlineSignature, data.onlinePayment, data.coverLetter, data.sourceTotal, data.sourceNetAmount, data.sourceTaxAmount, data.sourceRecurringTotal, data.sourceMargin);
    }
    async create(tenderData) {
        const data = await prisma_client_1.default.tender.create({
            data: tenderData
        });
        return this.mapToEntity(data);
    }
    async findById(id) {
        const data = await prisma_client_1.default.tender.findUnique({
            where: { id },
            include: {
                customer: { select: { id: true, companyName: true, address: true, mainPhone: true, mainEmail: true, taxNumber: true } },
                createdBy: { select: { id: true, firstName: true, lastName: true, email: true } }
            }
        });
        if (!data)
            return null;
        const entity = this.mapToEntity(data);
        entity.customerName = data.customer?.companyName ?? null;
        entity.customerAddress = data.customer?.address ?? null;
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
                    deliveryAddress: true,
                    internalDeliveryDate: true,
                    priceList: true,
                    paymentTerms: true,
                    commissionNumber: true,
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
                orderBy: { createdAt: 'desc' },
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
    async delete(id) {
        await prisma_client_1.default.$transaction(async (tx) => {
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
    async updateStatus(id, status) {
        const data = await prisma_client_1.default.tender.update({
            where: { id },
            data: { status }
        });
        return this.mapToEntity(data);
    }
    async createNextVersion(tenderId, newCreatedBy) {
        const existingTender = await prisma_client_1.default.tender.findUnique({
            where: { id: tenderId },
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
                    deliveryAddress: existingTender.deliveryAddress,
                    internalDeliveryDate: existingTender.internalDeliveryDate,
                    priceList: existingTender.priceList,
                    paymentTerms: existingTender.paymentTerms,
                    commissionNumber: existingTender.commissionNumber,
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