import { Router } from 'express';
import multer from 'multer';
// (Yukarıda oluşturduğumuz ProjectController ve UseCase/Repo sınıflarını import edin)
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission, requirePermission } from '../middlewares/RbacMiddleware';
import { ProjectController } from '../controllers/ProjectController';
import { CreateProjectFromTenderUseCase } from '../../application/use-cases/project/CreateProjectFromTenderUseCase';
import { AddProjectReportUseCase } from '../../application/use-cases/project/AddProjectReportUseCase';
import { RequestExtraMaterialUseCase } from '../../application/use-cases/project/RequestExtraMaterialUseCase';
import { ApproveVariationUseCase } from '../../application/use-cases/project/ApproveVariationUseCase';
import { AddProjectExpenseUseCase } from '../../application/use-cases/project/AddProjectExpenseUseCase';

import { ProjectRepository } from '../../infrastructure/repositories/ProjectRepository';
import { ProjectReportRepository } from '../../infrastructure/repositories/ProjectReportRepository';
import { TenderRepository } from '../../infrastructure/repositories/TenderRepository';
import { TenantRepository } from '../../infrastructure/repositories/TenantRepository';
import { isModuleEnabledForTenant } from '../../shared/tenantModules';
import { Request, Response, NextFunction } from 'express';

const router = Router();
/* TERMINUNTERLAGEN (24.08.2026): die Datei bleibt im Arbeitsspeicher, bis sie
   auf die Platte geschrieben ist — nichts landet in einem Zwischenordner.
   Dieselbe Einstellung wie beim Angebotsanhang, nur mit der Grenze der
   Unterlagen (12 MB). */
const appointmentDocumentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024, files: 40 },
});
const projectRepo = new ProjectRepository();
const reportRepo = new ProjectReportRepository();
const controller = new ProjectController(
    new CreateProjectFromTenderUseCase(projectRepo, new TenderRepository(), new TenantRepository()),
    new AddProjectReportUseCase(reportRepo, projectRepo),
    new RequestExtraMaterialUseCase(projectRepo),
    new ApproveVariationUseCase(projectRepo),
    new AddProjectExpenseUseCase(projectRepo),
    projectRepo,
    reportRepo
);

// The company category ("Numara" profile) is the authority: it decides which
// modules the selected company runs, and a company without a category runs all
// of them. The legacy Tenant.isProjectModuleEnabled column is no longer
// consulted — it had no UI and defaulted to off, so it kept answering 403 for
// companies whose category granted the Projects module.
const requireProjectModule = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        if (!await isModuleEnabledForTenant(req.user!.tenantId, 'projects')) {
            res.status(403).json({ error: 'Seçili şirket için Proje Yönetimi modülü aktif değildir.' });
            return;
        }

        next();
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
};

router.use(requireAuth, requireProjectModule);

router.get('/', requirePermission('projects.view'), (req, res) => controller.list(req, res));
router.get('/options/technicians', requireAnyPermission(['projects.manage', 'projects.view']), (req, res) => controller.listTechnicians(req, res));
router.get('/appointments', requireAnyPermission(['projects.view', 'projects.manage']), (req, res) => controller.listAppointments(req, res));
router.get('/appointments/:appointmentId/detail', requireAnyPermission(['projects.view', 'projects.manage']), (req, res) => controller.getAppointmentDetail(req, res));
// Technikerendpunkte: jede Abfrage ist auf die anfragende Person
// eingeschraenkt (assignedTechId / employeeId), darum genuegt zum LESEN das
// Projekt-Leserecht - so traegt Stufe 1 der Seite "Montage" auch etwas.
// Geschrieben (abschliessen, Rapport, Unterschrift) wird weiterhin nur mit
// 'projects.report' bzw. dem Wartungsrecht.
router.get('/technician/installations', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.listMyInstallations(req, res));
router.get('/technician/installations/:appointmentId/detail', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.getAppointmentDetail(req, res, { technicianScope: true }));
// Der ganze Einsatz aus Sicht der Monteurin: seine Tage (mehrtägige Einsätze)
// samt Begleitwort und Unterlagen. Lesen genügt — angelegt wird im Büro.
router.get('/technician/installations/:appointmentId/series', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.getAppointmentSeries(req, res, { technicianScope: true }));
router.get('/technician/appointment-documents/:documentId', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.getAppointmentDocument(req, res, { technicianScope: true }));
router.get('/technician/installations/:appointmentId', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.getMyInstallation(req, res));
router.post('/technician/installations/:appointmentId/complete', requireAnyPermission(['projects.report', 'maintenance.tasks.manage']), (req, res) => controller.completeInstallation(req, res));
router.get('/technician/reports', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.listMyMontageReportOrders(req, res));
router.get('/technician/report-orders/:salesOrderId', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.getMyMontageReportOrder(req, res));
router.get('/technician/reports/:reportId/resources', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.getMyMontageReportResources(req, res));
router.get('/technician/reports/:reportId', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.getMyMontageReport(req, res));
// Malzeme/ürün birleşmesi (2026-08-14): saha ekranlarının "malzeme" kataloğu
// artık ürün (Article) listesidir; yanıt eski ProjectMaterial biçimini korur.
router.get('/materials', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.listMaterials(req, res));

