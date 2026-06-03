"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const RegieController_1 = require("../controllers/RegieController");
const CreateServiceCallUseCase_1 = require("../../application/use-cases/regie/CreateServiceCallUseCase");
const CreateServiceReportUseCase_1 = require("../../application/use-cases/regie/CreateServiceReportUseCase");
const SignAndBillRegieUseCase_1 = require("../../application/use-cases/regie/SignAndBillRegieUseCase");
const RegieRepository_1 = require("../../infrastructure/repositories/RegieRepository");
const InventoryRepository_1 = require("../../infrastructure/repositories/InventoryRepository");
const WorkOrderRepository_1 = require("../../infrastructure/repositories/WorkOrderRepository");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const router = (0, express_1.Router)();
const regieRepo = new RegieRepository_1.RegieRepository();
const inventoryRepo = new InventoryRepository_1.InventoryRepository();
const workOrderRepo = new WorkOrderRepository_1.WorkOrderRepository();
const createCallUseCase = new CreateServiceCallUseCase_1.CreateServiceCallUseCase(regieRepo);
const createReportUseCase = new CreateServiceReportUseCase_1.CreateServiceReportUseCase(regieRepo, inventoryRepo);
const signAndBillUseCase = new SignAndBillRegieUseCase_1.SignAndBillRegieUseCase(regieRepo, workOrderRepo);
const controller = new RegieController_1.RegieController(createCallUseCase, createReportUseCase, signAndBillUseCase, regieRepo);
/**
 * @swagger
 * /regie/calls:
 *   post:
 *     tags: [Regie/Arıza]
 *     summary: Müşteri arızası / Çağrı kaydı oluştur
 *     security:
 *       - bearerAuth: []
 */
router.post('/calls', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('regie.calls.manage'), (req, res) => controller.createCall(req, res));
/**
 * @swagger
 * /regie/calls:
 *   get:
 *     tags: [Regie/Arıza]
 *     summary: Arıza çağrılarını listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/calls', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('regie.calls.manage'), (req, res) => controller.listCalls(req, res));
/**
 * @swagger
 * /regie/calls/{callId}:
 *   patch:
 *     tags: [Regie/Ariza]
 *     summary: Regie cagrisi atama, oncelik veya durum guncelle
 *     security:
 *       - bearerAuth: []
 */
router.patch('/calls/:callId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('regie.calls.manage'), (req, res) => controller.updateCall(req, res));
/**
 * @swagger
 * /regie/reports:
 *   get:
 *     tags: [Regie/Ariza]
 *     summary: Regie raporlarini listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/reports', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('regie.reports.manage'), (req, res) => controller.listReports(req, res));
/**
 * @swagger
 * /regie/reports:
 *   post:
 *     tags: [Regie/Arıza]
 *     summary: Arıza müdahale raporunu kaydet
 *     security:
 *       - bearerAuth: []
 */
router.post('/reports', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('regie.reports.manage'), (req, res) => controller.submitReport(req, res));
/**
 * @swagger
 * /regie/reports/{reportId}/sign:
 *   post:
 *     tags: [Regie/Arıza]
 *     summary: Raporu imzala (Garanti dışıysa fatura uyarısı döner)
 *     security:
 *       - bearerAuth: []
 */
router.post('/reports/:reportId/sign', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('regie.reports.manage'), (req, res) => controller.signReport(req, res));
/**
 * @swagger
 * /regie/reports/{reportId}/bill:
 *   post:
 *     tags: [Regie/Arıza]
 *     summary: Fatura (Auftrag/İş Emri) oluştur (Kullanıcı imzadan sonra EVET derse)
 *     security:
 *       - bearerAuth: []
 */
router.post('/reports/:reportId/bill', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('workorders.manage'), (req, res) => controller.generateBill(req, res));
exports.default = router;
//# sourceMappingURL=regie.routes.js.map