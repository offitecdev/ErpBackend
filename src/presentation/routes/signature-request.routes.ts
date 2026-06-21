import { Router } from "express";
import { requireAuth } from "../middlewares/AuthMiddleware";
import { requireAnyPermission } from "../middlewares/RbacMiddleware";
import { SignatureRequestController } from "../controllers/SignatureRequestController";

const router = Router();
const controller = new SignatureRequestController();

// ── Public (no auth) — the tokenized customer signature page ────────────────
router.get("/public/:token", (req, res) => controller.getByToken(req, res));
router.post("/public/:token/sign", (req, res) => controller.signByToken(req, res));

// ── Admin (authenticated) — manage signature requests across the 3 report kinds
const canManage = requireAnyPermission(["projects.report", "projects.manage", "projects.view"]);
router.get("/", requireAuth, canManage, (req, res) => controller.list(req, res));
router.post("/", requireAuth, canManage, (req, res) => controller.create(req, res));
router.delete("/:id", requireAuth, canManage, (req, res) => controller.remove(req, res));

export default router;
