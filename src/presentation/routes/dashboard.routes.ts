import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission } from '../middlewares/RbacMiddleware';
import { DashboardController } from '../controllers/DashboardController';

const router = Router();
const controller = new DashboardController();

router.use(requireAuth);

// Cross-domain read: any of the involved view permissions unlocks the
// aggregates (a new permission string would be unassigned on existing roles
// and 403 for everyone — see delivery-report.routes for the same idiom).
const anyDashboardView = requireAnyPermission([
    'crm.customers.view',
    'tenders.view',
    'projects.view',
    'billing.view',
]);

router.get('/summary', anyDashboardView, (req, res) => controller.getSummary(req, res));
router.get('/charts', anyDashboardView, (req, res) => controller.getCharts(req, res));

export default router;
