import { Router } from 'express';
import multer from 'multer';

import { requirePermission } from '../middlewares/RbacMiddleware';
import { rateLimit } from '../middlewares/RateLimitMiddleware';
import { ProductionController } from '../controllers/ProductionController';
import { ProductionBomController } from '../controllers/ProductionBomController';

/**
 * ── /production/bom — DIE BOM DER PRODUKTION (27.09.2026, Vorgabe Samet) ─────
 *
 *   GET    /bom/settings                          Höchstzahl BOM je Gerät und Bereich
 *   PUT    /bom/settings                          … ändern                              [Administratorrolle]
 *   POST   /bom/categories                        eigene BOM-Kategorie { name, code }   [Administratorrolle]
 *   PUT    /bom/categories/:categoryId            … umbenennen / Kod ändern (ohne BOMs) [Administratorrolle]
 *   DELETE /bom/categories/:categoryId            … löschen (ohne BOMs und Vorlagen)    [Administratorrolle]
 *   GET    /bom/templates                         Vorlagen (Kategorie, Ana kart, Vorsatz)
 *   POST   /bom/templates                         neue Vorlage                         [Admin / production.manage]
 *   POST   /bom/templates/examples                Beispiel «CHILLER» anlegen           [Admin / production.manage]
 *   GET    /bom/templates/:id                     Vorlage mit Zeilen (Depo-Karten)
 *   PUT    /bom/templates/:id                     Vorlage ersetzen                     [Admin / production.manage]
 *   DELETE /bom/templates/:id                     Vorlage löschen (BOMs behalten ihre Kopie)
 *   GET    /bom/products?q=                       Depo-Karten suchen (ERP-Code, Modell-Nr., Name)
 *   GET    /bom/devices/:itemId?area=             die BOMs eines Geräts im Bereich
 *   POST   /bom/devices/:itemId                   BOM aus Vorlage { area, templateId }
 *   GET    /bom/boms/:bomId                       eine BOM
 *   PUT    /bom/boms/:bomId/lines                 Zeilen (nur Entwurf)
 *   DELETE /bom/boms/:bomId                       BOM löschen (nur ein nie freigegebener Entwurf)
 *   POST   /bom/boms/:bomId/{approve|complete|reopen|consume}  («unapprove» gibt es nicht mehr)
 *   POST   /bom/boms/:bomId/revision              «Revize et» { reason } — Arbeitskopie der geltenden Zeilen
 *   DELETE /bom/boms/:bomId/revision              die Revision im Entwurf verwerfen
 *   GET    /bom/boms/:bomId/revision/preview      Unterschied + was mit jeder Bestellung geschieht (?keep=id,id)
 *   POST   /bom/boms/:bomId/revision/approve      … freigeben { keep: [purchaseOrderId] } — alles in einem Vorgang
 *   GET    /bom/boms/:bomId/revisions/:number     eine Revision (Zeilen, Unterschied, Bestellungen)
 *   GET    /bom/purchases/:id/revisions/:number   die Bestellung VOR ihrer Revision (altes PDF)
 *   GET    /bom/purchases/:id/revisions/:number/quote-file  … und die Bestätigung des Lieferanten dazu
 *   GET    /bom/boms/:bomId/order-proposal        «Sipariş oluştur»: was fehlt
 *   POST   /bom/boms/:bomId/orders                … Bestellungen je Lieferant anlegen
 *   GET    /bom/boms/:bomId/request-proposal      «Fiyat talebi» (nur Entwurf): Zeilen, Lieferanten
 *   POST   /bom/boms/:bomId/price-requests        … Preisanfragen je Lieferant anlegen (Name, Modell, Menge)
 *   POST   /bom/boms/:bomId/procurement-requests  Talep an den Einkauf { kind: PRICE|ORDER, lines, note } (ohne Lieferant/Preis)
 *   POST   /bom/procurement/requests/:id/withdraw  … unberührten Talep zurückziehen (BOM)
 *   GET    /bom/procurement/feed                   «Satın alma»: Talepler seitenweise (20), Stand, nächster Schritt, letzter Handgriff  [Buchhaltung/Admin]
 *   GET    /bom/procurement/requests/:id           … einer mit BOM (voll), Stand, Belegen und Verlauf
 *   POST   /bom/procurement/requests/:id/report    … bestätigte Bestellung / verschickte Anfragen im Verlauf festhalten
 *   POST   /bom/procurement/requests/:id/selection … Auswahl des Preisvergleichs an die Depo-Karten
 *   GET    /bom/procurement/requests/:id/comparisons  die gespeicherten Fiyat karşılaştırmaları eines Preistalep
 *   POST   /bom/procurement/requests/:id/comparisons  … neu: bis zu vier Angebots-PDFs per KI vergleichen { purchaseOrderIds, language }
 *   GET    /bom/procurement/comparisons/:id        … einer (eigene Seite)
 *   POST   /bom/procurement/requests/:id/{close|reopen|cancel}
 *   GET    /bom/costing                            «Kalkülasyon»: Projekte mit geplanten/tatsächlichen Materialkosten
 *   GET    /bom/costing/:projectId                 … ein Projekt: je Gerät die Kalemler (Menge, Alışpreis, Summe)
 *   PUT    /bom/purchases/:id/quote-number        Angebotsnummer des Lieferanten
 *   PUT    /bom/purchases/:id/prices              Stückpreise aus Angebot / Antwort des Lieferanten
 *   POST   /bom/purchases/:id/quote-file          Angebot des Lieferanten (PDF/Bild, multipart `file`)
 *   GET    /bom/purchases/:id/quote-file          … lesen
 *   DELETE /bom/purchases/:id/quote-file          … entfernen (nur unbestätigt)
 *   POST   /bom/purchases/:id/receive             Wareneingang ins Depo (+ Reservierung)
 *   POST   /bom/purchases/:id/ai-fill             leere Zellen der Vorlagenspalten per KI füllen
 *
 * Wer schreiben darf, entscheidet der Anwendungsfall (Administratorrolle,
 * `production.manage`, die Personen der Stufe BOM am Gerät; bei Bestellungen
 * zusätzlich `inventory.transfer`). `requireAuth` erbt der Weg vom
 * Produktionsrouter.
 */
