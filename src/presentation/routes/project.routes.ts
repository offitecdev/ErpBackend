import { Router } from 'express';
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
import { MaterialRepository } from '../../infrastructure/repositories/MaterialRepository';
import prisma from '../../infrastructure/database/prisma.client';
import { Request, Response, NextFunction } from 'express';

const router = Router();
const projectRepo = new ProjectRepository();
const reportRepo = new ProjectReportRepository();
const materialRepo = new MaterialRepository();
const controller = new ProjectController(
    new CreateProjectFromTenderUseCase(projectRepo, new TenderRepository(), new TenantRepository()),
    new AddProjectReportUseCase(reportRepo, projectRepo, materialRepo),
    new RequestExtraMaterialUseCase(projectRepo, materialRepo),
    new ApproveVariationUseCase(projectRepo),
    new AddProjectExpenseUseCase(projectRepo),
    projectRepo,
    reportRepo,
    materialRepo
);

const requireProjectModule = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenant = await prisma.tenant.findUnique({
            where: { id: req.user!.tenantId },
            select: { isProjectModuleEnabled: true },
        });

        if (!tenant?.isProjectModuleEnabled) {
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
<<<<<<< HEAD
router.get('/appointments', requireAnyPermission(['projects.view', 'projects.manage']), (req, res) => controller.listAppointments(req, res));
=======
>>>>>>> 16c911768b897682a1f0e461e228a105fcd606ae
router.get('/technician/installations', requireAnyPermission(['projects.report', 'maintenance.tasks.manage']), (req, res) => controller.listMyInstallations(req, res));
router.get('/technician/installations/:appointmentId', requireAnyPermission(['projects.report', 'maintenance.tasks.manage']), (req, res) => controller.getMyInstallation(req, res));
router.post('/technician/installations/:appointmentId/complete', requireAnyPermission(['projects.report', 'maintenance.tasks.manage']), (req, res) => controller.completeInstallation(req, res));
router.get('/materials', requireAnyPermission(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.listMaterials(req, res));
router.post('/materials', requirePermission('inventory.articles.create'), (req, res) => controller.createMaterial(req, res));
router.patch('/materials/:materialId', requirePermission('inventory.articles.update'), (req, res) => controller.updateMaterial(req, res));
router.delete('/materials/:materialId', requirePermission('inventory.articles.delete'), (req, res) => controller.deleteMaterial(req, res));

router.post('/from-tender', requirePermission('projects.create'), (req, res) => controller.createFromTender(req, res));

// Global field-report registry for the Services > Reports module. Must be declared before '/:id'.
router.get('/reports', requireAnyPermission(['projects.view', 'projects.report']), (req, res) => controller.listAllReports(req, res));

router.get('/:id', requirePermission('projects.view'), (req, res) => controller.getById(req, res));
router.patch('/:id', requirePermission('projects.manage'), (req, res) => controller.update(req, res));
router.patch('/:id/activate', requirePermission('projects.approve'), (req, res) => controller.activate(req, res));
router.post('/:id/send-booking-mail', requirePermission('projects.mail'), (req, res) => controller.sendBookingMail(req, res));

router.post('/:id/reports', requirePermission('projects.report'), (req, res) => controller.addReport(req, res));
router.patch('/reports/:reportId', requirePermission('projects.report'), (req, res) => controller.updateReport(req, res));
router.patch('/reports/:reportId/sign', requirePermission('projects.report'), (req, res) => controller.signReport(req, res));
<<<<<<< HEAD
router.post('/reports/:reportId/materials', requirePermission('projects.report'), (req, res) => controller.addReportMaterials(req, res));
=======
>>>>>>> 16c911768b897682a1f0e461e228a105fcd606ae
router.post('/reports/:reportId/signature-request', requirePermission('projects.report'), (req, res) => controller.requestReportSignature(req, res));

router.post('/:id/appointments', requirePermission('projects.manage'), (req, res) => controller.createAppointment(req, res));
router.patch('/appointments/:appointmentId', requirePermission('projects.manage'), (req, res) => controller.updateAppointment(req, res));
router.delete('/appointments/:appointmentId', requirePermission('projects.manage'), (req, res) => controller.deleteAppointment(req, res));
router.post('/appointments/:appointmentId/complete', requirePermission('projects.manage'), (req, res) => controller.completeInstallation(req, res, { allowManagerComplete: true }));

router.post('/:id/variations', requirePermission('projects.report'), (req, res) => controller.requestExtraMaterial(req, res));
router.patch('/variations/:variationId/approve', requirePermission('projects.approveVariation'), (req, res) => controller.approveVariation(req, res));

router.post('/:id/expenses', requirePermission('projects.manage'), (req, res) => controller.addExpense(req, res));
router.patch('/expenses/:expenseId', requirePermission('projects.manage'), (req, res) => controller.updateExpense(req, res));
router.delete('/expenses/:expenseId', requirePermission('projects.manage'), (req, res) => controller.deleteExpense(req, res));
router.patch('/extra-materials/:extraMaterialId', requirePermission('projects.manage'), (req, res) => controller.updateExtraMaterial(req, res));
router.delete('/extra-materials/:extraMaterialId', requirePermission('projects.manage'), (req, res) => controller.deleteExtraMaterial(req, res));
router.post('/:id/addon-orders', requirePermission('projects.createAddonOrder'), (req, res) => controller.createAddonOrder(req, res));

export default router;
