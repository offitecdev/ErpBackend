"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const MailController_1 = require("../controllers/MailController");
const caldavCalendarService_1 = require("../../infrastructure/services/caldavCalendarService");
const router = (0, express_1.Router)();
const controller = new MailController_1.MailController();
router.get('/settings', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('mail.manage'), (req, res) => controller.getSettings(req, res));
router.put('/settings', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('mail.manage'), (req, res) => controller.saveSettings(req, res));
router.post('/send', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('mail.send'), (req, res) => controller.send(req, res));
/* KALENDER DES KONTOS (CalDAV, 31.08.2026).
   `test` sucht die Kalender des eingerichteten Kontos und meldet, was es
   gefunden hat — die Einrichtung soll man prüfen können, ohne auf den nächsten
   Zeitplan-Durchgang zu warten. `sync` holt sie sofort ab. Beides hängt an
   `mail.manage`: es sind Einstellungen des Postfachs, keine Kalenderfunktion. */
router.post('/caldav/test', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('mail.manage'), async (req, res) => {
    try {
        res.json(await (0, caldavCalendarService_1.testCalendarAccess)(req.user.tenantId));
    }
    catch (error) {
        res.status(400).json({ ok: false, calendars: [], error: error?.message || 'Prüfung fehlgeschlagen.' });
    }
});
router.post('/caldav/sync', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('mail.manage'), async (req, res) => {
    try {
        res.json(await (0, caldavCalendarService_1.captureCalendar)(req.user.tenantId));
    }
    catch (error) {
        res.status(400).json({ error: error?.message || 'Kalenderabruf fehlgeschlagen.' });
    }
});
exports.default = router;
//# sourceMappingURL=mail.routes.js.map