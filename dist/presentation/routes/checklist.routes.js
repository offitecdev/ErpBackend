"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const ChecklistController_1 = require("../controllers/ChecklistController");
const router = (0, express_1.Router)();
const controller = new ChecklistController_1.ChecklistController();
// Checklist templates are administered from the Settings area and consumed by
// the project delivery-report flow, so we accept either the project-management
// or tenant-administration permission rather than introducing a new one.
const canManage = (0, RbacMiddleware_1.requireAnyPermission)(["projects.manage", "tenants.update"]);
// Technicians (projects.report) only need read access to fill delivery reports.
const canRead = (0, RbacMiddleware_1.requireAnyPermission)(["projects.manage", "tenants.update", "projects.report"]);
router.get("/", AuthMiddleware_1.requireAuth, canRead, (req, res) => controller.list(req, res));
router.get("/:id", AuthMiddleware_1.requireAuth, canRead, (req, res) => controller.getOne(req, res));
router.post("/", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.create(req, res));
router.put("/:id", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.update(req, res));
router.delete("/:id", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.remove(req, res));
exports.default = router;
//# sourceMappingURL=checklist.routes.js.map