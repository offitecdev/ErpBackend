import { Router } from 'express';

import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { responseCache } from '../middlewares/ResponseCacheMiddleware';
import { requireSystemAdmin } from '../middlewares/SystemAdminMiddleware';
import { WarehouseController } from '../controllers/WarehouseController';

/**
 * ── /warehouse — DAS DEPO DER PRODUKTIONSFIRMA (26.09.2026, Vorgabe Samet) ──
 *
 *   GET    /status                            gibt es das Depo in dieser Firma?
 *   GET    /products                          Produktkarten (Suche, Gruppen, Barcode, Seiten)
 *   POST   /products                          neue Karte (Pflicht: Name) [+ Seriennummern]; mit Gruppe → ERP-Code + Barcode
 *   GET    /export                            alle Karten der Abfrage (PDF / Excel, höchstens 5000)
 *   GET    /products/:id                      Karte + Seriennummern
 *   PATCH  /products/:id                      Karte ändern (neue Gruppe → neuer ERP-Code)
 *   DELETE /products/:id                      Karte löschen (samt Seriennummern)
 *   POST   /products/:id/receive              «Ürün ekle»: Bestand ± n (ohne Seriennummern)
 *   POST   /products/:id/serials              Seriennummer anlegen (Bestand zählt mit)
 *   PATCH  /serials/:id                       Nummer / Projekt / Gerät ändern
 *   DELETE /serials/:id                       Seriennummer löschen
 *   GET    /lookup?code=                      Scan: Seriennummer, Barcode, Herstellerbarcode, ERP-Code
 *   GET    /material-groups                   Hauptkategorien mit ihren Gruppen (+ Zahl der Karten)
 *   POST   /categories                        Hauptkategorie anlegen (Name + Kürzel)
 *   PATCH  /categories/:id                    Hauptkategorie ändern (Kürzel nur ohne Karten mit Code)
 *   DELETE /categories/:id                    Hauptkategorie löschen (nur ohne Gruppen)
 *   POST   /material-groups                   Gruppe anlegen (Kategorie, Name, Kürzel)
 *   PATCH  /material-groups/:id               Gruppe ändern
 *   DELETE /material-groups/:id               Gruppe löschen (nur ohne Karten)
 *   POST   /material-groups/:id/assign-codes  Karten der Gruppe ohne Code bekommen ihn
 *   GET    /settings                          Etikett der Firma
 *   PUT    /settings                          Etikett speichern
 *   GET    /imports                           Excel-Aktarımlar (neueste zuerst)
 *   POST   /imports/preview                   Zeilen prüfen, ohne zu speichern
 *   POST   /imports                           Zeilen zur Freigabe einreichen
 *   GET    /imports/:id                       ein Aktarım mit Zeilen (geprüft gegen jetzt)
 *   POST   /imports/:id/approve               Freigabe: die Karten entstehen (nur Administratorrolle)
 *   POST   /imports/:id/reject                ablehnen (nur Administratorrolle)
 *   POST   /imports/:id/cancel                zurückziehen (einreichende Person)
 *   GET    /suppliers?q=                      Lieferantenliste der Firma (nur lesen)
 *   GET    /production-projects?search=       Produktionsprojekte (nur lesen)
 *   GET    /production-projects/:id/devices   ihre Geräte (nur lesen)
 *
 * Rechte: lesen mit `production.view`, schreiben mit `production.manage` — das
 * Depo gehört zur Produktion («sadece üretim modülü ile ilişkili»). Dazu die
 * Firmenschranke `requireWarehouse`: nur Produktionsfirmen, nur wo die
 * Kategorie die Produktion führt. Einen Aktarım gibt nur die
 * Administratorrolle frei («her aktarımdan önce administratöre izin»).
 */
const router = Router();
const controller = new WarehouseController();

const VIEW = requirePermission('production.view');
const MANAGE = requirePermission('production.manage');
const GATE = WarehouseController.requireWarehouse;
const cache = responseCache({ namespaces: ['warehouse'], ttlSec: 20 });
// Die Auswahlen lesen fremde Tabellen: jede Schreibanfrage dort macht sie alt.
const supplierCache = responseCache({ namespaces: ['warehouse', 'catalog'], ttlSec: 60 });
const productionCache = responseCache({ namespaces: ['warehouse', 'production'], ttlSec: 30 });

router.use(requireAuth);

/**
 * @swagger
 * /warehouse/status:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: gibt es das Depo in der gewählten Firma (Produktionsfirma, Produktion eingeschaltet)?"
 *     security:
 *       - bearerAuth: []
 */
router.get('/status', (req, res, next) => controller.status(req, res, next));

