import { PrismaBomRevisionApprovals } from '../../infrastructure/repositories/BomRevisionApprovalRepository';
import { BomRevisionNotifier } from '../../infrastructure/services/bomRevisionNotifications';
import { PrismaSupplierEmailBook } from '../../infrastructure/repositories/SupplierEmailBook';
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
import { BomProcurementUseCase } from '../../application/use-cases/production/bom/BomProcurementUseCase';
import { BomCostingUseCase } from '../../application/use-cases/production/bom/BomCostingUseCase';
import { ProcurementDeskUseCase } from '../../application/use-cases/production/bom/ProcurementDeskUseCase';
import { PrismaProcurementJournal } from '../../infrastructure/repositories/ProcurementJournalRepository';
import { PriceComparisonUseCase } from '../../application/use-cases/production/bom/PriceComparisonUseCase';
import { PrismaPriceComparisonStore } from '../../infrastructure/repositories/PriceComparisonRepository';
import { compareOffersWithAi } from '../../infrastructure/services/priceCompareAi';
import { PrismaBomGoodsInRepository, PrismaBomProcurementRepository } from '../../infrastructure/repositories/ProductionBomProcurementRepository';
import type { BomDemand, BomGoodsIn } from '../../domain/entities/ProductionBom';
import { nextPurchaseReference } from '../routes/inventory.routes';
import { onWarehouseStockChanged } from '../../shared/warehouseStockEvents';
import { setWarehouseGoodsInHandler } from '../../shared/warehouseGoodsIn';
import { BomStockReceiptUseCase } from '../../application/use-cases/production/bom/BomStockReceiptUseCase';
import { PrismaBomStockReceiptRepository } from '../../infrastructure/repositories/ProductionBomStockReceiptRepository';
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
const procurementRequests = new PrismaBomProcurementRepository();
const goodsIn = new PrismaBomGoodsInRepository();
const journal = new PrismaProcurementJournal();

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

/* «Satın alma» (27.09.2026 abends): der Einkauf macht aus den Taleplern der BOM die Belege. */
const procurement = new BomProcurementUseCase(procurementRequests, goodsIn, purchases, stock, directory, reservations, devices, journal);
devices.attachProcurement(procurement);
/* Die Freigaben der Revisionen (eingereicht / zurückgewiesen) stehen an der BOM (30.09.2026). */
const revisionApprovals = new PrismaBomRevisionApprovals();
devices.attachRevisionApprovals(revisionApprovals);

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
        goodsIn,
        directory,
    ),
    procurement,
    /* «Satın alma» (28.09.2026): Liste seitenweise, Stand + nächster Schritt, Verlauf, Handgriffe. */
    desk: new ProcurementDeskUseCase(procurementRequests, goodsIn, purchases, journal, procurement, devices, directory, stock, writer, revisions, new PrismaSupplierEmailBook()),
    /* «Fiyat karşılaştırma» (29.09.2026): bis zu vier Angebots-PDFs per KI vergleichen, gespeichert. */
    comparisons: new PriceComparisonUseCase(
        procurementRequests,
        devices,
        procurement,
        productionBomDocumentStorage,
        compareOffersWithAi,
        new PrismaPriceComparisonStore(),
        journal,
        directory,
    ),
    /* «Kalkülasyon» (27.09.2026 abends): geplante gegen tatsächliche Materialkosten. */
    costing: new BomCostingUseCase(boms, stock, directory, devices),
    /* «Bom onaylanırsa geri dönüş yok, revize olması lazım» (27.09.2026). */
    revisions: new BomRevisionsUseCase(
        boms,
        revisions,
        directory,
        reservations,
        devices,
        new PrismaBomRevisionWriter(),
        productionBomDocumentStorage,
        // Eine Revision gibt die Administratorrolle frei (30.09.2026).
        revisionApprovals,
        new BomRevisionNotifier(),
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
        const result = await reservations.assignFreeSerialsDetailed(tenantId, productIds);
        // «Gelen mallar»: im Depo dazugekommene Nummern, die gleich an ein Projekt gingen.
        if (!result.assigned.length) return;
        const groups = new Map<string, { demand: BomDemand; productId: string; serials: string[] }>();
        for (const entry of result.assigned) {
            const key = `${entry.productId}:${entry.demand.lineId}`;
            const group = groups.get(key) ?? { demand: entry.demand, productId: entry.productId, serials: [] };
            group.serials.push(entry.serialNumber);
            groups.set(key, group);
        }
        const receiptId = `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 32);
        const receivedAt = new Date();
        const rows: Array<Omit<BomGoodsIn, 'id' | 'tenantId'>> = [...groups.values()].map((group) => {
            const product = result.products.get(group.productId);
            return {
                receiptId,
                source: 'STOCK',
                purchaseOrderId: null,
                referenceNumber: null,
                productId: group.productId,
                erpCode: product?.erpCode ?? null,
                name: product?.name ?? '—',
                bomId: group.demand.bomId,
                lineId: group.demand.lineId,
                productionProjectId: group.demand.productionProjectId,
                productionItemId: group.demand.productionItemId,
                quantity: group.serials.length,
                serials: group.serials,
                receivedById: null,
                receivedAt,
            };
        });
        await goodsIn.add(tenantId, rows);
    })().catch((error: unknown) => {
        const message = (error as Error)?.message ?? String(error);
        if (!/doesn't exist|does not exist|P2021/i.test(message)) console.warn('[production-bom] serial reservation failed', message);
    });
});

/* «Hiç sormadan, proje teslim tarihi en önce olan ürünün siparişine otomatik
   çeksin stoktan» (28.09.2026): was «Ürün ekle» im Depo einbucht, ist der
   Wareneingang der bestätigten BOM-Bestellungen, die auf die Karte warten.
   Das Depo wartet auf die Antwort (wohin die Stücke gingen) und zeigt sie an. */
setWarehouseGoodsInHandler(new BomStockReceiptUseCase(
    new PrismaBomStockReceiptRepository(),
    goodsIn,
    reservations,
    writer,
    directory,
    bomAvailable,
));
