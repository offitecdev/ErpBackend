
import { Router } from 'express';
import { TenderController } from '../controllers/TenderController';
import { ImportTenderUseCase } from '../../application/use-cases/tender/ImportTenderUseCase';
import { ImportSalesOrderCsvUseCase } from '../../application/use-cases/tender/ImportSalesOrderCsvUseCase';
import { CalculatePositionCostUseCase } from '../../application/use-cases/tender/CalculatePositionCostUseCase';
import { TenderRepository } from '../../infrastructure/repositories/TenderRepository';
import { PositionRepository } from '../../infrastructure/repositories/PositionRepository';
import { DummyTenderParserService } from '../../infrastructure/services/DummyTenderParserService';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { TenderArticleController } from '../controllers/TenderArticleController';
import { ArticleRepository } from '../../infrastructure/repositories/ArticleRepository';
import { MapArticleToPositionUseCase } from '../../application/use-cases/tender/MapArticleToPositionUseCase';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { TenderReportController } from '../controllers/TenderReportController';
import { ExportTenderDataUseCase } from '../../application/use-cases/tender/ExportTenderDataUseCase';
import { GetTenderSummaryReportUseCase } from '../../application/use-cases/tender/GetTenderSummaryReportUseCase';
import { CustomerActivityRepository } from '../../infrastructure/repositories/CustomerActivityRepository';
import { InventoryRepository } from '../../infrastructure/repositories/InventoryRepository';
import { TenderActivityLogRepository } from '../../infrastructure/repositories/TenderActivityLogRepository';

const router = Router();

const tenderRepository = new TenderRepository();
const positionRepository = new PositionRepository();
const parserService = new DummyTenderParserService();
const customerActivityRepo = new CustomerActivityRepository();
const tenderLogRepo = new TenderActivityLogRepository();
const importTenderUseCase = new ImportTenderUseCase(tenderRepository, positionRepository, parserService, customerActivityRepo);
const importSalesOrderCsvUseCase = new ImportSalesOrderCsvUseCase();
const calculateCostUseCase = new CalculatePositionCostUseCase(positionRepository, tenderRepository);
const summaryUseCase = new GetTenderSummaryReportUseCase(tenderRepository, positionRepository);
const exportDataUseCase = new ExportTenderDataUseCase(tenderRepository, positionRepository);
const tenderReportController = new TenderReportController(summaryUseCase, exportDataUseCase);
const tenderController = new TenderController(
    importTenderUseCase,
    importSalesOrderCsvUseCase,
    calculateCostUseCase,
    tenderRepository,
    positionRepository,
    customerActivityRepo,
    tenderLogRepo
);
const articleRepo = new ArticleRepository();
const inventoryRepository = new InventoryRepository();
const mapArticleUseCase = new MapArticleToPositionUseCase(articleRepo, tenderRepository, positionRepository, inventoryRepository);
const tenderArticleController = new TenderArticleController(mapArticleUseCase, articleRepo, positionRepository, tenderRepository, tenderLogRepo);

/**
 * @swagger
 * /tenders:
 *   get:
 *     tags: [Tender]
 *     summary: İhale/teklif listesini getir (filtre destekli)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: customerId
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [Draft, Approved, Exported] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 */
router.get(
    '/',
    requireAuth,
    requirePermission('tenders.view'),
    (req, res) => tenderController.list(req, res)
);

/**
 * @swagger
 * /tenders:
 *   post:
 *     tags: [Tender]
 *     summary: Sıfırdan boş bir teklif (taslak) oluştur
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.createManual(req, res)
);

/**
 * @swagger
 * /tenders/{id}:
 *   delete:
 *     tags: [Tender]
 *     summary: Taslak teklifi sil
 *     security:
 *       - bearerAuth: []
 */
router.delete(
    '/:id',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.delete(req, res)
);

