import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission, requirePermission } from '../middlewares/RbacMiddleware';
import { requireItGate } from '../middlewares/ItGateMiddleware';
import { responseCache } from '../middlewares/ResponseCacheMiddleware';
import { ProductionController } from '../controllers/ProductionController';
// Schaltschränke (20.09.2026): Modell-/Seriennummern, Typenschild — ein
// eigener Router unter /production/panels, damit diese Datei knapp bleibt.
import panelRouter from './panel.routes';
// Görevlendirme (26.09.2026): Vorlagen und die Aufgaben der Geräte.
import productionTaskRouter from './productionTasks.routes';
// BOM (27.09.2026): Vorlagen, BOMs der Geräte, Reservierung, Bestellungen.
import productionBomRouter from './productionBom.routes';
// Automatik des Einkaufs (30.09.2026): Postfächer, Senden, Bestellen aus dem Vergleich.
import productionProcurementRouter from './productionProcurement.routes';

/**
 * ── /production — DAS PRODUKTIONSMODUL (19.09.2026) ─────────────────────────
 *
 *   GET  /status                       ist das Modul in dieser Firma an?
 *   POST /sync                         Abgleich mit dem Verkauf (force = sofort)
 *   GET  /overview                     Seite «Produktionsaufträge»
 *   GET  /projects/:id                 Projektseite (zwei Reiter + Vergleich)
 *   GET  /projects/:id/devices         Projektseite + Geräteseite: Tabelle, Geräte (24.09.2026)
 *   GET  /lines                        Seite «Bestellte Produkte»
 *   GET  /items/:id                    das Gerät im Fenster
 *   GET  /picker/projects              Auswahl in der Lieferantenbestellung
 *   GET  /picker/projects/:id          … die Geräte eines Projekts
 *   GET  /picker/purchase-orders/:id   … die Auswahl einer Bestellung
 *   GET  /settings, PUT /settings      Einstellungen → Firmenübertragungen
 *   GET  /supplier-links, PUT …        Modul-Einstellungen › Produktion › Produktionslieferant
 *
 * Die Auswahl selbst wird mit der Bestellung gespeichert (inventory.routes).
 * Die Lagerleute brauchen die Auswahl-Wege auch ohne eigenes Produktionsrecht:
 * darum dort `inventory.view` ODER `production.view`.
 */
const router = Router();
const controller = new ProductionController();

const VIEW = requirePermission('production.view');
const VIEW_OR_INVENTORY = requireAnyPermission(['production.view', 'inventory.view', 'panels.view']);
const cache = responseCache({ namespaces: ['production'], ttlSec: 20 });

router.use(requireAuth);

router.get('/status', (req, res, next) => controller.status(req, res, next));

router.post('/sync', VIEW_OR_INVENTORY, ProductionController.requireModule, (req, res, next) => controller.sync(req, res, next));

router.get('/overview', VIEW, ProductionController.requireModule, cache, (req, res, next) => controller.overview(req, res, next));
router.get('/projects/:id/devices', VIEW, ProductionController.requireModule, cache, (req, res, next) => controller.projectDevices(req, res, next));
router.get('/projects/:id/devices/:deviceId', VIEW, ProductionController.requireModule, cache, (req, res, next) => controller.deviceHeader(req, res, next));
router.get('/projects/:id', VIEW, ProductionController.requireModule, cache, (req, res, next) => controller.project(req, res, next));
router.get('/lines', VIEW, ProductionController.requireModule, cache, (req, res, next) => controller.lines(req, res, next));
router.get('/items/:id', VIEW_OR_INVENTORY, ProductionController.requireModule, cache, (req, res, next) => controller.item(req, res, next));

router.get('/picker/projects', VIEW_OR_INVENTORY, ProductionController.requireModule, cache, (req, res, next) => controller.pickerProjects(req, res, next));
router.get('/picker/projects/:id', VIEW_OR_INVENTORY, ProductionController.requireModule, cache, (req, res, next) => controller.pickerProject(req, res, next));
router.get('/picker/purchase-orders/:purchaseOrderId', VIEW_OR_INVENTORY, cache, (req, res, next) => controller.pickerAssignment(req, res, next));

// Firmenübertragungen öffnen Daten ANDERER Firmen für die Produktion — das
// ist Sache der Verwaltung und steht hinter dem IT-Kennwort (wie das ganze
// Einstellungsmenü). Lesen geht ohne Schleuse, damit die Seite ihren Stand zeigt.
router.get('/settings', requirePermission('roles.manage'), (req, res, next) => controller.getSettings(req, res, next));
router.put('/settings', requirePermission('roles.manage'), requireItGate, (req, res, next) => controller.saveSettings(req, res, next));

// Produktionslieferant (02.10.2026): stellt die BESTELLENDE Firma ein — dort
// ist die Produktion meist gar nicht eingeschaltet, darum ohne requireModule.
// Gleiche Hürde wie die Firmenübertragungen.
router.get('/supplier-links', requirePermission('roles.manage'), (req, res, next) => controller.getSupplierLinks(req, res, next));
router.put('/supplier-links', requirePermission('roles.manage'), requireItGate, (req, res, next) => controller.saveSupplierLinks(req, res, next));

// Die Schaltschrank-Wege erben `requireAuth` von oben.
router.use('/panels', panelRouter);

// Görevlendirme: /task-templates und /devices/:itemId/tasks (erben `requireAuth`).
router.use(productionTaskRouter);

// BOM: /bom/* (erbt `requireAuth`).
// VOR der BOM: dort fängt `/bom/procurement/requests/:id/:action` alles Übrige ab.
router.use(productionProcurementRouter);
router.use(productionBomRouter);

export default router;
