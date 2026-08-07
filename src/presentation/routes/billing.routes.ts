import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { BillingController } from '../controllers/BillingController';
import { CreateInvoiceUseCase } from '../../application/use-cases/billing/CreateInvoiceUseCase';
import { GetBillingSummaryUseCase } from '../../application/use-cases/billing/GetBillingSummaryUseCase';
import { ListInvoicesUseCase } from '../../application/use-cases/billing/ListInvoicesUseCase';
import { UpdateInvoiceStatusUseCase } from '../../application/use-cases/billing/UpdateInvoiceStatusUseCase';
import { DeleteInvoiceUseCase } from '../../application/use-cases/billing/DeleteInvoiceUseCase';
import { InvoiceRepository } from '../../infrastructure/repositories/InvoiceRepository';

const router = Router();

const invoiceRepo = new InvoiceRepository();
const controller = new BillingController(
    new CreateInvoiceUseCase(invoiceRepo),
    new GetBillingSummaryUseCase(invoiceRepo),
    new ListInvoicesUseCase(invoiceRepo),
    new UpdateInvoiceStatusUseCase(invoiceRepo),
    new DeleteInvoiceUseCase(invoiceRepo)
);

router.use(requireAuth);

router.get('/summary', requirePermission('billing.view'), (req, res) => controller.getSummary(req, res));
router.get('/invoices', requirePermission('billing.view'), (req, res) => controller.list(req, res));
router.post('/invoices', requirePermission('billing.create'), (req, res) => controller.create(req, res));
router.patch('/invoices/:id/status', requirePermission('billing.manage'), (req, res) => controller.updateStatus(req, res));
// Kalıcı silme — yalnızca CANCELLED faturalar (use case doğrular).
router.delete('/invoices/:id', requirePermission('billing.manage'), (req, res) => controller.delete(req, res));

export default router;