/**
 * @swagger
 * /tenders/{id}/positions:
 *   post:
 *     tags: [Tender]
 *     summary: Teklif içerisine esnek satır ekle
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/:id/positions',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.addPosition(req, res)
);

/**
 * @swagger
 * /tenders/{id}/positions/{positionId}:
 *   patch:
 *     tags: [Tender]
 *     summary: Satır açıklaması, miktar, fiyat ve tipini güncelle
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/:id/positions/:positionId',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.updatePosition(req, res)
);

/**
 * @swagger
 * /tenders/import:
 *   post:
 *     tags: [Tender]
 *     summary: CRB/SIA 451 Dosyasını İçe Aktar (Parse & Validate)
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/import',
    requireAuth,
    requirePermission('tenders.import'),
    (req, res) => tenderController.import(req, res)
);

router.post(
    '/import-sales-order-csv',
    requireAuth,
    requirePermission('tenders.import'),
    (req, res) => tenderController.importSalesOrderCsv(req, res)
);

router.get(
    '/offer-accept/:token',
    (req, res) => tenderController.acceptOfferByToken(req, res)
);

/**
 * @swagger
 * /tenders/{id}/positions/{positionId}/calculate:
 *   post:
 *     tags: [Tender]
 *     summary: Bir satırın maliyetlerini hesapla ve kaydet
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/:id/positions/:positionId/calculate',
    requireAuth,
    requirePermission('tenders.calculate'), // Sadece Estimator/Teklif Uzmanı
    (req, res) => tenderController.calculateCost(req, res)
);

/**
 * @swagger
 * /tenders/{id}/version:
 *   post:
 *     tags: [Tender]
 *     summary: İhalenin yeni bir versiyonunu oluştur (Snapshot)
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/:id/version',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.createVersion(req, res)
);

/**
 * @swagger
 * /tenders/{id}/approve:
 *   patch:
 *     tags: [Tender]
 *     summary: Teklifi Onayla (Fiyatları kilitler)
 *     security:
 *       - bearerAuth: []
 */
router.patch(
    '/:id/approve',
    requireAuth,
    requirePermission('tenders.approve'), // Sadece Yönetici / Project Manager
    (req, res) => tenderController.approve(req, res)
);

router.patch(
    '/:id/meta',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.updateMeta(req, res)
);

router.patch(
    '/:id',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.updateMeta(req, res)
);

router.get(
    '/options/technicians',
    requireAuth,
    requirePermission('tenders.view'),
    (req, res) => tenderController.listTechnicians(req, res)
);

router.get(
    '/:id/schedule-slots',
    requireAuth,
    requirePermission('tenders.view'),
    (req, res) => tenderController.getScheduleSlots(req, res)
);

router.post(
    '/:id/schedule-slots',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.createScheduleSlot(req, res)
);

router.patch(
    '/:id/schedule-slots/:slotId',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.updateScheduleSlot(req, res)
);

router.delete(
    '/:id/schedule-slots/:slotId',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.deleteScheduleSlot(req, res)
);

router.post(
    '/:id/send-offer-mail',
    requireAuth,
    requirePermission('mail.send'),
    (req, res) => tenderController.sendOfferMail(req, res)
);

router.patch(
    '/:id/mark-offer-accepted',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.markOfferAccepted(req, res)
);

/**
 * @swagger
 * /tenders/{id}/export:
 *   post:
 *     tags: [Tender]
 *     summary: Onaylanmış teklifi dışa aktar (SIA/CRBX veya PDF)
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/:id/export',
    requireAuth,
    requirePermission('tenders.export'),
    (req, res) => tenderController.export(req, res)
);

/**
 * @swagger
 * /tenders/{id}:
 *   get:
 *     tags: [Tender]
 *     summary: İhale detaylarını ve esnek teklif satırlarını getir
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/:id',
    requireAuth,
    requirePermission('tenders.view'),
    (req, res) => tenderController.getDetails(req, res)
);

/**
 * @swagger
 * /tenders/{id}/product-images:
 *   post:
 *     tags: [Tender]
 *     summary: PDF için yalnızca verilen ürün id'lerinin görsellerini getir (aşırı veri çekmeden)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids: { type: array, items: { type: string } }
 */
router.post(
    '/:id/product-images',
    requireAuth,
    requirePermission('tenders.view'),
    (req, res) => tenderController.getPdfImages(req, res)
);

