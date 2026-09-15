import { Router, type RequestHandler } from 'express';

import { requireAuth } from '../../middlewares/AuthMiddleware';
import { assertSystemAdmin } from '../../../application/services/tasks/taskActor';
import { sendTaskError } from './taskHttp';
import { requireTasksAccess, tasksActor } from './taskMiddleware';
import attachmentsRouter from './attachments.routes';
import chatRouter from './chat.routes';
import commentsRouter from './comments.routes';
import contentRouter from './content.routes';
import dailyReportsRouter from './dailyReports.routes';
import labelsRouter from './labels.routes';
import liveRouter from './live.routes';
import peopleRouter from './people.routes';
import reportsRouter from './reports.routes';
import settingsRouter from './settings.routes';
import tasksRouter from './tasks.routes';

/**
 * ── GÖREVLER / TASKS-MODUL: API (13.09.2026, Vorgabe Samet) ─────────────────
 *
 * «ayrı bir görev modülü istiyorum»: ein eigenständiges Aufgabenmodul nach dem
 * Vorbild Görevly, gemountet unter /api/v1/tasks — ohne Verbindung zu
 * Projekten, CRM-Aufgaben (/crm/tasks) oder Wartungsaufgaben.
 *
 * Vor JEDEM Weg: Anmeldung, Modul für die ausgewählte Firma freigeschaltet,
 * Recht tasks.view / tasks.manage / tasks.delete (oder Administratorrolle).
 * Leitung = tasks.manage, Teammitglied = nur tasks.view.
 *
 * Reihenfolge der Router ist Absicht: Wege mit festem ersten Abschnitt
 * (/labels, /people, /reports, /settings, /chat) vor den Routern, die
 * `/:taskId…` kennen; innerhalb eines Routers stehen feste Wege vor Parametern.
 *
 *   /labels                       Etiketten der Firma
 *   /live                         «Canlı»: wer heute woran arbeitet (ersetzt die Kanban-Pano)
 *   /people                       Personalverzeichnis des Moduls, «Kişiler»
 *   /reports                      Team-, Personen-, eigener und Aufgabenbericht (PDF-Daten)
 *   /settings/me                  persönliche Einstellungen
 *   /daily-reports/me             Gün sonu raporu (jede Person, eigener Rapport)
 *   /chat                         Räume, Mitglieder, Nachrichten, Lesestand
 *   /attachments/:id[/content]    Dateien ausliefern / löschen; /:taskId/attachments
 *   /comments/:id; /:taskId/comments
 *   /checklists…, /checklist-items…; /:taskId/content, /:taskId/checklists
 *   /bootstrap, /summary, /approvals, /timer/…, / und /:taskId…  (Aufgaben)
 */
const router = Router();

/* Ein <img>/<a href> kann keinen X-Tenant-Id-Kopf senden — Dateien einer
   ausgewählten Zweitfirma kämen sonst als 404 zurück. Für LESENDE Wege darf
   die Firma darum als `?tenantId=` mitreisen; requireAuth prüft sie genauso
   streng wie den Kopf (resolveTenantId). */
const tenantFromQuery: RequestHandler = (req, _res, next) => {
    const fromQuery = req.query.tenantId;
    if (req.method === 'GET' && !req.header('x-tenant-id') && typeof fromQuery === 'string' && fromQuery) {
        req.headers['x-tenant-id'] = fromQuery.slice(0, 64);
    }
    next();
};

router.use(tenantFromQuery, requireAuth, requireTasksAccess);

/* Canlı und Raporlar: nur die Administratorrolle (alle anderen haben nur Görevler + Sohbet). */
const adminGate: RequestHandler = (_req, res, next) => {
    try {
        assertSystemAdmin(tasksActor(res));
        next();
    } catch (error) {
        sendTaskError(res, error, 'tasks.adminOnly');
    }
};

router.use('/labels', labelsRouter);
router.use('/live', adminGate, liveRouter);
router.use('/people', peopleRouter);
router.use('/reports', adminGate, reportsRouter);
router.use('/settings', settingsRouter);
router.use('/daily-reports', dailyReportsRouter);
router.use('/chat', chatRouter);
router.use('/', attachmentsRouter);
router.use('/', commentsRouter);
router.use('/', contentRouter);
router.use('/', tasksRouter);

export default router;
