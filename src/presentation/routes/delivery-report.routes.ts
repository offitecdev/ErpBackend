import { Router } from "express";
import { requireAuth } from "../middlewares/AuthMiddleware";
import { requireAnyPermission } from "../middlewares/RbacMiddleware";
import { DeliveryReportController } from "../controllers/DeliveryReportController";

const router = Router();
const controller = new DeliveryReportController();

// Technicians (projects.report) create and read their delivery reports; admins
// (projects.manage / projects.view) read them in the reports section.
const canReport = requireAnyPermission(["projects.report", "projects.manage", "maintenance.tasks.manage"]);
const canView = requireAnyPermission(["projects.view", "projects.manage", "projects.report"]);

router.get("/", requireAuth, canView, (req, res) => controller.list(req, res));
router.get("/by-appointment/:appointmentId", requireAuth, canReport, (req, res) => controller.getByAppointment(req, res));
router.get("/:id", requireAuth, canView, (req, res) => controller.getOne(req, res));
router.post("/", requireAuth, canReport, (req, res) => controller.create(req, res));
router.patch("/:id", requireAuth, requireAnyPermission(["projects.manage", "projects.report"]), (req, res) => controller.update(req, res));
router.patch("/:id/sign", requireAuth, canReport, (req, res) => controller.sign(req, res));

export default router;
