import { Prisma } from '@prisma/client';
import prisma from '../database/prisma.client';
import type { IProductionDemandReader } from '../../domain/repositories/IProductionRepository';
import type { ProductionDemand } from '../../domain/services/production';
import { findConfirmedProducerOrders } from '../../shared/producerOrders';

/**
 * ── WAS DIE PROJEKTFIRMEN BEI DER PRODUKTION BESTELLT HABEN ─────────────────
 *
 * Eine Projektfirma bestellt ein Gerät über die Positionsliste ihres Projekts
 * — bei der Produktionsfirma direkt («Üretilecek», die Zeile trägt
 * `source.producerTenantId`) oder bei einem Lieferanten, der die
 * Produktionsfirma ist (siehe shared/producerOrders.ts). Zählt nur, wenn die
 * Bestellung BESTÄTIGT ist («Siparişi onayla» → TO_BE_STOCKED; PENDING ist
 * die alte Form derselben Bestätigung; COMPLETED danach).
 *
 * Dazu die Geräte und Projekte, an denen in der Produktionsfirma schon eigene
 * Lieferantenbestellungen hängen — sie dürfen nicht verschwinden.
 */
const parseJson = (raw: unknown): unknown => {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return null; }
};

export class PrismaProductionDemandReader implements IProductionDemandReader {
    async read(producerTenantId: string): Promise<ProductionDemand> {
        const [orders, assignments, lines] = await Promise.all([
            findConfirmedProducerOrders(producerTenantId),
            prisma.$queryRaw<any[]>(Prisma.sql`
                SELECT productionProjectId, productionItemIds
                FROM uretim_siparis_atamalari
                WHERE tenantId = ${producerTenantId}
            `),
            prisma.$queryRaw<any[]>(Prisma.sql`
                SELECT DISTINCT productionProjectId, productionItemId
                FROM uretim_siparisleri
                WHERE tenantId = ${producerTenantId}
            `),
        ]);

        const sourceTenantIds = new Set<string>();
        const orderedByPosition = new Map<string, number>();
        for (const order of orders) {
            for (const line of order.lines) {
                orderedByPosition.set(line.positionId, (orderedByPosition.get(line.positionId) ?? 0) + line.quantity);
            }
            sourceTenantIds.add(order.tenantId);
        }

        const pinnedItemIds = new Set<string>();
        const pinnedProjectIds = new Set<string>();
        for (const row of assignments) {
            if (row.productionProjectId) pinnedProjectIds.add(String(row.productionProjectId));
            const ids = parseJson(row.productionItemIds);
            if (Array.isArray(ids)) {
                for (const entry of ids) {
                    const id = typeof entry === 'string' ? entry : String((entry as any)?.id ?? '');
                    if (id) pinnedItemIds.add(id);
                }
            }
        }
        for (const row of lines) {
            if (row.productionProjectId) pinnedProjectIds.add(String(row.productionProjectId));
            if (row.productionItemId) pinnedItemIds.add(String(row.productionItemId));
        }

        return { sourceTenantIds: [...sourceTenantIds], orderedByPosition, pinnedItemIds, pinnedProjectIds };
    }
}