router.post('/from-tender', requirePermission('projects.create'), (req, res) => controller.createFromTender(req, res));

// Global field-report registry for the Services > Reports module. Must be declared before '/:id'.
router.get('/reports', requireAnyPermission(['projects.view', 'projects.report']), (req, res) => controller.listAllReports(req, res));

router.get('/:id', requirePermission('projects.view'), (req, res) => controller.getById(req, res));
router.patch('/:id', requirePermission('projects.manage'), (req, res) => controller.update(req, res));
router.patch('/:id/activate', requirePermission('projects.approve'), (req, res) => controller.activate(req, res));
router.post('/:id/send-booking-mail', requirePermission('projects.mail'), (req, res) => controller.sendBookingMail(req, res));

router.post('/:id/reports', requirePermission('projects.report'), (req, res) => controller.addReport(req, res));
// Kompletter Rapport-Speicherstand eines Termins in EINEM Aufruf (Körper +
// Spesen + Zusatz-/verwendetes Material als Ersatz) — Projektleiter-Popup und
// Montage-Bildschirm speichern beide hierüber; der letzte Speicherstand gilt.
router.put('/appointments/:appointmentId/field-report', requireAnyPermission(['projects.report', 'maintenance.tasks.manage']), (req, res) => controller.saveFieldReport(req, res));
// Speicherprotokoll (wer/wann) — Protokoll-Knopf der Projektleiter-Ansicht.
router.get('/reports/:reportId/logs', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.getReportLogs(req, res));
router.patch('/reports/:reportId', requirePermission('projects.report'), (req, res) => controller.updateReport(req, res));
router.patch('/reports/:reportId/sign', requireAnyPermission(['projects.report', 'maintenance.tasks.manage']), (req, res) => controller.signReport(req, res));
router.post('/reports/:reportId/materials', requirePermission('projects.report'), (req, res) => controller.addReportMaterials(req, res));
router.post('/reports/:reportId/signature-request', requirePermission('projects.report'), (req, res) => controller.requestReportSignature(req, res));

router.post('/:id/appointments', requirePermission('projects.manage'), (req, res) => controller.createAppointment(req, res));
router.patch('/appointments/:appointmentId', requirePermission('projects.manage'), (req, res) => controller.updateAppointment(req, res));
router.delete('/appointments/:appointmentId', requirePermission('projects.manage'), (req, res) => controller.deleteAppointment(req, res));
/* MEHRTÄGIGE EINSÄTZE UND TERMINUNTERLAGEN (24.08.2026).
   `…/series`          — der ganze Einsatz: Tage, Begleitwort, Unterlagen.
   `…/series/days`     — der Einsatzplan, wie er sein soll (anhängen, ändern,
                         streichen in EINEM Aufruf).
   `…/documents`       — Begleitzettel, Bilder, PDF für die Monteurin. Sie gehen
                         an keine Kundenmail; der Inhalt kommt erst beim Öffnen
                         über `/appointment-documents/:id`. */
