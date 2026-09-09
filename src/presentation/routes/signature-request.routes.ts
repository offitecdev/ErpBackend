import { Router } from "express";
import { requireAuth } from "../middlewares/AuthMiddleware";
import { requireAnyPermission } from "../middlewares/RbacMiddleware";
import { SignatureRequestController } from "../controllers/SignatureRequestController";
import { rateLimit } from "../middlewares/RateLimitMiddleware";

const router = Router();
const controller = new SignatureRequestController();

/**
 * Ohne Anmeldung erreichbar — und bis jetzt ohne jede Bremse: ein Skript
 * konnte hier Schlüssel durchprobieren, so lange es wollte. Die Grenze ist
 * grosszügig genug für eine Kundin, die die Seite ein paarmal neu lädt.
 */
const publicSignatureLimiter = rateLimit({
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
const canManage = requireAnyPermission(["projects.report", "projects.manage", "projects.view"]);
router.get("/", requireAuth, canManage, (req, res) => controller.list(req, res));
router.post("/", requireAuth, canManage, (req, res) => controller.create(req, res));
router.get("/:id", requireAuth, canManage, (req, res) => controller.getOne(req, res));
router.patch("/:id/sign", requireAuth, canManage, (req, res) => controller.sign(req, res));
router.delete("/:id", requireAuth, canManage, (req, res) => controller.remove(req, res));

export default router;
