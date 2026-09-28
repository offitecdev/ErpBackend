import prisma from '../database/prisma.client';
import type { IBomStockReceiptRepository } from '../../domain/repositories/IBomStockReceiptRepository';
import { round3 } from '../../domain/services/productionBom';
import { STOCK_RECEIPT_STATUSES, type ReceivableLine } from '../../domain/services/productionBomStockReceipt';

/**
 * ── WELCHE BESTELLUNG WARTET AUF DIESE KARTE? (28.09.2026) ──────────────────
 * Die Positionen der BOM-Bestellungen (`uretim_bom_siparisleri`, Art ORDER)
 * zu den BOM-Zeilen einer Depo-Karte — nur bestätigte (MAL KABULDE). Die
 * Stelle in `PurchaseOrder.items` bleibt erhalten: der Wareneingang bucht
 * über sie.
 */

/** Die Positionen, wie sie gespeichert sind — ohne Lücken zu schliessen (die Stelle zählt). */
const rawItems = (raw: string | null): unknown[] => {
    try {
        const parsed: unknown = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const record = (item: unknown): Record<string, unknown> | null =>
    item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;

const num = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

const lineIdOf = (item: Record<string, unknown> | null): string =>
    typeof item?.bomLineId === 'string' ? item.bomLineId : '';

export class PrismaBomStockReceiptRepository implements IBomStockReceiptRepository {
    async receivableLines(tenantId: string, productId: string): Promise<Array<Omit<ReceivableLine, 'deliveryDate'>>> {
        const lines = await prisma.productionBomLine.findMany({
            where: { tenantId, productId },
            select: { id: true, bomId: true },
        });
        if (!lines.length) return [];
        const lineIds = new Set(lines.map((line) => line.id));
        const bomIds = [...new Set(lines.map((line) => line.bomId))];
        const links = await prisma.productionBomPurchase.findMany({
            where: { tenantId, kind: 'ORDER', bomId: { in: bomIds } },
            select: { purchaseOrderId: true, bomId: true, productionProjectId: true, productionItemId: true },
        });
        if (!links.length) return [];
        const [orders, boms] = await Promise.all([
            prisma.purchaseOrder.findMany({
                where: {
                    tenantId,
                    id: { in: links.map((link) => link.purchaseOrderId) },
                    status: { in: [...STOCK_RECEIPT_STATUSES] },
                },
                select: { id: true, referenceNumber: true, supplierId: true, supplierName: true, createdAt: true, items: true },
            }),
            prisma.productionBom.findMany({
                where: { tenantId, id: { in: bomIds } },
                select: { id: true, approvedAt: true },
            }),
        ]);
        const linkOf = new Map(links.map((link) => [link.purchaseOrderId, link]));
        const approvedAt = new Map(boms.map((bom) => [bom.id, bom.approvedAt]));
        const result: Array<Omit<ReceivableLine, 'deliveryDate'>> = [];
        for (const order of orders) {
            const link = linkOf.get(order.id);
            if (!link) continue;
            rawItems(order.items).forEach((entry, index) => {
                const item = record(entry);
                const bomLineId = lineIdOf(item);
                if (!item || !bomLineId || !lineIds.has(bomLineId)) return;
                result.push({
                    purchaseOrderId: order.id,
                    referenceNumber: order.referenceNumber,
                    supplierId: order.supplierId ?? null,
                    supplierName: order.supplierName ?? '',
                    orderCreatedAt: order.createdAt,
                    itemIndex: index,
                    bomLineId,
                    bomId: link.bomId,
                    productionProjectId: link.productionProjectId,
                    productionItemId: link.productionItemId,
                    bomApprovedAt: approvedAt.get(link.bomId) ?? null,
                    quantity: round3(num(item.quantity)),
                    received: round3(num(item.receivedQuantity)),
                });
            });
        }
        return result;
    }

    async orderLines(
        tenantId: string,
        purchaseOrderId: string,
        productId: string,
    ): Promise<Array<{ index: number; quantity: number; received: number }>> {
        const order = await prisma.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, tenantId },
            select: { items: true },
        });
        if (!order) return [];
        const items = rawItems(order.items).map(record);
        const lineIds = [...new Set(items.map(lineIdOf).filter(Boolean))];
        if (!lineIds.length) return [];
        const own = new Set((await prisma.productionBomLine.findMany({
            where: { tenantId, productId, id: { in: lineIds } },
            select: { id: true },
        })).map((line) => line.id));
        return items.flatMap((item, index) => (item && own.has(lineIdOf(item))
            ? [{ index, quantity: round3(num(item.quantity)), received: round3(num(item.receivedQuantity)) }]
            : []));
    }
}
