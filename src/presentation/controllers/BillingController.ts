import { Request, Response } from 'express';
import { CreateInvoiceUseCase } from '../../application/use-cases/billing/CreateInvoiceUseCase';
import { CreateDirectInvoiceUseCase } from '../../application/use-cases/billing/CreateDirectInvoiceUseCase';
import { UpdateDirectInvoiceUseCase } from '../../application/use-cases/billing/UpdateDirectInvoiceUseCase';
import { GetBillingSummaryUseCase } from '../../application/use-cases/billing/GetBillingSummaryUseCase';
import { ListInvoicesUseCase } from '../../application/use-cases/billing/ListInvoicesUseCase';
import { UpdateInvoiceStatusUseCase } from '../../application/use-cases/billing/UpdateInvoiceStatusUseCase';
import { DeleteInvoiceUseCase } from '../../application/use-cases/billing/DeleteInvoiceUseCase';
import { InvoiceCategory, InvoiceStatus } from '../../domain/entities/Invoice';
import { Prisma } from '@prisma/client';
import prisma from '../../infrastructure/database/prisma.client';
import { getArticleThumbnails } from '../../infrastructure/services/PdfImageThumbnailService';
import { peekDocumentNumber } from '../../shared/documentNumber';

const INVOICE_CATEGORIES: InvoiceCategory[] = ['PROJECT', 'DELIVERY', 'DIRECT'];

export class BillingController {
    constructor(
        private createInvoiceUseCase: CreateInvoiceUseCase,
        private getSummaryUseCase: GetBillingSummaryUseCase,
        private listInvoicesUseCase: ListInvoicesUseCase,
        private updateStatusUseCase: UpdateInvoiceStatusUseCase,
        private deleteInvoiceUseCase: DeleteInvoiceUseCase,
        private createDirectInvoiceUseCase: CreateDirectInvoiceUseCase,
        private updateDirectInvoiceUseCase: UpdateDirectInvoiceUseCase
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
     * Die Nummer, die die NÄCHSTE Rechnung bekäme — für die Vorschau der
     * Erfassungsmaske, damit dort nicht «Entwurf» steht (Vorgabe Samet
     * 05.09.2026). Der Zähler wird dabei NICHT bewegt: vergeben wird die Nummer
     * erst beim Erstellen, und wer in derselben Minute eine Rechnung stellt,
     * bekommt sie. Die Vorschau ist eine Auskunft, keine Reservierung.
     */
    async nextInvoiceNumber(req: Request, res: Response) {
        try {
            const invoiceNumber = await peekDocumentNumber(req.user!.tenantId, 'INVOICE');
            res.status(200).json({ invoiceNumber, preview: true });
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
                // Die drei Abschnitte des Belegs (Positionen · Rabatt ·
                // Schlusstext), der Rabattstapel und die eigene Absenderzeile.
                sections: req.body.sections ?? null,
                discounts: req.body.discounts ?? null,
                closingText: req.body.closingText ?? null,
                senderAddress: req.body.senderAddress ?? null,
                paymentStages: req.body.paymentStages ?? null,
            });
            res.status(201).json({ message: 'Rechnung erstellt.', invoice });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * Eine Direktrechnung ändern (Vorgabe Samet 05.09.2026: «für die direkt
     * erzeugten Rechnungen ein Bearbeiten-Knopf»). Der Körper ist derselbe wie
     * beim Erstellen — der Beleg wird als GANZES neu geschrieben; Nummer und
     * Zahlungsstand bleiben, siehe `UpdateDirectInvoiceUseCase`.
     */
    async updateDirect(req: Request, res: Response) {
        try {
            const invoice = await this.updateDirectInvoiceUseCase.execute(String(req.params.id), {
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
                sections: req.body.sections ?? null,
                discounts: req.body.discounts ?? null,
                closingText: req.body.closingText ?? null,
                senderAddress: req.body.senderAddress ?? null,
                paymentStages: req.body.paymentStages ?? null,
            });
            res.status(200).json({ message: 'Rechnung gespeichert.', invoice });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async updateStatus(req: Request, res: Response) {
        try {
            const invoice = await this.updateStatusUseCase.execute(
                req.params.id as string,
                req.user!.tenantId,
                String(req.body.status || ''),
                // Zahlungseingang — die Liste schickt ihn beim Markieren als
                // bezahlt mit; fehlt er, nimmt der Server "jetzt".
                req.body.paidAt ? String(req.body.paidAt) : null
            );
            res.status(200).json({ message: 'Fatura durumu güncellendi.', invoice });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * ── PRODUKTBILDER DER DIREKTRECHNUNG ─────────────────────────────────────
     *
     * Die Rechnung druckt DIESELBE Positionstabelle wie das Angebot, also auch
     * dessen Produktbilder. Die Offerte holt sie über `/tenders/:id/
     * product-images` — eine Direktrechnung hat aber keine Offerte, an der ein
     * solcher Weg hängen könnte. Darum hier derselbe Dienst noch einmal, nur
     * über die ARTIKEL-Kennungen: `getArticleThumbnails` liefert die auf den
     * 36 × 20 mm-Rahmen des PDF verkleinerten Bilder (die Originale reisen
     * nie, siehe PdfImageThumbnailService).
     *
     * Wie dort werden Artikel OHNE Bild gar nicht erst gelesen: sie stehen mit
     * leerer Zeichenkette statt NULL in der Spalte, und ohne den `notIn`-Filter
     * kämen sie als Bildzeilen zurück, die das PDF sofort wegwirft.
     */
    async getProductImages(req: Request, res: Response) {
        try {
            const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
            const ids = [...new Set(
                raw.map((value: unknown) => String(value || '').trim()).filter(Boolean),
            )] as string[];
            if (ids.length === 0) return res.status(200).json([]);

            const tenantId = req.user!.tenantId;
            const articles = await (prisma as any).article.findMany({
                where: { tenantId, id: { in: ids }, imageUrl: { not: null, notIn: [''] } },
                select: { id: true, updatedAt: true },
            });
            res.status(200).json(await getArticleThumbnails(tenantId, articles));
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
