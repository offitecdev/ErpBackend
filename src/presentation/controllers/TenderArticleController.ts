import { Request, Response } from 'express';
import { MapArticleToPositionUseCase } from '../../application/use-cases/tender/MapArticleToPositionUseCase';
import { IArticleRepository } from '../../domain/repositories/IArticleRepository';
import { IPositionRepository } from '../../domain/repositories/IPositionRepository';
import { ITenderRepository } from '../../domain/repositories/ITenderRepository';
import { TenderActivityLogRepository } from '../../infrastructure/repositories/TenderActivityLogRepository';
import prisma from '../../infrastructure/database/prisma.client';
import { nanoid } from 'nanoid';

export class TenderArticleController {
    constructor(
        private mapArticleUseCase: MapArticleToPositionUseCase,
        private articleRepository: IArticleRepository,
        private positionRepository: IPositionRepository,
        private tenderRepository: ITenderRepository,
        private tenderLogRepo: TenderActivityLogRepository,
    ) {}

    async mapArticle(req: Request, res: Response) {
        try {
            const { id: tenderId, positionId } = req.params;
            const { articleId, quantityMultiplier, discount, sourceLocationId, autoConsumeStock } = req.body;
            const tenantId = (req as any).user?.tenantId;
            const employeeId = (req as any).user?.id;

            if (!tenderId || !positionId || !articleId || quantityMultiplier === undefined) {
                return res.status(400).json({ error: "ÃœrÃ¼n ID ve Miktar (quantityMultiplier) zorunludur." });
            }

            const result = await this.mapArticleUseCase.execute({
                tenderId: tenderId as string,
                positionId: positionId as string,
                articleId,
                quantityMultiplier: Number(quantityMultiplier),
                discount: discount ? Number(discount) : 0,
                sourceLocationId: sourceLocationId || null,
                autoConsumeStock: !!autoConsumeStock,
                tenantId,
                employeeId,
            });

            const mappedArticle = result.mapping?.article;
            const targetPosition = await prisma.position.findUnique({
                where: { id: positionId as string },
                select: { shortDescription: true },
            });
            const positionLabel = targetPosition
                ? targetPosition.shortDescription
                : positionId;
            const unit = mappedArticle?.unit || 'adet';

            void this.tenderLogRepo.create({
                tenantId,
                tenderId: tenderId as string,
                positionId: positionId as string,
                mappingId: result.mapping?.id ?? null,
                articleId,
                employeeId,
                actionType: "ARTICLE_MAPPED",
                fieldName: "quantityMultiplier",
                oldValue: null,
                newValue: String(quantityMultiplier),
                description: `${mappedArticle?.name ?? 'Ürün'} ürünü ${positionLabel} satırına ${quantityMultiplier} ${unit} olarak eklendi.${autoConsumeStock ? ' Seçilen lokasyondan stoktan düşüldü.' : ''}${discount ? ` İndirim: %${discount}.` : ''}`,
            }).catch((error) => {
                console.error('[mapArticle] log write failed:', error);
            });

            res.status(200).json({
                message: "KullanÄ±lan malzeme baÅŸarÄ±yla eklendi. Fiyat toplamÄ±na dahil edilmedi.",
                ...result
            });
        } catch (error: any) {
            console.error('[mapArticle] error:', error);
            res.status(400).json({ error: error.message });
        }
    }

