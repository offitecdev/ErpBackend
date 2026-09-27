import {
    PrismaWarehouseDirectory,
    PrismaWarehouseProductRepository,
} from '../../infrastructure/repositories/WarehouseRepository';
import {
    PrismaWarehouseGroupRepository,
    PrismaWarehouseSettingsRepository,
} from '../../infrastructure/repositories/WarehouseCatalogRepository';
import { PrismaWarehouseImportRepository } from '../../infrastructure/repositories/WarehouseImportRepository';
import { WarehouseImportNotifier } from '../../infrastructure/services/warehouseImportNotifications';
import { WarehouseProductsUseCase } from '../../application/use-cases/warehouse/WarehouseProductsUseCase';
import { WarehouseSerialsUseCase } from '../../application/use-cases/warehouse/WarehouseSerialsUseCase';
import { WarehouseCatalogUseCase } from '../../application/use-cases/warehouse/WarehouseCatalogUseCase';
import { WarehouseImportsUseCase } from '../../application/use-cases/warehouse/WarehouseImportsUseCase';
import { readTenantCompanyType, type CompanyType } from '../../shared/companyType';
import { isModuleEnabledForTenant } from '../../shared/tenantModules';

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

const products = new PrismaWarehouseProductRepository();
const groups = new PrismaWarehouseGroupRepository();
const settings = new PrismaWarehouseSettingsRepository();
const imports = new PrismaWarehouseImportRepository();
const directory = new PrismaWarehouseDirectory();
const notifier = new WarehouseImportNotifier();

export const warehouseModule = {
    products: new WarehouseProductsUseCase(products, groups, directory),
    serials: new WarehouseSerialsUseCase(products, directory),
    catalog: new WarehouseCatalogUseCase(groups, directory, products, settings),
    imports: new WarehouseImportsUseCase(imports, groups, products, directory, notifier),
    directory,
};

/* ── Der Firmentyp, kurz gemerkt ─────────────────────────────────────────────
   Jede Anfrage an /warehouse fragt ihn; er ändert sich fast nie (Einstellungen
   → Firmenkategorien). Eine Minute Gedächtnis wie beim Modulschalter
   (shared/tenantModules.ts); gleichzeitige Fragen teilen sich eine Abfrage. */
const TYPE_TTL_MS = 60_000;
const typeCache = new Map<string, { expiresAt: number; type: CompanyType | null }>();
const typeInFlight = new Map<string, Promise<CompanyType | null>>();

const companyTypeOf = async (tenantId: string): Promise<CompanyType | null> => {
    const cached = typeCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.type;
    const pending = typeInFlight.get(tenantId);
    if (pending) return pending;
    const request = readTenantCompanyType(tenantId)
        .then((type) => {
            typeCache.set(tenantId, { expiresAt: Date.now() + TYPE_TTL_MS, type });
            return type;
        })
        .finally(() => typeInFlight.delete(tenantId));
    typeInFlight.set(tenantId, request);
    return request;
};

export interface WarehouseAvailability {
    available: boolean;
    companyType: CompanyType | null;
    productionEnabled: boolean;
}

export const warehouseAvailability = async (tenantId: string): Promise<WarehouseAvailability> => {
    const [companyType, productionEnabled] = await Promise.all([
        companyTypeOf(tenantId),
        isModuleEnabledForTenant(tenantId, 'production'),
    ]);
    return { available: companyType === 'PRODUCTION' && productionEnabled, companyType, productionEnabled };
};