const router = Router();
const controller = new ProductionBomController();

const VIEW = requirePermission('production.view');
// Die Bestellwege erreicht der Einkauf — seit 27.09.2026 abends auch die Buchhaltung
// ohne Produktionsrechte (Seite «Satın alma»); was er darf, prüft der Anwendungsfall.
const PURCHASE_VIEW = ProductionBomController.requireBomOrProcurement;
const MODULE = ProductionController.requireModule;
const AVAILABLE = ProductionBomController.requireAvailable;

const quoteUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });

/* Die KI kostet Geld: je Benutzer und Stunde gezählt, wie der Beleg-Import. */
const aiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.gptHourlyLimit || 60),
    message: 'Zu viele KI-Anfragen in kurzer Zeit. Bitte später erneut versuchen.',
    keyBy: (req: any) => (req.user?.id ? `gpt-bom:${req.user.id}` : null),
});

/**
 * @swagger
 * /production/bom/settings:
 *   get:
 *     tags: [Production]
 *     summary: "BOM: Höchstzahl je Gerät und Bereich"
 *     security:
 *       - bearerAuth: []
 *   put:
 *     tags: [Production]
 *     summary: "BOM: Höchstzahl ändern (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/settings', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.getSettings(req, res, next));
router.put('/bom/settings', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.saveSettings(req, res, next));
router.post('/bom/categories', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.createCategory(req, res, next));
router.put('/bom/categories/:categoryId', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.updateCategory(req, res, next));
router.delete('/bom/categories/:categoryId', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.deleteCategory(req, res, next));

/**
 * @swagger
 * /production/bom/templates:
 *   get:
 *     tags: [Production]
 *     summary: "BOM: Vorlagen der Firma"
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Production]
 *     summary: "BOM: neue Vorlage"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/templates', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.listTemplates(req, res, next));
router.post('/bom/templates', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.createTemplate(req, res, next));

/**
 * @swagger
 * /production/bom/templates/examples:
 *   post:
 *     tags: [Production]
 *     summary: "BOM: Beispiel CHILLER (Vorlagen, Gruppen und Depo-Karten) anlegen"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/templates/examples', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.seedExamples(req, res, next));

/**
 * @swagger
 * /production/bom/templates/{id}:
 *   get:
 *     tags: [Production]
 *     summary: "BOM: eine Vorlage mit ihren Zeilen"
 *     security:
 *       - bearerAuth: []
 *   put:
 *     tags: [Production]
 *     summary: "BOM: Vorlage ersetzen"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Production]
 *     summary: "BOM: Vorlage löschen"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/templates/:id', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.getTemplate(req, res, next));
router.put('/bom/templates/:id', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.updateTemplate(req, res, next));
router.delete('/bom/templates/:id', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.deleteTemplate(req, res, next));

/**
 * @swagger
 * /production/bom/products:
 *   get:
 *     tags: [Production]
 *     summary: "BOM: Depo-Karten suchen (ERP-Code, Modellnummer, Name, Marke, Barcode)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/products', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.searchProducts(req, res, next));

/**
 * @swagger
 * /production/bom/devices/{itemId}:
 *   get:
 *     tags: [Production]
 *     summary: "BOM: die BOMs eines Geräts im Bereich (area=mechanical|electrical)"
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Production]
 *     summary: "BOM: aus einer Vorlage anlegen"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/devices/:itemId', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.deviceView(req, res, next));
router.post('/bom/devices/:itemId', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.addBom(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}:
 *   get:
 *     tags: [Production]
 *     summary: "BOM: eine BOM mit Reservierung und Bestellungen"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Production]
 *     summary: "BOM: löschen (nur ein nie freigegebener Entwurf ohne Bestellungen)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/boms/:bomId', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.getBom(req, res, next));
router.delete('/bom/boms/:bomId', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.deleteBom(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/lines:
 *   put:
 *     tags: [Production]
 *     summary: "BOM: Zeilen ersetzen (nur Entwurf)"
 *     security:
 *       - bearerAuth: []
 */
