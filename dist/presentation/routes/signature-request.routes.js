"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const SignatureRequestController_1 = require("../controllers/SignatureRequestController");
const RateLimitMiddleware_1 = require("../middlewares/RateLimitMiddleware");
const router = (0, express_1.Router)();
const controller = new SignatureRequestController_1.SignatureRequestController();
/**
 * Ohne Anmeldung erreichbar — und bis jetzt ohne jede Bremse: ein Skript
 * konnte hier Schlüssel durchprobieren, so lange es wollte. Die Grenze ist
 * grosszügig genug für eine Kundin, die die Seite ein paarmal neu lädt.
 */
const publicSignatureLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: "Zu viele Anfragen. Bitte versuchen Sie es später erneut.",
});
// ── Öffentlich (ohne Anmeldung) — die Unterschriftsseite der Kundin ─────────
// Der Schlüssel reist im Kopf `X-Public-Token`, nicht mehr im Pfad: ein Pfad
// landet wörtlich im Zugriffsprotokoll und im Verlauf. Siehe publicToken.ts.
router.get("/public", publicSignatureLimiter, (req, res) => controller.getByToken(req, res));
router.post("/public/sign", publicSignatureLimiter, (req, res) => controller.signByToken(req, res));
// Rückfallweg mit dem Schlüssel im Pfad: es sind Verweise unterwegs, und ein
// zwischengespeichertes Oberflächenpaket ruft noch diesen Weg auf. `main.ts`
// schwärzt ihn im Protokoll. Kann weg, sobald die Oberfläche überall neu ist.
router.get("/public/:token", publicSignatureLimiter, (req, res) => controller.getByToken(req, res));
router.post("/public/:token/sign", publicSignatureLimiter, (req, res) => controller.signByToken(req, res));
// ── Admin (authenticated) — manage signature requests across the 3 report kinds
const canManage = (0, RbacMiddleware_1.requireAnyPermission)(["projects.report", "projects.manage", "projects.view"]);
router.get("/", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.list(req, res));
router.post("/", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.create(req, res));
router.get("/:id", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.getOne(req, res));
router.patch("/:id/sign", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.sign(req, res));
router.delete("/:id", AuthMiddleware_1.requireAuth, canManage, (req, res) => controller.remove(req, res));
exports.default = router;
//# sourceMappingURL=signature-request.routes.js.map