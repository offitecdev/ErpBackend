import { Request, Response } from 'express';
import { CreateInvoiceUseCase } from '../../application/use-cases/billing/CreateInvoiceUseCase';
import { CreateDirectInvoiceUseCase } from '../../application/use-cases/billing/CreateDirectInvoiceUseCase';
import { GetBillingSummaryUseCase } from '../../application/use-cases/billing/GetBillingSummaryUseCase';
import { ListInvoicesUseCase } from '../../application/use-cases/billing/ListInvoicesUseCase';
import { UpdateInvoiceStatusUseCase } from '../../application/use-cases/billing/UpdateInvoiceStatusUseCase';
import { DeleteInvoiceUseCase } from '../../application/use-cases/billing/DeleteInvoiceUseCase';
import { InvoiceCategory, InvoiceStatus } from '../../domain/entities/Invoice';
import { Prisma } from '@prisma/client';
import prisma from '../../infrastructure/database/prisma.client';

const INVOICE_CATEGORIES: InvoiceCategory[] = ['PROJECT', 'DELIVERY', 'DIRECT'];

export class BillingController {
    constructor(
        private createInvoiceUseCase: CreateInvoiceUseCase,
        private getSummaryUseCase: GetBillingSummaryUseCase,
        private listInvoicesUseCase: ListInvoicesUseCase,
        private updateStatusUseCase: UpdateInvoiceStatusUseCase,
        private deleteInvoiceUseCase: DeleteInvoiceUseCase,
        private createDirectInvoiceUseCase: CreateDirectInvoiceUseCase
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
            // The project table needs only billing progress, not invoice rows,
            // line items, customer/order labels or PDF metadata. Aggregate active
            // percentages in one statement so this view never executes the full
            // two-query invoice-list path.
            if (String(req.query.view || '') === 'project-list') {
                const rows = await prisma.$queryRaw<Array<{
                    projectId: string | null;
                    salesOrderId: string | null;
                    billedPercent: number | string | null;
                }>>(Prisma.sql`
                    SELECT i.projectId, i.salesOrderId, SUM(i.billedPercent) AS billedPercent
                    FROM Invoice i
                    WHERE i.tenantId = ${req.user!.tenantId}
                      AND i.status <> 'CANCELLED'
                      AND (i.projectId IS NOT NULL OR i.salesOrderId IS NOT NULL)
                    GROUP BY i.projectId, i.salesOrderId
                `);
                return res.status(200).json(rows.map((row) => ({
                    projectId: row.projectId ?? null,
                    salesOrderId: row.salesOrderId ?? null,
                    billedPercent: Number(row.billedPercent || 0),
                    status: 'ISSUED',
                })));
            }

            // Der Rechnungstyp ist abgeleitet; ein unbekannter Wert wird still
            // fallen gelassen statt die Liste leer zu lassen.
            const rawCategory = req.query.category ? String(req.query.category) : '';
            const category = INVOICE_CATEGORIES.includes(rawCategory as InvoiceCategory)
                ? (rawCategory as InvoiceCategory)
                : undefined;
            const invoices = await this.listInvoicesUseCase.execute({
                tenantId: req.user!.tenantId,
                projectId: req.query.projectId ? String(req.query.projectId) : undefined,
                salesOrderId: req.query.salesOrderId ? String(req.query.salesOrderId) : undefined,
                customerId: req.query.customerId ? String(req.query.customerId) : undefined,
                status: req.query.status ? (String(req.query.status) as InvoiceStatus) : undefined,
                category,
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
                kind: req.body.kind ?? null,
                percent: req.body.percent,
                invoiceDate: req.body.invoiceDate ?? null,
                dueDate: req.body.dueDate ?? null,
                salespersonName: req.body.salespersonName ?? null,
                commissionNumber: req.body.commissionNumber ?? null,
                // Fatura kodu sunucuda üretilir (RE-2026-10001); gövdeden gelen
                // `invoiceNumber` artık kabul edilmiyor.
                notes: req.body.notes,
            });
            res.status(201).json({ message: 'Fatura oluşturuldu.', invoice });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * Direktrechnung — die selbst ausgefüllte Vorlage: kein Auftrag, kein
     * Projekt, die Positionen sind der Betrag. Die Zeilen kommen so an, wie sie
     * auf dem Beleg stehen; die Reihenfolge ist ihre Reihenfolge im Feld.
     */
    async createDirect(req: Request, res: Response) {
        try {
            const invoice = await this.createDirectInvoiceUseCase.execute({
                tenantId: req.user!.tenantId,
                issuedByEmployeeId: req.user!.id,
                customerId: req.body.customerId ?? null,
                recipientName: String(req.body.recipientName || ''),
                recipientAddress: req.body.recipientAddress ?? null,
                introText: req.body.introText ?? null,
                invoiceDate: req.body.invoiceDate ?? null,
                dueDate: req.body.dueDate ?? null,
                salespersonName: req.body.salespersonName ?? null,
                commissionNumber: req.body.commissionNumber ?? null,
                vatRate: req.body.vatRate ?? null,
                notes: req.body.notes ?? null,
                lines: Array.isArray(req.body.lines) ? req.body.lines : [],
            });
            res.status(201).json({ message: 'Rechnung erstellt.', invoice });
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

    async delete(req: Request, res: Response) {
        try {
            await this.deleteInvoiceUseCase.execute(req.params.id as string, req.user!.tenantId);
            res.status(200).json({ message: 'Fatura kalıcı olarak silindi.' });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
