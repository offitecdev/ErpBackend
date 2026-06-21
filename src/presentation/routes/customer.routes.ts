import { Router } from 'express';
import { CustomerController } from '../controllers/CustomerController';
import { CreateCustomerUseCase } from '../../application/use-cases/crm/CreateCustomerUseCase';
import { GetCustomerDashboardUseCase } from '../../application/use-cases/crm/GetCustomerDashboardUseCase';
import { AddCustomerNoteUseCase } from '../../application/use-cases/crm/AddCustomerNoteUseCase';
import { ListCustomersUseCase } from '../../application/use-cases/crm/ListCustomersUseCase';
import { LogCustomerActivityUseCase } from '../../application/use-cases/crm/LogCustomerActivityUseCase';
import { UploadDocumentUseCase } from '../../application/use-cases/crm/UploadDocumentUseCase';
import { AddCustomerContactUseCase } from '../../application/use-cases/crm/AddCustomerContactUseCase';

import { CustomerRepository } from '../../infrastructure/repositories/CustomerRepository';
import { CustomerNoteRepository } from '../../infrastructure/repositories/CustomerNoteRepository';
import { CustomerActivityRepository } from '../../infrastructure/repositories/CustomerActivityRepository';
import { DocumentRepository } from '../../infrastructure/repositories/DocumentRepository';
import { CustomerContactRepository } from '../../infrastructure/repositories/CustomerContactRepository';
import { TenderRepository } from '../../infrastructure/repositories/TenderRepository';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';

const router = Router();

const customerRepo          = new CustomerRepository();
const customerNoteRepo      = new CustomerNoteRepository();
const customerActivityRepo  = new CustomerActivityRepository();
const documentRepo          = new DocumentRepository();
const customerContactRepo   = new CustomerContactRepository();

const createCustomerUseCase         = new CreateCustomerUseCase(customerRepo);
const getCustomerDashboardUseCase   = new GetCustomerDashboardUseCase(customerRepo);
const addCustomerNoteUseCase        = new AddCustomerNoteUseCase(customerNoteRepo, customerRepo);
const listCustomersUseCase          = new ListCustomersUseCase(customerRepo);
const logCustomerActivityUseCase    = new LogCustomerActivityUseCase(customerActivityRepo);
const uploadDocumentUseCase         = new UploadDocumentUseCase(documentRepo);
const addCustomerContactUseCase     = new AddCustomerContactUseCase(customerContactRepo);
const tenderRepoForCustomer = new TenderRepository();

const customerController = new CustomerController(
    createCustomerUseCase,
    getCustomerDashboardUseCase,
    addCustomerNoteUseCase,
    listCustomersUseCase,
    logCustomerActivityUseCase,
    uploadDocumentUseCase,
    addCustomerContactUseCase,
    customerRepo,
    customerContactRepo
);

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
router.get(
    '/',
    requireAuth,
    requirePermission('crm.customers.view'),
    (req, res) => customerController.list(req, res)
);

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
router.post(
    '/',
    requireAuth,
    requirePermission('crm.customers.create'),
    (req, res) => customerController.create(req, res)
);

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
router.patch(
    '/:id',
    requireAuth,
    requirePermission('crm.customers.create'),
    (req, res) => customerController.update(req, res)
);

/**
 * @swagger
 * /customers/{id}:
 *   delete:
 *     tags: [CRM]
 *     summary: Müşteriyi sil
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Müşteri silindi
 *       400:
 *         description: Müşteri silinemedi (bağlı kayıtlar mevcut)
 */
router.delete(
    '/:id',
    requireAuth,
    requirePermission('crm.customers.create'),
    (req, res) => customerController.delete(req, res)
);

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
router.get(
    '/:id/dashboard',
    requireAuth,
    requirePermission('crm.customers.view'),
    (req, res) => customerController.getDashboard(req, res)
);

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
router.post(
    '/:id/notes',
    requireAuth,
    requirePermission('crm.customers.addNote'),
    (req, res) => customerController.addNote(req, res)
);

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
router.post(
    '/:id/activities',
    requireAuth,
    requirePermission('crm.activities.create'),
    (req, res) => customerController.logActivity(req, res)
);

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
router.post(
    '/:id/documents',
    requireAuth,
    requirePermission('crm.documents.upload'),
    (req, res) => customerController.uploadDocument(req, res)
);


/**
 * @swagger
 * /customers/{id}/tenders:
 *   get:
 *     tags: [CRM]
 *     summary: Belirli bir müşteriye ait tüm ihaleleri/teklifleri listele
 *     security:
 *       - bearerAuth: []
 */
router.get(
    '/:id/tenders',
    requireAuth,
    requirePermission('crm.customers.view'),
    async (req, res) => {
        try {
            const customerId = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;

            const tenders = await tenderRepoForCustomer.findAll({
                tenantId: tenantId,
                customerId: customerId
            });

            res.status(200).json(tenders);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
);




export default router;