router.get('/appointments/:appointmentId/series', requireAnyPermission(['projects.view', 'projects.manage']), (req, res) => controller.getAppointmentSeries(req, res));
router.put('/appointments/:appointmentId/series/days', requirePermission('projects.manage'), (req, res) => controller.saveAppointmentSeriesDays(req, res));
router.patch('/appointments/:appointmentId/series', requirePermission('projects.manage'), (req, res) => controller.saveAppointmentSeriesNote(req, res));
// Die Datei reist ROH (multipart) — derselbe Weg wie der Angebotsanhang, und
// der Grund, warum das Anhängen sofort geht. Base64 in einem JSON-Körper bleibt
// als zweiter Weg möglich (Skripte), ist aber ein Drittel grösser.
// Mehrere Unterlagen fahren in EINEM Request. Dadurch laufen Authentisierung,
// Modul-/Rechtepruefung, Terminabfrage und Serienpruefung auch bei zwanzig
// Dateien nur einmal statt zwanzigmal parallel durch MariaDB.
router.post('/appointments/:appointmentId/documents/batch', requirePermission('projects.manage'), appointmentDocumentUpload.array('files', 40), (req, res) => controller.addAppointmentDocuments(req, res));
router.post('/appointments/:appointmentId/documents', requirePermission('projects.manage'), appointmentDocumentUpload.single('file'), (req, res) => controller.addAppointmentDocument(req, res));
router.get('/appointment-documents/:documentId', requireAnyPermission(['projects.view', 'projects.manage']), (req, res) => controller.getAppointmentDocument(req, res));
router.delete('/appointment-documents/:documentId', requirePermission('projects.manage'), (req, res) => controller.deleteAppointmentDocument(req, res));
// «Termin an Kunden senden» — die Kalender-Einladung geht NUR hierüber raus.
router.post('/appointments/:appointmentId/send-invite', requirePermission('projects.manage'), (req, res) => controller.sendAppointmentInvite(req, res));
router.post('/appointments/:appointmentId/complete', requirePermission('projects.manage'), (req, res) => controller.completeInstallation(req, res, { allowManagerComplete: true }));

router.post('/:id/variations', requirePermission('projects.report'), (req, res) => controller.requestExtraMaterial(req, res));
router.patch('/variations/:variationId/approve', requirePermission('projects.approveVariation'), (req, res) => controller.approveVariation(req, res));

router.post('/:id/expenses', requirePermission('projects.manage'), (req, res) => controller.addExpense(req, res));
router.patch('/expenses/:expenseId', requirePermission('projects.manage'), (req, res) => controller.updateExpense(req, res));
router.delete('/expenses/:expenseId', requirePermission('projects.manage'), (req, res) => controller.deleteExpense(req, res));
router.patch('/extra-materials/:extraMaterialId', requirePermission('projects.manage'), (req, res) => controller.updateExtraMaterial(req, res));
router.delete('/extra-materials/:extraMaterialId', requirePermission('projects.manage'), (req, res) => controller.deleteExtraMaterial(req, res));
router.post('/:id/addon-orders', requirePermission('projects.createAddonOrder'), (req, res) => controller.createAddonOrder(req, res));
router.delete('/:id/sales-orders/:salesOrderId', requirePermission('projects.manage'), (req, res) => controller.deleteSalesOrder(req, res));

// Technicians raise an addon-order request (they cannot create the order); managers resolve/dismiss it.
router.post('/:id/addon-order-requests', requireAnyPermission(['projects.report', 'maintenance.tasks.manage']), (req, res) => controller.requestAddonOrder(req, res));
router.patch('/addon-order-requests/:requestId', requirePermission('projects.createAddonOrder'), (req, res) => controller.resolveAddonRequest(req, res));

// Projeyi tüm operasyonel kayıtlarıyla siler (faturalanmış proje silinemez).
// Daha özgül DELETE yolları üstte kayıtlı olduğundan '/:id' onları GÖLGELEMEZ.
router.delete('/:id', requirePermission('projects.manage'), (req, res) => controller.deleteProject(req, res));

export default router;
