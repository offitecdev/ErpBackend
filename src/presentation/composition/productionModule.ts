import {
    PrismaProductionProjectRepository,
    PrismaProductionPurchaseRepository,
    PrismaProductionSettingsRepository,
    PrismaTenantDirectory,
} from '../../infrastructure/repositories/ProductionRepository';
import { PrismaSalesSourceReader } from '../../infrastructure/repositories/SalesSourceReader';
import { PrismaPurchaseOrderReader } from '../../infrastructure/repositories/PurchaseOrderReader';
import { PrismaProductionDemandReader } from '../../infrastructure/repositories/ProductionDemandReader';
import { PrismaProductionIntakeReader } from '../../infrastructure/repositories/ProductionIntakeReader';
import { PrismaProductionProjectSourceReader } from '../../infrastructure/repositories/ProductionProjectSourceReader';
import { SyncProductionProjectsUseCase } from '../../application/use-cases/production/SyncProductionProjectsUseCase';
import { GetProductionOverviewUseCase } from '../../application/use-cases/production/GetProductionOverviewUseCase';
import { GetProductionProjectUseCase } from '../../application/use-cases/production/GetProductionProjectUseCase';
import { GetProductionProjectDevicesUseCase } from '../../application/use-cases/production/GetProductionProjectDevicesUseCase';
import { ListProductionLinesUseCase } from '../../application/use-cases/production/ListProductionLinesUseCase';
import { GetProductionItemUseCase } from '../../application/use-cases/production/GetProductionItemUseCase';
import { ProductionPickerUseCase } from '../../application/use-cases/production/ProductionPickerUseCase';
import { ProductionSettingsUseCase } from '../../application/use-cases/production/ProductionSettingsUseCase';
import { ProductionPurchaseLinkService } from '../../application/use-cases/production/ProductionPurchaseLinkService';
import { isModuleEnabledForTenant } from '../../shared/tenantModules';

/**
 * ── DAS PRODUKTIONSMODUL, ZUSAMMENGESTECKT ───────────────────────────────────
 * Die einzige Stelle, an der die Anwendungsfälle ihre Datenbankseite
 * bekommen. Zwei Router brauchen dieselben Stücke: `production.routes.ts`
 * (die Seiten des Moduls) und `inventory.routes.ts` (die Lieferantenbestellung
 * mit Pflichtauswahl und bestätigten Zeilen).
 */
const projects = new PrismaProductionProjectRepository();
const purchase = new PrismaProductionPurchaseRepository();
const settings = new PrismaProductionSettingsRepository();
const tenants = new PrismaTenantDirectory();
const salesReader = new PrismaSalesSourceReader();
const purchaseOrders = new PrismaPurchaseOrderReader();

/** Ist die Produktion in dieser Firma eingeschaltet (Firmenkategorie)? */
export const isProductionEnabled = (tenantId: string): Promise<boolean> =>
    isModuleEnabledForTenant(tenantId, 'production');

const sync = new SyncProductionProjectsUseCase(settings, projects, salesReader, tenants, new PrismaProductionDemandReader());

export const productionModule = {
    sync,
    overview: new GetProductionOverviewUseCase(projects, purchase, purchaseOrders, settings, tenants),
    project: new GetProductionProjectUseCase(projects, purchase, purchaseOrders, tenants),
    devices: new GetProductionProjectDevicesUseCase(
        projects,
        new PrismaProductionIntakeReader(),
        tenants,
        new PrismaProductionProjectSourceReader(),
    ),
    lines: new ListProductionLinesUseCase(projects, purchase, purchaseOrders),
    item: new GetProductionItemUseCase(projects, purchase, purchaseOrders),
    picker: new ProductionPickerUseCase(projects, purchase),
    settings: new ProductionSettingsUseCase(settings, tenants, sync),
    purchaseLink: new ProductionPurchaseLinkService(projects, purchase, isProductionEnabled),
};
