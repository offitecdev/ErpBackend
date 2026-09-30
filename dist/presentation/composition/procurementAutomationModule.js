"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.procurementAutomationModule = void 0;
const ProductionBomProcurementRepository_1 = require("../../infrastructure/repositories/ProductionBomProcurementRepository");
const ProductionBomRepository_1 = require("../../infrastructure/repositories/ProductionBomRepository");
const ProcurementJournalRepository_1 = require("../../infrastructure/repositories/ProcurementJournalRepository");
const PriceComparisonRepository_1 = require("../../infrastructure/repositories/PriceComparisonRepository");
const ProductionMailboxRepository_1 = require("../../infrastructure/repositories/ProductionMailboxRepository");
const ProcurementMailRepository_1 = require("../../infrastructure/repositories/ProcurementMailRepository");
const ProcurementAutomationRepository_1 = require("../../infrastructure/repositories/ProcurementAutomationRepository");
const SupplierEmailBook_1 = require("../../infrastructure/repositories/SupplierEmailBook");
const productionBomPurchaseWriter_1 = require("../../infrastructure/services/productionBomPurchaseWriter");
const SmtpMailService_1 = require("../../infrastructure/services/SmtpMailService");
const supplierPdfRenderer_1 = require("../../infrastructure/services/supplierPdfRenderer");
const procurementInbox_1 = require("../../infrastructure/services/procurementInbox");
const offerReadAi_1 = require("../../infrastructure/services/offerReadAi");
const ProcurementDispatchUseCase_1 = require("../../application/use-cases/production/bom/ProcurementDispatchUseCase");
const ProcurementOrderingUseCase_1 = require("../../application/use-cases/production/bom/ProcurementOrderingUseCase");
const ProcurementReplyUseCase_1 = require("../../application/use-cases/production/bom/ProcurementReplyUseCase");
const ProductionMailboxUseCase_1 = require("../../application/use-cases/production/bom/ProductionMailboxUseCase");
const inventory_routes_1 = require("../routes/inventory.routes");
const productionBomGuardModule_1 = require("./productionBomGuardModule");
const productionBomModule_1 = require("./productionBomModule");
/**
 * ── DIE AUTOMATIK DES EINKAUFS, ZUSAMMENGESTECKT (30.09.2026) ──────────────
 *
 * «BOM'da sistem tamamen değişiyor ve otomatikleşiyor.» Hier bekommen die
 * Anwendungsfälle der Automatik ihre Datenbank-, Mail- und PDF-Seite:
 *   · dispatch  — Preisanfragen, Bestellungen, Revisionen als PDF + Mail
 *   · ordering  — aus der Auswahl des Vergleichs je Lieferant eine Bestellung
 *   · replies   — die Antworten der Lieferanten an die Belege (Abruf: inbox)
 *   · mailboxes — die Postfächer der Produktion (Üretim ayarları › E-posta)
 * Angeschlossen an die BOM: ein neuer Preistalep geht sofort hinaus, eine
 * freigegebene Revision schickt geänderte Bestellungen neu.
 */
const purchases = new ProductionBomRepository_1.PrismaBomPurchaseRepository();
const requests = new ProductionBomProcurementRepository_1.PrismaBomProcurementRepository();
const stock = new ProductionBomRepository_1.PrismaBomStockReader();
const directory = new ProductionBomRepository_1.PrismaBomProductionDirectory();
const journal = new ProcurementJournalRepository_1.PrismaProcurementJournal();
const writer = new productionBomPurchaseWriter_1.BomPurchaseOrderWriter();
const mailboxes = new ProductionMailboxRepository_1.PrismaProductionMailboxRepository();
const mails = new ProcurementMailRepository_1.PrismaProcurementMailRepository();
const automation = new ProcurementAutomationRepository_1.PrismaProcurementAutomationRepository();
const smtp = new SmtpMailService_1.SmtpMailService();
const emails = new SupplierEmailBook_1.PrismaSupplierEmailBook();
const dispatch = new ProcurementDispatchUseCase_1.ProcurementDispatchUseCase({
    purchases,
    requests,
    devices: productionBomModule_1.productionBomModule.devices,
    procurement: productionBomModule_1.productionBomModule.procurement,
    stock,
    journal,
    automation,
    mails,
    mailboxes,
    emails,
    documents: productionBomGuardModule_1.productionBomDocumentStorage,
    loadDocument: (tenantId, id) => (0, inventory_routes_1.purchaseOrderDocument)(tenantId, id),
    renderPdf: supplierPdfRenderer_1.renderSupplierPdf,
    companySettings: supplierPdfRenderer_1.pdfCompanySettings,
    sendMail: (settings, mail) => smtp.send(settings, mail),
});
const ordering = new ProcurementOrderingUseCase_1.ProcurementOrderingUseCase({
    requests,
    purchases,
    devices: productionBomModule_1.productionBomModule.devices,
    procurement: productionBomModule_1.productionBomModule.procurement,
    stock,
    directory,
    comparisons: new PriceComparisonRepository_1.PrismaPriceComparisonStore(),
    writer,
    documents: productionBomGuardModule_1.productionBomDocumentStorage,
    automation,
});
const replies = new ProcurementReplyUseCase_1.ProcurementReplyUseCase({
    purchases,
    mails,
    automation,
    writer,
    documents: productionBomGuardModule_1.productionBomDocumentStorage,
    journal,
    dispatch,
    readOffer: offerReadAi_1.readOfferFacts,
});
const inbox = new procurementInbox_1.ProcurementInbox(mailboxes, mails, replies.handle);
/* Ein Preistalep aus der BOM geht gleich hinaus — ohne dass die BOM wartet. */
productionBomModule_1.productionBomModule.procurement.attachAutomation((tenantId, requestId, actor) => {
    setImmediate(() => {
        void dispatch.dispatchRequest(tenantId, actor, requestId)
            .then((results) => {
            const sent = results.filter((entry) => entry.status === 'SENT').length;
            console.log(`[satın alma] Talep ${requestId}: ${sent}/${results.length} Preisanfragen gesendet`);
        })
            .catch((error) => console.warn('[satın alma] Preisanfragen nicht gesendet:', requestId, error?.message));
    });
});
/* Eine freigegebene Revision: geänderte Bestellungen beim Lieferanten gehen neu hinaus. */
productionBomModule_1.productionBomModule.revisions.attachRevisionDispatch((tenantId, actor, purchaseOrderIds) => dispatch.dispatchRevision(tenantId, actor, purchaseOrderIds));
exports.procurementAutomationModule = {
    dispatch,
    ordering,
    mailboxes: new ProductionMailboxUseCase_1.ProductionMailboxUseCase(mailboxes, inbox),
    inbox,
};
//# sourceMappingURL=procurementAutomationModule.js.map