"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const DeliveryReportController_1 = require("../controllers/DeliveryReportController");
const router = (0, express_1.Router)();
const controller = new DeliveryReportController_1.DeliveryReportController();
// Technicians (projects.report) create and read their delivery reports; admins
// (projects.manage / projects.view) read them in the reports section.
const canReport = (0, RbacMiddleware_1.requireAnyPermission)(["projects.report", "projects.manage", "maintenance.tasks.manage"]);
const canView = (0, RbacMiddleware_1.requireAnyPermission)(["projects.view", "projects.manage", "projects.report"]);
router.get("/", AuthMiddleware_1.requireAuth, canView, (req, res) => controller.list(req, res));
router.get("/by-appointment/:appointmentId", AuthMiddleware_1.requireAuth, canReport, (req, res) => controller.getByAppointment(req, res));
router.get("/:id", AuthMiddleware_1.requireAuth, canView, (req, res) => controller.getOne(req, res));
router.post("/", AuthMiddleware_1.requireAuth, canReport, (req, res) => controller.create(req, res));
router.patch("/:id", AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(["projects.manage", "projects.report"]), (req, res) => controller.update(req, res));
router.patch("/:id/sign", AuthMiddleware_1.requireAuth, canReport, (req, res) => controller.sign(req, res));
exports.default = router;
//# sourceMappingURL=delivery-report.routes.js.map