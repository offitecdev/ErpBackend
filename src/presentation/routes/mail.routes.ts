import { Router } from "express";
import { requireAuth } from "../middlewares/AuthMiddleware";
import { requirePermission } from "../middlewares/RbacMiddleware";
import { MailController } from "../controllers/MailController";
import { captureCalendar, testCalendarAccess } from "../../infrastructure/services/caldavCalendarService";

const router = Router();
const controller = new MailController();

router.get('/settings', requireAuth, requirePermission('mail.manage'), (req, res) => controller.getSettings(req, res));
router.put('/settings', requireAuth, requirePermission('mail.manage'), (req, res) => controller.saveSettings(req, res));
router.post('/send', requireAuth, requirePermission('mail.send'), (req, res) => controller.send(req, res));

/* KALENDER DES KONTOS (CalDAV, 31.08.2026).
   `test` sucht die Kalender des eingerichteten Kontos und meldet, was es
   gefunden hat — die Einrichtung soll man prüfen können, ohne auf den nächsten
   Zeitplan-Durchgang zu warten. `sync` holt sie sofort ab. Beides hängt an
   `mail.manage`: es sind Einstellungen des Postfachs, keine Kalenderfunktion. */
router.post('/caldav/test', requireAuth, requirePermission('mail.manage'), async (req, res) => {
    try {
        res.json(await testCalendarAccess(req.user!.tenantId));
    } catch (error: any) {
        res.status(400).json({ ok: false, calendars: [], error: error?.message || 'Prüfung fehlgeschlagen.' });
    }
});

router.post('/caldav/sync', requireAuth, requirePermission('mail.manage'), async (req, res) => {
    try {
        res.json(await captureCalendar(req.user!.tenantId));
    } catch (error: any) {
        res.status(400).json({ error: error?.message || 'Kalenderabruf fehlgeschlagen.' });
    }
});

export default router;
