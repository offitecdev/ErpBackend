import { Request, Response } from 'express';
import { CreateInvoiceUseCase } from '../../application/use-cases/billing/CreateInvoiceUseCase';
import { GetBillingSummaryUseCase } from '../../application/use-cases/billing/GetBillingSummaryUseCase';
import { ListInvoicesUseCase } from '../../application/use-cases/billing/ListInvoicesUseCase';
import { UpdateInvoiceStatusUseCase } from '../../application/use-cases/billing/UpdateInvoiceStatusUseCase';
import { InvoiceStatus } from '../../domain/entities/Invoice';

export class BillingController {
    constructor(
        private createInvoiceUseCase: CreateInvoiceUseCase,
        private getSummaryUseCase: GetBillingSummaryUseCase,
        private listInvoicesUseCase: ListInvoicesUseCase,
        private updateStatusUseCase: UpdateInvoiceStatusUseCase
    ) {}

    async getSummary(req: Request, res: Response) {
        try {
            const salesOrderId = req.query.salesOrderId ? String(req.query.salesOrderId) : null;
            const projectId = req.query.projectId ? String(req.query.projectId) : null;
            const summary = await this.getSummaryUseCase.execute({ tenantId: req.user!.tenantId, salesOrderId, projectId });
            res.status(200).json(summary);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async list(req: Request, res: Response) {
        try {
            const invoices = await this.listInvoicesUseCase.execute({
                tenantId: req.user!.tenantId,
                projectId: req.query.projectId ? String(req.query.projectId) : undefined,
                salesOrderId: req.query.salesOrderId ? String(req.query.salesOrderId) : undefined,
                customerId: req.query.customerId ? String(req.query.customerId) : undefined,
                status: req.query.status ? (String(req.query.status) as InvoiceStatus) : undefined,
            });
            res.status(200).json(invoices);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async create(req: Request, res: Response) {
        try {
            const invoice = await this.createInvoiceUseCase.execute({
                tenantId: req.user!.tenantId,
                issuedByEmployeeId: req.user!.id,
                salesOrderId: req.body.salesOrderId,
                projectId: req.body.projectId,
                billingType: req.body.billingType === 'PARTIAL' ? 'PARTIAL' : 'FULL',
                percent: req.body.percent,
                invoiceNumber: req.body.invoiceNumber,
                notes: req.body.notes,
            });
            res.status(201).json({ message: 'Fatura oluşturuldu.', invoice });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateStatus(req: Request, res: Response) {
        try {
            const invoice = await this.updateStatusUseCase.execute(
                req.params.id as string,
                req.user!.tenantId,
                String(req.body.status || '')
            );
            res.status(200).json({ message: 'Fatura durumu güncellendi.', invoice });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
