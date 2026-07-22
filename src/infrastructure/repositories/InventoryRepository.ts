import prisma from "../database/prisma.client";
import { IInventoryRepository } from "../../domain/repositories/IInventoryRepository";
import { Location, StockBalance, StockMovement, PurchaseProposal } from "../../domain/entities/Inventory";
import { Article } from "../../domain/entities/Article";
import { nanoid } from "nanoid";

const inboundCostMovementTypes = new Set(['IN', 'RETURN', 'ADJUSTMENT']);

// Relations required to compute the weighted-average cost / stock totals shown in
// the article summary. Shared by the full and paginated summary queries.
const articleSummaryInclude = {
    stockBalances: {
        include: { location: { select: { locationName: true, locationType: true } } }
    },
    articleSuppliers: {
        include: {
            supplier: true,
            location: { select: { id: true, locationName: true, locationType: true } }
        },
        orderBy: [{ isPreferred: 'desc' }, { lastPurchaseDate: 'desc' }, { updatedAt: 'desc' }]
    },
    stockMovements: {
        select: {
            id: true,
            movementType: true,
            quantity: true,
            unitCost: true,
            referenceId: true,
            transactionDate: true,
            description: true,
        }
    },
} as const;

const mapArticleToSummary = (a: any, includeImages: boolean) => {
    const costSummary = computeArticleCostSummary(a);
    return {
        id: a.id,
        articleCode: a.articleCode,
        name: a.name,
        description: a.description,
        unit: a.unit,
        baseCost: a.baseCost,
        salePrice: a.salePrice ?? 0,
        defaultSupplierId: a.defaultSupplierId,
        // Base64 images bloat this list response (~1MB+); only embed them
        // when a consumer that actually renders thumbnails asks for them.
        imageUrl: includeImages ? a.imageUrl : null,
        systemBarcode: a.systemBarcode,
        supplierBarcode: a.supplierBarcode,
        isActive: a.isActive,
        status: a.status,
        category: a.category,
        itemType: a.itemType ?? 'PRODUCT',
        minStockLevel: a.minStockLevel,
        criticalStockLevel: a.criticalStockLevel,
        maxStockLevel: a.maxStockLevel,
        lastPurchaseDate: a.lastPurchaseDate,
        totalQuantity: a.stockBalances.reduce((s: number, b: any) => s + (b.currentQuantity || 0), 0),
        totalReserved: a.stockBalances.reduce((s: number, b: any) => s + (b.reservedQuantity || 0), 0),
        balances: a.stockBalances.map((b: any) => ({
            locationId: b.locationId,
            locationName: b.location?.locationName,
            locationType: b.location?.locationType,
            currentQuantity: b.currentQuantity,
            reservedQuantity: b.reservedQuantity,
        })),
        suppliers: a.articleSuppliers,
        ...costSummary,
    };
};

const computeArticleCostSummary = (article: any) => {
    const suppliers = Array.isArray(article.articleSuppliers) ? article.articleSuppliers : [];
    const balances = Array.isArray(article.stockBalances) ? article.stockBalances : [];
    const movements = Array.isArray(article.stockMovements) ? article.stockMovements : [];
    const supplierIds = new Set(suppliers.map((row: any) => row.id));

    const supplierCostQuantity = suppliers.reduce((sum: number, row: any) => sum + Math.max(0, Number(row.quantity || 0)), 0);
    const supplierCostValue = suppliers.reduce(
        (sum: number, row: any) => sum + Math.max(0, Number(row.quantity || 0)) * Math.max(0, Number(row.purchasePrice || 0)),
        0
    );
    const totalQuantity = balances.reduce((sum: number, row: any) => sum + Number(row.currentQuantity || 0), 0);

    const manualUnitCost = Math.max(0, Number(article.baseCost || 0));

    // Manuel stok girişleri: her hareket kendi birim maliyetini taşır (yoksa ürün kartı maliyetine düşer).
    const manualMovements = movements
        .filter((movement: any) => inboundCostMovementTypes.has(String(movement.movementType)))
        .filter((movement: any) => !movement.referenceId || !supplierIds.has(movement.referenceId))
        .filter((movement: any) => !String(movement.description || '').toLocaleLowerCase('tr-TR').startsWith('tedarik'));

    let manualCostQuantity = manualMovements.reduce(
        (sum: number, movement: any) => sum + Math.max(0, Number(movement.quantity || 0)),
        0
    );
    let manualCostValue = manualMovements.reduce((sum: number, movement: any) => {
        const qty = Math.max(0, Number(movement.quantity || 0));
        const unitCost = movement.unitCost != null && Number(movement.unitCost) > 0
            ? Number(movement.unitCost)
            : manualUnitCost;
        return sum + qty * unitCost;
    }, 0);

    // Hareket kaydı olmayan eski/açılış stoğu varsa, kalanı ürün kartı maliyetiyle değerle.
    if (manualCostQuantity <= 0 && totalQuantity > supplierCostQuantity) {
        manualCostQuantity = totalQuantity - supplierCostQuantity;
        manualCostValue = manualCostQuantity * manualUnitCost;
    }

    const costBasisQuantity = supplierCostQuantity + manualCostQuantity;
    const costBasisValue = supplierCostValue + manualCostValue;
    const weightedAverageCost = costBasisQuantity > 0
        ? costBasisValue / costBasisQuantity
        : manualUnitCost;

    return {
        weightedAverageCost,
        costBasisQuantity,
        costBasisValue,
        supplierCostQuantity,
        supplierCostValue,
        manualCostQuantity,
        manualCostValue,
    };
};

