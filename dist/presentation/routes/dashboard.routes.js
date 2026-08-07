"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const DashboardController_1 = require("../controllers/DashboardController");
const router = (0, express_1.Router)();
const controller = new DashboardController_1.DashboardController();
router.use(AuthMiddleware_1.requireAuth);
// Cross-domain read: any of the involved view permissions unlocks the
// aggregates (a new permission string would be unassigned on existing roles
// and 403 for everyone — see delivery-report.routes for the same idiom).
const anyDashboardView = (0, RbacMiddleware_1.requireAnyPermission)([
    'crm.customers.view',
    'tenders.view',
    'projects.view',
    'billing.view',
]);
router.get('/summary', anyDashboardView, (req, res) => controller.getSummary(req, res));
router.get('/charts', anyDashboardView, (req, res) => controller.getCharts(req, res));
exports.default = router;
//# sourceMappingURL=dashboard.routes.js.map