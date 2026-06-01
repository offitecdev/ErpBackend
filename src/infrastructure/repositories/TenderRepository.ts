

import prisma from "../database/prisma.client";
import { ITenderRepository, ITenderFilter, TenderListItem } from "../../domain/repositories/ITenderRepository";
import { Tender } from "../../domain/entities/Tender";
import { nanoid } from "nanoid";

export class TenderRepository implements ITenderRepository {

    private mapToEntity(data: any): Tender {
        return new Tender(
            data.id, data.tenantId, data.customerId, data.tenderNumber,
            data.version, data.format, data.status, data.createdByEmployeeId,
            data.createdAt, data.projectId, data.validUntil,
            data.offerMailSentAt, data.offerAcceptedAt, data.offerMailRecipient, data.offerAcceptanceToken
        );
    }

    async create(tenderData: Partial<Tender>): Promise<Tender> {
        const data = await prisma.tender.create({
            data: tenderData as any
        });
        return this.mapToEntity(data);
    }

    async findById(id: string): Promise<Tender | null> {
        const data = await prisma.tender.findUnique({
            where: { id },
            include: {
                customer: { select: { id: true, companyName: true, address: true, mainPhone: true, mainEmail: true, taxNumber: true } },
                createdBy: { select: { id: true, firstName: true, lastName: true, email: true } }
            }
        });
        if (!data) return null;
        const entity: any = this.mapToEntity(data);
        entity.customerName = (data as any).customer?.companyName ?? null;
        entity.customerAddress = (data as any).customer?.address ?? null;
        entity.customerEmail = (data as any).customer?.mainEmail ?? null;
        entity.customerPhone = (data as any).customer?.mainPhone ?? null;
        entity.customerTaxNumber = (data as any).customer?.taxNumber ?? null;
        entity.createdByName = (data as any).createdBy
            ? `${(data as any).createdBy.firstName} ${(data as any).createdBy.lastName}`
            : null;
        entity.createdByEmail = (data as any).createdBy?.email ?? null;
        return entity;
    }

    async findAll(filter: ITenderFilter): Promise<TenderListItem[] | { items: TenderListItem[]; total: number; page: number; pageSize: number; totalPages: number }> {
        const where: any = { tenantId: filter.tenantId };
        if (filter.customerId) where.customerId = filter.customerId;
        if (filter.status) where.status = filter.status;
        if (filter.search) {
            where.OR = [
                { tenderNumber: { contains: filter.search } },
            ];
        }

        const page = filter.page && filter.page > 0 ? filter.page : undefined;
        const pageSize = filter.pageSize && filter.pageSize > 0 ? Math.min(filter.pageSize, 100) : undefined;
        const [data, total] = await Promise.all([
            (prisma as any).tender.findMany({
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
                offerMailSentAt: true,
                offerAcceptedAt: true,
                offerMailRecipient: true,
                offerAcceptanceToken: true,
                customer: { select: { companyName: true } },
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
            page && pageSize ? prisma.tender.count({ where }) : Promise.resolve(0),
        ]);

        const items = data.map((d: any) => {
            const grandTotal = d.positions.reduce((sum: number, p: any) => {
                const qty = p.quantity ?? 0;
                const price = p.unitPrice;
                const disc = p.discount ?? 0;
                if (price != null && qty > 0) {
                    return sum + qty * price * (1 - disc / 100);
                }
                return sum + Math.max(0, p.calculation?.totalCalculatedPrice ?? 0);
            }, 0);
            const item: any = this.mapToEntity(d);
            item.customerName = d.customer?.companyName ?? null;
            item.positionCount = d.positions.length;
            item.grandTotal = grandTotal;
            return item as TenderListItem;
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

    async delete(id: string): Promise<void> {
        await prisma.$transaction(async (tx) => {
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

    async updateStatus(id: string, status: 'Draft' | 'Approved' | 'Exported'): Promise<Tender> {
        const data = await prisma.tender.update({
            where: { id },
            data: { status }
        });
        return this.mapToEntity(data);
    }

    async createNextVersion(tenderId: string, newCreatedBy: string): Promise<Tender> {
        const existingTender = await prisma.tender.findUnique({
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

        if (!existingTender) throw new Error("Kopyalanacak teklif bulunamadı.");

        const newTenderId = nanoid(10);
        const newVersion = existingTender.version + 1;

        const result = await prisma.$transaction(async (tx) => {
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
                    projectId: existingTender.projectId,
                }
            });

            const idMapping = new Map<string, string>(); 

            for (const pos of existingTender.positions) {
                const newPosId = nanoid(10);
                idMapping.set(pos.id, newPosId);
            }

            for (const pos of existingTender.positions) {
                const newPosId = idMapping.get(pos.id)!;
                const newParentId = pos.parentPositionId ? idMapping.get(pos.parentPositionId) || null : null;

                await tx.position.create({
                    data: {
                        id: newPosId,
                        tenantId: pos.tenantId,
                        tenderId: newTenderId,
                        parentPositionId: newParentId,
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
                            id: nanoid(8),
                            positionId: newPosId,
                            materialCost: pos.calculation.materialCost,
                            laborCost: pos.calculation.laborCost,
                            overheadCost: pos.calculation.overheadCost,
                            riskAmount: pos.calculation.riskAmount,
                            profitMargin: pos.calculation.profitMargin,
                            totalCalculatedPrice: pos.calculation.totalCalculatedPrice
                        }
                    });
                }

                if (pos.articleMappings && pos.articleMappings.length > 0) {
                    for (const mapping of pos.articleMappings) {
                        await tx.positionArticleMapping.create({
                            data: {
                                id: nanoid(10),
                                positionId: newPosId,
                                articleId: mapping.articleId,
                                quantityMultiplier: mapping.quantityMultiplier,
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
