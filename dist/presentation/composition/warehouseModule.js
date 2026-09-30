"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.warehouseAvailability = exports.warehouseModule = void 0;
const WarehouseRepository_1 = require("../../infrastructure/repositories/WarehouseRepository");
const WarehouseCatalogRepository_1 = require("../../infrastructure/repositories/WarehouseCatalogRepository");
const WarehouseImportRepository_1 = require("../../infrastructure/repositories/WarehouseImportRepository");
const SupplierEmailBook_1 = require("../../infrastructure/repositories/SupplierEmailBook");
const warehouseImportNotifications_1 = require("../../infrastructure/services/warehouseImportNotifications");
const WarehouseProductsUseCase_1 = require("../../application/use-cases/warehouse/WarehouseProductsUseCase");
const WarehouseSerialsUseCase_1 = require("../../application/use-cases/warehouse/WarehouseSerialsUseCase");
const WarehouseCatalogUseCase_1 = require("../../application/use-cases/warehouse/WarehouseCatalogUseCase");
const WarehouseImportsUseCase_1 = require("../../application/use-cases/warehouse/WarehouseImportsUseCase");
const companyType_1 = require("../../shared/companyType");
const tenantModules_1 = require("../../shared/tenantModules");
/**
 * ── DAS DEPO, ZUSAMMENGESTECKT (26.09.2026) ──────────────────────────────────
 *
 * Die einzige Stelle, an der die Anwendungsfälle des Depos ihre
 * Datenbankseite bekommen — und an der steht, WO es das Depo gibt:
 *
 *   «Depo modülü sadece üretim türündeki şirketlerde çıkmalıdır.»
 *
 * also nur in einer Firma mit `companyType = PRODUCTION`, und — weil das Depo
 * zur Produktion gehört — nur, wo deren Firmenkategorie die Produktion führt
 * (ohne Kategorie: ja, wie überall).
 */
const products = new WarehouseRepository_1.PrismaWarehouseProductRepository();
const groups = new WarehouseCatalogRepository_1.PrismaWarehouseGroupRepository();
const settings = new WarehouseCatalogRepository_1.PrismaWarehouseSettingsRepository();
const imports = new WarehouseImportRepository_1.PrismaWarehouseImportRepository();
const directory = new WarehouseRepository_1.PrismaWarehouseDirectory();
const notifier = new warehouseImportNotifications_1.WarehouseImportNotifier();
/* Eine an einer Karte eingetragene Lieferanten-E-Mail wird die des Lieferanten (30.09.2026). */
const supplierEmails = new SupplierEmailBook_1.PrismaSupplierEmailBook();
exports.warehouseModule = {
    products: new WarehouseProductsUseCase_1.WarehouseProductsUseCase(products, groups, directory, supplierEmails),
    serials: new WarehouseSerialsUseCase_1.WarehouseSerialsUseCase(products, directory),
    catalog: new WarehouseCatalogUseCase_1.WarehouseCatalogUseCase(groups, directory, products, settings),
    imports: new WarehouseImportsUseCase_1.WarehouseImportsUseCase(imports, groups, products, directory, notifier, supplierEmails),
    directory,
};
/* ── Der Firmentyp, kurz gemerkt ─────────────────────────────────────────────
   Jede Anfrage an /warehouse fragt ihn; er ändert sich fast nie (Einstellungen
   → Firmenkategorien). Eine Minute Gedächtnis wie beim Modulschalter
   (shared/tenantModules.ts); gleichzeitige Fragen teilen sich eine Abfrage. */
const TYPE_TTL_MS = 60_000;
const typeCache = new Map();
const typeInFlight = new Map();
const companyTypeOf = async (tenantId) => {
    const cached = typeCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now())
        return cached.type;
    const pending = typeInFlight.get(tenantId);
    if (pending)
        return pending;
    const request = (0, companyType_1.readTenantCompanyType)(tenantId)
        .then((type) => {
        typeCache.set(tenantId, { expiresAt: Date.now() + TYPE_TTL_MS, type });
        return type;
    })
        .finally(() => typeInFlight.delete(tenantId));
    typeInFlight.set(tenantId, request);
    return request;
};
const warehouseAvailability = async (tenantId) => {
    const [companyType, productionEnabled] = await Promise.all([
        companyTypeOf(tenantId),
        (0, tenantModules_1.isModuleEnabledForTenant)(tenantId, 'production'),
    ]);
    return { available: companyType === 'PRODUCTION' && productionEnabled, companyType, productionEnabled };
};
exports.warehouseAvailability = warehouseAvailability;
//# sourceMappingURL=warehouseModule.js.map