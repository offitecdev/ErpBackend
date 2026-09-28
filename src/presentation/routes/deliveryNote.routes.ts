import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { DeliveryNoteController } from '../controllers/DeliveryNoteController';

/**
 * LIEFERSCHEINE (28.09.2026) — am Auftrag (AB), erstellt von der Auftragskarte
 * der Projektübersicht aus. Lesen mit dem Leserecht des Projekts, Schreiben mit
 * demselben Recht wie die Auftragsbestätigung (`projects.manage`).
 */
const router = Router();
const controller = new DeliveryNoteController();

router.use(requireAuth);

router.get('/', requirePermission('projects.view'), (req, res) => controller.list(req, res));
router.get('/next-number', requirePermission('projects.view'), (req, res) => controller.nextNumber(req, res));
router.get('/article-codes', requirePermission('projects.view'), (req, res) => controller.articleCodes(req, res));
router.post('/', requirePermission('projects.manage'), (req, res) => controller.create(req, res));
router.patch('/:id', requirePermission('projects.manage'), (req, res) => controller.update(req, res));
router.delete('/:id', requirePermission('projects.manage'), (req, res) => controller.remove(req, res));

export default router;