router.put('/bom/boms/:bomId/lines', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.saveLines(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/order-proposal:
 *   get:
 *     tags: [Production]
 *     summary: "BOM: was fehlt und bestellt werden muss (Mindestbestellmenge, Lieferanten)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/boms/:bomId/order-proposal', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.proposal(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/orders:
 *   post:
 *     tags: [Production]
 *     summary: "BOM: Bestellungen je Lieferant anlegen"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/boms/:bomId/orders', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.createOrders(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/request-proposal:
 *   get:
 *     tags: [Production]
 *     summary: "BOM (nur Entwurf): Zeilen, Lieferanten und bestehende Preisanfragen für «Fiyat talebi»"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/boms/:bomId/request-proposal', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.requestProposal(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/price-requests:
 *   post:
 *     tags: [Production]
 *     summary: "BOM (nur Entwurf): Preisanfragen anlegen, je Lieferant eine (Name, Modell, Menge)"
 *     security:
 *       - bearerAuth: []
 */
// Vor `/:action` — sonst hielte der Handlungsweg «price-requests» für eine Handlung.
router.post('/bom/boms/:bomId/price-requests', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.createRequests(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/procurement-requests:
 *   post:
 *     tags: [Production]
 *     summary: "BOM: Talep an den Einkauf (Preis anfragen oder bestellen) ohne Lieferant und Preis"
 *     security:
 *       - bearerAuth: []
 */
// Ebenfalls vor `/:action`.
router.post('/bom/boms/:bomId/procurement-requests', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.createProcurementRequest(req, res, next));

/**
 * @swagger
 * /production/bom/costing:
 *   get:
 *     tags: [Production]
 *     summary: "Kalkülasyon: Projekte mit geplanten und tatsächlichen Materialkosten"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/costing', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.costingProjects(req, res, next));

/**
 * @swagger
 * /production/bom/costing/{projectId}:
 *   get:
 *     tags: [Production]
 *     summary: "Kalkülasyon: ein Projekt, je Gerät Menge, Alışpreis und Summe"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/costing/:projectId', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.costingProject(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/requests/{requestId}:
 *   get:
 *     tags: [Production]
 *     summary: "Satın alma: ein Talep mit seiner BOM"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/procurement/requests/:requestId', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.getProcurement(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/requests/{requestId}/withdraw:
 *   post:
 *     tags: [Production]
 *     summary: "BOM: einen unberührten Talep zurückziehen"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/procurement/requests/:requestId/withdraw', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.withdrawProcurementRequest(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/feed:
 *   get:
 *     tags: [Production]
 *     summary: "Satın alma: Talepler seitenweise (20), mit Stand, nächstem Schritt und letztem Handgriff (?page=&search=)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/procurement/feed', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.procurementFeed(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/requests/{requestId}/report:
 *   post:
 *     tags: [Production]
 *     summary: "Satın alma: bestätigte Bestellungen oder verschickte Preisanfragen im Verlauf festhalten"
 *     security:
 *       - bearerAuth: []
 */
// Vor `/:action`.
router.post('/bom/procurement/requests/:requestId/report', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.reportProcurement(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/requests/{requestId}/selection:
 *   post:
 *     tags: [Production]
 *     summary: "Satın alma: Auswahl eines Preisvergleichs an die Depo-Karten geben (Lieferant, Alışpreis)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/procurement/requests/:requestId/selection', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.saveProcurementSelection(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/requests/{requestId}/comparisons:
 *   get:
 *     tags: [Production]
 *     summary: "Satın alma: die gespeicherten Preisvergleiche eines Preistalep"
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Production]
 *     summary: "Satın alma: bis zu vier Angebots-PDFs per KI vergleichen und speichern"
 *     security:
 *       - bearerAuth: []
 */
// Vor `/:action`.
router.get('/bom/procurement/requests/:requestId/comparisons', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.listComparisons(req, res, next));
router.post('/bom/procurement/requests/:requestId/comparisons', PURCHASE_VIEW, MODULE, AVAILABLE, aiLimiter, (req, res, next) => controller.createComparison(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/comparisons/{comparisonId}:
 *   get:
 *     tags: [Production]
 *     summary: "Satın alma: ein gespeicherter Preisvergleich"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/procurement/comparisons/:comparisonId', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.getComparison(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/requests/{requestId}/{action}:
 *   post:
 *     tags: [Production]
 *     summary: "Satın alma: Talep schliessen, wieder öffnen oder verwerfen (close, reopen, cancel)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/procurement/requests/:requestId/:action', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.procurementAction(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/revision:
 *   post:
 *     tags: [Production]
 *     summary: "BOM: Revision beginnen (Grund Pflicht) — die BOM gilt unverändert weiter, bis sie freigegeben ist"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Production]
 *     summary: "BOM: die Revision im Entwurf verwerfen"
 *     security:
 *       - bearerAuth: []
 */
// Auch vor `/:action` — «revision» ist keine Handlung.
router.post('/bom/boms/:bomId/revision', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.startRevision(req, res, next));
router.delete('/bom/boms/:bomId/revision', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.discardRevision(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/revision/preview:
 *   get:
 *     tags: [Production]
 *     summary: "BOM-Revision: Unterschied und was mit jeder Bestellung geschieht (keep = Bestellungen, die bleiben)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/boms/:bomId/revision/preview', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.revisionPreview(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/revision/approve:
 *   post:
 *     tags: [Production]
 *     summary: "BOM-Revision freigeben: Zeilen, Revision und Bestellungen in einem Vorgang"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/boms/:bomId/revision/approve', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.approveRevision(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/revision/submit:
 *   post:
 *     tags: [Production]
 *     summary: "BOM-Revision zur Freigabe einreichen (die Administratorrolle wird benachrichtigt)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/boms/:bomId/revision/submit', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.submitRevision(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/revision/reject:
 *   post:
 *     tags: [Production]
 *     summary: "Eingereichte BOM-Revision zurückweisen (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/boms/:bomId/revision/reject', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.rejectRevision(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/revisions/{number}:
 *   get:
 *     tags: [Production]
 *     summary: "BOM: eine Revision mit Zeilen, Unterschied und Bestellungen"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/boms/:bomId/revisions/:number', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.revisionDetail(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/{action}:
 *   post:
 *     tags: [Production]
 *     summary: "BOM: freigeben, abschliessen, wieder öffnen oder vom Bestand abbuchen (die Freigabe ist endgültig)"
 *     security:
 *       - bearerAuth: []
 */
// Express 5 kennt keine Muster in Parametern — die Handlung prüft der Controller.
router.post('/bom/boms/:bomId/:action', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.transition(req, res, next));

/**
 * @swagger
 * /production/bom/purchases/{purchaseOrderId}/quote-number:
 *   put:
 *     tags: [Production]
 *     summary: "BOM-Bestellung: Angebotsnummer des Lieferanten"
 *     security:
 *       - bearerAuth: []
 */
router.put('/bom/purchases/:purchaseOrderId/quote-number', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.setQuoteNumber(req, res, next));

/**
 * @swagger
 * /production/bom/purchases/{purchaseOrderId}/prices:
 *   put:
 *     tags: [Production]
 *     summary: "Satın alma: Stückpreise aus dem Angebot bzw. der Antwort des Lieferanten ({ prices: [{ index, unitPrice }] })"
 *     security:
 *       - bearerAuth: []
 */
router.put('/bom/purchases/:purchaseOrderId/prices', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.setPurchasePrices(req, res, next));

/**
 * @swagger
 * /production/bom/purchases/{purchaseOrderId}/quote-file:
 *   post:
 *     tags: [Production]
 *     summary: "BOM-Bestellung: Angebot des Lieferanten hochladen (multipart file)"
 *     security:
 *       - bearerAuth: []
 *   get:
 *     tags: [Production]
 *     summary: "BOM-Bestellung: Angebot des Lieferanten lesen"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Production]
 *     summary: "BOM-Bestellung: Angebot entfernen (nur unbestätigt)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/purchases/:purchaseOrderId/quote-file', PURCHASE_VIEW, MODULE, AVAILABLE, quoteUpload.single('file'), (req, res, next) => controller.uploadQuote(req, res, next));
router.get('/bom/purchases/:purchaseOrderId/quote-file', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.readQuote(req, res, next));
router.delete('/bom/purchases/:purchaseOrderId/quote-file', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.removeQuote(req, res, next));

/**
 * @swagger
 * /production/bom/purchases/{purchaseOrderId}/receive:
 *   post:
 *     tags: [Production]
 *     summary: "BOM-Bestellung: Wareneingang ins Depo"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/purchases/:purchaseOrderId/receive', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.receive(req, res, next));

/**
 * @swagger
 * /production/bom/purchases/{purchaseOrderId}/revisions/{number}:
 *   get:
 *     tags: [Production]
 *     summary: "BOM-Bestellung: die Fassung vor ihrer Revision (altes PDF)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/purchases/:purchaseOrderId/revisions/:number', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.purchaseRevision(req, res, next));

/**
 * @swagger
 * /production/bom/purchases/{purchaseOrderId}/revisions/{number}/quote-file:
 *   get:
 *     tags: [Production]
 *     summary: "BOM-Bestellung: die Bestätigung des Lieferanten zur Fassung vor der Revision"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/purchases/:purchaseOrderId/revisions/:number/quote-file', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.purchaseRevisionQuote(req, res, next));

/**
 * @swagger
 * /production/bom/purchases/{purchaseOrderId}/ai-fill:
 *   post:
 *     tags: [Production]
 *     summary: "BOM-Bestellung: leere Zellen der Vorlagenspalten per KI füllen (eingefügte Zeilen, Bilder, Excel, PDF)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/purchases/:purchaseOrderId/ai-fill', PURCHASE_VIEW, MODULE, AVAILABLE, aiLimiter, (req, res, next) => controller.fillTable(req, res, next));

export default router;
