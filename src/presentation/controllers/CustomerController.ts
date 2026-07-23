import { Request, Response } from 'express';
import '../middlewares/AuthMiddleware';
import prisma from '../../infrastructure/database/prisma.client';
import { CreateCustomerUseCase } from '../../application/use-cases/crm/CreateCustomerUseCase';
import { GetCustomerDashboardUseCase } from '../../application/use-cases/crm/GetCustomerDashboardUseCase';
import { AddCustomerNoteUseCase } from '../../application/use-cases/crm/AddCustomerNoteUseCase';
import { ListCustomersUseCase } from '../../application/use-cases/crm/ListCustomersUseCase';
import { LogCustomerActivityUseCase } from '../../application/use-cases/crm/LogCustomerActivityUseCase';
import { UploadDocumentUseCase } from '../../application/use-cases/crm/UploadDocumentUseCase';
import { AddCustomerContactUseCase } from '../../application/use-cases/crm/AddCustomerContactUseCase';
import { AddCustomerLocationUseCase } from '../../application/use-cases/crm/AddCustomerLocationUseCase';
import { ICustomerRepository } from '../../domain/repositories/ICustomerRepository';
import { ICustomerContactRepository } from '../../domain/repositories/ICustomerContactRepository';
import { ICustomerNoteRepository } from '../../domain/repositories/ICustomerNoteRepository';
import { ICustomerActivityRepository } from '../../domain/repositories/ICustomerActivityRepository';
import { ICustomerLocationRepository } from '../../domain/repositories/ICustomerLocationRepository';
import { CustomerProductDiscountRepository } from '../../infrastructure/repositories/CustomerProductDiscountRepository';

export class CustomerController {
    constructor(
        private createCustomerUseCase: CreateCustomerUseCase,
        private getCustomerDashboardUseCase: GetCustomerDashboardUseCase,
        private addCustomerNoteUseCase: AddCustomerNoteUseCase,
        private listCustomersUseCase: ListCustomersUseCase,
        private logCustomerActivityUseCase: LogCustomerActivityUseCase,
        private uploadDocumentUseCase: UploadDocumentUseCase,
        private addCustomerContactUseCase: AddCustomerContactUseCase,
        private customerRepository: ICustomerRepository,
        private contactRepository: ICustomerContactRepository,
        private noteRepository: ICustomerNoteRepository,
        private activityRepository: ICustomerActivityRepository,
        private addCustomerLocationUseCase: AddCustomerLocationUseCase,
        private locationRepository: ICustomerLocationRepository,
        private productDiscountRepository: CustomerProductDiscountRepository
    ) {}

    /**
     * Ownership guards (anti-IDOR): every by-id operation must resolve to a row
     * inside the caller's tenant. A foreign id behaves exactly like a missing
     * id — the guard fails and the handler answers 404.
     */
    private async customerInTenant(customerId: string, tenantId: string): Promise<boolean> {
        const customer = await prisma.customer.findUnique({
            where: { id: customerId },
            select: { tenantId: true },
        });
        return customer?.tenantId === tenantId;
    }

    /** Child rows (contact/note/activity/location) resolve tenant via their parent customer. */
    private async childInTenant(
        model: 'customerContact' | 'customerNote' | 'customerActivity' | 'customerLocation',
        id: string,
        tenantId: string,
    ): Promise<boolean> {
        const row = await (prisma as any)[model].findUnique({
            where: { id },
            select: { customer: { select: { tenantId: true } } },
        });
        return row?.customer?.tenantId === tenantId;
    }

    private async discountInTenant(discountId: string, tenantId: string): Promise<boolean> {
        const row = await prisma.customerProductDiscount.findUnique({
            where: { id: discountId },
            select: { tenantId: true },
        });
        return row?.tenantId === tenantId;
    }

    async create(req: Request, res: Response) {
        try {
            const customerData = {
                ...req.body,
                tenantId: req.user?.tenantId
            };
            const result = await this.createCustomerUseCase.execute(customerData);
            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Müşteri oluşturulamadı.' });
        }
    }

