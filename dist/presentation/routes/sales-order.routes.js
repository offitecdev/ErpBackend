"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const SystemAdminMiddleware_1 = require("../middlewares/SystemAdminMiddleware");
const SalesOrderController_1 = require("../controllers/SalesOrderController");
const FullCancelController_1 = require("../controllers/FullCancelController");
const router = (0, express_1.Router)();
const controller = new SalesOrderController_1.SalesOrderController();
router.use(AuthMiddleware_1.requireAuth);
router.get('/', (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), (req, res) => controller.list(req, res));
router.get('/my-orders', (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), (req, res) => controller.myOrders(req, res));
router.post('/from-tender', (0, RbacMiddleware_1.requirePermission)('tenders.approve'), (req, res) => controller.createFromTender(req, res));
router.get('/:id', (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), (req, res) => controller.getById(req, res));
router.patch('/:id/payment-stages', (0, RbacMiddleware_1.requirePermission)('billing.manage'), (req, res) => controller.updatePaymentStages(req, res));
// Auftragsbestätigung: Einleitungstext + «Gültig bis». Sie wird von der
// Auftragskarte aus geschrieben — auf der Projektübersicht wie in der
// Auftragsansicht — also gilt dieselbe Berechtigung wie für den Verkäufertext.
router.patch('/:id/order-confirmation', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.updateOrderConfirmation(req, res));
/**
 * ── LÖSCHEN / STORNO / ZURÜCK IN ENTWURF (Vorgabe Samet 06.09.2026) ──────────
 * Alle drei sind ein Eingriff in den Auftragsbestand — dieselbe Berechtigung
 * wie das Löschen über das Projekt (`projects.manage`). Nur die AUSKUNFT, was
 * erlaubt wäre, genügt mit Leserecht: die Auftragsansicht holt sie beim Öffnen.
 */
router.get('/:id/lifecycle', (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), (req, res) => controller.lifecycle(req, res));
// Eigene Rechte je Rücknahme (Stufe 3 der Auftragsliste); das Storno
// aufheben gehört der Systemverwaltung allein (16.09.2026, D2/D3).
router.post('/:id/revert-to-draft', (0, RbacMiddleware_1.requirePermission)('salesOrders.revert'), (req, res) => controller.revertToDraft(req, res));
router.post('/:id/cancel', (0, RbacMiddleware_1.requirePermission)('salesOrders.cancel'), (req, res) => controller.cancel(req, res));
// «Gesamten Vorgang stornieren» (17.09.2026): Vorschau + Ausführung samt Rechnungen.
router.get('/:id/full-cancel', (0, RbacMiddleware_1.requirePermission)('salesOrders.cancel'), (0, FullCancelController_1.previewFullCancel)('ORDER'));
router.post('/:id/full-cancel', (0, RbacMiddleware_1.requirePermission)('salesOrders.cancel'), (0, FullCancelController_1.runFullCancel)('ORDER'));
router.post('/:id/uncancel', SystemAdminMiddleware_1.requireSystemAdmin, (req, res) => controller.uncancel(req, res));
// Der alte Weg, mit den neuen Regeln: ein Hauptauftrag geht damit zurück in den
// Entwurf, ein Nachtrag ohne Rechnung verschwindet ganz.
router.delete('/:id', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.remove(req, res));
exports.default = router;
//# sourceMappingURL=sales-order.routes.js.map