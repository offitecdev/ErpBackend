import { Request, Response } from 'express';
import '../middlewares/AuthMiddleware';
import { CreateCustomerUseCase } from '../../application/use-cases/crm/CreateCustomerUseCase';
import { GetCustomerDashboardUseCase } from '../../application/use-cases/crm/GetCustomerDashboardUseCase';
import { AddCustomerNoteUseCase } from '../../application/use-cases/crm/AddCustomerNoteUseCase';
import { ListCustomersUseCase } from '../../application/use-cases/crm/ListCustomersUseCase';
import { LogCustomerActivityUseCase } from '../../application/use-cases/crm/LogCustomerActivityUseCase';
import { UploadDocumentUseCase } from '../../application/use-cases/crm/UploadDocumentUseCase';
import { AddCustomerContactUseCase } from '../../application/use-cases/crm/AddCustomerContactUseCase';
import { ICustomerRepository } from '../../domain/repositories/ICustomerRepository';
import { ICustomerContactRepository } from '../../domain/repositories/ICustomerContactRepository';

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
        private contactRepository: ICustomerContactRepository
    ) {}

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
            const filter: { tenantId: string; isActive?: boolean; segment?: string; search?: string; page?: number; pageSize?: number } = {
                tenantId: req.user!.tenantId,
            };
            if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';
            if (req.query.segment) filter.segment = req.query.segment as string;
            if (req.query.search) filter.search = req.query.search as string;
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
            const result = await this.getCustomerDashboardUseCase.execute(id, tenantId);
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
            const result = await this.customerRepository.update(id, req.body);
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Müşteri güncellenemedi.' });
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
        } catch (error: any) {
            res.status(400).json({ error: error.message || 'Yetkili kişi eklenemedi.' });
        }
    }

    async logActivity(req: Request, res: Response) {
        try {
            const customerId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
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

    async uploadDocument(req: Request, res: Response) {  
        try {
            const relatedEntityId = (Array.isArray(req.params.id) ? req.params.id[0] : req.params.id) as string;
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
