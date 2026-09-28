"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.productionBomGuard = exports.bomAvailable = exports.productionBomDocumentStorage = void 0;
const path_1 = __importDefault(require("path"));
const ProductionBomRepository_1 = require("../../infrastructure/repositories/ProductionBomRepository");
const ProductionBomRevisionRepository_1 = require("../../infrastructure/repositories/ProductionBomRevisionRepository");
const LocalFileStorage_1 = require("../../infrastructure/services/LocalFileStorage");
const BomPurchaseGuard_1 = require("../../application/use-cases/production/bom/BomPurchaseGuard");
const warehouseModule_1 = require("./warehouseModule");
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
exports.productionBomDocumentStorage = new LocalFileStorage_1.DocumentStorage({
    prefix: 'local:production-bom-document/',
    directory: process.env.OFFITEC_PRODUCTION_BOM_UPLOAD_DIR
        || path_1.default.join(process.cwd(), 'storage', 'production-bom-documents'),
});
/** BOM gibt es nur, wo es das Depo gibt: Produktionsfirma mit Produktionsmodul. */
const bomAvailable = async (tenantId) => (await (0, warehouseModule_1.warehouseAvailability)(tenantId)).available;
exports.bomAvailable = bomAvailable;
exports.productionBomGuard = new BomPurchaseGuard_1.BomPurchaseGuard(new ProductionBomRepository_1.PrismaBomPurchaseRepository(), new ProductionBomRepository_1.PrismaBomRepository(), new ProductionBomRepository_1.PrismaBomProductionDirectory(), exports.productionBomDocumentStorage, exports.bomAvailable, new ProductionBomRevisionRepository_1.PrismaBomRevisionRepository());
//# sourceMappingURL=productionBomGuardModule.js.map