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
const router = (0, express_1.Router)();
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
/**
 * @swagger
 * /maintenance/tasks:
 *   get:
 *     tags: [Maintenance]
 *     summary: Bakim gorevlerini tarih araligina gore listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/tasks', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.contracts.manage'), (req, res) => controller.listTasks(req, res));
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
 * /maintenance/reports/{reportId}/sign:
 *   post:
 *     tags: [Maintenance]
 *     summary: Müşterinin bakım raporunu imzalaması
 *     security:
 *       - bearerAuth: []
 */
router.post('/reports/:reportId/sign', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('maintenance.reports.manage'), (req, res) => controller.signReport(req, res));
exports.default = router;
//# sourceMappingURL=maintenance.routes.js.map