"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BillingController = void 0;
class BillingController {
    createInvoiceUseCase;
    getSummaryUseCase;
    listInvoicesUseCase;
    updateStatusUseCase;
    constructor(createInvoiceUseCase, getSummaryUseCase, listInvoicesUseCase, updateStatusUseCase) {
        this.createInvoiceUseCase = createInvoiceUseCase;
        this.getSummaryUseCase = getSummaryUseCase;
        this.listInvoicesUseCase = listInvoicesUseCase;
        this.updateStatusUseCase = updateStatusUseCase;
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
            const invoices = await this.listInvoicesUseCase.execute({
                tenantId: req.user.tenantId,
                projectId: req.query.projectId ? String(req.query.projectId) : undefined,
                salesOrderId: req.query.salesOrderId ? String(req.query.salesOrderId) : undefined,
                customerId: req.query.customerId ? String(req.query.customerId) : undefined,
                status: req.query.status ? String(req.query.status) : undefined,
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
                percent: req.body.percent,
                invoiceNumber: req.body.invoiceNumber,
                notes: req.body.notes,
            });
            res.status(201).json({ message: 'Fatura oluşturuldu.', invoice });
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
}
exports.BillingController = BillingController;
//# sourceMappingURL=BillingController.js.map