"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const TenderController_1 = require("../controllers/TenderController");
const ImportTenderUseCase_1 = require("../../application/use-cases/tender/ImportTenderUseCase");
const ImportSalesOrderCsvUseCase_1 = require("../../application/use-cases/tender/ImportSalesOrderCsvUseCase");
const CalculatePositionCostUseCase_1 = require("../../application/use-cases/tender/CalculatePositionCostUseCase");
const TenderRepository_1 = require("../../infrastructure/repositories/TenderRepository");
const PositionRepository_1 = require("../../infrastructure/repositories/PositionRepository");
const DummyTenderParserService_1 = require("../../infrastructure/services/DummyTenderParserService");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const TenderArticleController_1 = require("../controllers/TenderArticleController");
const ArticleRepository_1 = require("../../infrastructure/repositories/ArticleRepository");
const MapArticleToPositionUseCase_1 = require("../../application/use-cases/tender/MapArticleToPositionUseCase");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const TenderReportController_1 = require("../controllers/TenderReportController");
const ExportTenderDataUseCase_1 = require("../../application/use-cases/tender/ExportTenderDataUseCase");
const GetTenderSummaryReportUseCase_1 = require("../../application/use-cases/tender/GetTenderSummaryReportUseCase");
const CustomerActivityRepository_1 = require("../../infrastructure/repositories/CustomerActivityRepository");
const InventoryRepository_1 = require("../../infrastructure/repositories/InventoryRepository");
const TenderActivityLogRepository_1 = require("../../infrastructure/repositories/TenderActivityLogRepository");
const router = (0, express_1.Router)();
const tenderRepository = new TenderRepository_1.TenderRepository();
const positionRepository = new PositionRepository_1.PositionRepository();
const parserService = new DummyTenderParserService_1.DummyTenderParserService();
const customerActivityRepo = new CustomerActivityRepository_1.CustomerActivityRepository();
const tenderLogRepo = new TenderActivityLogRepository_1.TenderActivityLogRepository();
const importTenderUseCase = new ImportTenderUseCase_1.ImportTenderUseCase(tenderRepository, positionRepository, parserService, customerActivityRepo);
const importSalesOrderCsvUseCase = new ImportSalesOrderCsvUseCase_1.ImportSalesOrderCsvUseCase();
const calculateCostUseCase = new CalculatePositionCostUseCase_1.CalculatePositionCostUseCase(positionRepository, tenderRepository);
const summaryUseCase = new GetTenderSummaryReportUseCase_1.GetTenderSummaryReportUseCase(tenderRepository, positionRepository);
const exportDataUseCase = new ExportTenderDataUseCase_1.ExportTenderDataUseCase(tenderRepository, positionRepository);
const tenderReportController = new TenderReportController_1.TenderReportController(summaryUseCase, exportDataUseCase);
const tenderController = new TenderController_1.TenderController(importTenderUseCase, importSalesOrderCsvUseCase, calculateCostUseCase, tenderRepository, positionRepository, customerActivityRepo, tenderLogRepo);
const articleRepo = new ArticleRepository_1.ArticleRepository();
const inventoryRepository = new InventoryRepository_1.InventoryRepository();
const mapArticleUseCase = new MapArticleToPositionUseCase_1.MapArticleToPositionUseCase(articleRepo, tenderRepository, positionRepository, inventoryRepository);
const tenderArticleController = new TenderArticleController_1.TenderArticleController(mapArticleUseCase, articleRepo, positionRepository, tenderRepository, tenderLogRepo);
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
router.get('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), (req, res) => tenderController.list(req, res));
/**
 * @swagger
 * /tenders:
 *   post:
 *     tags: [Tender]
 *     summary: Sıfırdan boş bir teklif (taslak) oluştur
 *     security:
 *       - bearerAuth: []
 */
router.post('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.createManual(req, res));
/**
 * @swagger
 * /tenders/{id}:
 *   delete:
 *     tags: [Tender]
 *     summary: Taslak teklifi sil
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.delete(req, res));
/**
 * @swagger
 * /tenders/{id}/positions:
 *   post:
 *     tags: [Tender]
 *     summary: Teklif içerisine esnek satır ekle
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/positions', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.addPosition(req, res));
/**
 * @swagger
 * /tenders/{id}/positions/{positionId}:
 *   patch:
 *     tags: [Tender]
 *     summary: Satır açıklaması, miktar, fiyat ve tipini güncelle
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:id/positions/:positionId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.updatePosition(req, res));
/**
 * @swagger
 * /tenders/import:
 *   post:
 *     tags: [Tender]
 *     summary: CRB/SIA 451 Dosyasını İçe Aktar (Parse & Validate)
 *     security:
 *       - bearerAuth: []
 */
router.post('/import', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.import'), (req, res) => tenderController.import(req, res));
router.post('/import-sales-order-csv', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.import'), (req, res) => tenderController.importSalesOrderCsv(req, res));
router.get('/offer-accept/:token', (req, res) => tenderController.acceptOfferByToken(req, res));
/**
 * @swagger
 * /tenders/{id}/positions/{positionId}/calculate:
 *   post:
 *     tags: [Tender]
 *     summary: Bir satırın maliyetlerini hesapla ve kaydet
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/positions/:positionId/calculate', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.calculate'), // Sadece Estimator/Teklif Uzmanı
(req, res) => tenderController.calculateCost(req, res));
/**
 * @swagger
 * /tenders/{id}/version:
 *   post:
 *     tags: [Tender]
 *     summary: İhalenin yeni bir versiyonunu oluştur (Snapshot)
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/version', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.createVersion(req, res));
/**
 * @swagger
 * /tenders/{id}/approve:
 *   patch:
 *     tags: [Tender]
 *     summary: Teklifi Onayla (Fiyatları kilitler)
 *     security:
 *       - bearerAuth: []
 */
router.patch('/:id/approve', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.approve'), // Sadece Yönetici / Project Manager
(req, res) => tenderController.approve(req, res));
router.patch('/:id/meta', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.updateMeta(req, res));
router.patch('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.updateMeta(req, res));
router.get('/options/technicians', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), (req, res) => tenderController.listTechnicians(req, res));
router.get('/:id/schedule-slots', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), (req, res) => tenderController.getScheduleSlots(req, res));
router.post('/:id/schedule-slots', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.createScheduleSlot(req, res));
router.patch('/:id/schedule-slots/:slotId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.updateScheduleSlot(req, res));
router.delete('/:id/schedule-slots/:slotId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.deleteScheduleSlot(req, res));
router.post('/:id/send-offer-mail', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('mail.send'), (req, res) => tenderController.sendOfferMail(req, res));
router.patch('/:id/mark-offer-accepted', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.markOfferAccepted(req, res));
/**
 * @swagger
 * /tenders/{id}/export:
 *   post:
 *     tags: [Tender]
 *     summary: Onaylanmış teklifi dışa aktar (SIA/CRBX veya PDF)
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/export', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.export'), (req, res) => tenderController.export(req, res));
/**
 * @swagger
 * /tenders/{id}:
 *   get:
 *     tags: [Tender]
 *     summary: İhale detaylarını ve esnek teklif satırlarını getir
 *     security:
 *       - bearerAuth: []
 */
router.get('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), (req, res) => tenderController.getDetails(req, res));
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
router.post('/:id/product-images', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), (req, res) => tenderController.getPdfImages(req, res));
/**
 * @swagger
 * /tenders/{id}/positions/{positionId}:
 *   delete:
 *     tags: [Tender]
 *     summary: Taslak teklifteki satırı ve alt satırlarını sil
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id/positions/:positionId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.deletePosition(req, res));
/**
 * @swagger
 * /tenders/{id}/positions/{positionId}/articles:
 *   post:
 *     tags: [Tender]
 *     summary: Eski ürün eşleştirme kaydını satıra ekler.
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/positions/:positionId/articles', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.calculate'), (req, res) => tenderArticleController.mapArticle(req, res));
/**
 * @swagger
 * /tenders/{id}/positions/{positionId}/articles/{mappingId}:
 *   delete:
 *     tags: [Tender]
 *     summary: Satırdan eski ürün eşleştirme kaydını kaldırır
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id/positions/:positionId/articles/:mappingId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.calculate'), (req, res) => tenderArticleController.removeArticleMapping(req, res));
router.patch('/:id/positions/:positionId/articles/:mappingId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.calculate'), (req, res) => tenderArticleController.updateArticleMapping(req, res));
router.post('/:id/materials', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.calculate'), (req, res) => tenderArticleController.mapMaterial(req, res));
router.get('/:id/materials', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), (req, res) => tenderArticleController.listMaterials(req, res));
router.delete('/:id/materials/:mappingId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.calculate'), (req, res) => tenderArticleController.removeMaterialMapping(req, res));
/**
 * @swagger
 * /tenders/{id}/report:
 *   get:
 *     tags: [Tender]
 *     summary: İhale için kârlılık ve maliyet özet raporunu getirir
 *     security:
 *       - bearerAuth: []
 */
router.get('/:id/report', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), // Yönetici veya Teklif Uzmanı görebilir
(req, res) => tenderReportController.getSummary(req, res));
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
router.get('/:id/export', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.export'), // Sadece yetkililer dışarıya teklif dosyası alabilir
(req, res) => tenderReportController.exportData(req, res));
/**
 * @swagger
 * /tenders/{id}/activities:
 *   get:
 *     tags: [Tender]
 *     summary: Bu teklife ait kullanıcı aktivitelerini (kim ne yaptı) getirir
 *     security:
 *       - bearerAuth: []
 */
router.get('/:id/activities', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), (req, res) => tenderController.getActivities(req, res));
router.get('/:id/logs', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), (req, res) => tenderController.getLogs(req, res));
router.get('/:id/chatter-summary', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), (req, res) => tenderController.getChatterSummary(req, res));
router.post('/:id/notes', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.addNote(req, res));
router.get('/:id/documents', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), (req, res) => tenderController.getDocuments(req, res));
router.post('/:id/documents', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), (req, res) => tenderController.addDocument(req, res));
exports.default = router;
//# sourceMappingURL=tender.routes.js.map