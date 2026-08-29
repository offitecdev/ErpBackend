import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { SalesOrderController } from '../controllers/SalesOrderController';

const router = Router();
const controller = new SalesOrderController();

router.use(requireAuth);

router.get('/', requirePermission('crm.customers.view'), (req, res) => controller.list(req, res));
router.get('/my-orders', requirePermission('crm.customers.view'), (req, res) => controller.myOrders(req, res));
router.post('/from-tender', requirePermission('tenders.approve'), (req, res) => controller.createFromTender(req, res));
router.get('/:id', requirePermission('crm.customers.view'), (req, res) => controller.getById(req, res));
router.patch('/:id/payment-stages', requirePermission('billing.manage'), (req, res) => controller.updatePaymentStages(req, res));
// Auftragsbestätigung: Einleitungstext + «Gültig bis». Sie wird von der
// Auftragskarte aus geschrieben — auf der Projektübersicht wie in der
// Auftragsansicht — also gilt dieselbe Berechtigung wie für den Verkäufertext.
router.patch('/:id/order-confirmation', requirePermission('projects.manage'), (req, res) => controller.updateOrderConfirmation(req, res));

export default router;
