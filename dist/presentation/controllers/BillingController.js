"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BillingController = void 0;
const INVOICE_CATEGORIES = ['PROJECT', 'DELIVERY', 'DIRECT'];
class BillingController {
    createInvoiceUseCase;
    getSummaryUseCase;
    listInvoicesUseCase;
    updateStatusUseCase;
    deleteInvoiceUseCase;
    createDirectInvoiceUseCase;
    constructor(createInvoiceUseCase, getSummaryUseCase, listInvoicesUseCase, updateStatusUseCase, deleteInvoiceUseCase, createDirectInvoiceUseCase) {
        this.createInvoiceUseCase = createInvoiceUseCase;
        this.getSummaryUseCase = getSummaryUseCase;
        this.listInvoicesUseCase = listInvoicesUseCase;
        this.updateStatusUseCase = updateStatusUseCase;
        this.deleteInvoiceUseCase = deleteInvoiceUseCase;
        this.createDirectInvoiceUseCase = createDirectInvoiceUseCase;
    }
    async getSummary(req, res) {
        try {
            const salesOrderId = req.query.salesOrderId ? String(req.query.salesOrderId) : null;
            const projectId = req.query.projectId ? String(req.query.projectId) : null;
            const summary = await this.getSummaryUseCase.execute({ tenantId: req.user.tenantId, salesOrderId, projectId });
            res.status(200).json(summary);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async list(req, res) {
        try {
            // Der Rechnungstyp ist abgeleitet; ein unbekannter Wert wird still
            // fallen gelassen statt die Liste leer zu lassen.
            const rawCategory = req.query.category ? String(req.query.category) : '';
            const category = INVOICE_CATEGORIES.includes(rawCategory)
                ? rawCategory
                : undefined;
            const invoices = await this.listInvoicesUseCase.execute({
                tenantId: req.user.tenantId,
                projectId: req.query.projectId ? String(req.query.projectId) : undefined,
                salesOrderId: req.query.salesOrderId ? String(req.query.salesOrderId) : undefined,
                customerId: req.query.customerId ? String(req.query.customerId) : undefined,
                status: req.query.status ? String(req.query.status) : undefined,
                category,
            });
            res.status(200).json(invoices);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async create(req, res) {
        try {
            const invoice = await this.createInvoiceUseCase.execute({
                tenantId: req.user.tenantId,
                issuedByEmployeeId: req.user.id,
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * Direktrechnung — die selbst ausgefüllte Vorlage: kein Auftrag, kein
     * Projekt, die Positionen sind der Betrag. Die Zeilen kommen so an, wie sie
     * auf dem Beleg stehen; die Reihenfolge ist ihre Reihenfolge im Feld.
     */
    async createDirect(req, res) {
        try {
            const invoice = await this.createDirectInvoiceUseCase.execute({
                tenantId: req.user.tenantId,
                issuedByEmployeeId: req.user.id,
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateStatus(req, res) {
        try {
            const invoice = await this.updateStatusUseCase.execute(req.params.id, req.user.tenantId, String(req.body.status || ''));
            res.status(200).json({ message: 'Fatura durumu güncellendi.', invoice });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async delete(req, res) {
        try {
            await this.deleteInvoiceUseCase.execute(req.params.id, req.user.tenantId);
            res.status(200).json({ message: 'Fatura kalıcı olarak silindi.' });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.BillingController = BillingController;
//# sourceMappingURL=BillingController.js.map