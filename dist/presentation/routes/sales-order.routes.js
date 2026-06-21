"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const SalesOrderController_1 = require("../controllers/SalesOrderController");
const router = (0, express_1.Router)();
const controller = new SalesOrderController_1.SalesOrderController();
router.use(AuthMiddleware_1.requireAuth);
router.get('/', (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), (req, res) => controller.list(req, res));
<<<<<<< HEAD
router.get('/my-orders', (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), (req, res) => controller.myOrders(req, res));
router.post('/from-tender', (0, RbacMiddleware_1.requirePermission)('tenders.approve'), (req, res) => controller.createFromTender(req, res));
router.get('/:id', (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), (req, res) => controller.getById(req, res));
=======
router.post('/from-tender', (0, RbacMiddleware_1.requirePermission)('tenders.approve'), (req, res) => controller.createFromTender(req, res));
>>>>>>> 16c911768b897682a1f0e461e228a105fcd606ae
exports.default = router;
//# sourceMappingURL=sales-order.routes.js.map