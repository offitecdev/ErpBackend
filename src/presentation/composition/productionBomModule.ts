import {
    PrismaBomProductionDirectory,
    PrismaBomPurchaseRepository,
    PrismaBomRepository,
    PrismaBomSettingsRepository,
    PrismaBomStockReader,
    PrismaBomTemplateRepository,
} from '../../infrastructure/repositories/ProductionBomRepository';
import { BomPurchaseOrderWriter } from '../../infrastructure/services/productionBomPurchaseWriter';
import { PrismaBomRevisionWriter } from '../../infrastructure/services/productionBomRevisionWriter';
import { PrismaBomRevisionRepository } from '../../infrastructure/repositories/ProductionBomRevisionRepository';
import { BomRevisionsUseCase } from '../../application/use-cases/production/bom/BomRevisionsUseCase';
import { fillTableWithAi } from '../../infrastructure/services/bomTableAi';
import { BomReservationService } from '../../application/use-cases/production/bom/BomReservationService';
import { BomTemplatesUseCase } from '../../application/use-cases/production/bom/BomTemplatesUseCase';
import { DeviceBomsUseCase } from '../../application/use-cases/production/bom/DeviceBomsUseCase';
import { BomPurchasesUseCase } from '../../application/use-cases/production/bom/BomPurchasesUseCase';
import { BomSettingsUseCase } from '../../application/use-cases/production/bom/BomSettingsUseCase';
import { nextPurchaseReference } from '../routes/inventory.routes';
import { onWarehouseStockChanged } from '../../shared/warehouseStockEvents';
import { bomAvailable, productionBomDocumentStorage, productionBomGuard } from './productionBomGuardModule';
import { PrismaWarehouseDirectory, PrismaWarehouseProductRepository } from '../../infrastructure/repositories/WarehouseRepository';
import { PrismaWarehouseGroupRepository } from '../../infrastructure/repositories/WarehouseCatalogRepository';

/**
 * ── DIE BOM DER PRODUKTION, ZUSAMMENGESTECKT (27.09.2026) ────────────────────
 * Die einzige Stelle, an der die Anwendungsfälle der BOM ihre Datenbankseite
 * bekommen (Vorlagen, BOMs, Depo, Bestellungen, Verzeichnis, Einstellungen).
 */
const templates = new PrismaBomTemplateRepository();
const boms = new PrismaBomRepository();
const stock = new PrismaBomStockReader();
const purchases = new PrismaBomPurchaseRepository();
const directory = new PrismaBomProductionDirectory();
const settings = new PrismaBomSettingsRepository();
const writer = new BomPurchaseOrderWriter();
const warehouseProducts = new PrismaWarehouseProductRepository();
const revisions = new PrismaBomRevisionRepository();

const reservations = new BomReservationService(boms, stock, purchases, directory);
const templateUseCase = new BomTemplatesUseCase(templates, boms, stock, reservations, {
    groups: new PrismaWarehouseGroupRepository(),
    products: warehouseProducts,
    directory: new PrismaWarehouseDirectory(),
});
const devices = new DeviceBomsUseCase(
    boms,
    templates,
    stock,
    purchases,
    directory,
    settings,
    reservations,
    templateUseCase,
    writer,
    (tenantId) => nextPurchaseReference(tenantId, 'ORDER'),
    (tenantId) => nextPurchaseReference(tenantId, 'PRICE_REQUEST'),
    revisions,
);

export const productionBomModule = {
    templates: templateUseCase,
    devices,
    purchases: new BomPurchasesUseCase(
        purchases,
        boms,
        stock,
        warehouseProducts,
        reservations,
        devices,
        writer,
        productionBomDocumentStorage,
        fillTableWithAi,
        revisions,
    ),
    /* «Bom onaylanırsa geri dönüş yok, revize olması lazım» (27.09.2026). */
    revisions: new BomRevisionsUseCase(
        boms,
        revisions,
        directory,
        reservations,
        devices,
        new PrismaBomRevisionWriter(),
        productionBomDocumentStorage,
    ),
    settings: new BomSettingsUseCase(settings),
    reservations,
    directory,
    guard: productionBomGuard,
    available: bomAvailable,
};

/* «Geldiği anda — depoya geldi, eklendi — bu eklenenler rezerve olmalı»:
   kommt im Depo eine Seriennummer dazu (Karte, Scan, Excel-Aktarım), geht sie
   gleich an die wartende BOM-Zeile mit dem frühesten Liefertermin. Fehler
   werden nur gemeldet — das Depo darf daran nie scheitern. */
onWarehouseStockChanged(({ tenantId, productIds }) => {
    void (async () => {
        if (!(await bomAvailable(tenantId))) return;
        await reservations.assignFreeSerials(tenantId, productIds);
    })().catch((error: unknown) => {
        const message = (error as Error)?.message ?? String(error);
        if (!/doesn't exist|does not exist|P2021/i.test(message)) console.warn('[production-bom] serial reservation failed', message);
    });
});