export class InventoryRepository implements IInventoryRepository {
    
    async createLocation(locationData: Partial<Location>): Promise<Location> {
        const data = await prisma.location.create({
            data: {
                id: locationData.id || nanoid(8),
                tenantId: locationData.tenantId!,
                locationName: locationData.locationName!,
                locationType: locationData.locationType!,
                parentLocationId: locationData.parentLocationId || null,
                isActive: locationData.isActive ?? true
            }
        });
        return new Location(data.id, data.tenantId, data.locationName, data.locationType as any, data.isActive, data.parentLocationId);
    }

    async getLocations(tenantId: string): Promise<Location[]> {
        const data = await prisma.location.findMany({ where: { tenantId } });
        return data.map(d => new Location(d.id, d.tenantId, d.locationName, d.locationType as any, d.isActive, d.parentLocationId));
    }

    /**
     * Tek global stok modeli için varsayılan ana depoyu bulur, yoksa oluşturur.
     * Lokasyon UI'dan kaldırıldığı için tüm stok hareketleri bu depo üzerinden işlenir.
     */
    async ensureDefaultLocation(tenantId: string): Promise<Location> {
        let data = await prisma.location.findFirst({
            where: { tenantId, locationType: 'MAIN_WAREHOUSE' },
            orderBy: { locationName: 'asc' },
        });
        if (!data) {
            data = await prisma.location.create({
                data: {
                    id: nanoid(8),
                    tenantId,
                    locationName: 'Ana Depo',
                    locationType: 'MAIN_WAREHOUSE',
                    isActive: true,
                },
            });
        }
        return new Location(data.id, data.tenantId, data.locationName, data.locationType as any, data.isActive, data.parentLocationId);
    }

    async getStockBalance(articleId: string, locationId: string): Promise<StockBalance | null> {
        const data = await prisma.stockBalance.findUnique({
            where: { articleId_locationId: { articleId, locationId } }
        });
        if (!data) return null;
        return new StockBalance(data.id, data.tenantId, data.articleId, data.locationId, data.currentQuantity, data.reservedQuantity, data.updatedAt);
    }

    async getAllBalances(tenantId: string, locationId?: string): Promise<any[]> {
        const where: any = { tenantId };
        if (locationId) where.locationId = locationId;

        return await (prisma as any).stockBalance.findMany({
            where,
            include: {
                article: { select: { id: true, articleCode: true, name: true, unit: true, baseCost: true, salePrice: true, minStockLevel: true, criticalStockLevel: true, imageUrl: true, systemBarcode: true } },
                location: { select: { locationName: true, locationType: true } }
            }
        });
    }

    async getArticleStockSummary(tenantId: string, includeImages = false): Promise<any[]> {
        const articles = await (prisma as any).article.findMany({
            where: { tenantId },
            include: articleSummaryInclude,
        });
        return articles.map((a: any) => mapArticleToSummary(a, includeImages));
    }

    // Tek ürünün yalın stok bilgisi: yalnızca toplam adet, stok eşikleri ve ağırlıklı
    // ortalama maliyet dökümü. Lokasyon/depo objeleri, tedarikçi listesi ve görsel
    // ÇEKİLMEZ — stok hareketi ekranındaki canlı sayaç için gereken en az veri.
    async getArticleStockInfo(tenantId: string, articleId: string): Promise<any | null> {
        const article = await (prisma as any).article.findFirst({
            where: { id: articleId, tenantId },
            select: {
                id: true,
                baseCost: true,
                minStockLevel: true,
                criticalStockLevel: true,
                maxStockLevel: true,
                stockBalances: { select: { currentQuantity: true } },
                articleSuppliers: { select: { id: true, quantity: true, purchasePrice: true } },
                stockMovements: {
                    select: { movementType: true, quantity: true, unitCost: true, referenceId: true, description: true },
                },
            },
        });
        if (!article) return null;

        const cost = computeArticleCostSummary(article);
        return {
            id: article.id,
            totalQuantity: article.stockBalances.reduce((s: number, b: any) => s + (b.currentQuantity || 0), 0),
            minStockLevel: article.minStockLevel,
            criticalStockLevel: article.criticalStockLevel,
            maxStockLevel: article.maxStockLevel ?? null,
            ...cost,
        };
    }

