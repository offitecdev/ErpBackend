"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productionBomModule = void 0;
const BomRevisionApprovalRepository_1 = require("../../infrastructure/repositories/BomRevisionApprovalRepository");
const bomRevisionNotifications_1 = require("../../infrastructure/services/bomRevisionNotifications");
const SupplierEmailBook_1 = require("../../infrastructure/repositories/SupplierEmailBook");
const ProductionBomRepository_1 = require("../../infrastructure/repositories/ProductionBomRepository");
const productionBomPurchaseWriter_1 = require("../../infrastructure/services/productionBomPurchaseWriter");
const productionBomRevisionWriter_1 = require("../../infrastructure/services/productionBomRevisionWriter");
const ProductionBomRevisionRepository_1 = require("../../infrastructure/repositories/ProductionBomRevisionRepository");
const BomRevisionsUseCase_1 = require("../../application/use-cases/production/bom/BomRevisionsUseCase");
const bomTableAi_1 = require("../../infrastructure/services/bomTableAi");
const BomReservationService_1 = require("../../application/use-cases/production/bom/BomReservationService");
const BomTemplatesUseCase_1 = require("../../application/use-cases/production/bom/BomTemplatesUseCase");
const DeviceBomsUseCase_1 = require("../../application/use-cases/production/bom/DeviceBomsUseCase");
const BomPurchasesUseCase_1 = require("../../application/use-cases/production/bom/BomPurchasesUseCase");
const BomSettingsUseCase_1 = require("../../application/use-cases/production/bom/BomSettingsUseCase");
const BomProcurementUseCase_1 = require("../../application/use-cases/production/bom/BomProcurementUseCase");
const BomCostingUseCase_1 = require("../../application/use-cases/production/bom/BomCostingUseCase");
const ProcurementDeskUseCase_1 = require("../../application/use-cases/production/bom/ProcurementDeskUseCase");
const ProcurementJournalRepository_1 = require("../../infrastructure/repositories/ProcurementJournalRepository");
const PriceComparisonUseCase_1 = require("../../application/use-cases/production/bom/PriceComparisonUseCase");
const PriceComparisonRepository_1 = require("../../infrastructure/repositories/PriceComparisonRepository");
const priceCompareAi_1 = require("../../infrastructure/services/priceCompareAi");
const ProductionBomProcurementRepository_1 = require("../../infrastructure/repositories/ProductionBomProcurementRepository");
const inventory_routes_1 = require("../routes/inventory.routes");
const warehouseStockEvents_1 = require("../../shared/warehouseStockEvents");
const warehouseGoodsIn_1 = require("../../shared/warehouseGoodsIn");
const BomStockReceiptUseCase_1 = require("../../application/use-cases/production/bom/BomStockReceiptUseCase");
const ProductionBomStockReceiptRepository_1 = require("../../infrastructure/repositories/ProductionBomStockReceiptRepository");
const productionBomGuardModule_1 = require("./productionBomGuardModule");
const WarehouseRepository_1 = require("../../infrastructure/repositories/WarehouseRepository");
const WarehouseCatalogRepository_1 = require("../../infrastructure/repositories/WarehouseCatalogRepository");
/**
 * ── DIE BOM DER PRODUKTION, ZUSAMMENGESTECKT (27.09.2026) ────────────────────
 * Die einzige Stelle, an der die Anwendungsfälle der BOM ihre Datenbankseite
 * bekommen (Vorlagen, BOMs, Depo, Bestellungen, Verzeichnis, Einstellungen).
 */