    async updateArticleMapping(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const positionId = req.params.positionId as string;
            const mappingId = req.params.mappingId as string;
            const tenantId = (req as any).user?.tenantId;
            const employeeId = (req as any).user?.id;
            const { quantityMultiplier, discount } = req.body;

            const before = await prisma.positionArticleMapping.findUnique({
                where: { id: mappingId },
                select: {
                    id: true,
                    positionId: true,
                    articleId: true,
                    quantityMultiplier: true,
                    discount: true,
                    article: {
                        select: {
                            id: true,
                            tenantId: true,
                            articleCode: true,
                            name: true,
                            description: true,
                            baseCost: true,
                            salePrice: true,
                            unit: true,
                            category: true,
                            status: true,
                            isActive: true,
                            minStockLevel: true,
                            criticalStockLevel: true,
                            maxStockLevel: true,
                            lastPurchaseDate: true,
                        },
                    },
                    position: {
                        select: {
                            tenderId: true,
                            calculation: true,
                            tender: { select: { status: true } },
                        },
                    },
                },
            });
            if (!before) return res.status(404).json({ error: "ÃƒÅ“rÃƒÂ¼n eÃ…Å¸leÃ…Å¸tirmesi bulunamadÃ„Â±." });
            if (before.positionId !== positionId || before.position.tenderId !== tenderId) {
                return res.status(404).json({ error: "ÃƒÅ“rÃƒÂ¼n eÃ…Å¸leÃ…Å¸tirmesi bu teklife ait deÄŸil." });
            }
            if (before.position.tender.status !== 'Draft') {
                return res.status(403).json({ error: "OnaylanmÃ„Â±Ã…Å¸ tekliflerdeki ÃƒÂ¼rÃƒÂ¼n eÃ…Å¸leÃ…Å¸tirmeleri gÃƒÂ¼ncellenemez." });
            }

            const patch: { quantityMultiplier?: number; discount?: number | null } = {};
            if (quantityMultiplier !== undefined) patch.quantityMultiplier = Number(quantityMultiplier);
            if (discount !== undefined) patch.discount = discount === null ? null : Number(discount);

            const updatedCalculation = before.position.calculation ?? null;

            const updatedCore = await prisma.$transaction(async (tx) => {
                const updatedMapping = await tx.positionArticleMapping.update({
                    where: { id: mappingId },
                    data: {
                        ...(patch.quantityMultiplier !== undefined ? { quantityMultiplier: patch.quantityMultiplier } : {}),
                        ...(patch.discount !== undefined ? { discount: patch.discount ?? 0 } : {}),
                    },
                    select: {
                        id: true,
                        positionId: true,
                        articleId: true,
                        quantityMultiplier: true,
                        discount: true,
                    },
                });

                return updatedMapping;
            });
            const updated = { ...updatedCore, article: before.article };

            const logs = [];
            if (quantityMultiplier !== undefined && Number(before.quantityMultiplier) !== Number(updated.quantityMultiplier)) {
                logs.push({
                    tenantId,
                    tenderId,
                    positionId,
                    mappingId,
                    articleId: updated.articleId,
                    employeeId,
                    actionType: "ARTICLE_MAPPING_PRICE_UPDATED",
                    fieldName: "quantityMultiplier",
                    oldValue: String(before.quantityMultiplier),
                    newValue: String(updated.quantityMultiplier),
                    description: `${updated.article?.name ?? 'Ürün'} ürününün teklif miktarı ${before.quantityMultiplier} ${updated.article?.unit ?? 'adet'} değerinden ${updated.quantityMultiplier} ${updated.article?.unit ?? 'adet'} değerine değiştirildi.`
                });
            }
            if (discount !== undefined && Number(before.discount ?? 0) !== Number(updated.discount ?? 0)) {
                logs.push({
                    tenantId,
                    tenderId,
                    positionId,
                    mappingId,
                    articleId: updated.articleId,
                    employeeId,
                    actionType: "ARTICLE_MAPPING_PRICE_UPDATED",
                    fieldName: "discount",
                    oldValue: String(before.discount ?? 0),
                    newValue: String(updated.discount ?? 0),
                    description: `${updated.article?.name ?? 'Ürün'} ürününün teklif indirimi %${before.discount ?? 0} değerinden %${updated.discount ?? 0} değerine değiştirildi.`
                });
            }
            void this.tenderLogRepo.createMany(logs as any).catch((error) => {
                console.error('[updateArticleMapping] log write failed:', error);
            });

            res.status(200).json({
                message: "ÃƒÅ“rÃƒÂ¼n eÃ…Å¸leÃ…Å¸tirmesi gÃƒÂ¼ncellendi.",
                mapping: updated,
                updatedCalculation,
            });
        } catch (error: any) {
            console.error('[updateArticleMapping] error:', error);
            res.status(400).json({ error: error.message });
        }
    }

    async removeArticleMapping(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const positionId = req.params.positionId as string;
            const mappingId = req.params.mappingId as string;
            const tenantId = (req as any).user?.tenantId;
            const employeeId = (req as any).user?.id;

            const before = await prisma.positionArticleMapping.findUnique({
                where: { id: mappingId },
                select: {
                    id: true,
                    positionId: true,
                    articleId: true,
                    quantityMultiplier: true,
                    discount: true,
                    article: { select: { name: true, unit: true, baseCost: true } },
                    position: {
                        select: {
                            tenderId: true,
                            shortDescription: true,
                            calculation: true,
                            tender: { select: { status: true } },
                        },
                    },
                },
            });
            if (!before) return res.status(404).json({ error: "Ürün eşleştirmesi bulunamadı." });
            if (before.positionId !== positionId || before.position.tenderId !== tenderId) {
                return res.status(404).json({ error: "Ürün eşleştirmesi bu teklife ait değil." });
            }
            if (before.position.tender.status !== 'Draft') {
                return res.status(403).json({ error: "Onaylanmış tekliflerdeki ürün eşleştirmeleri silinemez." });
            }

            const updatedCalculation = before.position.calculation ?? null;

            await prisma.$transaction(async (tx) => {
                await tx.positionArticleMapping.delete({ where: { id: mappingId } });

            });

            if (before) {
                const positionLabel = before.position.shortDescription;
                void this.tenderLogRepo.create({
                    tenantId,
                    tenderId,
                    positionId,
                    mappingId,
                    articleId: before.articleId,
                    employeeId,
                    actionType: "ARTICLE_MAPPING_REMOVED",
                    fieldName: null,
                    oldValue: before.article?.name ?? before.articleId,
                    newValue: null,
                    description: `${before.article?.name ?? 'Ürün'} ürünü ${positionLabel} satırından kaldırıldı. ${before.quantityMultiplier} ${before.article?.unit ?? 'adet'} için iade/silme işlemi tamamlandı.`
                }).catch((error) => {
                    console.error('[removeArticleMapping] log write failed:', error);
                });
            }

            res.status(200).json({
                message: "Kullanılan malzeme kaldırıldı. Fiyat toplamı değişmedi.",
                mappingId,
                positionId,
                updatedCalculation,
            });

        } catch (error: any) {
            console.error('[removeArticleMapping] error:', error);
            res.status(400).json({ error: error.message });
        }
    }

    async mapMaterial(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tenantId = (req as any).user?.tenantId;
            const employeeId = (req as any).user?.id;
            const { materialId, quantity, description } = req.body;

            if (!materialId || quantity === undefined) {
                return res.status(400).json({ error: "Malzeme ID ve miktar zorunludur." });
            }

            const normalizedQuantity = Number(quantity);
            if (normalizedQuantity <= 0) return res.status(400).json({ error: "Miktar 0'dan büyük olmalıdır." });

            const tender = await prisma.tender.findUnique({
                where: { id: tenderId },
                select: { id: true, tenantId: true, status: true },
            });
            if (!tender || tender.tenantId !== tenantId) {
                return res.status(404).json({ error: "Teklif bulunamadı." });
            }
            const material = await prisma.material.findUnique({ where: { id: materialId } });
            if (!material || material.tenantId !== tenantId || !material.isActive) {
                return res.status(404).json({ error: "Malzeme bulunamadı." });
            }
            if (material.stockQuantity < normalizedQuantity) {
                return res.status(400).json({ error: `[Stok uyarısı] ${material.name} için kayıtlı miktar yetersiz.` });
            }

            const usage = await prisma.$transaction(async (tx) => {
                await tx.material.update({
                    where: { id: materialId },
                    data: { stockQuantity: { decrement: normalizedQuantity } },
                });
                return await (tx as any).tenderMaterialUsage.create({
                    data: {
                        id: nanoid(10),
                        tenderId,
                        materialId,
                        quantity: normalizedQuantity,
                        unitCost: material.unitCost,
                        description: description || null,
                    },
                    include: { material: true },
                });
            });

            void this.tenderLogRepo.create({
                tenantId,
                tenderId,
                positionId: null,
                mappingId: usage.id,
                articleId: null,
                employeeId,
                actionType: "MATERIAL_MAPPED",
                fieldName: "quantity",
                oldValue: null,
                newValue: String(normalizedQuantity),
                description: `${material.name} malzemesi teklif ayarlarına ${normalizedQuantity} adet olarak eklendi. Fiyata dahil edilmedi.`,
            }).catch((error) => console.error('[mapMaterial] log write failed:', error));

            res.status(200).json({
                message: "Malzeme eklendi. Fiyat toplamına dahil edilmedi.",
                usage,
            });
        } catch (error: any) {
            console.error('[mapMaterial] error:', error);
            res.status(400).json({ error: error.message });
        }
    }

    async listMaterials(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const tenantId = (req as any).user?.tenantId;
            const tender = await prisma.tender.findUnique({ where: { id: tenderId }, select: { tenantId: true } });
            if (!tender || tender.tenantId !== tenantId) return res.status(404).json({ error: "Teklif bulunamadı." });

            const usages = await (prisma as any).tenderMaterialUsage.findMany({
                where: { tenderId },
                include: { material: true },
                orderBy: { createdAt: 'desc' },
            });
            res.status(200).json(usages);
        } catch (error: any) {
            console.error('[listTenderMaterials] error:', error);
            res.status(400).json({ error: error.message });
        }
    }

    async updateMaterialMapping(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const positionId = req.params.positionId as string;
            const mappingId = req.params.mappingId as string;
            const tenantId = (req as any).user?.tenantId;
            const { quantityMultiplier, discount } = req.body;

            const before = await (prisma as any).positionMaterialMapping.findUnique({
                where: { id: mappingId },
                include: {
                    material: true,
                    position: { include: { tender: { select: { id: true, tenantId: true, status: true } }, calculation: true } },
                },
            });
            if (!before || before.positionId !== positionId || before.position.tender.id !== tenderId || before.position.tender.tenantId !== tenantId) {
                return res.status(404).json({ error: "Malzeme eşleştirmesi bulunamadı." });
            }
            if (before.position.tender.status !== 'Draft') {
                return res.status(403).json({ error: "Onaylanmış tekliflerde malzeme güncellenemez." });
            }

            const patch: any = {};
            if (quantityMultiplier !== undefined) {
                const nextQuantity = Number(quantityMultiplier);
                if (nextQuantity <= 0) return res.status(400).json({ error: "Miktar 0'dan büyük olmalıdır." });
                patch.quantityMultiplier = nextQuantity;
            }
            if (discount !== undefined) patch.discount = discount === null ? 0 : Number(discount);

            const mapping = await (prisma as any).positionMaterialMapping.update({
                where: { id: mappingId },
                data: patch,
                include: { material: true },
            });

            res.status(200).json({
                message: "Malzeme güncellendi. Fiyat toplamı değişmedi.",
                mapping,
                updatedCalculation: before.position.calculation ?? null,
            });
        } catch (error: any) {
            console.error('[updateMaterialMapping] error:', error);
            res.status(400).json({ error: error.message });
        }
    }

    async removeMaterialMapping(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            const mappingId = req.params.mappingId as string;
            const tenantId = (req as any).user?.tenantId;

            const before = await (prisma as any).tenderMaterialUsage.findUnique({
                where: { id: mappingId },
                include: {
                    material: true,
                    tender: { select: { id: true, tenantId: true, status: true } },
                },
            });
            if (!before || before.tender.id !== tenderId || before.tender.tenantId !== tenantId) {
                return res.status(404).json({ error: "Malzeme kaydı bulunamadı." });
            }
            await prisma.$transaction(async (tx) => {
                await (tx as any).tenderMaterialUsage.delete({ where: { id: mappingId } });
                await tx.material.update({
                    where: { id: before.materialId },
                    data: { stockQuantity: { increment: Number(before.quantity || 0) } },
                });
            });

            res.status(200).json({
                message: "Malzeme kaldırıldı. Fiyat toplamı değişmedi.",
                mappingId,
            });
        } catch (error: any) {
            console.error('[removeMaterialMapping] error:', error);
            res.status(400).json({ error: error.message });
        }
    }
}
