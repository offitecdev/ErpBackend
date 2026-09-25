"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaProductionDemandReader = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const producerOrders_1 = require("../../shared/producerOrders");
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
const parseJson = (raw) => {
    if (typeof raw !== 'string')
        return raw;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
class PrismaProductionDemandReader {
    async read(producerTenantId) {
        const [orders, assignments, lines] = await Promise.all([
            (0, producerOrders_1.findConfirmedProducerOrders)(producerTenantId),
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT productionProjectId, productionItemIds
                FROM uretim_siparis_atamalari
                WHERE tenantId = ${producerTenantId}
            `),
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT DISTINCT productionProjectId, productionItemId
                FROM uretim_siparisleri
                WHERE tenantId = ${producerTenantId}
            `),
        ]);
        const sourceTenantIds = new Set();
        const orderedByPosition = new Map();
        for (const order of orders) {
            for (const line of order.lines) {
                orderedByPosition.set(line.positionId, (orderedByPosition.get(line.positionId) ?? 0) + line.quantity);
            }
            sourceTenantIds.add(order.tenantId);
        }
        const pinnedItemIds = new Set();
        const pinnedProjectIds = new Set();
        for (const row of assignments) {
            if (row.productionProjectId)
                pinnedProjectIds.add(String(row.productionProjectId));
            const ids = parseJson(row.productionItemIds);
            if (Array.isArray(ids)) {
                for (const entry of ids) {
                    const id = typeof entry === 'string' ? entry : String(entry?.id ?? '');
                    if (id)
                        pinnedItemIds.add(id);
                }
            }
        }
        for (const row of lines) {
            if (row.productionProjectId)
                pinnedProjectIds.add(String(row.productionProjectId));
            if (row.productionItemId)
                pinnedItemIds.add(String(row.productionItemId));
        }
        return { sourceTenantIds: [...sourceTenantIds], orderedByPosition, pinnedItemIds, pinnedProjectIds };
    }
}
exports.PrismaProductionDemandReader = PrismaProductionDemandReader;
//# sourceMappingURL=ProductionDemandReader.js.map