"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const ItGateMiddleware_1 = require("../middlewares/ItGateMiddleware");
const ResponseCacheMiddleware_1 = require("../middlewares/ResponseCacheMiddleware");
const ProductionController_1 = require("../controllers/ProductionController");
// Schaltschränke (20.09.2026): Modell-/Seriennummern, Typenschild — ein
// eigener Router unter /production/panels, damit diese Datei knapp bleibt.
const panel_routes_1 = __importDefault(require("./panel.routes"));
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
 *
 * Die Auswahl selbst wird mit der Bestellung gespeichert (inventory.routes).
 * Die Lagerleute brauchen die Auswahl-Wege auch ohne eigenes Produktionsrecht:
 * darum dort `inventory.view` ODER `production.view`.
 */
const router = (0, express_1.Router)();
const controller = new ProductionController_1.ProductionController();
const VIEW = (0, RbacMiddleware_1.requirePermission)('production.view');
const VIEW_OR_INVENTORY = (0, RbacMiddleware_1.requireAnyPermission)(['production.view', 'inventory.view', 'panels.view']);
const cache = (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['production'], ttlSec: 20 });
router.use(AuthMiddleware_1.requireAuth);
router.get('/status', (req, res, next) => controller.status(req, res, next));
router.post('/sync', VIEW_OR_INVENTORY, ProductionController_1.ProductionController.requireModule, (req, res, next) => controller.sync(req, res, next));
router.get('/overview', VIEW, ProductionController_1.ProductionController.requireModule, cache, (req, res, next) => controller.overview(req, res, next));
router.get('/projects/:id/devices', VIEW, ProductionController_1.ProductionController.requireModule, cache, (req, res, next) => controller.projectDevices(req, res, next));
router.get('/projects/:id', VIEW, ProductionController_1.ProductionController.requireModule, cache, (req, res, next) => controller.project(req, res, next));
router.get('/lines', VIEW, ProductionController_1.ProductionController.requireModule, cache, (req, res, next) => controller.lines(req, res, next));
router.get('/items/:id', VIEW_OR_INVENTORY, ProductionController_1.ProductionController.requireModule, cache, (req, res, next) => controller.item(req, res, next));
router.get('/picker/projects', VIEW_OR_INVENTORY, ProductionController_1.ProductionController.requireModule, cache, (req, res, next) => controller.pickerProjects(req, res, next));
router.get('/picker/projects/:id', VIEW_OR_INVENTORY, ProductionController_1.ProductionController.requireModule, cache, (req, res, next) => controller.pickerProject(req, res, next));
router.get('/picker/purchase-orders/:purchaseOrderId', VIEW_OR_INVENTORY, cache, (req, res, next) => controller.pickerAssignment(req, res, next));
// Firmenübertragungen öffnen Daten ANDERER Firmen für die Produktion — das
// ist Sache der Verwaltung und steht hinter dem IT-Kennwort (wie das ganze
// Einstellungsmenü). Lesen geht ohne Schleuse, damit die Seite ihren Stand zeigt.
router.get('/settings', (0, RbacMiddleware_1.requirePermission)('roles.manage'), (req, res, next) => controller.getSettings(req, res, next));
router.put('/settings', (0, RbacMiddleware_1.requirePermission)('roles.manage'), ItGateMiddleware_1.requireItGate, (req, res, next) => controller.saveSettings(req, res, next));
// Die Schaltschrank-Wege erben `requireAuth` von oben.
router.use('/panels', panel_routes_1.default);
exports.default = router;
//# sourceMappingURL=production.routes.js.map