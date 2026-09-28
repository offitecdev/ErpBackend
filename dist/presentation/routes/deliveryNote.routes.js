"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const DeliveryNoteController_1 = require("../controllers/DeliveryNoteController");
/**
 * LIEFERSCHEINE (28.09.2026) — am Auftrag (AB), erstellt von der Auftragskarte
 * der Projektübersicht aus. Lesen mit dem Leserecht des Projekts, Schreiben mit
 * demselben Recht wie die Auftragsbestätigung (`projects.manage`).
 */
const router = (0, express_1.Router)();
const controller = new DeliveryNoteController_1.DeliveryNoteController();
router.use(AuthMiddleware_1.requireAuth);
router.get('/', (0, RbacMiddleware_1.requirePermission)('projects.view'), (req, res) => controller.list(req, res));
router.get('/next-number', (0, RbacMiddleware_1.requirePermission)('projects.view'), (req, res) => controller.nextNumber(req, res));
router.get('/article-codes', (0, RbacMiddleware_1.requirePermission)('projects.view'), (req, res) => controller.articleCodes(req, res));
router.post('/', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.create(req, res));
router.patch('/:id', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.update(req, res));
router.delete('/:id', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.remove(req, res));
exports.default = router;
//# sourceMappingURL=deliveryNote.routes.js.map