    async list(req: Request, res: Response) {
        try {
            const filter: {
                tenantId: string; isActive?: boolean; segment?: string; status?: string; search?: string;
                companyName?: string; vatNumber?: string; email?: string;
                sortBy?: 'companyName' | 'vatNumber' | 'status'; sortDirection?: 'asc' | 'desc';
                page?: number; pageSize?: number;
            } = {
                tenantId: req.user!.tenantId,
            };
            if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';
            if (req.query.segment) filter.segment = req.query.segment as string;
            if (req.query.status) filter.status = req.query.status as string;
            if (req.query.search) filter.search = req.query.search as string;
            // Kolon bazlı filtreler + sıralama (Teklifler/Ürünler listesindeki desenle aynı).
            if (req.query.companyName) filter.companyName = req.query.companyName as string;
            if (req.query.vatNumber) filter.vatNumber = req.query.vatNumber as string;
            if (req.query.email) filter.email = req.query.email as string;
            if (req.query.sortBy === 'companyName' || req.query.sortBy === 'vatNumber' || req.query.sortBy === 'status') filter.sortBy = req.query.sortBy;
            if (req.query.sortDirection) filter.sortDirection = req.query.sortDirection === 'asc' ? 'asc' : 'desc';
            if (req.query.page) filter.page = Math.max(1, Number(req.query.page) || 1);
            if (req.query.pageSize) filter.pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

            const result = await this.listCustomersUseCase.execute(filter);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getDashboard(req: Request, res: Response) {
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
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Dashboard yüklenemedi.' });
        }
    }

    async update(req: Request, res: Response) {
        try {
            const { id } = req.params;
            if (!id || Array.isArray(id)) {
                return res.status(400).json({ error: 'Geçersiz müşteri ID.' });
            }
            if (!(await this.customerInTenant(id, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }
            const result = await this.customerRepository.update(id, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Müşteri güncellenemedi.' });
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const { id } = req.params;
            if (!id || Array.isArray(id)) {
                return res.status(400).json({ error: 'Geçersiz müşteri ID.' });
            }
            await this.customerRepository.delete(id, req.user?.tenantId);
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Müşteri silinemedi.' });
        }
    }

    async addNote(req: Request, res: Response) {
        try {
            const { id } = req.params;
            const employeeId = req.user?.id;

            if (!id || Array.isArray(id)) {
                return res.status(400).json({ error: 'Geçersiz müşteri ID.' });
            }

            if (!employeeId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }

            if (!(await this.customerInTenant(id, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Müşteri bulunamadı.' });
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
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Not eklenemedi.' });
        }
    }

    async addContact(req: Request, res: Response) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;

            if (!(await this.customerInTenant(customerId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }

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
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Yetkili kişi eklenemedi.' });
        }
    }

    async updateContact(req: Request, res: Response) {
        try {
            const contactId = (Array.isArray(req.params.contactId) ? req.params.contactId[0] : req.params.contactId) as string;
            if (!(await this.childInTenant('customerContact', contactId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Kayıt bulunamadı.' });
            }
            const result = await this.contactRepository.update(contactId, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Yetkili kişi güncellenemedi.' });
        }
    }

    async deleteContact(req: Request, res: Response) {
        try {
            const contactId = (Array.isArray(req.params.contactId) ? req.params.contactId[0] : req.params.contactId) as string;
            if (!(await this.childInTenant('customerContact', contactId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Kayıt bulunamadı.' });
            }
            await this.contactRepository.delete(contactId);
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Yetkili kişi silinemedi.' });
        }
    }

    async updateNote(req: Request, res: Response) {
        try {
            const noteId = (Array.isArray(req.params.noteId) ? req.params.noteId[0] : req.params.noteId) as string;
            if (!(await this.childInTenant('customerNote', noteId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Kayıt bulunamadı.' });
            }
            const result = await this.noteRepository.update(noteId, {
                noteText: req.body.noteText,
                noteType: req.body.noteType,
                isHighlight: req.body.isHighlight ?? req.body.isHighlighted,
            });
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Not güncellenemedi.' });
        }
    }

    async deleteNote(req: Request, res: Response) {
        try {
            const noteId = (Array.isArray(req.params.noteId) ? req.params.noteId[0] : req.params.noteId) as string;
            if (!(await this.childInTenant('customerNote', noteId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Kayıt bulunamadı.' });
            }
            await this.noteRepository.delete(noteId);
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Not silinemedi.' });
        }
    }

    async addLocation(req: Request, res: Response) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
            if (!(await this.customerInTenant(customerId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }
            const result = await this.addCustomerLocationUseCase.execute({ ...req.body, customerId });
            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Standort eklenemedi.' });
        }
    }

    async updateLocation(req: Request, res: Response) {
        try {
            const locationId = (Array.isArray(req.params.locationId) ? req.params.locationId[0] : req.params.locationId) as string;
            if (!(await this.childInTenant('customerLocation', locationId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Kayıt bulunamadı.' });
            }
            const result = await this.locationRepository.update(locationId, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Standort güncellenemedi.' });
        }
    }

    async deleteLocation(req: Request, res: Response) {
        try {
            const locationId = (Array.isArray(req.params.locationId) ? req.params.locationId[0] : req.params.locationId) as string;
            if (!(await this.childInTenant('customerLocation', locationId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Kayıt bulunamadı.' });
            }
            await this.locationRepository.delete(locationId);
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Standort silinemedi.' });
        }
    }

    async listLocations(req: Request, res: Response) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
            if (!(await this.customerInTenant(customerId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }
            const result = await this.locationRepository.findByCustomerId(customerId);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Standorte konnten nicht geladen werden.' });
        }
    }

    async listProductDiscounts(req: Request, res: Response) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
            if (!(await this.customerInTenant(customerId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }
            const result = await this.productDiscountRepository.findByCustomerId(customerId);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Produktrabatte konnten nicht geladen werden.' });
        }
    }

    async upsertProductDiscount(req: Request, res: Response) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
            const articleId = req.body.articleId as string;
            const discount = Number(req.body.discount);
            if (!articleId || typeof articleId !== 'string') {
                return res.status(400).json({ error: 'articleId ist erforderlich.' });
            }
            if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
                return res.status(400).json({ error: 'Rabatt muss zwischen 0 und 100 liegen.' });
            }
            if (!(await this.customerInTenant(customerId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }
            const result = await this.productDiscountRepository.upsert({
                tenantId: req.user!.tenantId,
                customerId,
                articleId,
                discount,
            });
            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Produktrabatt konnte nicht gespeichert werden.' });
        }
    }

    async updateProductDiscount(req: Request, res: Response) {
        try {
            const discountId = (Array.isArray(req.params.discountId) ? req.params.discountId[0] : req.params.discountId) as string;
            const discount = Number(req.body.discount);
            if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
                return res.status(400).json({ error: 'Rabatt muss zwischen 0 und 100 liegen.' });
            }
            if (!(await this.discountInTenant(discountId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Kayıt bulunamadı.' });
            }
            const result = await this.productDiscountRepository.updateDiscount(discountId, discount);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Produktrabatt konnte nicht aktualisiert werden.' });
        }
    }

    async deleteProductDiscount(req: Request, res: Response) {
        try {
            const discountId = (Array.isArray(req.params.discountId) ? req.params.discountId[0] : req.params.discountId) as string;
            if (!(await this.discountInTenant(discountId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Kayıt bulunamadı.' });
            }
            await this.productDiscountRepository.delete(discountId);
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Produktrabatt konnte nicht gelöscht werden.' });
        }
    }

    async logActivity(req: Request, res: Response) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
            if (!(await this.customerInTenant(customerId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }
            const activityData: { customerId: string; employeeId: string; activityType: string; description?: string; referenceId?: string; activityDate?: Date } = {
                customerId,
                employeeId: req.user!.id,
                activityType: req.body.activityType as string,
                activityDate: req.body.activityDate ? new Date(req.body.activityDate) : new Date()
            };
            if (req.body.description) activityData.description = req.body.description as string;
            if (req.body.referenceId) activityData.referenceId = req.body.referenceId as string;

            const result = await this.logCustomerActivityUseCase.execute(activityData);
            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || "Aktivite kaydedilemedi." });
        }
    }

    async updateActivity(req: Request, res: Response) {
        try {
            const activityId = (Array.isArray(req.params.activityId) ? req.params.activityId[0] : req.params.activityId) as string;
            if (!(await this.childInTenant('customerActivity', activityId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Kayıt bulunamadı.' });
            }
            const payload: { activityType?: string; description?: string; activityDate?: Date } = {};
            if (req.body.activityType !== undefined) payload.activityType = req.body.activityType;
            if (req.body.description !== undefined) payload.description = req.body.description;
            if (req.body.activityDate !== undefined) payload.activityDate = new Date(req.body.activityDate);
            const result = await this.activityRepository.update(activityId, payload);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || "Aktivite güncellenemedi." });
        }
    }

    async deleteActivity(req: Request, res: Response) {
        try {
            const activityId = (Array.isArray(req.params.activityId) ? req.params.activityId[0] : req.params.activityId) as string;
            if (!(await this.childInTenant('customerActivity', activityId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Kayıt bulunamadı.' });
            }
            await this.activityRepository.delete(activityId);
            res.status(204).send();
        } catch (error: any) {
            res.status(400).json({ error: error.message || "Aktivite silinemedi." });
        }
    }

    async uploadDocument(req: Request, res: Response) {
        try {
            const relatedEntityId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
            if (!(await this.customerInTenant(relatedEntityId, req.user!.tenantId))) {
                return res.status(404).json({ error: 'Müşteri bulunamadı.' });
            }
            const documentData: { tenantId: string; relatedEntityId: string; entityType: string; fileUrl: string; uploadedByEmployeeId: string; fileName?: string; fileType?: string; category?: string } = {
                tenantId: req.user!.tenantId,
                relatedEntityId,
                entityType: 'customer',
                fileUrl: req.body.fileUrl as string,
                uploadedByEmployeeId: req.user!.id
            };
            if (req.body.fileName) documentData.fileName = req.body.fileName as string;
            if (req.body.fileType) documentData.fileType = req.body.fileType as string;
            if (req.body.category) documentData.category = req.body.category as string;

            const result = await this.uploadDocumentUseCase.execute(documentData);
            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || "Doküman yüklenemedi." });
        }
    }
}
