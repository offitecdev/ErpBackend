import { Router } from 'express';
import { MaintenanceController } from '../controllers/MaintenanceController';
import { CreateMaintenanceContractUseCase } from '../../application/use-cases/maintenance/CreateMaintenanceContract';
import { MaintenanceReportUseCase } from '../../application/use-cases/maintenance/MaintenanceReportUseCase';
import { MaintenanceRepository } from '../../infrastructure/repositories/MaintenanceRepository';
import { InventoryRepository } from '../../infrastructure/repositories/InventoryRepository';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission, requirePermission } from '../middlewares/RbacMiddleware';

const router = Router();

const maintenanceRepo = new MaintenanceRepository();
const inventoryRepo = new InventoryRepository();

const createContractUseCase = new CreateMaintenanceContractUseCase(maintenanceRepo);
const reportUseCase = new MaintenanceReportUseCase(maintenanceRepo, inventoryRepo);

const controller = new MaintenanceController(createContractUseCase, reportUseCase, maintenanceRepo);

const serviceOptionPermissions = [
    'maintenance.contracts.manage',
    'maintenance.reports.manage',
    'regie.calls.manage',
    'regie.reports.manage',
];

router.get(
    '/public/booking/:token',
    (req, res) => controller.getPublicAppointmentOptions(req, res)
);

router.post(
    '/public/booking/:token/confirm',
    (req, res) => controller.confirmPublicAppointment(req, res)
);

router.post(
    '/public/booking/:token/disapprove',
    (req, res) => controller.disapprovePublicAppointment(req, res)
);

/**
 * @swagger
 * /maintenance/options/customers:
 *   get:
 *     tags: [Maintenance]
 *     summary: Bakim/regie formlari icin musterileri listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/options/customers',
    requireAuth,
    requireAnyPermission(serviceOptionPermissions),
    (req, res) => controller.listOptionCustomers(req, res)
);

/**
 * @swagger
 * /maintenance/options/technicians:
 *   get:
 *     tags: [Maintenance]
 *     summary: Rolu veya unvani Teknisyen olan personeli listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/options/technicians',
    requireAuth,
    requireAnyPermission(serviceOptionPermissions),
    (req, res) => controller.listTechnicians(req, res)
);

/**
 * @swagger
 * /maintenance/contracts:
 *   post:
 *     tags: [Maintenance]
 *     summary: Yeni bir periyodik bakım sözleşmesi oluştur
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/contracts',
    requireAuth,
    requirePermission('maintenance.contracts.manage'),
    (req, res) => controller.createContract(req, res)
);

/**
 * @swagger
 * /maintenance/contracts:
 *   get:
 *     tags: [Maintenance]
 *     summary: Bakım sözleşmelerini listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/contracts',
    requireAuth,
    requirePermission('maintenance.contracts.manage'),
    (req, res) => controller.listContracts(req, res)
);

router.patch(
    '/contracts/:contractId',
    requireAuth,
    requirePermission('maintenance.contracts.manage'),
    (req, res) => controller.updateContract(req, res)
);

router.delete(
    '/contracts/:contractId',
    requireAuth,
    requirePermission('maintenance.contracts.manage'),
    (req, res) => controller.archiveContract(req, res)
);

/**
 * @swagger
 * /maintenance/tasks:
 *   get:
 *     tags: [Maintenance]
 *     summary: Bakim gorevlerini tarih araligina gore listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/tasks',
    requireAuth,
    requirePermission('maintenance.contracts.manage'),
    (req, res) => controller.listTasks(req, res)
);

router.get(
    '/tasks/:taskId',
    requireAuth,
    requirePermission('maintenance.contracts.manage'),
    (req, res) => controller.getTask(req, res)
);

router.get(
    '/technician/tasks',
    requireAuth,
    requireAnyPermission(['maintenance.tasks.manage', 'maintenance.reports.manage']),
    (req, res) => controller.listMyTasks(req, res)
);

router.get(
    '/technician/tasks/:taskId',
    requireAuth,
    requireAnyPermission(['maintenance.tasks.manage', 'maintenance.reports.manage']),
    (req, res) => controller.getMyTask(req, res)
);

/**
 * @swagger
 * /maintenance/tasks/{taskId}:
 *   patch:
 *     tags: [Maintenance]
 *     summary: Bakim gorevinin tarih, durum veya teknisyen atamasini guncelle
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/tasks/:taskId',
    requireAuth,
    requirePermission('maintenance.contracts.manage'),
    (req, res) => controller.updateTask(req, res)
);

router.put(
    '/tasks/:taskId/appointment-options/draft',
    requireAuth,
    requirePermission('maintenance.contracts.manage'),
    (req, res) => controller.saveAppointmentOptionsDraft(req, res)
);

router.post(
    '/tasks/:taskId/appointment-options',
    requireAuth,
    requirePermission('maintenance.contracts.manage'),
    (req, res) => controller.sendAppointmentOptions(req, res)
);

router.post(
    '/tasks/:taskId/appointment-options/:optionId/approve',
    requireAuth,
    requirePermission('maintenance.contracts.manage'),
    (req, res) => controller.approveAppointmentOption(req, res)
);

/**
 * @swagger
 * /maintenance/reports:
 *   get:
 *     tags: [Maintenance]
 *     summary: Bakim raporlarini listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/reports',
    requireAuth,
    requirePermission('maintenance.reports.manage'),
    (req, res) => controller.listReports(req, res)
);

/**
 * @swagger
 * /maintenance/reports:
 *   post:
 *     tags: [Maintenance]
 *     summary: Teknisyenin sahadaki bakım raporunu kaydetmesi (Stok düşümü otomatik yapılır)
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/reports',
    requireAuth,
    requirePermission('maintenance.reports.manage'),
    (req, res) => controller.submitReport(req, res)
);

/**
 * @swagger
 * /maintenance/reports/{reportId}:
 *   patch:
 *     tags: [Maintenance]
 *     summary: Bakim raporunu duzenle (imzasiz raporlar icin)
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/reports/:reportId',
    requireAuth,
    requirePermission('maintenance.reports.manage'),
    (req, res) => controller.updateReport(req, res)
);

/**
 * @swagger
 * /maintenance/reports/{reportId}/sign:
 *   post:
 *     tags: [Maintenance]
 *     summary: Müşterinin bakım raporunu imzalaması
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/reports/:reportId/sign',
    requireAuth,
    requirePermission('maintenance.reports.manage'),
    (req, res) => controller.signReport(req, res)
);

/**
 * @swagger
 * /maintenance/reports/{reportId}/signature-request:
 *   post:
 *     tags: [Maintenance]
 *     summary: Bakim raporu icin teknisyene veya musteriye imza istegi gonder
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/reports/:reportId/signature-request',
    requireAuth,
    requirePermission('maintenance.reports.manage'),
    (req, res) => controller.requestReportSignature(req, res)
);

/**
 * @swagger
 * /maintenance/reports/{reportId}/send-to-manager:
 *   post:
 *     tags: [Maintenance]
 *     summary: Teknisyenin bakim raporunu imzali veya imzasiz yoneticiye gondermesi
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/reports/:reportId/send-to-manager',
    requireAuth,
    requirePermission('maintenance.reports.manage'),
    (req, res) => controller.sendReportToManager(req, res)
);

export default router;
