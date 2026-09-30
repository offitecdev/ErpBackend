import { Router } from 'express';

import { rateLimit } from '../middlewares/RateLimitMiddleware';
import { ProcurementAutomationController } from '../controllers/ProcurementAutomationController';
import { ProductionBomController } from '../controllers/ProductionBomController';
import { ProductionController } from '../controllers/ProductionController';

/**
 * ── /production — DIE AUTOMATIK DES EINKAUFS (30.09.2026, Vorgabe Samet) ────
 *
 *   GET    /bom/mailboxes                              Postfächer der Produktion (RFQ, ORDER) — ohne Passwort
 *   PUT    /bom/mailboxes/:purpose                     … speichern (RFQ | ORDER)                 [Administratorrolle]
 *   DELETE /bom/mailboxes/:purpose                     … entfernen (ORDER → Bestellungen über RFQ) [Administratorrolle]
 *   POST   /bom/mailboxes/:purpose/test                SMTP + IMAP prüfen                        [Administratorrolle]
 *   POST   /bom/mailboxes/check                        Antworten der Lieferanten jetzt lesen
 *   POST   /bom/procurement/requests/:id/dispatch      Preisanfragen eines Talep anlegen (Karten) und senden
 *   POST   /bom/purchases/:id/dispatch                 EIN Beleg als PDF + Mail: «Onayla ve gönder», «Tekrar gönder»
 *   GET    /bom/purchases/dispatch-status?ids=         Sendungen und Antworten der Belege
 *   GET    /bom/procurement/files/:source/:id          verschicktes PDF (mail) / Datei einer Antwort (reply)
 *   POST   /bom/procurement/comparisons/:id/orders     aus der Auswahl des Vergleichs je Lieferant eine Bestellung
 *
 * Dieser Router hängt VOR dem der BOM (production.routes.ts): dort fängt
 * `/bom/procurement/requests/:id/:action` alles Übrige ab.
 */
const router = Router();
const controller = new ProcurementAutomationController();

const PURCHASE_VIEW = ProductionBomController.requireBomOrProcurement;
const MODULE = ProductionController.requireModule;
const AVAILABLE = ProductionBomController.requireAvailable;

/* Senden kostet nichts, aber jede Mail geht an einen Lieferanten — je Benutzer gebremst. */
const sendLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: Number(process.env.procurementSendLimit || 120),
    message: 'Zu viele Sendungen in kurzer Zeit. Bitte kurz warten.',
    keyBy: (req: any) => (req.user?.id ? `procurement-send:${req.user.id}` : null),
});

/**
 * @swagger
 * /production/bom/mailboxes:
 *   get:
 *     tags: [Production]
 *     summary: "Üretim: Postfächer der Automatik (RFQ, ORDER)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/mailboxes', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.listMailboxes(req, res, next));

/**
 * @swagger
 * /production/bom/mailboxes/check:
 *   post:
 *     tags: [Production]
 *     summary: "Üretim: Antworten der Lieferanten jetzt lesen"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/mailboxes/check', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.checkInbox(req, res, next));

/**
 * @swagger
 * /production/bom/mailboxes/{purpose}:
 *   put:
 *     tags: [Production]
 *     summary: "Üretim: Postfach speichern (RFQ oder ORDER)"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Production]
 *     summary: "Üretim: Postfach entfernen"
 *     security:
 *       - bearerAuth: []
 */
router.put('/bom/mailboxes/:purpose', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.saveMailbox(req, res, next));
router.delete('/bom/mailboxes/:purpose', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.removeMailbox(req, res, next));

/**
 * @swagger
 * /production/bom/mailboxes/{purpose}/test:
 *   post:
 *     tags: [Production]
 *     summary: "Üretim: Postfach prüfen (SMTP-Anmeldung, IMAP-Ordner)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/mailboxes/:purpose/test', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.testMailbox(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/requests/{requestId}/dispatch:
 *   post:
 *     tags: [Production]
 *     summary: "Satın alma: Preisanfragen eines Talep (Lieferanten der Karten) anlegen und senden"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/procurement/requests/:requestId/dispatch', PURCHASE_VIEW, MODULE, AVAILABLE, sendLimiter, (req, res, next) => controller.dispatchRequest(req, res, next));

/**
 * @swagger
 * /production/bom/purchases/dispatch-status:
 *   get:
 *     tags: [Production]
 *     summary: "Satın alma: Sendungen und Antworten der Belege (?ids=a,b)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/purchases/dispatch-status', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.dispatchStatus(req, res, next));

/**
 * @swagger
 * /production/bom/purchases/{purchaseOrderId}/dispatch:
 *   post:
 *     tags: [Production]
 *     summary: "Satın alma: EIN Beleg als PDF per Mail an den Lieferanten («Onayla ve gönder», «Tekrar gönder»)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/purchases/:purchaseOrderId/dispatch', PURCHASE_VIEW, MODULE, AVAILABLE, sendLimiter, (req, res, next) => controller.sendDocument(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/files/{source}/{id}:
 *   get:
 *     tags: [Production]
 *     summary: "Satın alma: verschicktes PDF (mail) oder Datei einer Antwort (reply)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/procurement/files/:source/:id', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.file(req, res, next));

/**
 * @swagger
 * /production/bom/purchases/{purchaseOrderId}/document-pdf:
 *   get:
 *     tags: [Production]
 *     summary: "PDF eines BOM-Belegs, wie es jetzt gesendet würde (nichts wird gesendet)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/bom/purchases/:purchaseOrderId/document-pdf', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.documentPdf(req, res, next));

/**
 * @swagger
 * /production/bom/procurement/comparisons/{comparisonId}/orders:
 *   post:
 *     tags: [Production]
 *     summary: "Satın alma: aus der Auswahl des Vergleichs je Lieferant eine Bestellung ({ lines: [{ bomLineId, supplier }] })"
 *     security:
 *       - bearerAuth: []
 */
router.post('/bom/procurement/comparisons/:comparisonId/orders', PURCHASE_VIEW, MODULE, AVAILABLE, (req, res, next) => controller.ordersFromComparison(req, res, next));

export default router;
