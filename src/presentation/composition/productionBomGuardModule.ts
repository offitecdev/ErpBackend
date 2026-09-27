import path from 'path';

import {
    PrismaBomProductionDirectory,
    PrismaBomPurchaseRepository,
    PrismaBomRepository,
} from '../../infrastructure/repositories/ProductionBomRepository';
import { PrismaBomRevisionRepository } from '../../infrastructure/repositories/ProductionBomRevisionRepository';
import { DocumentStorage } from '../../infrastructure/services/LocalFileStorage';
import { BomPurchaseGuard } from '../../application/use-cases/production/bom/BomPurchaseGuard';
import { warehouseAvailability } from './warehouseModule';

/**
 * ── DER WÄCHTER DER BOM-BELEGE, ZUSAMMENGESTECKT (27.09.2026) ───────────────
 *
 * Eigene Datei, weil inventory.routes.ts ihn braucht: sie darf NICHTS
 * einziehen, was inventory.routes.ts selbst einzieht (der Bestellschreiber
 * der BOM tut das) — sonst entstünde ein Ring beim Laden.
 */

/**
 * ANGEBOTE DER LIEFERANTEN (27.09.2026): «sipariş onayından önce fiyat
 * teklifi, yani bize verdikleri fiyat teklifi zorunlu». PDF oder Bild, an der
 * BOM-Bestellung; es verlässt das Haus nie.
 */
export const productionBomDocumentStorage = new DocumentStorage({
    prefix: 'local:production-bom-document/',
    directory: process.env.OFFITEC_PRODUCTION_BOM_UPLOAD_DIR
        || path.join(process.cwd(), 'storage', 'production-bom-documents'),
});

/** BOM gibt es nur, wo es das Depo gibt: Produktionsfirma mit Produktionsmodul. */
export const bomAvailable = async (tenantId: string): Promise<boolean> =>
    (await warehouseAvailability(tenantId)).available;

export const productionBomGuard = new BomPurchaseGuard(
    new PrismaBomPurchaseRepository(),
    new PrismaBomRepository(),
    new PrismaBomProductionDirectory(),
    productionBomDocumentStorage,
    bomAvailable,
    new PrismaBomRevisionRepository(),
);
