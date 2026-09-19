import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { requireSystemAdmin } from '../middlewares/SystemAdminMiddleware';
import { SalesOrderController } from '../controllers/SalesOrderController';
import { previewFullCancel, runFullCancel } from '../controllers/FullCancelController';

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
// Eigene Rechte je Rücknahme (Stufe 3 der Auftragsliste); das Storno
// aufheben gehört der Systemverwaltung allein (16.09.2026, D2/D3).
router.post('/:id/revert-to-draft', requirePermission('salesOrders.revert'), (req, res) => controller.revertToDraft(req, res));
router.post('/:id/cancel', requirePermission('salesOrders.cancel'), (req, res) => controller.cancel(req, res));
// «Gesamten Vorgang stornieren» (17.09.2026): Vorschau + Ausführung samt Rechnungen.
router.get('/:id/full-cancel', requirePermission('salesOrders.cancel'), previewFullCancel('ORDER'));
router.post('/:id/full-cancel', requirePermission('salesOrders.cancel'), runFullCancel('ORDER'));
router.post('/:id/uncancel', requireSystemAdmin, (req, res) => controller.uncancel(req, res));

// Der alte Weg, mit den neuen Regeln: ein Hauptauftrag geht damit zurück in den
// Entwurf, ein Nachtrag ohne Rechnung verschwindet ganz.
router.delete('/:id', requirePermission('projects.manage'), (req, res) => controller.remove(req, res));

export default router;
