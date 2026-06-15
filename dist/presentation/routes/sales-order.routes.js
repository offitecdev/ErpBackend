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
router.post('/from-tender', (0, RbacMiddleware_1.requirePermission)('tenders.approve'), (req, res) => controller.createFromTender(req, res));
exports.default = router;
//# sourceMappingURL=sales-order.routes.js.map