/**
 * @swagger
 * /tenders/{id}/positions/{positionId}:
 *   delete:
 *     tags: [Tender]
 *     summary: Taslak teklifteki satırı ve alt satırlarını sil
 *     security:
 *       - bearerAuth: []
 */
router.delete(
    '/:id/positions/:positionId',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.deletePosition(req, res)
);

/**
 * @swagger
 * /tenders/{id}/positions/{positionId}/articles:
 *   post:
 *     tags: [Tender]
 *     summary: Eski ürün eşleştirme kaydını satıra ekler.
 *     security:
 *       - bearerAuth: []
 */
router.post(
    '/:id/positions/:positionId/articles',
    requireAuth,
    requirePermission('tenders.calculate'),
    (req, res) => tenderArticleController.mapArticle(req, res)
);

/**
 * @swagger
 * /tenders/{id}/positions/{positionId}/articles/{mappingId}:
 *   delete:
 *     tags: [Tender]
 *     summary: Satırdan eski ürün eşleştirme kaydını kaldırır
 *     security:
 *       - bearerAuth: []
 */
router.delete(
    '/:id/positions/:positionId/articles/:mappingId',
    requireAuth,
    requirePermission('tenders.calculate'),
    (req, res) => tenderArticleController.removeArticleMapping(req, res)
);

router.patch(
    '/:id/positions/:positionId/articles/:mappingId',
    requireAuth,
    requirePermission('tenders.calculate'),
    (req, res) => tenderArticleController.updateArticleMapping(req, res)
);

router.post(
    '/:id/materials',
    requireAuth,
    requirePermission('tenders.calculate'),
    (req, res) => tenderArticleController.mapMaterial(req, res)
);

router.get(
    '/:id/materials',
    requireAuth,
    requirePermission('tenders.view'),
    (req, res) => tenderArticleController.listMaterials(req, res)
);

router.delete(
    '/:id/materials/:mappingId',
    requireAuth,
    requirePermission('tenders.calculate'),
    (req, res) => tenderArticleController.removeMaterialMapping(req, res)
);

/**
 * @swagger
 * /tenders/{id}/report:
 *   get:
 *     tags: [Tender]
 *     summary: İhale için kârlılık ve maliyet özet raporunu getirir
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/:id/report',
    requireAuth,
    requirePermission('tenders.view'), // Yönetici veya Teklif Uzmanı görebilir
    (req, res) => tenderReportController.getSummary(req, res)
);

/**
 * @swagger
 * /tenders/{id}/export:
 *   get:
 *     tags: [Tender]
 *     summary: Teklifi PDF veya XML çıktısı için satır formatında dışa aktarır
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [PDF, CRBX, SIA451]
 */
router.get(
    '/:id/export',
    requireAuth,
    requirePermission('tenders.export'), // Sadece yetkililer dışarıya teklif dosyası alabilir
    (req, res) => tenderReportController.exportData(req, res)
);

/**
 * @swagger
 * /tenders/{id}/activities:
 *   get:
 *     tags: [Tender]
 *     summary: Bu teklife ait kullanıcı aktivitelerini (kim ne yaptı) getirir
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/:id/activities',
    requireAuth,
    requirePermission('tenders.view'),
    (req, res) => tenderController.getActivities(req, res)
);

router.get(
    '/:id/logs',
    requireAuth,
    requirePermission('tenders.view'),
    (req, res) => tenderController.getLogs(req, res)
);

router.get(
    '/:id/chatter-summary',
    requireAuth,
    requirePermission('tenders.view'),
    (req, res) => tenderController.getChatterSummary(req, res)
);

router.post(
    '/:id/notes',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.addNote(req, res)
);

router.get(
    '/:id/documents',
    requireAuth,
    requirePermission('tenders.view'),
    (req, res) => tenderController.getDocuments(req, res)
);

router.post(
    '/:id/documents',
    requireAuth,
    requirePermission('tenders.manage'),
    (req, res) => tenderController.addDocument(req, res)
);


export default router;
