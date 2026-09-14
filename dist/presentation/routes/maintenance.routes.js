"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const MaintenanceController_1 = require("../controllers/MaintenanceController");
const CreateMaintenanceContract_1 = require("../../application/use-cases/maintenance/CreateMaintenanceContract");
const MaintenanceReportUseCase_1 = require("../../application/use-cases/maintenance/MaintenanceReportUseCase");
const MaintenanceRepository_1 = require("../../infrastructure/repositories/MaintenanceRepository");
const InventoryRepository_1 = require("../../infrastructure/repositories/InventoryRepository");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const RateLimitMiddleware_1 = require("../middlewares/RateLimitMiddleware");
const ResponseCacheMiddleware_1 = require("../middlewares/ResponseCacheMiddleware");
const router = (0, express_1.Router)();
/**
 * Die drei Terminwege sind ohne Anmeldung erreichbar und waren ungebremst —
 * ein Skript konnte Schlüssel durchprobieren. Grosszügig genug für eine
 * Kundin, die die Seite mehrfach öffnet.
 */
const publicBookingLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.',
});
const maintenanceRepo = new MaintenanceRepository_1.MaintenanceRepository();
const inventoryRepo = new InventoryRepository_1.InventoryRepository();
const createContractUseCase = new CreateMaintenanceContract_1.CreateMaintenanceContractUseCase(maintenanceRepo);
const reportUseCase = new MaintenanceReportUseCase_1.MaintenanceReportUseCase(maintenanceRepo, inventoryRepo);
const controller = new MaintenanceController_1.MaintenanceController(createContractUseCase, reportUseCase, maintenanceRepo);
const serviceOptionPermissions = [
    'maintenance.contracts.manage',
    'maintenance.reports.manage',
    'regie.calls.manage',
    'regie.reports.manage',
];
// Der Schlüssel reist im Kopf `X-Public-Token`, nicht mehr im Pfad — ein Pfad
// landet wörtlich im Zugriffsprotokoll und im Verlauf. Siehe publicToken.ts.
router.get('/public/booking', publicBookingLimiter, (req, res) => controller.getPublicAppointmentOptions(req, res));
router.post('/public/booking/confirm', publicBookingLimiter, (req, res) => controller.confirmPublicAppointment(req, res));
router.post('/public/booking/disapprove', publicBookingLimiter, (req, res) => controller.disapprovePublicAppointment(req, res));
// Rückfallweg mit dem Schlüssel im Pfad (verschickte Verweise, alte
// Oberfläche). `main.ts` schwärzt ihn im Protokoll.
router.get('/public/booking/:token', publicBookingLimiter, (req, res) => controller.getPublicAppointmentOptions(req, res));
router.post('/public/booking/:token/confirm', publicBookingLimiter, (req, res) => controller.confirmPublicAppointment(req, res));
router.post('/public/booking/:token/disapprove', publicBookingLimiter, (req, res) => controller.disapprovePublicAppointment(req, res));
/**
 * @swagger
 * /maintenance/options/customers:
 *   get:
 *     tags: [Maintenance]
 *     summary: Bakim/regie formlari icin musterileri listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/options/customers', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(serviceOptionPermissions), (req, res) => controller.listOptionCustomers(req, res));
/**
 * @swagger
 * /maintenance/options/technicians:
 *   get:
 *     tags: [Maintenance]
 *     summary: Rolu veya unvani Teknisyen olan personeli listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/options/technicians', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(serviceOptionPermissions), (req, res) => controller.listTechnicians(req, res));
/**
 * @swagger
 * /maintenance/contracts:
 *   post:
 *     tags: [Maintenance]
 *     summary: Yeni bir periyodik bakım sözleşmesi oluştur
 *     security:
 *       - bearerAuth: []
 */
