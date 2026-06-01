import { Router } from "express";
import { requireAuth } from "../middlewares/AuthMiddleware";
import { requirePermission } from "../middlewares/RbacMiddleware";
import { MailController } from "../controllers/MailController";

const router = Router();
const controller = new MailController();

router.get('/settings', requireAuth, requirePermission('mail.manage'), (req, res) => controller.getSettings(req, res));
router.put('/settings', requireAuth, requirePermission('mail.manage'), (req, res) => controller.saveSettings(req, res));
router.post('/send', requireAuth, requirePermission('mail.send'), (req, res) => controller.send(req, res));

export default router;
