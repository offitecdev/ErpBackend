"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const ChecklistController_1 = require("../controllers/ChecklistController");
const router = (0, express_1.Router)();
const controller = new ChecklistController_1.ChecklistController();
// Checklist templates are admin configuration consumed by the delivery-report
// flow. Reading is open to any authenticated user (technicians need templates to
// fill delivery reports). Writing accepts any common admin-level permission so it
// works regardless of how a tenant's admin role happens to be named — the builder
// itself only appears in the admin Settings UI.
const canWrite = (0, RbacMiddleware_1.requireAnyPermission)([
    "projects.manage", "projects.create", "projects.view",
    "tenants.update", "tenants.create", "roles.manage", "mail.manage",
]);
router.get("/", AuthMiddleware_1.requireAuth, (req, res) => controller.list(req, res));
router.get("/:id", AuthMiddleware_1.requireAuth, (req, res) => controller.getOne(req, res));
router.post("/", AuthMiddleware_1.requireAuth, canWrite, (req, res) => controller.create(req, res));
router.put("/:id", AuthMiddleware_1.requireAuth, canWrite, (req, res) => controller.update(req, res));
router.delete("/:id", AuthMiddleware_1.requireAuth, canWrite, (req, res) => controller.remove(req, res));
exports.default = router;
//# sourceMappingURL=checklist.routes.js.map