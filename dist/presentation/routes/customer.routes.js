"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const CustomerController_1 = require("../controllers/CustomerController");
const CreateCustomerUseCase_1 = require("../../application/use-cases/crm/CreateCustomerUseCase");
const GetCustomerDashboardUseCase_1 = require("../../application/use-cases/crm/GetCustomerDashboardUseCase");
const AddCustomerNoteUseCase_1 = require("../../application/use-cases/crm/AddCustomerNoteUseCase");
const ListCustomersUseCase_1 = require("../../application/use-cases/crm/ListCustomersUseCase");
const LogCustomerActivityUseCase_1 = require("../../application/use-cases/crm/LogCustomerActivityUseCase");
const UploadDocumentUseCase_1 = require("../../application/use-cases/crm/UploadDocumentUseCase");
const AddCustomerContactUseCase_1 = require("../../application/use-cases/crm/AddCustomerContactUseCase");
const CustomerRepository_1 = require("../../infrastructure/repositories/CustomerRepository");
const CustomerNoteRepository_1 = require("../../infrastructure/repositories/CustomerNoteRepository");
const CustomerActivityRepository_1 = require("../../infrastructure/repositories/CustomerActivityRepository");
const DocumentRepository_1 = require("../../infrastructure/repositories/DocumentRepository");
const CustomerContactRepository_1 = require("../../infrastructure/repositories/CustomerContactRepository");
const TenderRepository_1 = require("../../infrastructure/repositories/TenderRepository");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const router = (0, express_1.Router)();
const customerRepo = new CustomerRepository_1.CustomerRepository();
const customerNoteRepo = new CustomerNoteRepository_1.CustomerNoteRepository();
const customerActivityRepo = new CustomerActivityRepository_1.CustomerActivityRepository();
const documentRepo = new DocumentRepository_1.DocumentRepository();
const customerContactRepo = new CustomerContactRepository_1.CustomerContactRepository();
const createCustomerUseCase = new CreateCustomerUseCase_1.CreateCustomerUseCase(customerRepo);
const getCustomerDashboardUseCase = new GetCustomerDashboardUseCase_1.GetCustomerDashboardUseCase(customerRepo);
const addCustomerNoteUseCase = new AddCustomerNoteUseCase_1.AddCustomerNoteUseCase(customerNoteRepo, customerRepo);
const listCustomersUseCase = new ListCustomersUseCase_1.ListCustomersUseCase(customerRepo);
const logCustomerActivityUseCase = new LogCustomerActivityUseCase_1.LogCustomerActivityUseCase(customerActivityRepo);
const uploadDocumentUseCase = new UploadDocumentUseCase_1.UploadDocumentUseCase(documentRepo);
const addCustomerContactUseCase = new AddCustomerContactUseCase_1.AddCustomerContactUseCase(customerContactRepo);
const tenderRepoForCustomer = new TenderRepository_1.TenderRepository();
const customerController = new CustomerController_1.CustomerController(createCustomerUseCase, getCustomerDashboardUseCase, addCustomerNoteUseCase, listCustomersUseCase, logCustomerActivityUseCase, uploadDocumentUseCase, addCustomerContactUseCase, customerRepo, customerContactRepo);
/**
 * @swagger
 * /customers:
 *   get:
 *     tags: [CRM]
 *     summary: Müşteri Listesini Getir
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: isActive
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: segment
 *         schema:
 *           type: string
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Müşteri listesi
 *       401:
 *         description: Yetkisiz
 */
router.get('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), (req, res) => customerController.list(req, res));
/**
 * @swagger
 * /customers:
 *   post:
 *     tags: [CRM]
 *     summary: Yeni Müşteri Oluştur
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateCustomerRequest'
 *     responses:
 *       201:
 *         description: Müşteri başarıyla oluşturuldu
 *       400:
 *         description: Geçersiz istek
 */
router.post('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.customers.create'), (req, res) => customerController.create(req, res));
/**
 * @swagger
 * /customers/{id}:
 *   patch:
 *     tags: [CRM]
 *     summary: Müşteri bilgilerini güncelle
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               companyName:
 *                 type: string
 *               segment:
 *                 type: string
 *               taxOffice:
 *                 type: string
 *               taxNumber:
 *                 type: string
 *               address:
 *                 type: string
 *               mainPhone:
 *                 type: string
 *               mainEmail:
 *                 type: string
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Müşteri güncellendi
 *       400:
 *         description: Geçersiz istek
 */
router.patch('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.customers.create'), (req, res) => customerController.update(req, res));
/**
 * @swagger
 * /customers/{id}/dashboard:
 *   get:
 *     tags: [CRM]
 *     summary: Müşteri 360° Genel Bakış Paneli (Dashboard) Getir
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Dashboard verisi başarıyla getirildi
 *       404:
 *         description: Müşteri bulunamadı
 */
router.get('/:id/dashboard', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), (req, res) => customerController.getDashboard(req, res));
/**
 * @swagger
 * /customers/{id}/notes:
 *   post:
 *     tags: [CRM]
 *     summary: Müşteriye Not Ekle
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AddCustomerNoteRequest'
 *     responses:
 *       201:
 *         description: Not başarıyla eklendi
 */
router.post('/:id/notes', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.customers.addNote'), (req, res) => customerController.addNote(req, res));
/**
 * @swagger
 * /customers/{id}/activities:
 *   post:
 *     tags: [CRM]
 *     summary: Müşteri Zaman Çizelgesine Aktivite Ekle
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               activityType:
 *                 type: string
 *               description:
 *                 type: string
 *               activityDate:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Aktivite kaydedildi.
 */
router.post('/:id/activities', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.activities.create'), (req, res) => customerController.logActivity(req, res));
/**
 * @swagger
 * /customers/{id}/documents:
 *   post:
 *     tags: [CRM]
 *     summary: Müşteriye Ait Doküman Yükle
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fileName:
 *                 type: string
 *               fileUrl:
 *                 type: string
 *               fileType:
 *                 type: string
 *               category:
 *                 type: string
 *     responses:
 *       201:
 *         description: Doküman meta verisi kaydedildi.
 */
router.post('/:id/documents', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.documents.upload'), (req, res) => customerController.uploadDocument(req, res));
/**
 * @swagger
 * /customers/{id}/tenders:
 *   get:
 *     tags: [CRM]
 *     summary: Belirli bir müşteriye ait tüm ihaleleri/teklifleri listele
 *     security:
 *       - bearerAuth: []
 */
router.get('/:id/tenders', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('crm.customers.view'), async (req, res) => {
    try {
        const customerId = req.params.id;
        const tenantId = req.user.tenantId;
        const tenders = await tenderRepoForCustomer.findAll({
            tenantId: tenantId,
            customerId: customerId
        });
        res.status(200).json(tenders);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=customer.routes.js.map