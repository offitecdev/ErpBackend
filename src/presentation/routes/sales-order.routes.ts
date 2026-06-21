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

export default router;
