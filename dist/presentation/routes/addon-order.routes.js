"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const AddonOrderController_1 = require("../controllers/AddonOrderController");
/**
 * NACHTRÄGE (NT-…) — eigene Adresse, damit weder `/sales-orders/:id` noch
 * `/projects/:id` einen weiteren Unterweg tragen müssen.
 *
 * Lesen dürfen Büro UND Monteur (die Rapport-Flächen öffnen von hier das
 * Fenster «Zusatzaufträge»); anlegen und ändern nur, wer Nachträge erstellen
 * darf — dasselbe Recht wie beim Zusammenziehen aus dem Feld.
 */
const router = (0, express_1.Router)();
const controller = new AddonOrderController_1.AddonOrderController();
router.use(AuthMiddleware_1.requireAuth);
router.get('/', (0, RbacMiddleware_1.requireAnyPermission)(AddonOrderController_1.ADDON_READ_PERMISSIONS), (req, res) => controller.list(req, res));
router.get('/:id/document', (0, RbacMiddleware_1.requireAnyPermission)(AddonOrderController_1.ADDON_READ_PERMISSIONS), (req, res) => controller.document(req, res));
router.post('/', (0, RbacMiddleware_1.requirePermission)('projects.createAddonOrder'), (req, res) => controller.create(req, res));
router.put('/:id/lines', (0, RbacMiddleware_1.requirePermission)('projects.createAddonOrder'), (req, res) => controller.replaceLines(req, res));
exports.default = router;
//# sourceMappingURL=addon-order.routes.js.map