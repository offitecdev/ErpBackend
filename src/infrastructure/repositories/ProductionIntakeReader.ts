import type { IProductionIntakeReader } from '../../domain/repositories/IProductionRepository';
import type { ProductionIntakeOrder } from '../../domain/entities/Production';
import { findConfirmedProducerOrders } from '../../shared/producerOrders';

/**
 * ── WELCHE BESTELLUNG DAS GERÄT GEBRACHT HAT ────────────────────────────────
 *
 * Ist eine interne Bestellung der Projektfirma BESTÄTIGT, steht das Gerät im
 * Produktionsprojekt — und die Projektseite nennt je Zeile die Bestellung,
 * aus der es kam (welche Bestellungen zählen: shared/producerOrders.ts).
 */
export class PrismaProductionIntakeReader implements IProductionIntakeReader {
    async byPosition(producerTenantId: string, positionIds: string[]): Promise<Map<string, ProductionIntakeOrder[]>> {
        const result = new Map<string, ProductionIntakeOrder[]>();
        if (!positionIds.length) return result;
        const wanted = new Set(positionIds);
        for (const order of await findConfirmedProducerOrders(producerTenantId)) {
            for (const line of order.lines) {
                if (!wanted.has(line.positionId)) continue;
                const list = result.get(line.positionId) ?? [];
                const same = list.find((entry) => entry.purchaseOrderId === order.id);
                if (same) {
                    same.quantity += line.quantity;
                } else {
                    list.push({
                        purchaseOrderId: order.id,
                        referenceNumber: order.referenceNumber,
                        sourceTenantId: order.tenantId,
                        status: order.status,
                        quantity: line.quantity,
                    });
                }
                result.set(line.positionId, list);
            }
        }
        return result;
    }
}
