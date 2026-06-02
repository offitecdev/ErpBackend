"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const MailController_1 = require("../controllers/MailController");
const router = (0, express_1.Router)();
const controller = new MailController_1.MailController();
router.get('/settings', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('mail.manage'), (req, res) => controller.getSettings(req, res));
router.put('/settings', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('mail.manage'), (req, res) => controller.saveSettings(req, res));
router.post('/send', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('mail.send'), (req, res) => controller.send(req, res));
exports.default = router;
//# sourceMappingURL=mail.routes.js.map