/**
 * @swagger
 * /warehouse/products:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: Produktkarten — Suche nach ERP-Code oder Name, Materialgruppen, Barcode, Seiten"
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: groups, schema: { type: string }, description: "Kennungen mit Komma; none = ohne Gruppe" }
 *       - { in: query, name: barcode, schema: { type: string } }
 *       - { in: query, name: sort, schema: { type: string } }
 *       - { in: query, name: dir, schema: { type: string, enum: [asc, desc] } }
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: pageSize, schema: { type: integer } }
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: neue Produktkarte (Pflicht ist nur der Name; mit Gruppe vergibt der Server ERP-Code und Barcode)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/products', VIEW, GATE, cache, (req, res, next) => controller.list(req, res, next));
router.post('/products', MANAGE, GATE, (req, res, next) => controller.create(req, res, next));

/**
 * @swagger
 * /warehouse/export:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: alle Karten der Abfrage für PDF und Excel (höchstens 5000)"
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: groups, schema: { type: string } }
 *       - { in: query, name: barcode, schema: { type: string } }
 *       - { in: query, name: sort, schema: { type: string } }
 *       - { in: query, name: dir, schema: { type: string, enum: [asc, desc] } }
 */
router.get('/export', VIEW, GATE, cache, (req, res, next) => controller.export(req, res, next));

/**
 * @swagger
 * /warehouse/products/{id}:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: Produktkarte mit Seriennummern"
 *     security:
 *       - bearerAuth: []
 *   patch:
 *     tags: [Warehouse]
 *     summary: "Depo: Produktkarte ändern (eine neue Materialgruppe gibt einen neuen ERP-Code)"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Warehouse]
 *     summary: "Depo: Produktkarte löschen (samt Seriennummern)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/products/:id', VIEW, GATE, cache, (req, res, next) => controller.get(req, res, next));
router.patch('/products/:id', MANAGE, GATE, (req, res, next) => controller.update(req, res, next));
router.delete('/products/:id', MANAGE, GATE, (req, res, next) => controller.remove(req, res, next));

/**
 * @swagger
 * /warehouse/products/{id}/receive:
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: Bestand einer Karte ohne Seriennummern ändern (Ürün ekle; negativ = Scan zurücknehmen)"
 *     security:
 *       - bearerAuth: []
 * /warehouse/products/{id}/serials:
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: Seriennummer anlegen, optional mit Produktionsprojekt und Gerät"
 *     security:
 *       - bearerAuth: []
 */
router.post('/products/:id/receive', MANAGE, GATE, (req, res, next) => controller.receive(req, res, next));
router.post('/products/:id/serials', MANAGE, GATE, (req, res, next) => controller.addSerial(req, res, next));

/**
 * @swagger
 * /warehouse/serials/{id}:
 *   patch:
 *     tags: [Warehouse]
 *     summary: "Depo: Seriennummer, Projekt oder Gerät ändern"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Warehouse]
 *     summary: "Depo: Seriennummer löschen"
 *     security:
 *       - bearerAuth: []
 */
router.patch('/serials/:id', MANAGE, GATE, (req, res, next) => controller.updateSerial(req, res, next));
router.delete('/serials/:id', MANAGE, GATE, (req, res, next) => controller.removeSerial(req, res, next));

/**
 * @swagger
 * /warehouse/lookup:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: Scan — Seriennummer, Barcode, Herstellerbarcode oder ERP-Code"
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - { in: query, name: code, required: true, schema: { type: string } }
 */
router.get('/lookup', VIEW, GATE, (req, res, next) => controller.lookup(req, res, next));

/**
 * @swagger
 * /warehouse/material-groups:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: Hauptkategorien mit ihren Materialgruppen, Kürzeln, nächstem ERP-Code und Zahl der Karten"
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: Materialgruppe anlegen (Hauptkategorie, Name, Kürzel)"
 *     security:
 *       - bearerAuth: []
 * /warehouse/material-groups/{id}:
 *   patch:
 *     tags: [Warehouse]
 *     summary: "Depo: Materialgruppe ändern (Kürzel und Kategorie nur ohne Karten mit Code)"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Warehouse]
 *     summary: "Depo: Materialgruppe löschen (nur ohne Karten)"
 *     security:
 *       - bearerAuth: []
 * /warehouse/material-groups/{id}/assign-codes:
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: Karten der Gruppe ohne ERP-Code bekommen ihn, in der Reihenfolge des Anlegens"
 *     security:
 *       - bearerAuth: []
 */
