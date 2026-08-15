import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission } from '../middlewares/RbacMiddleware';
import { FormController } from '../controllers/FormController';

/* Checklisten / Formulare / Vorlagen (Modul im CRM).
   Rechte: BEWUSST keine neuen Berechtigungsschlüssel — ein neuer Schlüssel
   stünde auf keiner bestehenden Rolle und wäre für alle 403 (siehe
   crm.routes.ts / dashboard.routes.ts). Lesen ist für jede angemeldete Person
   des Mandanten offen (Techniker brauchen die Formulare am Termin), Schreiben
   verlangt eine der Rollen, die im CRM, im Verkauf, im Projekt oder im Feld
   arbeiten. Vorlagen pflegt das Büro (CRM/Projekt/Admin-Rechte). */

const router = Router();
const controller = new FormController();

const canWriteSubmissions = requireAnyPermission([
    'crm.customers.view', 'crm.customers.create', 'crm.activities.create',
    'tenders.view', 'tenders.create', 'tenders.update',
    'projects.view', 'projects.report', 'projects.manage',
    'maintenance.tasks.manage',
    'tenants.update', 'roles.manage',
]);

const canWriteTemplates = requireAnyPermission([
    'crm.customers.create', 'crm.activities.create',
    'tenders.create', 'tenders.update', 'tenders.manage',
    'projects.manage', 'projects.create',
    'tenants.update', 'roles.manage',
]);

// Vorlagen
router.get('/templates', requireAuth, (req, res) => controller.listTemplates(req, res));
router.get('/templates/:id', requireAuth, (req, res) => controller.getTemplate(req, res));
router.post('/templates', requireAuth, canWriteTemplates, (req, res) => controller.createTemplate(req, res));
router.post('/templates/:id/duplicate', requireAuth, canWriteTemplates, (req, res) => controller.duplicateTemplate(req, res));
router.put('/templates/:id', requireAuth, canWriteTemplates, (req, res) => controller.updateTemplate(req, res));
router.delete('/templates/:id', requireAuth, canWriteTemplates, (req, res) => controller.deleteTemplate(req, res));

// Kontext (Kundenakte / Angebot / Auftrag / Projekt / Termin → Kette + Abgaben + Hinweise)
router.get('/context/:kind/:id', requireAuth, (req, res) => controller.getContext(req, res));

// Ausgefüllte Formulare
router.get('/submissions', requireAuth, (req, res) => controller.listSubmissions(req, res));
router.get('/submissions/:id', requireAuth, (req, res) => controller.getSubmission(req, res));
router.get('/submissions/:id/visibility', requireAuth, (req, res) => controller.getSubmissionVisibility(req, res));
router.post('/submissions', requireAuth, canWriteSubmissions, (req, res) => controller.createSubmission(req, res));
router.put('/submissions/:id', requireAuth, canWriteSubmissions, (req, res) => controller.updateSubmission(req, res));
router.delete('/submissions/:id', requireAuth, canWriteSubmissions, (req, res) => controller.deleteSubmission(req, res));

// Einsatz-Hinweise
router.get('/notes', requireAuth, (req, res) => controller.listNotes(req, res));
router.post('/notes', requireAuth, canWriteSubmissions, (req, res) => controller.createNote(req, res));
router.put('/notes/:id', requireAuth, canWriteSubmissions, (req, res) => controller.updateNote(req, res));
router.delete('/notes/:id', requireAuth, canWriteSubmissions, (req, res) => controller.deleteNote(req, res));

export default router;
