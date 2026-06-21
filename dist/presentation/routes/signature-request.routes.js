"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const SignatureRequestController_1 = require("../controllers/SignatureRequestController");
const router = (0, express_1.Router)();
const controller = new SignatureRequestController_1.SignatureRequestController();
// ── Public (no auth) — the tokenized customer signature page ────────────────
router.get("/public/:token", (req, res) => controller.getByToken(req, res));
router.post("/public/:token/sign", (req, res) => controller.signByToken(req, res));
// ── Admin (authenticated) — manage signature requests across the 3 report kinds
const canManage = (0, RbacMiddleware_1.requireAnyPermission)(["projects.report", "projects.manage", "projects.view"]);
router.get("/", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.list(req, res));
router.post("/", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.create(req, res));
router.delete("/:id", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.remove(req, res));
exports.default = router;
//# sourceMappingURL=signature-request.routes.js.map