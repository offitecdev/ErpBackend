import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { BillingController } from '../controllers/BillingController';
import { CreateInvoiceUseCase } from '../../application/use-cases/billing/CreateInvoiceUseCase';
import { CreateDirectInvoiceUseCase } from '../../application/use-cases/billing/CreateDirectInvoiceUseCase';
import { GetBillingSummaryUseCase } from '../../application/use-cases/billing/GetBillingSummaryUseCase';
import { ListInvoicesUseCase } from '../../application/use-cases/billing/ListInvoicesUseCase';
import { UpdateInvoiceStatusUseCase } from '../../application/use-cases/billing/UpdateInvoiceStatusUseCase';
import { DeleteInvoiceUseCase } from '../../application/use-cases/billing/DeleteInvoiceUseCase';
import { UpdateDirectInvoiceUseCase } from '../../application/use-cases/billing/UpdateDirectInvoiceUseCase';
import { InvoiceRepository } from '../../infrastructure/repositories/InvoiceRepository';

const router = Router();

const invoiceRepo = new InvoiceRepository();
const controller = new BillingController(
    new CreateInvoiceUseCase(invoiceRepo),
    new GetBillingSummaryUseCase(invoiceRepo),
    new ListInvoicesUseCase(invoiceRepo),
    new UpdateInvoiceStatusUseCase(invoiceRepo),
    new DeleteInvoiceUseCase(invoiceRepo),
    new CreateDirectInvoiceUseCase(invoiceRepo),
    new UpdateDirectInvoiceUseCase(invoiceRepo)
);

router.use(requireAuth);

router.get('/summary', requirePermission('billing.view'), (req, res) => controller.getSummary(req, res));
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
// Produktbilder der Direktrechnung: dieselbe Tabelle wie das Angebot braucht
// dieselben Bilder, aber ohne Offerte, an der sie hängen könnten.
router.post('/product-images', requirePermission('billing.view'), (req, res) => controller.getProductImages(req, res));
router.patch('/invoices/:id/status', requirePermission('billing.manage'), (req, res) => controller.updateStatus(req, res));
// Kalıcı silme — yalnızca CANCELLED faturalar (use case doğrular).
router.delete('/invoices/:id', requirePermission('billing.manage'), (req, res) => controller.delete(req, res));

export default router;
