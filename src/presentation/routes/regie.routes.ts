
import { Router } from 'express';
import { RegieController } from '../controllers/RegieController';
import { CreateServiceCallUseCase } from '../../application/use-cases/regie/CreateServiceCallUseCase';
import { CreateServiceReportUseCase } from '../../application/use-cases/regie/CreateServiceReportUseCase';
import { SignAndBillRegieUseCase } from '../../application/use-cases/regie/SignAndBillRegieUseCase';
import { RegieRepository } from '../../infrastructure/repositories/RegieRepository';
import { InventoryRepository } from '../../infrastructure/repositories/InventoryRepository';
import { WorkOrderRepository } from '../../infrastructure/repositories/WorkOrderRepository';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';

const router = Router();

const regieRepo = new RegieRepository();
const inventoryRepo = new InventoryRepository();
const workOrderRepo = new WorkOrderRepository();

const createCallUseCase = new CreateServiceCallUseCase(regieRepo);
const createReportUseCase = new CreateServiceReportUseCase(regieRepo, inventoryRepo);
const signAndBillUseCase = new SignAndBillRegieUseCase(regieRepo, workOrderRepo);

const controller = new RegieController(
    createCallUseCase, 
    createReportUseCase, 
    signAndBillUseCase, 
    regieRepo
);

/**
 * @swagger
 * /regie/calls:
 *   post:
 *     tags: [Regie/Arıza]
 *     summary: Müşteri arızası / Çağrı kaydı oluştur
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/calls',
    requireAuth,
    requirePermission('regie.calls.manage'),
    (req, res) => controller.createCall(req, res)
);

/**
 * @swagger
 * /regie/calls:
 *   get:
 *     tags: [Regie/Arıza]
 *     summary: Arıza çağrılarını listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/calls',
    requireAuth,
    requirePermission('regie.calls.manage'),
    (req, res) => controller.listCalls(req, res)
);

/**
 * @swagger
 * /regie/calls/{callId}:
 *   patch:
 *     tags: [Regie/Ariza]
 *     summary: Regie cagrisi atama, oncelik veya durum guncelle
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/calls/:callId',
    requireAuth,
    requirePermission('regie.calls.manage'),
    (req, res) => controller.updateCall(req, res)
);

/**
 * @swagger
 * /regie/reports:
 *   get:
 *     tags: [Regie/Ariza]
 *     summary: Regie raporlarini listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/reports',
    requireAuth,
    requirePermission('regie.reports.manage'),
    (req, res) => controller.listReports(req, res)
);

/**
 * @swagger
 * /regie/reports:
 *   post:
 *     tags: [Regie/Arıza]
 *     summary: Arıza müdahale raporunu kaydet
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/reports',
    requireAuth,
    requirePermission('regie.reports.manage'),
    (req, res) => controller.submitReport(req, res)
);

/**
 * @swagger
 * /regie/reports/{reportId}/sign:
 *   post:
 *     tags: [Regie/Arıza]
 *     summary: Raporu imzala (Garanti dışıysa fatura uyarısı döner)
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/reports/:reportId/sign',
    requireAuth,
    requirePermission('regie.reports.manage'),
    (req, res) => controller.signReport(req, res)
);

/**
 * @swagger
 * /regie/reports/{reportId}/bill:
 *   post:
 *     tags: [Regie/Arıza]
 *     summary: Fatura (Auftrag/İş Emri) oluştur (Kullanıcı imzadan sonra EVET derse)
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/reports/:reportId/bill',
    requireAuth,
    requirePermission('workorders.manage'),
    (req, res) => controller.generateBill(req, res)
);

export default router;
