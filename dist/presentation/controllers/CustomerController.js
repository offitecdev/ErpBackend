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
    noteRepository;
    activityRepository;
    addCustomerLocationUseCase;
    locationRepository;
    productDiscountRepository;
    constructor(createCustomerUseCase, getCustomerDashboardUseCase, addCustomerNoteUseCase, listCustomersUseCase, logCustomerActivityUseCase, uploadDocumentUseCase, addCustomerContactUseCase, customerRepository, contactRepository, noteRepository, activityRepository, addCustomerLocationUseCase, locationRepository, productDiscountRepository) {
        this.createCustomerUseCase = createCustomerUseCase;
        this.getCustomerDashboardUseCase = getCustomerDashboardUseCase;
        this.addCustomerNoteUseCase = addCustomerNoteUseCase;
        this.listCustomersUseCase = listCustomersUseCase;
        this.logCustomerActivityUseCase = logCustomerActivityUseCase;
        this.uploadDocumentUseCase = uploadDocumentUseCase;
        this.addCustomerContactUseCase = addCustomerContactUseCase;
        this.customerRepository = customerRepository;
        this.contactRepository = contactRepository;
        this.noteRepository = noteRepository;
        this.activityRepository = activityRepository;
        this.addCustomerLocationUseCase = addCustomerLocationUseCase;
        this.locationRepository = locationRepository;
        this.productDiscountRepository = productDiscountRepository;
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
            if (req.query.status)
                filter.status = req.query.status;
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
            const summaryOnly = req.query.summary === 'true';
            const result = await this.getCustomerDashboardUseCase.execute(id, tenantId, summaryOnly);
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
    async delete(req, res) {
        try {
            const { id } = req.params;
            if (!id || Array.isArray(id)) {
                return res.status(400).json({ error: 'Geçersiz müşteri ID.' });
            }
            await this.customerRepository.delete(id, req.user?.tenantId);
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Müşteri silinemedi.' });
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
                mobilePhone: req.body.mobilePhone,
                notes: req.body.notes,
                isPrimaryContact: req.body.isPrimaryContact
            };
            const result = await this.addCustomerContactUseCase.execute(contactData);
            res.status(201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Yetkili kişi eklenemedi.' });
        }
    }
    async updateContact(req, res) {
        try {
            const contactId = (Array.isArray(req.params.contactId) ? req.params.contactId[0] : req.params.contactId);
            const result = await this.contactRepository.update(contactId, req.body);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Yetkili kişi güncellenemedi.' });
        }
    }
    async deleteContact(req, res) {
        try {
            const contactId = (Array.isArray(req.params.contactId) ? req.params.contactId[0] : req.params.contactId);
            await this.contactRepository.delete(contactId);
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Yetkili kişi silinemedi.' });
        }
    }
    async updateNote(req, res) {
        try {
            const noteId = (Array.isArray(req.params.noteId) ? req.params.noteId[0] : req.params.noteId);
            const result = await this.noteRepository.update(noteId, {
                noteText: req.body.noteText,
                noteType: req.body.noteType,
                isHighlight: req.body.isHighlight ?? req.body.isHighlighted,
            });
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Not güncellenemedi.' });
        }
    }
    async deleteNote(req, res) {
        try {
            const noteId = (Array.isArray(req.params.noteId) ? req.params.noteId[0] : req.params.noteId);
            await this.noteRepository.delete(noteId);
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Not silinemedi.' });
        }
    }
    async addLocation(req, res) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
            const result = await this.addCustomerLocationUseCase.execute({ ...req.body, customerId });
            res.status(201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Standort eklenemedi.' });
        }
    }
    async updateLocation(req, res) {
        try {
            const locationId = (Array.isArray(req.params.locationId) ? req.params.locationId[0] : req.params.locationId);
            const result = await this.locationRepository.update(locationId, req.body);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Standort güncellenemedi.' });
        }
    }
    async deleteLocation(req, res) {
        try {
            const locationId = (Array.isArray(req.params.locationId) ? req.params.locationId[0] : req.params.locationId);
            await this.locationRepository.delete(locationId);
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Standort silinemedi.' });
        }
    }
    async listLocations(req, res) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
            const result = await this.locationRepository.findByCustomerId(customerId);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Standorte konnten nicht geladen werden.' });
        }
    }
    async listProductDiscounts(req, res) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
            const result = await this.productDiscountRepository.findByCustomerId(customerId);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Produktrabatte konnten nicht geladen werden.' });
        }
    }
    async upsertProductDiscount(req, res) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
            const articleId = req.body.articleId;
            const discount = Number(req.body.discount);
            if (!articleId || typeof articleId !== 'string') {
                return res.status(400).json({ error: 'articleId ist erforderlich.' });
            }
            if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
                return res.status(400).json({ error: 'Rabatt muss zwischen 0 und 100 liegen.' });
            }
            const result = await this.productDiscountRepository.upsert({
                tenantId: req.user.tenantId,
                customerId,
                articleId,
                discount,
            });
            res.status(201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Produktrabatt konnte nicht gespeichert werden.' });
        }
    }
    async updateProductDiscount(req, res) {
        try {
            const discountId = (Array.isArray(req.params.discountId) ? req.params.discountId[0] : req.params.discountId);
            const discount = Number(req.body.discount);
            if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
                return res.status(400).json({ error: 'Rabatt muss zwischen 0 und 100 liegen.' });
            }
            const result = await this.productDiscountRepository.updateDiscount(discountId, discount);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Produktrabatt konnte nicht aktualisiert werden.' });
        }
    }
    async deleteProductDiscount(req, res) {
        try {
            const discountId = (Array.isArray(req.params.discountId) ? req.params.discountId[0] : req.params.discountId);
            await this.productDiscountRepository.delete(discountId);
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message || 'Produktrabatt konnte nicht gelöscht werden.' });
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
    async updateActivity(req, res) {
        try {
            const activityId = (Array.isArray(req.params.activityId) ? req.params.activityId[0] : req.params.activityId);
            const payload = {};
            if (req.body.activityType !== undefined)
                payload.activityType = req.body.activityType;
            if (req.body.description !== undefined)
                payload.description = req.body.description;
            if (req.body.activityDate !== undefined)
                payload.activityDate = new Date(req.body.activityDate);
            const result = await this.activityRepository.update(activityId, payload);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message || "Aktivite güncellenemedi." });
        }
    }
    async deleteActivity(req, res) {
        try {
            const activityId = (Array.isArray(req.params.activityId) ? req.params.activityId[0] : req.params.activityId);
            await this.activityRepository.delete(activityId);
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message || "Aktivite silinemedi." });
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