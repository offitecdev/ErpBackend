"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerController = void 0;
require("../middlewares/AuthMiddleware");
class CustomerController {
    createCustomerUseCase;
    getCustomerDashboardUseCase;
    addCustomerNoteUseCase;
    listCustomersUseCase;
    logCustomerActivityUseCase;
    uploadDocumentUseCase;
    addCustomerContactUseCase;
    customerRepository;
    contactRepository;
    constructor(createCustomerUseCase, getCustomerDashboardUseCase, addCustomerNoteUseCase, listCustomersUseCase, logCustomerActivityUseCase, uploadDocumentUseCase, addCustomerContactUseCase, customerRepository, contactRepository) {
        this.createCustomerUseCase = createCustomerUseCase;
        this.getCustomerDashboardUseCase = getCustomerDashboardUseCase;
        this.addCustomerNoteUseCase = addCustomerNoteUseCase;
        this.listCustomersUseCase = listCustomersUseCase;
        this.logCustomerActivityUseCase = logCustomerActivityUseCase;
        this.uploadDocumentUseCase = uploadDocumentUseCase;
        this.addCustomerContactUseCase = addCustomerContactUseCase;
        this.customerRepository = customerRepository;
        this.contactRepository = contactRepository;
    }
    async create(req, res) {
        try {
            const customerData = {
                ...req.body,
                tenantId: req.user?.tenantId
            };
            const result = await this.createCustomerUseCase.execute(customerData);
            res.status(201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Müşteri oluşturulamadı.' });
        }
    }
    async list(req, res) {
        try {
            const filter = {
                tenantId: req.user.tenantId,
            };
            if (req.query.isActive !== undefined)
                filter.isActive = req.query.isActive === 'true';
            if (req.query.segment)
                filter.segment = req.query.segment;
            if (req.query.search)
                filter.search = req.query.search;
            if (req.query.page)
                filter.page = Math.max(1, Number(req.query.page) || 1);
            if (req.query.pageSize)
                filter.pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));
            const result = await this.listCustomersUseCase.execute(filter);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getDashboard(req, res) {
        try {
            const { id } = req.params;
            if (!id || Array.isArray(id)) {
                return res.status(400).json({ error: 'Geçersiz müşteri ID.' });
            }
            const tenantId = req.user?.tenantId;
            const result = await this.getCustomerDashboardUseCase.execute(id, tenantId);
            if (!result) {
                return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Dashboard yüklenemedi.' });
        }
    }
    async update(req, res) {
        try {
            const { id } = req.params;
            if (!id || Array.isArray(id)) {
                return res.status(400).json({ error: 'Geçersiz müşteri ID.' });
            }
            const result = await this.customerRepository.update(id, req.body);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Müşteri güncellenemedi.' });
        }
    }
    async addNote(req, res) {
        try {
            const { id } = req.params;
            const employeeId = req.user?.id;
            if (!id || Array.isArray(id)) {
                return res.status(400).json({ error: 'Geçersiz müşteri ID.' });
            }
            if (!employeeId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            const noteData = {
                customerId: id,
                createdByEmployeeId: employeeId,
                noteText: req.body.noteText,
                noteType: req.body.noteType,
                isHighlight: req.body.isHighlight ?? req.body.isHighlighted ?? false
            };
            const result = await this.addCustomerNoteUseCase.execute(noteData);
            res.status(201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Not eklenemedi.' });
        }
    }
    async addContact(req, res) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
            const contactData = {
                customerId,
                firstName: req.body.firstName,
                lastName: req.body.lastName,
                title: req.body.title,
                email: req.body.email,
                phone: req.body.phone,
                isPrimaryContact: req.body.isPrimaryContact
            };
            const result = await this.addCustomerContactUseCase.execute(contactData);
            res.status(201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Yetkili kişi eklenemedi.' });
        }
    }
    async logActivity(req, res) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
            const activityData = {
                customerId,
                employeeId: req.user.id,
                activityType: req.body.activityType,
                activityDate: req.body.activityDate ? new Date(req.body.activityDate) : new Date()
            };
            if (req.body.description)
                activityData.description = req.body.description;
            if (req.body.referenceId)
                activityData.referenceId = req.body.referenceId;
            const result = await this.logCustomerActivityUseCase.execute(activityData);
            res.status(201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || "Aktivite kaydedilemedi." });
        }
    }
    async uploadDocument(req, res) {
        try {
            const relatedEntityId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
            const documentData = {
                tenantId: req.user.tenantId,
                relatedEntityId,
                entityType: 'customer',
                fileUrl: req.body.fileUrl,
                uploadedByEmployeeId: req.user.id
            };
            if (req.body.fileName)
                documentData.fileName = req.body.fileName;
            if (req.body.fileType)
                documentData.fileType = req.body.fileType;
            if (req.body.category)
                documentData.category = req.body.category;
            const result = await this.uploadDocumentUseCase.execute(documentData);
            res.status(201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || "Doküman yüklenemedi." });
        }
    }
}
exports.CustomerController = CustomerController;
//# sourceMappingURL=CustomerController.js.map