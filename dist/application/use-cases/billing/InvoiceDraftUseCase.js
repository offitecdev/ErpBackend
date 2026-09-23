"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoiceDraftUseCase = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const documentNumber_1 = require("../../../shared/documentNumber");
const documentGovernance_1 = require("../../../shared/documentGovernance");
const invoiceErrors_1 = require("./invoiceErrors");
const CLOSING_KINDS = new Set(['RECHNUNG', 'SCHLUSS']);
const dayOf = (value) => {
    if (!value)
        return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};
class InvoiceDraftUseCase {
    invoiceRepository;
    createInvoice;
    constructor(invoiceRepository, createInvoice) {
        this.invoiceRepository = invoiceRepository;
        this.createInvoice = createInvoice;
    }
    async loadDraft(id, tenantId) {
        const invoice = await this.invoiceRepository.findById(id, tenantId);
        if (!invoice)
            throw (0, invoiceErrors_1.invoiceError)('NOT_FOUND', 'Rechnung nicht gefunden.', { status: 404 });
        if (invoice.status !== 'DRAFT') {
            throw (0, invoiceErrors_1.invoiceError)('NOT_DRAFT', 'Diese Rechnung ist bereits ausgestellt.', { status: 409 });
        }
        return invoice;
    }
    /**
     * Den Entwurf einer AUFTRAGSrechnung neu rechnen — Prozentsatz, Daten,
     * Verkäufer, Notiz. `percent` fehlt = der offene Rest (Schluss/Rechnung).
     */
    async updateOrderDraft(id, tenantId, input) {
        const draft = await this.loadDraft(id, tenantId);
        if (!draft.salesOrderId && !draft.projectId) {
            throw (0, invoiceErrors_1.invoiceError)('DIRECT_ONLY', 'Eine Direktrechnung wird in ihrer eigenen Maske geändert.', { status: 409 });
        }
        const { data, lineItems } = await this.createInvoice.build({
            tenantId,
            issuedByEmployeeId: draft.issuedByEmployeeId,
            salesOrderId: draft.salesOrderId ?? null,
            projectId: draft.salesOrderId ? null : (draft.projectId ?? null),
            percent: input.percent ?? null,
            invoiceDate: input.invoiceDate ?? null,
            dueDate: input.dueDate ?? null,
            salespersonName: input.salespersonName ?? null,
            commissionNumber: input.commissionNumber ?? null,
            notes: input.notes ?? null,
        });
        return this.invoiceRepository.updateWithItems(id, { ...data, invoiceNumber: '', status: 'DRAFT' }, lineItems);
    }
    /** Ausstellen: Nummer ziehen, Status «offen», Verlauf schreiben. */
    async issue(id, tenantId, actor) {
        const draft = await this.loadDraft(id, tenantId);
        let issued;
        if (draft.salesOrderId || draft.projectId) {
            // Mit dem Stand von JETZT rechnen. Eine abschliessende Rechnung
            // nimmt den dann offenen Rest, eine Teilrechnung ihren Prozentsatz.
            const closes = CLOSING_KINDS.has(String(draft.kind));
            const { data, lineItems } = await this.createInvoice.build({
                tenantId,
                issuedByEmployeeId: actor.employeeId,
                salesOrderId: draft.salesOrderId ?? null,
                projectId: draft.salesOrderId ? null : (draft.projectId ?? null),
                billingType: closes ? 'FULL' : 'PARTIAL',
                percent: closes ? null : Number(draft.billedPercent),
                invoiceDate: dayOf(draft.invoiceDate) ?? dayOf(new Date()),
                dueDate: dayOf(draft.dueDate),
                salespersonName: draft.salespersonName ?? null,
                commissionNumber: draft.commissionNumber ?? null,
                notes: draft.notes ?? null,
            });
            const invoiceNumber = await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'INVOICE');
            issued = await this.invoiceRepository.updateWithItems(id, { ...data, invoiceNumber, status: 'ISSUED', issuedByEmployeeId: actor.employeeId }, lineItems);
        }
        else {
            const invoiceNumber = await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'INVOICE');
            // Nur ein noch offener Entwurf wird ausgestellt — zweimal
            // gleichzeitig «Ausstellen» zieht keine zweite Nummer durch.
            const claimed = await prisma_client_1.default.invoice.updateMany({
                where: { id, tenantId, status: 'DRAFT' },
                data: {
                    invoiceNumber,
                    status: 'ISSUED',
                    issuedByEmployeeId: actor.employeeId,
                    invoiceDate: draft.invoiceDate ?? new Date(),
                    dueDate: draft.dueDate ?? draft.invoiceDate ?? new Date(),
                },
            });
            if (!claimed.count)
                throw (0, invoiceErrors_1.invoiceError)('NOT_DRAFT', 'Diese Rechnung ist bereits ausgestellt.', { status: 409 });
            issued = (await this.invoiceRepository.findById(id, tenantId));
        }
        await (0, documentGovernance_1.recordDocumentEvent)(prisma_client_1.default, {
            tenantId,
            entityType: 'INVOICE',
            entityId: id,
            documentNumber: issued.invoiceNumber,
            action: 'ISSUED',
            actorId: actor.employeeId,
            snapshot: {
                kind: issued.kind,
                percent: Number(issued.billedPercent || 0),
                amount: Number(issued.amount || 0),
                invoiceDate: issued.invoiceDate ?? null,
                dueDate: issued.dueDate ?? null,
            },
            links: { projectId: issued.projectId ?? null, salesOrderId: issued.salesOrderId ?? null },
            ipAddress: actor.ip ?? null,
        }).catch((error) => console.error('[InvoiceDraft] Verlauf nicht geschrieben:', error?.message || error));
        return issued;
    }
    /** Einen Entwurf verwerfen. Eine ausgestellte Rechnung bleibt IMMER stehen. */
    async discard(id, tenantId, actor) {
        const draft = await this.loadDraft(id, tenantId);
        const removed = await this.invoiceRepository.deleteDraft(id, tenantId);
        if (!removed)
            throw (0, invoiceErrors_1.invoiceError)('NOT_DRAFT', 'Diese Rechnung ist bereits ausgestellt.', { status: 409 });
        await (0, documentGovernance_1.recordDocumentEvent)(prisma_client_1.default, {
            tenantId,
            entityType: 'INVOICE',
            entityId: id,
            documentNumber: null,
            action: 'DRAFT_DISCARDED',
            actorId: actor.employeeId,
            snapshot: { kind: draft.kind, amount: Number(draft.amount || 0) },
            links: { projectId: draft.projectId ?? null, salesOrderId: draft.salesOrderId ?? null },
            ipAddress: actor.ip ?? null,
        }).catch((error) => console.error('[InvoiceDraft] Verlauf nicht geschrieben:', error?.message || error));
    }
}
exports.InvoiceDraftUseCase = InvoiceDraftUseCase;
//# sourceMappingURL=InvoiceDraftUseCase.js.map