    /**
     * Ürün LİSTE ekranı için yalın, sayfalı sorgu (varsayılan 15). Yalnızca
     * tabloda gösterilen alanlar + kayda bağlanmak için id döner — görseller,
     * tedarikçiler, hareketler ve maliyet dökümü ÇEKİLMEZ (aşırı veri çekmemek
     * için). Ürün detayı ayrı bir uçtan (getById) yüklenir.
     */
    async getArticleStockSummaryPaged(
        tenantId: string,
        options: {
            page?: number;
            pageSize?: number;
            search?: string | undefined;
            status?: string | undefined;
            itemType?: string | undefined;
            includeDescription?: boolean;
            code?: string | undefined;
            name?: string | undefined;
            barcode?: string | undefined;
        }
    ): Promise<{ items: any[]; total: number; page: number; pageSize: number }> {
        const page = Math.max(1, Number(options.page) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(options.pageSize) || 15));

        const where: any = { tenantId };
        if (options.itemType) where.itemType = options.itemType;
        if (options.status) where.status = options.status;
        const search = String(options.search || '').trim();
        if (search) {
            where.OR = [
                { articleCode: { contains: search } },
                { name: { contains: search } },
                { systemBarcode: { contains: search } },
                { supplierBarcode: { contains: search } },
                { category: { contains: search } },
            ];
        }
        // Kolon bazlı filtreler — genel aramanın (OR) üstüne AND olarak daraltır.
        const columnFilters: any[] = [];
        const code = String(options.code || '').trim();
        if (code) columnFilters.push({ articleCode: { contains: code } });
        const name = String(options.name || '').trim();
        if (name) columnFilters.push({ name: { contains: name } });
        const barcode = String(options.barcode || '').trim();
        if (barcode) {
            columnFilters.push({
                OR: [
                    { systemBarcode: { contains: barcode } },
                    { supplierBarcode: { contains: barcode } },
                ],
            });
        }
        if (columnFilters.length) where.AND = columnFilters;

