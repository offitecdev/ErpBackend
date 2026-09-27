import { Router } from 'express';
import multer from 'multer';

import { requireAnyPermission, requirePermission } from '../middlewares/RbacMiddleware';
import { rateLimit } from '../middlewares/RateLimitMiddleware';
import { ProductionController } from '../controllers/ProductionController';
import { ProductionBomController } from '../controllers/ProductionBomController';

/**
 * ── /production/bom — DIE BOM DER PRODUKTION (27.09.2026, Vorgabe Samet) ─────
 *
 *   GET    /bom/settings                          Höchstzahl BOM je Gerät und Bereich
 *   PUT    /bom/settings                          … ändern                              [Administratorrolle]
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
 *   PUT    /bom/purchases/:id/quote-number        Angebotsnummer des Lieferanten
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
// Die Bestellwege erreicht auch der Einkauf aus der Auftragsseite heraus.
const PURCHASE_VIEW = requireAnyPermission(['production.view', 'inventory.view']);
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
router.get('/bom/boms/:bomId/order-proposal', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.proposal(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/orders:
 *   post:
 *     tags: [Production]
 *     summary: "BOM: Bestellungen je Lieferant anlegen"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/boms/:bomId/orders', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.createOrders(req, res, next));

/**
 * @swagger
 * /production/bom/boms/{bomId}/request-proposal:
 *   get:
 *     tags: [Production]
 *     summary: "BOM (nur Entwurf): Zeilen, Lieferanten und bestehende Preisanfragen für «Fiyat talebi»"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/boms/:bomId/request-proposal', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.requestProposal(req, res, next));

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
router.post('/bom/boms/:bomId/price-requests', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.createRequests(req, res, next));

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
 * /production/bom/boms/{bomId}/revisions/{number}:
 *   get:
 *     tags: [Production]
 *     summary: "BOM: eine Revision mit Zeilen, Unterschied und Bestellungen"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/boms/:bomId/revisions/:number', VIEW, MODULE, AVAILABLE, (req, res, next) => controller.revisionDetail(req, res, next));

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
