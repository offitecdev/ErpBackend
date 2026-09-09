import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { SalesOrderController } from '../controllers/SalesOrderController';

const router = Router();
const controller = new SalesOrderController();

router.use(requireAuth);

router.get('/', requirePermission('crm.customers.view'), (req, res) => controller.list(req, res));
router.get('/my-orders', requirePermission('crm.customers.view'), (req, res) => controller.myOrders(req, res));
router.post('/from-tender', requirePermission('tenders.approve'), (req, res) => controller.createFromTender(req, res));
router.get('/:id', requirePermission('crm.customers.view'), (req, res) => controller.getById(req, res));
router.patch('/:id/payment-stages', requirePermission('billing.manage'), (req, res) => controller.updatePaymentStages(req, res));
// Auftragsbestätigung: Einleitungstext + «Gültig bis». Sie wird von der
// Auftragskarte aus geschrieben — auf der Projektübersicht wie in der
// Auftragsansicht — also gilt dieselbe Berechtigung wie für den Verkäufertext.
router.patch('/:id/order-confirmation', requirePermission('projects.manage'), (req, res) => controller.updateOrderConfirmation(req, res));

/**
 * ── LÖSCHEN / STORNO / ZURÜCK IN ENTWURF (Vorgabe Samet 06.09.2026) ──────────
 * Alle drei sind ein Eingriff in den Auftragsbestand — dieselbe Berechtigung
 * wie das Löschen über das Projekt (`projects.manage`). Nur die AUSKUNFT, was
 * erlaubt wäre, genügt mit Leserecht: die Auftragsansicht holt sie beim Öffnen.
 */
router.get('/:id/lifecycle', requirePermission('crm.customers.view'), (req, res) => controller.lifecycle(req, res));
router.post('/:id/revert-to-draft', requirePermission('projects.manage'), (req, res) => controller.revertToDraft(req, res));
router.post('/:id/cancel', requirePermission('projects.manage'), (req, res) => controller.cancel(req, res));
router.post('/:id/uncancel', requirePermission('projects.manage'), (req, res) => controller.uncancel(req, res));

// Der alte Weg, mit den neuen Regeln: ein Hauptauftrag geht damit zurück in den
// Entwurf, ein Nachtrag ohne Rechnung verschwindet ganz.
router.delete('/:id', requirePermission('projects.manage'), (req, res) => controller.remove(req, res));

export default router;
