"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaBomStockReceiptRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const productionBom_1 = require("../../domain/services/productionBom");
const productionBomStockReceipt_1 = require("../../domain/services/productionBomStockReceipt");
/**
 * ── WELCHE BESTELLUNG WARTET AUF DIESE KARTE? (28.09.2026) ──────────────────
 * Die Positionen der BOM-Bestellungen (`uretim_bom_siparisleri`, Art ORDER)
 * zu den BOM-Zeilen einer Depo-Karte — nur bestätigte (MAL KABULDE). Die
 * Stelle in `PurchaseOrder.items` bleibt erhalten: der Wareneingang bucht
 * über sie.
 */
/** Die Positionen, wie sie gespeichert sind — ohne Lücken zu schliessen (die Stelle zählt). */
const rawItems = (raw) => {
    try {
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
};
const record = (item) => item && typeof item === 'object' && !Array.isArray(item) ? item : null;
const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};
const lineIdOf = (item) => typeof item?.bomLineId === 'string' ? item.bomLineId : '';
class PrismaBomStockReceiptRepository {
    async receivableLines(tenantId, productId) {
        const lines = await prisma_client_1.default.productionBomLine.findMany({
            where: { tenantId, productId },
            select: { id: true, bomId: true },
        });
        if (!lines.length)
            return [];
        const lineIds = new Set(lines.map((line) => line.id));
        const bomIds = [...new Set(lines.map((line) => line.bomId))];
        const links = await prisma_client_1.default.productionBomPurchase.findMany({
            where: { tenantId, kind: 'ORDER', bomId: { in: bomIds } },
            select: { purchaseOrderId: true, bomId: true, productionProjectId: true, productionItemId: true },
        });
        if (!links.length)
            return [];
        const [orders, boms] = await Promise.all([
            prisma_client_1.default.purchaseOrder.findMany({
                where: {
                    tenantId,
                    id: { in: links.map((link) => link.purchaseOrderId) },
                    status: { in: [...productionBomStockReceipt_1.STOCK_RECEIPT_STATUSES] },
                },
                select: { id: true, referenceNumber: true, supplierId: true, supplierName: true, createdAt: true, items: true },
            }),
            prisma_client_1.default.productionBom.findMany({
                where: { tenantId, id: { in: bomIds } },
                select: { id: true, approvedAt: true },
            }),
        ]);
        const linkOf = new Map(links.map((link) => [link.purchaseOrderId, link]));
        const approvedAt = new Map(boms.map((bom) => [bom.id, bom.approvedAt]));
        const result = [];
        for (const order of orders) {
            const link = linkOf.get(order.id);
            if (!link)
                continue;
            rawItems(order.items).forEach((entry, index) => {
                const item = record(entry);
                const bomLineId = lineIdOf(item);
                if (!item || !bomLineId || !lineIds.has(bomLineId))
                    return;
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
                    quantity: (0, productionBom_1.round3)(num(item.quantity)),
                    received: (0, productionBom_1.round3)(num(item.receivedQuantity)),
                });
            });
        }
        return result;
    }
    async orderLines(tenantId, purchaseOrderId, productId) {
        const order = await prisma_client_1.default.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, tenantId },
            select: { items: true },
        });
        if (!order)
            return [];
        const items = rawItems(order.items).map(record);
        const lineIds = [...new Set(items.map(lineIdOf).filter(Boolean))];
        if (!lineIds.length)
            return [];
        const own = new Set((await prisma_client_1.default.productionBomLine.findMany({
            where: { tenantId, productId, id: { in: lineIds } },
            select: { id: true },
        })).map((line) => line.id));
        return items.flatMap((item, index) => (item && own.has(lineIdOf(item))
            ? [{ index, quantity: (0, productionBom_1.round3)(num(item.quantity)), received: (0, productionBom_1.round3)(num(item.receivedQuantity)) }]
            : []));
    }
}
exports.PrismaBomStockReceiptRepository = PrismaBomStockReceiptRepository;
//# sourceMappingURL=ProductionBomStockReceiptRepository.js.map