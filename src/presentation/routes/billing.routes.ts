import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { BillingController } from '../controllers/BillingController';
import { CreateInvoiceUseCase } from '../../application/use-cases/billing/CreateInvoiceUseCase';
import { CreateDirectInvoiceUseCase } from '../../application/use-cases/billing/CreateDirectInvoiceUseCase';
import { GetBillingSummaryUseCase } from '../../application/use-cases/billing/GetBillingSummaryUseCase';
import { ListInvoicesUseCase } from '../../application/use-cases/billing/ListInvoicesUseCase';
import { UpdateInvoiceStatusUseCase } from '../../application/use-cases/billing/UpdateInvoiceStatusUseCase';
import { InvoiceDraftUseCase } from '../../application/use-cases/billing/InvoiceDraftUseCase';
import { InvoiceCreditUseCase } from '../../application/use-cases/billing/InvoiceCreditUseCase';
import { UpdateDirectInvoiceUseCase } from '../../application/use-cases/billing/UpdateDirectInvoiceUseCase';
import { UpdateInvoiceDatesUseCase } from '../../application/use-cases/billing/UpdateInvoiceDatesUseCase';
import { InvoiceRepository } from '../../infrastructure/repositories/InvoiceRepository';

const router = Router();

const invoiceRepo = new InvoiceRepository();
const createInvoiceUseCase = new CreateInvoiceUseCase(invoiceRepo);
const controller = new BillingController(
    createInvoiceUseCase,
    new GetBillingSummaryUseCase(invoiceRepo),
    new ListInvoicesUseCase(invoiceRepo),
    new UpdateInvoiceStatusUseCase(invoiceRepo),
    new InvoiceDraftUseCase(invoiceRepo, createInvoiceUseCase),
    new InvoiceCreditUseCase(),
    new CreateDirectInvoiceUseCase(invoiceRepo),
    new UpdateDirectInvoiceUseCase(invoiceRepo),
    new UpdateInvoiceDatesUseCase(invoiceRepo)
);

router.use(requireAuth);

router.get('/summary', requirePermission('billing.view'), (req, res) => controller.getSummary(req, res));
// Buchhaltung (Schritt 7): Kennzahlen und «Zu verrechnen».
router.get('/figures', requirePermission('billing.view'), (req, res) => controller.figures(req, res));
router.get('/to-bill', requirePermission('billing.view'), (req, res) => controller.toBill(req, res));
router.get('/invoices', requirePermission('billing.view'), (req, res) => controller.list(req, res));
router.post('/invoices', requirePermission('billing.create'), (req, res) => controller.create(req, res));
// Direktrechnung — die selbst ausgefüllte Vorlage (weder Auftrag noch Projekt).
router.post('/invoices/direct', requirePermission('billing.create'), (req, res) => controller.createDirect(req, res));
// Eine Direktrechnung noch einmal öffnen und als GANZES neu schreiben — die
// Nummer und der Zahlungsstand bleiben (siehe UpdateDirectInvoiceUseCase).
router.put('/invoices/:id/direct', requirePermission('billing.create'), (req, res) => controller.updateDirect(req, res));
// Vorschau der nächsten Rechnungsnummer (bewegt den Zähler NICHT) — die
// Erfassungsmaske zeigt sie, statt «Entwurf» zu schreiben.
router.get('/invoices/next-number', requirePermission('billing.create'), (req, res) => controller.nextInvoiceNumber(req, res));
// ── Entwürfe (Buchhaltung, Schritt 5) ─────────────────────────────────────
// Eine Rechnung entsteht als Entwurf ohne Nummer; «Ausstellen» zieht sie.
router.put('/invoices/:id/draft', requirePermission('billing.create'), (req, res) => controller.updateDraft(req, res));
router.post('/invoices/:id/issue', requirePermission('billing.create'), (req, res) => controller.issue(req, res));
// ── Gegenbelege (Schritt 6): Storno-Rechnung / Gutschrift. invoices.cancel prüft der Controller.
router.post('/invoices/:id/storno', requirePermission('billing.manage'), (req, res) => controller.storno(req, res));
router.post('/invoices/:id/credit', requirePermission('billing.manage'), (req, res) => controller.credit(req, res));
// Zahlungseingänge (Schritt 7 / G19): in Teilen erfassen, Fehlerfassung entfernen.
router.post('/invoices/:id/payments', requirePermission('billing.manage'), (req, res) => controller.addPayment(req, res));
router.delete('/invoices/:id/payments/:paymentId', requirePermission('billing.manage'), (req, res) => controller.removePayment(req, res));
// Eine Rechnung (Detailseite) — NACH `/invoices/next-number`, sonst fiele
// «next-number» als Kennung hier hinein.
router.get('/invoices/:id', requirePermission('billing.view'), (req, res) => controller.getById(req, res));
// Produktbilder der Direktrechnung: dieselbe Tabelle wie das Angebot braucht
// dieselben Bilder, aber ohne Offerte, an der sie hängen könnten.
router.post('/product-images', requirePermission('billing.view'), (req, res) => controller.getProductImages(req, res));
// Rechnungsdatum + Fälligkeit — auch für gestellte Rechnungen (16.09.2026).
router.patch('/invoices/:id/dates', requirePermission('billing.manage'), (req, res) => controller.updateDates(req, res));
router.patch('/invoices/:id/status', requirePermission('billing.manage'), (req, res) => controller.updateStatus(req, res));
// Löschen — NUR Entwürfe (der Use Case prüft); ausgestellte bleiben stehen.
router.delete('/invoices/:id', requirePermission('billing.create'), (req, res) => controller.delete(req, res));

export default router;