const templates = new ProductionBomRepository_1.PrismaBomTemplateRepository();
const boms = new ProductionBomRepository_1.PrismaBomRepository();
const stock = new ProductionBomRepository_1.PrismaBomStockReader();
const purchases = new ProductionBomRepository_1.PrismaBomPurchaseRepository();
const directory = new ProductionBomRepository_1.PrismaBomProductionDirectory();
const settings = new ProductionBomRepository_1.PrismaBomSettingsRepository();
const writer = new productionBomPurchaseWriter_1.BomPurchaseOrderWriter();
const warehouseProducts = new WarehouseRepository_1.PrismaWarehouseProductRepository();
const revisions = new ProductionBomRevisionRepository_1.PrismaBomRevisionRepository();
const procurementRequests = new ProductionBomProcurementRepository_1.PrismaBomProcurementRepository();
const goodsIn = new ProductionBomProcurementRepository_1.PrismaBomGoodsInRepository();
const journal = new ProcurementJournalRepository_1.PrismaProcurementJournal();
const reservations = new BomReservationService_1.BomReservationService(boms, stock, purchases, directory);
const templateUseCase = new BomTemplatesUseCase_1.BomTemplatesUseCase(templates, boms, stock, reservations, {
    groups: new WarehouseCatalogRepository_1.PrismaWarehouseGroupRepository(),
    products: warehouseProducts,
    directory: new WarehouseRepository_1.PrismaWarehouseDirectory(),
});
const devices = new DeviceBomsUseCase_1.DeviceBomsUseCase(boms, templates, stock, purchases, directory, settings, reservations, templateUseCase, writer, (tenantId) => (0, inventory_routes_1.nextPurchaseReference)(tenantId, 'ORDER'), (tenantId) => (0, inventory_routes_1.nextPurchaseReference)(tenantId, 'PRICE_REQUEST'), revisions);
/* «Satın alma» (27.09.2026 abends): der Einkauf macht aus den Taleplern der BOM die Belege. */
const procurement = new BomProcurementUseCase_1.BomProcurementUseCase(procurementRequests, goodsIn, purchases, stock, directory, reservations, devices, journal);
devices.attachProcurement(procurement);
/* Die Freigaben der Revisionen (eingereicht / zurückgewiesen) stehen an der BOM (30.09.2026). */
const revisionApprovals = new BomRevisionApprovalRepository_1.PrismaBomRevisionApprovals();
devices.attachRevisionApprovals(revisionApprovals);
exports.productionBomModule = {
    templates: templateUseCase,
    devices,
    purchases: new BomPurchasesUseCase_1.BomPurchasesUseCase(purchases, boms, stock, warehouseProducts, reservations, devices, writer, productionBomGuardModule_1.productionBomDocumentStorage, bomTableAi_1.fillTableWithAi, revisions, goodsIn, directory),
    procurement,
    /* «Satın alma» (28.09.2026): Liste seitenweise, Stand + nächster Schritt, Verlauf, Handgriffe. */
    desk: new ProcurementDeskUseCase_1.ProcurementDeskUseCase(procurementRequests, goodsIn, purchases, journal, procurement, devices, directory, stock, writer, revisions, new SupplierEmailBook_1.PrismaSupplierEmailBook()),
    /* «Fiyat karşılaştırma» (29.09.2026): bis zu vier Angebots-PDFs per KI vergleichen, gespeichert. */
    comparisons: new PriceComparisonUseCase_1.PriceComparisonUseCase(procurementRequests, devices, procurement, productionBomGuardModule_1.productionBomDocumentStorage, priceCompareAi_1.compareOffersWithAi, new PriceComparisonRepository_1.PrismaPriceComparisonStore(), journal, directory),
    /* «Kalkülasyon» (27.09.2026 abends): geplante gegen tatsächliche Materialkosten. */
    costing: new BomCostingUseCase_1.BomCostingUseCase(boms, stock, directory, devices),
    /* «Bom onaylanırsa geri dönüş yok, revize olması lazım» (27.09.2026). */
    revisions: new BomRevisionsUseCase_1.BomRevisionsUseCase(boms, revisions, directory, reservations, devices, new productionBomRevisionWriter_1.PrismaBomRevisionWriter(), productionBomGuardModule_1.productionBomDocumentStorage, 
    // Eine Revision gibt die Administratorrolle frei (30.09.2026).
    revisionApprovals, new bomRevisionNotifications_1.BomRevisionNotifier()),
    settings: new BomSettingsUseCase_1.BomSettingsUseCase(settings),
    reservations,
    directory,
    guard: productionBomGuardModule_1.productionBomGuard,
    available: productionBomGuardModule_1.bomAvailable,
};
/* «Geldiği anda — depoya geldi, eklendi — bu eklenenler rezerve olmalı»:
   kommt im Depo eine Seriennummer dazu (Karte, Scan, Excel-Aktarım), geht sie
   gleich an die wartende BOM-Zeile mit dem frühesten Liefertermin. Fehler
   werden nur gemeldet — das Depo darf daran nie scheitern. */
(0, warehouseStockEvents_1.onWarehouseStockChanged)(({ tenantId, productIds }) => {
    void (async () => {
        if (!(await (0, productionBomGuardModule_1.bomAvailable)(tenantId)))
            return;
        const result = await reservations.assignFreeSerialsDetailed(tenantId, productIds);
        // «Gelen mallar»: im Depo dazugekommene Nummern, die gleich an ein Projekt gingen.
        if (!result.assigned.length)
            return;
        const groups = new Map();
        for (const entry of result.assigned) {
            const key = `${entry.productId}:${entry.demand.lineId}`;
            const group = groups.get(key) ?? { demand: entry.demand, productId: entry.productId, serials: [] };
            group.serials.push(entry.serialNumber);
            groups.set(key, group);
        }
        const receiptId = `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 32);
        const receivedAt = new Date();
        const rows = [...groups.values()].map((group) => {
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
    })().catch((error) => {
        const message = error?.message ?? String(error);
        if (!/doesn't exist|does not exist|P2021/i.test(message))
            console.warn('[production-bom] serial reservation failed', message);
    });
});
/* «Hiç sormadan, proje teslim tarihi en önce olan ürünün siparişine otomatik
   çeksin stoktan» (28.09.2026): was «Ürün ekle» im Depo einbucht, ist der
   Wareneingang der bestätigten BOM-Bestellungen, die auf die Karte warten.
   Das Depo wartet auf die Antwort (wohin die Stücke gingen) und zeigt sie an. */
(0, warehouseGoodsIn_1.setWarehouseGoodsInHandler)(new BomStockReceiptUseCase_1.BomStockReceiptUseCase(new ProductionBomStockReceiptRepository_1.PrismaBomStockReceiptRepository(), goodsIn, reservations, writer, directory, productionBomGuardModule_1.bomAvailable));
//# sourceMappingURL=productionBomModule.js.map