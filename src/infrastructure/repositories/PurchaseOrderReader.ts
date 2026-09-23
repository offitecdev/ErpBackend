import prisma from '../database/prisma.client';
import type { IPurchaseOrderReader } from '../../domain/repositories/IProductionRepository';
import type { PurchaseOrderView } from '../../domain/entities/Production';
import { parsePurchaseLines } from '../../domain/services/production';

/**
 * Die Lieferantenbestellungen, gelesen für die Produktion. `items` ist dort
 * eine JSON-Spalte (Momentaufnahme, keine Fremdschlüssel) — `parsePurchaseLines`
 * übersetzt sie in die wenigen Felder, die das Modul braucht.
 */
export class PrismaPurchaseOrderReader implements IPurchaseOrderReader {
    async findByIds(tenantId: string, ids: string[]): Promise<PurchaseOrderView[]> {
        if (!ids.length) return [];
        const rows = await prisma.purchaseOrder.findMany({
            where: { tenantId, id: { in: ids } },
            select: { id: true, referenceNumber: true, status: true, supplierName: true, currency: true, createdAt: true, items: true },
        });
        return rows.map((row) => ({
            id: row.id,
            referenceNumber: row.referenceNumber,
            status: row.status,
            supplierName: row.supplierName ?? null,
            currency: row.currency || 'CHF',
            createdAt: row.createdAt,
            items: parsePurchaseLines(row.items),
        }));
    }
}