        const [total, articles] = await Promise.all([
            (prisma as any).article.count({ where }),
            (prisma as any).article.findMany({
                where,
                select: {
                    id: true,
                    articleCode: true,
                    name: true,
                    ...(options.includeDescription ? { description: true } : {}),
                    category: true,
                    itemType: true,
                    systemBarcode: true,
                    supplierBarcode: true,
                    unit: true,
                    salePrice: true,
                    baseCost: true,
                    status: true,
                    minStockLevel: true,
                    criticalStockLevel: true,
                    // Only the quantity is needed for the "in stock" column — no
                    // location objects, reservations or movement history.
                    stockBalances: { select: { currentQuantity: true } },
                },
                orderBy: { name: 'asc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
        ]);

        return {
            items: articles.map((a: any) => ({
                id: a.id,
                articleCode: a.articleCode,
                name: a.name,
                ...(options.includeDescription ? { description: a.description ?? null } : {}),
                category: a.category,
                itemType: a.itemType ?? 'PRODUCT',
                systemBarcode: a.systemBarcode,
                supplierBarcode: a.supplierBarcode,
                unit: a.unit,
                salePrice: a.salePrice ?? 0,
                baseCost: a.baseCost,
                status: a.status,
                minStockLevel: a.minStockLevel,
                criticalStockLevel: a.criticalStockLevel,
                totalQuantity: a.stockBalances.reduce((s: number, b: any) => s + (b.currentQuantity || 0), 0),
            })),
            total,
            page,
            pageSize,
        };
    }

    async findArticleByBarcodeOrCode(tenantId: string, codeOrBarcode: string): Promise<Article | null> {
        const data = await prisma.article.findFirst({
            where: {
                tenantId,
                OR: [
                    { systemBarcode: codeOrBarcode },
                    { supplierBarcode: codeOrBarcode },
                    { articleCode: codeOrBarcode }
                ]
            }
        });

        if (!data) return null;
        return new Article(
            data.id,
            data.tenantId,
            data.articleCode,
            data.name,
            data.baseCost,
            data.unit,
            data.description,
            data.systemBarcode,
            data.supplierBarcode,
            data.imageUrl,
            (data as any).category,
            ((data as any).status as any) ?? 'ACTIVE',
            data.isActive,
            data.minStockLevel,
            data.criticalStockLevel,
            data.maxStockLevel,
            (data as any).lastPurchaseDate,
            (data as any).salePrice ?? 0,
            (data as any).defaultSupplierId ?? null
        );
    }

    async processMovement(
        movementData: Partial<StockMovement>, 
        articleId: string,
        sourceLocationId: string | null,
        destLocationId: string | null,
        quantity: number
    ): Promise<StockMovement> {
        const result = await prisma.$transaction(async (tx) => {
            
            if (sourceLocationId) {
                const sourceBalance = await tx.stockBalance.findUnique({
                    where: { articleId_locationId: { articleId, locationId: sourceLocationId } }
                });

                if (!sourceBalance || sourceBalance.currentQuantity < quantity) {
                    if(movementData.movementType !== 'ADJUSTMENT') {
                        throw new Error(`[BLOCKED] Kaynak lokasyonda yeterli stok yok. Mevcut: ${sourceBalance?.currentQuantity || 0}, İstenen: ${quantity}`);
                    }
                }

                await tx.stockBalance.upsert({
                    where: { articleId_locationId: { articleId, locationId: sourceLocationId } },
                    update: { currentQuantity: { decrement: quantity } },
                    create: { id: nanoid(10), tenantId: movementData.tenantId!, articleId, locationId: sourceLocationId, currentQuantity: -quantity } // Sadece Adjustment eksiye düşürebilir
                });
            }

            if (destLocationId) {
                await tx.stockBalance.upsert({
                    where: { articleId_locationId: { articleId, locationId: destLocationId } },
                    update: { currentQuantity: { increment: quantity } },
                    create: { id: nanoid(10), tenantId: movementData.tenantId!, articleId, locationId: destLocationId, currentQuantity: quantity }
                });
            }

            // Birim maliyet yalnızca stok girişi yapan hareketlerde anlamlıdır (ağırlıklı ortalama için).
            const rawUnitCost = (movementData as any).unitCost;
            const unitCost = inboundCostMovementTypes.has(String(movementData.movementType)) && rawUnitCost != null && Number(rawUnitCost) > 0
                ? Number(rawUnitCost)
                : null;

            const movement = await tx.stockMovement.create({
                data: {
                    id: nanoid(12),
                    tenantId: movementData.tenantId!,
                    articleId,
                    movementType: movementData.movementType as any,
                    quantity,
                    unitCost,
                    sourceLocationId,
                    destinationLocationId: destLocationId,
                    employeeId: movementData.employeeId!,
                    supplierId: (movementData as any).supplierId || null,
                    referenceId: movementData.referenceId || null,
                    description: movementData.description || null,
                }
            });

            return movement;
        });

        return new StockMovement(result.id, result.tenantId, result.articleId, result.movementType as any, result.quantity, result.employeeId, result.transactionDate, result.sourceLocationId, result.destinationLocationId, result.referenceId || undefined, result.description || undefined, (result as any).unitCost ?? undefined, (result as any).supplierId ?? undefined);
    }

    async getMovements(articleId: string): Promise<StockMovement[]> {
        const data = await prisma.stockMovement.findMany({
            where: { articleId },
            orderBy: { transactionDate: 'desc' },
            include: {
                employee: { select: { firstName: true, lastName: true } },
                supplier: { select: { companyName: true } },
            }
        });
        return data.map(d => {
            const m: any = new StockMovement(d.id, d.tenantId, d.articleId, d.movementType as any, d.quantity, d.employeeId, d.transactionDate, d.sourceLocationId, d.destinationLocationId, d.referenceId || undefined, d.description || undefined, (d as any).unitCost ?? undefined, (d as any).supplierId ?? undefined);
            m.employee = (d as any).employee;
            m.supplier = (d as any).supplier;
            return m;
        });
    }

    async createPurchaseProposal(proposal: Partial<PurchaseProposal>): Promise<PurchaseProposal> {
        const data = await prisma.purchaseProposal.create({
            data: {
                id: nanoid(8),
                tenantId: proposal.tenantId!,
                articleId: proposal.articleId!,
                proposedQuantity: proposal.proposedQuantity!,
                supplierId: proposal.supplierId || null,
                status: 'PENDING'
            }
        });
        return new PurchaseProposal(data.id, data.tenantId, data.articleId, data.proposedQuantity, data.status as any, data.createdAt, data.supplierId);
    }

    async getPendingProposals(tenantId: string): Promise<PurchaseProposal[]> {
        const data = await prisma.purchaseProposal.findMany({
            where: { tenantId, status: 'PENDING' },
            include: { article: { select: { articleCode: true, name: true, imageUrl: true } } }
        });
        return data.map(d => new PurchaseProposal(d.id, d.tenantId, d.articleId, d.proposedQuantity, d.status as any, d.createdAt, d.supplierId));
    }

    async resolveProposal(proposalId: string, status: 'APPROVED' | 'REJECTED', employeeId: string): Promise<void> {
        await prisma.purchaseProposal.update({
            where: { id: proposalId },
            data: {
                status,
                resolvedAt: new Date(),
                resolvedByEmpId: employeeId
            }
        });
    }
}
