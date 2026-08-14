import { nanoid } from 'nanoid';

/**
 * Ürün stoğu düzeltmesi — malzeme/ürün birleşmesinin (2026-08-14) ortak yolu.
 *
 * Eski Material tablosu stoğu tek bir skalar alanda tutar ve saha akışları onu
 * doğrudan artırıp azaltırdı. Article stoğu ise StockBalance + StockMovement
 * ikilisinde yaşar; bu yardımcı, MEVCUT bir transaction içinde her düzeltme için
 * bir hareket satırı yazar ve ana depo bakiyesini günceller.
 *
 * Eski davranışla bilinçli uyum: OUT yönü bakiyeyi negatife düşürebilir —
 * saha kayıtları (Zusatzmaterial, rapor malzemesi) stok yetersiz diye
 * engellenmez; uyarı eşiği kullanıcı arayüzündedir.
 */
export type ArticleStockTx = {
    location: any;
    stockBalance: any;
    stockMovement: any;
};

export const adjustArticleStock = async (
    tx: ArticleStockTx,
    opts: {
        tenantId: string;
        articleId: string;
        employeeId: string;
        /** Pozitif miktar; yön `direction` ile belirlenir. */
        quantity: number;
        direction: 'IN' | 'OUT';
        /** Yalnızca IN hareketlerinde ağırlıklı ortalamaya girer. */
        unitCost?: number | null;
        referenceId?: string | null;
        description?: string | null;
    },
): Promise<void> => {
    const quantity = Number(opts.quantity) || 0;
    if (quantity <= 0) return;

    // Ana depo — yoksa oluşturulur (InventoryRepository.ensureDefaultLocation
    // ile aynı kural, ama mevcut transaction'ın içinde).
    let location = await tx.location.findFirst({
        where: { tenantId: opts.tenantId, locationType: 'MAIN_WAREHOUSE' },
        orderBy: { locationName: 'asc' },
        select: { id: true },
    });
    if (!location) {
        location = await tx.location.create({
            data: {
                id: nanoid(8),
                tenantId: opts.tenantId,
                locationName: 'Ana Depo',
                locationType: 'MAIN_WAREHOUSE',
                isActive: true,
            },
            select: { id: true },
        });
    }

    const isIn = opts.direction === 'IN';
    await tx.stockBalance.upsert({
        where: { articleId_locationId: { articleId: opts.articleId, locationId: location.id } },
        update: { currentQuantity: isIn ? { increment: quantity } : { decrement: quantity } },
        create: {
            id: nanoid(10),
            tenantId: opts.tenantId,
            articleId: opts.articleId,
            locationId: location.id,
            currentQuantity: isIn ? quantity : -quantity,
        },
    });

    const unitCost = isIn && opts.unitCost != null && Number(opts.unitCost) > 0 ? Number(opts.unitCost) : null;
    await tx.stockMovement.create({
        data: {
            id: nanoid(12),
            tenantId: opts.tenantId,
            articleId: opts.articleId,
            movementType: isIn ? 'IN' : 'OUT',
            quantity,
            unitCost,
            sourceLocationId: isIn ? null : location.id,
            destinationLocationId: isIn ? location.id : null,
            employeeId: opts.employeeId,
            referenceId: opts.referenceId || null,
            description: opts.description || null,
        },
    });
};

/** Ürünün tüm lokasyonlardaki toplam bakiyesi (stok uyarıları için). */
export const articleStockTotal = async (
    tx: { stockBalance: any },
    articleId: string,
): Promise<number> => {
    const sum = await tx.stockBalance.aggregate({
        where: { articleId },
        _sum: { currentQuantity: true },
    });
    return Number(sum?._sum?.currentQuantity || 0);
};
