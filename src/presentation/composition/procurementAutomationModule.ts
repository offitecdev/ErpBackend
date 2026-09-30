import { PrismaBomProcurementRepository } from '../../infrastructure/repositories/ProductionBomProcurementRepository';
import {
    PrismaBomProductionDirectory,
    PrismaBomPurchaseRepository,
    PrismaBomStockReader,
} from '../../infrastructure/repositories/ProductionBomRepository';
import { PrismaProcurementJournal } from '../../infrastructure/repositories/ProcurementJournalRepository';
import { PrismaPriceComparisonStore } from '../../infrastructure/repositories/PriceComparisonRepository';
import { PrismaProductionMailboxRepository } from '../../infrastructure/repositories/ProductionMailboxRepository';
import { PrismaProcurementMailRepository } from '../../infrastructure/repositories/ProcurementMailRepository';
import { PrismaProcurementAutomationRepository } from '../../infrastructure/repositories/ProcurementAutomationRepository';
import { PrismaSupplierEmailBook } from '../../infrastructure/repositories/SupplierEmailBook';
import { BomPurchaseOrderWriter } from '../../infrastructure/services/productionBomPurchaseWriter';
import { SmtpMailService } from '../../infrastructure/services/SmtpMailService';
import { pdfCompanySettings, renderSupplierPdf } from '../../infrastructure/services/supplierPdfRenderer';
import { ProcurementInbox } from '../../infrastructure/services/procurementInbox';
import { readOfferFacts } from '../../infrastructure/services/offerReadAi';
import { ProcurementDispatchUseCase } from '../../application/use-cases/production/bom/ProcurementDispatchUseCase';
import { ProcurementOrderingUseCase } from '../../application/use-cases/production/bom/ProcurementOrderingUseCase';
import { ProcurementReplyUseCase } from '../../application/use-cases/production/bom/ProcurementReplyUseCase';
import { ProductionMailboxUseCase } from '../../application/use-cases/production/bom/ProductionMailboxUseCase';
import { purchaseOrderDocument } from '../routes/inventory.routes';
import { productionBomDocumentStorage } from './productionBomGuardModule';
import { productionBomModule } from './productionBomModule';

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
const purchases = new PrismaBomPurchaseRepository();
const requests = new PrismaBomProcurementRepository();
const stock = new PrismaBomStockReader();
const directory = new PrismaBomProductionDirectory();
const journal = new PrismaProcurementJournal();
const writer = new BomPurchaseOrderWriter();
const mailboxes = new PrismaProductionMailboxRepository();
const mails = new PrismaProcurementMailRepository();
const automation = new PrismaProcurementAutomationRepository();
const smtp = new SmtpMailService();
const emails = new PrismaSupplierEmailBook();

const dispatch = new ProcurementDispatchUseCase({
    purchases,
    requests,
    devices: productionBomModule.devices,
    procurement: productionBomModule.procurement,
    stock,
    journal,
    automation,
    mails,
    mailboxes,
    emails,
    documents: productionBomDocumentStorage,
    loadDocument: (tenantId, id) => purchaseOrderDocument(tenantId, id),
    renderPdf: renderSupplierPdf,
    companySettings: pdfCompanySettings,
    sendMail: (settings, mail) => smtp.send(settings, mail),
});

const ordering = new ProcurementOrderingUseCase({
    requests,
    purchases,
    devices: productionBomModule.devices,
    procurement: productionBomModule.procurement,
    stock,
    directory,
    comparisons: new PrismaPriceComparisonStore(),
    writer,
    documents: productionBomDocumentStorage,
    automation,
});

const replies = new ProcurementReplyUseCase({
    purchases,
    mails,
    automation,
    writer,
    documents: productionBomDocumentStorage,
    journal,
    dispatch,
    readOffer: readOfferFacts,
});

const inbox = new ProcurementInbox(mailboxes, mails, replies.handle);

/* Ein Preistalep aus der BOM geht gleich hinaus — ohne dass die BOM wartet. */
productionBomModule.procurement.attachAutomation((tenantId, requestId, actor) => {
    setImmediate(() => {
        void dispatch.dispatchRequest(tenantId, actor, requestId)
            .then((results) => {
                const sent = results.filter((entry) => entry.status === 'SENT').length;
                console.log(`[satın alma] Talep ${requestId}: ${sent}/${results.length} Preisanfragen gesendet`);
            })
            .catch((error: unknown) => console.warn('[satın alma] Preisanfragen nicht gesendet:', requestId, (error as Error)?.message));
    });
});
/* Eine freigegebene Revision: geänderte Bestellungen beim Lieferanten gehen neu hinaus. */
productionBomModule.revisions.attachRevisionDispatch((tenantId, actor, purchaseOrderIds) => dispatch.dispatchRevision(tenantId, actor, purchaseOrderIds));

export const procurementAutomationModule = {
    dispatch,
    ordering,
    mailboxes: new ProductionMailboxUseCase(mailboxes, inbox),
    inbox,
};
