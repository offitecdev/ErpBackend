"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productionModule = exports.isProductionEnabled = void 0;
const ProductionRepository_1 = require("../../infrastructure/repositories/ProductionRepository");
const SalesSourceReader_1 = require("../../infrastructure/repositories/SalesSourceReader");
const PurchaseOrderReader_1 = require("../../infrastructure/repositories/PurchaseOrderReader");
const SyncProductionProjectsUseCase_1 = require("../../application/use-cases/production/SyncProductionProjectsUseCase");
const GetProductionOverviewUseCase_1 = require("../../application/use-cases/production/GetProductionOverviewUseCase");
const GetProductionProjectUseCase_1 = require("../../application/use-cases/production/GetProductionProjectUseCase");
const ListProductionLinesUseCase_1 = require("../../application/use-cases/production/ListProductionLinesUseCase");
const GetProductionItemUseCase_1 = require("../../application/use-cases/production/GetProductionItemUseCase");
const ProductionPickerUseCase_1 = require("../../application/use-cases/production/ProductionPickerUseCase");
const ProductionSettingsUseCase_1 = require("../../application/use-cases/production/ProductionSettingsUseCase");
const ProductionPurchaseLinkService_1 = require("../../application/use-cases/production/ProductionPurchaseLinkService");
const tenantModules_1 = require("../../shared/tenantModules");
/**
 * ── DAS PRODUKTIONSMODUL, ZUSAMMENGESTECKT ───────────────────────────────────
 * Die einzige Stelle, an der die Anwendungsfälle ihre Datenbankseite
 * bekommen. Zwei Router brauchen dieselben Stücke: `production.routes.ts`
 * (die Seiten des Moduls) und `inventory.routes.ts` (die Lieferantenbestellung
 * mit Pflichtauswahl und bestätigten Zeilen).
 */
const projects = new ProductionRepository_1.PrismaProductionProjectRepository();
const purchase = new ProductionRepository_1.PrismaProductionPurchaseRepository();
const settings = new ProductionRepository_1.PrismaProductionSettingsRepository();
const tenants = new ProductionRepository_1.PrismaTenantDirectory();
const salesReader = new SalesSourceReader_1.PrismaSalesSourceReader();
const purchaseOrders = new PurchaseOrderReader_1.PrismaPurchaseOrderReader();
/** Ist die Produktion in dieser Firma eingeschaltet (Firmenkategorie)? */
const isProductionEnabled = (tenantId) => (0, tenantModules_1.isModuleEnabledForTenant)(tenantId, 'production');
exports.isProductionEnabled = isProductionEnabled;
const sync = new SyncProductionProjectsUseCase_1.SyncProductionProjectsUseCase(settings, projects, salesReader, tenants);
exports.productionModule = {
    sync,
    overview: new GetProductionOverviewUseCase_1.GetProductionOverviewUseCase(projects, purchase, purchaseOrders, settings, tenants),
    project: new GetProductionProjectUseCase_1.GetProductionProjectUseCase(projects, purchase, purchaseOrders, tenants),
    lines: new ListProductionLinesUseCase_1.ListProductionLinesUseCase(projects, purchase, purchaseOrders),
    item: new GetProductionItemUseCase_1.GetProductionItemUseCase(projects, purchase, purchaseOrders),
    picker: new ProductionPickerUseCase_1.ProductionPickerUseCase(projects, purchase),
    settings: new ProductionSettingsUseCase_1.ProductionSettingsUseCase(settings, tenants, sync),
    purchaseLink: new ProductionPurchaseLinkService_1.ProductionPurchaseLinkService(projects, purchase, exports.isProductionEnabled),
};
//# sourceMappingURL=productionModule.js.map