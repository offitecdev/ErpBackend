"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
// (Yukarıda oluşturduğumuz ProjectController ve UseCase/Repo sınıflarını import edin)
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const ProjectController_1 = require("../controllers/ProjectController");
const CreateProjectFromTenderUseCase_1 = require("../../application/use-cases/project/CreateProjectFromTenderUseCase");
const AddProjectReportUseCase_1 = require("../../application/use-cases/project/AddProjectReportUseCase");
const RequestExtraMaterialUseCase_1 = require("../../application/use-cases/project/RequestExtraMaterialUseCase");
const ApproveVariationUseCase_1 = require("../../application/use-cases/project/ApproveVariationUseCase");
const AddProjectExpenseUseCase_1 = require("../../application/use-cases/project/AddProjectExpenseUseCase");
const ProjectRepository_1 = require("../../infrastructure/repositories/ProjectRepository");
const ProjectReportRepository_1 = require("../../infrastructure/repositories/ProjectReportRepository");
const TenderRepository_1 = require("../../infrastructure/repositories/TenderRepository");
const TenantRepository_1 = require("../../infrastructure/repositories/TenantRepository");
const MaterialRepository_1 = require("../../infrastructure/repositories/MaterialRepository");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const router = (0, express_1.Router)();
const projectRepo = new ProjectRepository_1.ProjectRepository();
const reportRepo = new ProjectReportRepository_1.ProjectReportRepository();
const materialRepo = new MaterialRepository_1.MaterialRepository();
const controller = new ProjectController_1.ProjectController(new CreateProjectFromTenderUseCase_1.CreateProjectFromTenderUseCase(projectRepo, new TenderRepository_1.TenderRepository(), new TenantRepository_1.TenantRepository()), new AddProjectReportUseCase_1.AddProjectReportUseCase(reportRepo, projectRepo, materialRepo), new RequestExtraMaterialUseCase_1.RequestExtraMaterialUseCase(projectRepo, materialRepo), new ApproveVariationUseCase_1.ApproveVariationUseCase(projectRepo), new AddProjectExpenseUseCase_1.AddProjectExpenseUseCase(projectRepo), projectRepo, reportRepo, materialRepo);
const requireProjectModule = async (req, res, next) => {
    try {
        const tenant = await prisma_client_1.default.tenant.findUnique({
            where: { id: req.user.tenantId },
            select: { isProjectModuleEnabled: true },
        });
        if (!tenant?.isProjectModuleEnabled) {
            res.status(403).json({ error: 'Seçili şirket için Proje Yönetimi modülü aktif değildir.' });
            return;
        }
        next();
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
};
router.use(AuthMiddleware_1.requireAuth, requireProjectModule);
router.get('/', (0, RbacMiddleware_1.requirePermission)('projects.view'), (req, res) => controller.list(req, res));
router.get('/options/technicians', (0, RbacMiddleware_1.requireAnyPermission)(['projects.manage', 'projects.view']), (req, res) => controller.listTechnicians(req, res));
router.get('/appointments', (0, RbacMiddleware_1.requireAnyPermission)(['projects.view', 'projects.manage']), (req, res) => controller.listAppointments(req, res));
router.get('/technician/installations', (0, RbacMiddleware_1.requireAnyPermission)(['projects.report', 'maintenance.tasks.manage']), (req, res) => controller.listMyInstallations(req, res));
router.get('/technician/installations/:appointmentId', (0, RbacMiddleware_1.requireAnyPermission)(['projects.report', 'maintenance.tasks.manage']), (req, res) => controller.getMyInstallation(req, res));
router.post('/technician/installations/:appointmentId/complete', (0, RbacMiddleware_1.requireAnyPermission)(['projects.report', 'maintenance.tasks.manage']), (req, res) => controller.completeInstallation(req, res));
router.get('/materials', (0, RbacMiddleware_1.requireAnyPermission)(['projects.view', 'projects.report', 'maintenance.tasks.manage']), (req, res) => controller.listMaterials(req, res));
router.post('/materials', (0, RbacMiddleware_1.requirePermission)('inventory.articles.create'), (req, res) => controller.createMaterial(req, res));
router.patch('/materials/:materialId', (0, RbacMiddleware_1.requirePermission)('inventory.articles.update'), (req, res) => controller.updateMaterial(req, res));
router.delete('/materials/:materialId', (0, RbacMiddleware_1.requirePermission)('inventory.articles.delete'), (req, res) => controller.deleteMaterial(req, res));
router.post('/from-tender', (0, RbacMiddleware_1.requirePermission)('projects.create'), (req, res) => controller.createFromTender(req, res));
// Global field-report registry for the Services > Reports module. Must be declared before '/:id'.
router.get('/reports', (0, RbacMiddleware_1.requireAnyPermission)(['projects.view', 'projects.report']), (req, res) => controller.listAllReports(req, res));
router.get('/:id', (0, RbacMiddleware_1.requirePermission)('projects.view'), (req, res) => controller.getById(req, res));
router.patch('/:id', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.update(req, res));
router.patch('/:id/activate', (0, RbacMiddleware_1.requirePermission)('projects.approve'), (req, res) => controller.activate(req, res));
router.post('/:id/send-booking-mail', (0, RbacMiddleware_1.requirePermission)('projects.mail'), (req, res) => controller.sendBookingMail(req, res));
router.post('/:id/reports', (0, RbacMiddleware_1.requirePermission)('projects.report'), (req, res) => controller.addReport(req, res));
router.patch('/reports/:reportId', (0, RbacMiddleware_1.requirePermission)('projects.report'), (req, res) => controller.updateReport(req, res));
router.patch('/reports/:reportId/sign', (0, RbacMiddleware_1.requirePermission)('projects.report'), (req, res) => controller.signReport(req, res));
router.post('/reports/:reportId/materials', (0, RbacMiddleware_1.requirePermission)('projects.report'), (req, res) => controller.addReportMaterials(req, res));
router.post('/reports/:reportId/signature-request', (0, RbacMiddleware_1.requirePermission)('projects.report'), (req, res) => controller.requestReportSignature(req, res));
router.post('/:id/appointments', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.createAppointment(req, res));
router.patch('/appointments/:appointmentId', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.updateAppointment(req, res));
router.delete('/appointments/:appointmentId', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.deleteAppointment(req, res));
router.post('/appointments/:appointmentId/complete', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.completeInstallation(req, res, { allowManagerComplete: true }));
router.post('/:id/variations', (0, RbacMiddleware_1.requirePermission)('projects.report'), (req, res) => controller.requestExtraMaterial(req, res));
router.patch('/variations/:variationId/approve', (0, RbacMiddleware_1.requirePermission)('projects.approveVariation'), (req, res) => controller.approveVariation(req, res));
router.post('/:id/expenses', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.addExpense(req, res));
router.patch('/expenses/:expenseId', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.updateExpense(req, res));
router.delete('/expenses/:expenseId', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.deleteExpense(req, res));
router.patch('/extra-materials/:extraMaterialId', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.updateExtraMaterial(req, res));
router.delete('/extra-materials/:extraMaterialId', (0, RbacMiddleware_1.requirePermission)('projects.manage'), (req, res) => controller.deleteExtraMaterial(req, res));
router.post('/:id/addon-orders', (0, RbacMiddleware_1.requirePermission)('projects.createAddonOrder'), (req, res) => controller.createAddonOrder(req, res));
exports.default = router;
//# sourceMappingURL=project.routes.js.map