router.get('/material-groups', VIEW, GATE, cache, (req, res, next) => controller.groups(req, res, next));
router.post('/material-groups', MANAGE, GATE, (req, res, next) => controller.createGroup(req, res, next));
router.patch('/material-groups/:id', MANAGE, GATE, (req, res, next) => controller.updateGroup(req, res, next));
router.delete('/material-groups/:id', MANAGE, GATE, (req, res, next) => controller.removeGroup(req, res, next));
router.post('/material-groups/:id/assign-codes', MANAGE, GATE, (req, res, next) => controller.assignCodes(req, res, next));

/**
 * @swagger
 * /warehouse/categories:
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: Hauptkategorie anlegen (Name + Kürzel, z. B. Elektrik = ELK)"
 *     security:
 *       - bearerAuth: []
 * /warehouse/categories/{id}:
 *   patch:
 *     tags: [Warehouse]
 *     summary: "Depo: Hauptkategorie ändern (Kürzel nur ohne Karten mit Code)"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Warehouse]
 *     summary: "Depo: Hauptkategorie löschen (nur ohne Materialgruppen)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/categories', MANAGE, GATE, (req, res, next) => controller.createCategory(req, res, next));
router.patch('/categories/:id', MANAGE, GATE, (req, res, next) => controller.updateCategory(req, res, next));
router.delete('/categories/:id', MANAGE, GATE, (req, res, next) => controller.removeCategory(req, res, next));

/**
 * @swagger
 * /warehouse/settings:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: Etikett der Firma (Grösse, Druckart, Produktname)"
 *     security:
 *       - bearerAuth: []
 *   put:
 *     tags: [Warehouse]
 *     summary: "Depo: Etikett speichern"
 *     security:
 *       - bearerAuth: []
 */
router.get('/settings', VIEW, GATE, cache, (req, res, next) => controller.settings(req, res, next));
router.put('/settings', MANAGE, GATE, (req, res, next) => controller.saveSettings(req, res, next));

/**
 * @swagger
 * /warehouse/imports:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: Excel-Aktarımlar, neueste zuerst (mit Zahl der wartenden)"
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: Zeilen aus Excel zur Freigabe einreichen (die Verwaltung bekommt die Glocke)"
 *     security:
 *       - bearerAuth: []
 * /warehouse/imports/preview:
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: Zeilen aus Excel prüfen, ohne zu speichern"
 *     security:
 *       - bearerAuth: []
 * /warehouse/imports/{id}:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: ein Aktarım mit seinen Zeilen (geprüft gegen den Stand von jetzt)"
 *     security:
 *       - bearerAuth: []
 * /warehouse/imports/{id}/approve:
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: Aktarım freigeben — die Karten entstehen mit ERP-Code und Barcode (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 * /warehouse/imports/{id}/reject:
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: Aktarım ablehnen (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 * /warehouse/imports/{id}/cancel:
 *   post:
 *     tags: [Warehouse]
 *     summary: "Depo: eigenen Aktarım zurückziehen, solange er wartet"
 *     security:
 *       - bearerAuth: []
 */
router.get('/imports', VIEW, GATE, (req, res, next) => controller.imports(req, res, next));
router.post('/imports/preview', MANAGE, GATE, (req, res, next) => controller.previewImport(req, res, next));
router.post('/imports', MANAGE, GATE, (req, res, next) => controller.requestImport(req, res, next));
router.get('/imports/:id', VIEW, GATE, (req, res, next) => controller.getImport(req, res, next));
router.post('/imports/:id/approve', GATE, requireSystemAdmin, (req, res, next) => controller.approveImport(req, res, next));
router.post('/imports/:id/reject', GATE, requireSystemAdmin, (req, res, next) => controller.rejectImport(req, res, next));
router.post('/imports/:id/cancel', MANAGE, GATE, (req, res, next) => controller.cancelImport(req, res, next));

/**
 * @swagger
 * /warehouse/suppliers:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: Lieferanten der Firma für die Karte (nur lesen)"
 *     security:
 *       - bearerAuth: []
 * /warehouse/production-projects:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: Produktionsprojekte für die Seriennummern (nur lesen)"
 *     security:
 *       - bearerAuth: []
 * /warehouse/production-projects/{id}/devices:
 *   get:
 *     tags: [Warehouse]
 *     summary: "Depo: Geräte eines Produktionsprojekts (nur lesen)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/suppliers', VIEW, GATE, supplierCache, (req, res, next) => controller.suppliers(req, res, next));
router.get('/production-projects', VIEW, GATE, productionCache, (req, res, next) => controller.projects(req, res, next));
router.get('/production-projects/:id/devices', VIEW, GATE, productionCache, (req, res, next) => controller.devices(req, res, next));

export default router;
