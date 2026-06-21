import { Router } from "express";
import { requireAuth } from "../middlewares/AuthMiddleware";
import { requireAnyPermission } from "../middlewares/RbacMiddleware";
import { ChecklistController } from "../controllers/ChecklistController";

const router = Router();
const controller = new ChecklistController();

// Checklist templates are admin configuration consumed by the delivery-report
// flow. Reading is open to any authenticated user (technicians need templates to
// fill delivery reports). Writing accepts any common admin-level permission so it
// works regardless of how a tenant's admin role happens to be named — the builder
// itself only appears in the admin Settings UI.
const canWrite = requireAnyPermission([
    "projects.manage", "projects.create", "projects.view",
    "tenants.update", "tenants.create", "roles.manage", "mail.manage",
]);

router.get("/", requireAuth, (req, res) => controller.list(req, res));
router.get("/:id", requireAuth, (req, res) => controller.getOne(req, res));
router.post("/", requireAuth, canWrite, (req, res) => controller.create(req, res));
router.put("/:id", requireAuth, canWrite, (req, res) => controller.update(req, res));
router.delete("/:id", requireAuth, canWrite, (req, res) => controller.remove(req, res));

export default router;