router.post('/contracts', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (req, res) => controller.createContract(req, res));
/**
 * @swagger
 * /maintenance/contracts:
 *   get:
 *     tags: [Maintenance]
 *     summary: Bakım sözleşmelerini listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/contracts', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (req, res) => controller.listContracts(req, res));
router.patch('/contracts/:contractId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (req, res) => controller.updateContract(req, res));
router.delete('/contracts/:contractId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (req, res) => controller.archiveContract(req, res));
/**
 * @swagger
 * /maintenance/tasks:
 *   get:
 *     tags: [Maintenance]
 *     summary: Bakim gorevlerini tarih araligina gore listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/tasks', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['calendar'], ttlSec: 30 }), (req, res) => controller.listTasks(req, res));
router.get('/tasks/:taskId/detail', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['calendar'], ttlSec: 30 }), (req, res) => controller.getTaskCalendarDetail(req, res));
router.get('/tasks/:taskId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['calendar'], ttlSec: 30 }), (req, res) => controller.getTask(req, res));
router.get('/technician/tasks', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['maintenance.tasks.manage', 'maintenance.reports.manage']), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['calendar'], ttlSec: 30 }), (req, res) => controller.listMyTasks(req, res));
router.get('/technician/tasks/:taskId/detail', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['maintenance.tasks.manage', 'maintenance.reports.manage']), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['calendar'], ttlSec: 30 }), (req, res) => controller.getMyTaskCalendarDetail(req, res));
router.get('/technician/tasks/:taskId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['maintenance.tasks.manage', 'maintenance.reports.manage']), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['calendar'], ttlSec: 30 }), (req, res) => controller.getMyTask(req, res));
/**
 * @swagger
 * /maintenance/tasks/{taskId}:
 *   patch:
 *     tags: [Maintenance]
 *     summary: Bakim gorevinin tarih, durum veya teknisyen atamasini guncelle
 *     security:
 *       - bearerAuth: []
 */
router.patch('/tasks/:taskId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (req, res) => controller.updateTask(req, res));
router.put('/tasks/:taskId/appointment-options/draft', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (req, res) => controller.saveAppointmentOptionsDraft(req, res));
router.post('/tasks/:taskId/appointment-options', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (req, res) => controller.sendAppointmentOptions(req, res));
router.post('/tasks/:taskId/appointment-options/:optionId/approve', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (req, res) => controller.approveAppointmentOption(req, res));
/**
 * @swagger
 * /maintenance/reports:
 *   get:
 *     tags: [Maintenance]
 *     summary: Bakim raporlarini listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/reports', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.reports.manage'), (req, res) => controller.listReports(req, res));
/**
 * @swagger
 * /maintenance/reports:
 *   post:
 *     tags: [Maintenance]
 *     summary: Teknisyenin sahadaki bakım raporunu kaydetmesi (Stok düşümü otomatik yapılır)
 *     security:
 *       - bearerAuth: []
 */
router.post('/reports', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.reports.manage'), (req, res) => controller.submitReport(req, res));
/**
 * @swagger
 * /maintenance/reports/{reportId}:
 *   patch:
 *     tags: [Maintenance]
 *     summary: Bakim raporunu duzenle (imzasiz raporlar icin)
 *     security:
 *       - bearerAuth: []
 */
router.patch('/reports/:reportId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.reports.manage'), (req, res) => controller.updateReport(req, res));
/**
 * @swagger
 * /maintenance/reports/{reportId}/sign:
 *   post:
 *     tags: [Maintenance]
 *     summary: Müşterinin bakım raporunu imzalaması
 *     security:
 *       - bearerAuth: []
 */
router.post('/reports/:reportId/sign', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.reports.manage'), (req, res) => controller.signReport(req, res));
/**
 * @swagger
 * /maintenance/reports/{reportId}/signature-request:
 *   post:
 *     tags: [Maintenance]
 *     summary: Bakim raporu icin teknisyene veya musteriye imza istegi gonder
 *     security:
 *       - bearerAuth: []
 */
router.post('/reports/:reportId/signature-request', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.reports.manage'), (req, res) => controller.requestReportSignature(req, res));
/**
 * @swagger
 * /maintenance/reports/{reportId}/send-to-manager:
 *   post:
 *     tags: [Maintenance]
 *     summary: Teknisyenin bakim raporunu imzali veya imzasiz yoneticiye gondermesi
 *     security:
 *       - bearerAuth: []
 */
router.post('/reports/:reportId/send-to-manager', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.reports.manage'), (req, res) => controller.sendReportToManager(req, res));
exports.default = router;
//# sourceMappingURL=maintenance.routes.js.map