import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission, requirePermission } from '../middlewares/RbacMiddleware';
import { AddonOrderController, ADDON_READ_PERMISSIONS } from '../controllers/AddonOrderController';

/**
 * NACHTRÄGE (NT-…) — eigene Adresse, damit weder `/sales-orders/:id` noch
 * `/projects/:id` einen weiteren Unterweg tragen müssen.
 *
 * Lesen dürfen Büro UND Monteur (die Rapport-Flächen öffnen von hier das
 * Fenster «Zusatzaufträge»); anlegen und ändern nur, wer Nachträge erstellen
 * darf — dasselbe Recht wie beim Zusammenziehen aus dem Feld.
 */
const router = Router();
const controller = new AddonOrderController();

router.use(requireAuth);

router.get('/', requireAnyPermission(ADDON_READ_PERMISSIONS), (req, res) => controller.list(req, res));
router.get('/:id/document', requireAnyPermission(ADDON_READ_PERMISSIONS), (req, res) => controller.document(req, res));
router.post('/', requirePermission('projects.createAddonOrder'), (req, res) => controller.create(req, res));
router.put('/:id/lines', requirePermission('projects.createAddonOrder'), (req, res) => controller.replaceLines(req, res));

export default router;
