"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoiceCreditUseCase = exports.creditInvoiceWithin = exports.stornoInvoiceWithin = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const documentNumber_1 = require("../../../shared/documentNumber");
const documentLifecycle_1 = require("../../../shared/documentLifecycle");
const documentGovernance_1 = require("../../../shared/documentGovernance");
const invoiceDrafts_1 = require("../../../shared/invoiceDrafts");
const invoiceErrors_1 = require("./invoiceErrors");
const invoicePayments_1 = require("../../../shared/invoicePayments");
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const REASON_MIN = 3;
const REASON_MAX = 1000;
const cleanReason = (raw) => {
    const reason = String(raw ?? '').trim().slice(0, REASON_MAX);
    if (reason.length < REASON_MIN) {
        throw (0, invoiceErrors_1.invoiceError)('CREDIT_REASON_REQUIRED', 'Bitte einen Grund angeben.', { params: { min: REASON_MIN } });
    }
    return reason;
};
const loadInvoice = async (tx, id, tenantId) => {
    const invoice = await tx.invoice.findFirst({
        where: { id, tenantId },
        include: { lineItems: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!invoice)
        throw (0, invoiceErrors_1.invoiceError)('NOT_FOUND', 'Rechnung nicht gefunden.', { status: 404 });
    return invoice;
};
/** Was der Gegenbeleg vom Original übernimmt — Empfänger, Bezug, Steuer. */
const inheritedFields = (original) => ({
    tenantId: original.tenantId,
    customerId: original.customerId ?? null,
    projectId: original.projectId ?? null,
    salesOrderId: original.salesOrderId ?? null,
    billingType: 'FULL',
    salespersonName: original.salespersonName ?? null,
    commissionNumber: original.commissionNumber ?? null,
    recipientName: original.recipientName ?? null,
    recipientAddress: original.recipientAddress ?? null,
    vatRate: original.vatRate ?? null,
    senderAddress: original.senderAddress ?? null,
    baseAmount: Number(original.baseAmount || 0),
    reversesInvoiceId: original.id,
});
const today = () => new Date();
/**
 * STORNO einer offenen Rechnung — IMMER in einer Transaktion aufrufen.
 * Die Zeilen der Rechnung kommen mit umgekehrtem Vorzeichen auf den Beleg.
 */
const stornoInvoiceWithin = async (tx, opts) => {
    const { invoiceId, tenantId, actor } = opts;
    const reason = cleanReason(opts.reason);
    const original = await loadInvoice(tx, invoiceId, tenantId);
    const lifecycle = await (0, documentLifecycle_1.readInvoiceLifecycle)(tx, original);
    if (!lifecycle.canCancel) {
        if (lifecycle.cancelBlockers.includes('INVOICE_PAID')) {
            throw (0, invoiceErrors_1.invoiceError)('PAID_NOT_CANCELLABLE', 'Auf dieser Rechnung sind Zahlungen oder Gutschriften erfasst — stellen Sie eine Gutschrift aus.', { status: 409 });
        }
        if (lifecycle.isDraft) {
            throw (0, invoiceErrors_1.invoiceError)('DRAFT_NOT_ISSUED', 'Ein Entwurf wird verworfen, nicht storniert.', { status: 409 });
        }
        if (lifecycle.isCreditDocument) {
            throw (0, invoiceErrors_1.invoiceError)('CREDIT_DOCUMENT_FINAL', 'Ein Gegenbeleg wird nicht storniert.', { status: 409 });
        }
        throw (0, invoiceErrors_1.invoiceError)('CANCELLED_STAYS', 'Diese Rechnung ist bereits storniert.', { status: 409 });
    }
    // Zuerst die Rechnung beanspruchen: zweimal gleichzeitig «Stornieren»
    // stellt so nie zwei Stornobelege aus.
    const claimed = await tx.invoice.updateMany({
        where: { id: invoiceId, tenantId, status: 'ISSUED' },
        data: { status: 'CANCELLED', paidAt: null },
    });
    if (!claimed.count)
        throw (0, invoiceErrors_1.invoiceError)('CANCELLED_STAYS', 'Diese Rechnung ist bereits storniert.', { status: 409 });
    const invoiceNumber = await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'INVOICE', tx);
    const id = (0, nanoid_1.nanoid)(8);
    const amount = -round2(Number(original.amount || 0));
    await tx.invoice.create({
        data: {
            ...inheritedFields(original),
            id,
            invoiceNumber,
            kind: invoiceDrafts_1.STORNO_KIND,
            status: 'ISSUED',
            billedPercent: -Number(original.billedPercent || 0),
            amount,
            invoiceDate: today(),
            dueDate: today(),
            creditReason: reason,
            issuedByEmployeeId: actor.employeeId,
        },
    });
    const lines = (original.lineItems || []);
    if (lines.length) {
        await tx.invoiceLineItem.createMany({
            data: lines.map((line, index) => ({
                id: (0, nanoid_1.nanoid)(12),
                invoiceId: id,
                description: line.description,
                longDescription: line.longDescription ?? null,
                sourceType: line.sourceType,
                sourceId: line.sourceId ?? null,
                quantity: Number(line.quantity || 0),
                unitAmount: -Number(line.unitAmount || 0),
                lineTotal: -Number(line.lineTotal || 0),
                unit: line.unit ?? null,
                sortOrder: index,
            })),
        });
    }
    const links = { projectId: original.projectId ?? null, salesOrderId: original.salesOrderId ?? null };
    await (0, documentGovernance_1.recordDocumentEvent)(tx, {
        tenantId,
        entityType: 'INVOICE',
        entityId: original.id,
        documentNumber: original.invoiceNumber,
        action: 'CANCELLED',
        actorId: actor.employeeId,
        reason,
        snapshot: { amount: Number(original.amount || 0), stornoInvoiceId: id, stornoNumber: invoiceNumber },
        links,
        ipAddress: actor.ip ?? null,
    });
    await (0, documentGovernance_1.recordDocumentEvent)(tx, {
        tenantId,
        entityType: 'INVOICE',
        entityId: id,
        documentNumber: invoiceNumber,
        action: 'CREDIT_ISSUED',
        actorId: actor.employeeId,
        reason,
        snapshot: { kind: invoiceDrafts_1.STORNO_KIND, amount, reverses: original.invoiceNumber },
        links,
        ipAddress: actor.ip ?? null,
    });
    return { id, invoiceNumber, kind: invoiceDrafts_1.STORNO_KIND, amount, reversesInvoiceId: original.id, reversesNumber: original.invoiceNumber };
};
exports.stornoInvoiceWithin = stornoInvoiceWithin;
/**
 * GUTSCHRIFT zu einer bezahlten Rechnung — IMMER in einer Transaktion.
 * `amount` ist positiv (was zurückgegeben wird); fehlt er, der ganze Rest.
 */
const creditInvoiceWithin = async (tx, opts) => {
    const { invoiceId, tenantId, actor } = opts;
    const reason = cleanReason(opts.reason);
    const original = await loadInvoice(tx, invoiceId, tenantId);
    const lifecycle = await (0, documentLifecycle_1.readInvoiceLifecycle)(tx, original);
    if (!lifecycle.canCredit) {
        const blocker = lifecycle.creditBlockers[0];
        if (blocker === 'INVOICE_DRAFT' || blocker === 'INVOICE_CANCELLED') {
            throw (0, invoiceErrors_1.invoiceError)('CREDIT_NEEDS_PAID', 'Zu dieser Rechnung ist keine Gutschrift möglich.', { status: 409 });
        }
        if (blocker === 'FULLY_CREDITED') {
            throw (0, invoiceErrors_1.invoiceError)('FULLY_CREDITED', 'Diese Rechnung ist bereits vollständig gutgeschrieben.', { status: 409 });
        }
        if (blocker === 'CREDIT_DOCUMENT') {
            throw (0, invoiceErrors_1.invoiceError)('CREDIT_DOCUMENT_FINAL', 'Zu einem Gegenbeleg gibt es keine Gutschrift.', { status: 409 });
        }
        throw (0, invoiceErrors_1.invoiceError)('CREDIT_NEEDS_PAID', 'Zu dieser Rechnung ist keine Gutschrift möglich.', { status: 409 });
    }
    const creditable = lifecycle.creditableAmount;
    const requested = opts.amount == null ? creditable : round2(Number(opts.amount));
    if (!Number.isFinite(requested) || requested <= 0) {
        throw (0, invoiceErrors_1.invoiceError)('CREDIT_AMOUNT_INVALID', 'Der Betrag der Gutschrift muss grösser als 0 sein.');
    }
    if (requested > creditable + 0.005) {
        throw (0, invoiceErrors_1.invoiceError)('CREDIT_AMOUNT_TOO_HIGH', `Höchstens ${creditable.toFixed(2)} kann gutgeschrieben werden.`, {
            status: 409,
            params: { max: creditable.toFixed(2) },
        });
    }
    const amount = round2(requested);
    const fullAmount = round2(Number(original.amount || 0));
    const isFull = lifecycle.creditedAmount <= 0.005 && Math.abs(amount - fullAmount) <= 0.005;
    const share = fullAmount !== 0 ? amount / fullAmount : 0;
    const invoiceNumber = await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'INVOICE', tx);
    const id = (0, nanoid_1.nanoid)(8);
    const due = today();
    due.setDate(due.getDate() + 30);
    await tx.invoice.create({
        data: {
            ...inheritedFields(original),
            id,
            invoiceNumber,
            kind: invoiceDrafts_1.CREDIT_KIND,
            // Offen = die Rückzahlung steht noch aus.
            status: 'ISSUED',
            billedPercent: -round2(Number(original.billedPercent || 0) * share),
            amount: -amount,
            invoiceDate: today(),
            dueDate: due,
            creditReason: reason,
            issuedByEmployeeId: actor.employeeId,
        },
    });
    const lines = (original.lineItems || []);
    const direct = !original.salesOrderId && !original.projectId;
    if (isFull && lines.length) {
        await tx.invoiceLineItem.createMany({
            data: lines.map((line, index) => ({
                id: (0, nanoid_1.nanoid)(12),
                invoiceId: id,
                description: line.description,
                longDescription: line.longDescription ?? null,
                sourceType: line.sourceType,
                sourceId: line.sourceId ?? null,
                quantity: Number(line.quantity || 0),
                unitAmount: -Number(line.unitAmount || 0),
                lineTotal: -Number(line.lineTotal || 0),
                unit: line.unit ?? null,
                sortOrder: index,
            })),
        });
    }
    else {
        // Teilgutschrift: EINE Zeile. Auftragsrechnungen führen Bruttozeilen,
        // die Direktrechnung Nettozeilen (die Steuer kommt im Summenblock).
        const vat = Number(original.vatRate || 0);
        const lineAmount = direct && vat > 0 ? round2(amount / (1 + vat / 100)) : amount;
        await tx.invoiceLineItem.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                invoiceId: id,
                description: `Gutschrift zu Rechnung ${original.invoiceNumber}`,
                longDescription: reason,
                sourceType: original.salesOrderId ? 'ORDER' : 'MANUAL',
                sourceId: original.salesOrderId ?? null,
                quantity: 1,
                unitAmount: -lineAmount,
                lineTotal: -lineAmount,
                unit: 'Pau.',
                sortOrder: 0,
            },
        });
    }
    // Was noch offen war, wird VERRECHNET (kein Geldfluss); nur der Rest ist
    // eine echte Rückzahlung an den Kunden.
    const offset = Math.min(amount, lifecycle.openAmount);
    const refundAmount = round2(amount - offset);
    const now = today();
    if (offset > 0.005) {
        await tx.invoicePayment.create({
            data: {
                id: `pm${(0, nanoid_1.nanoid)(16)}`,
                tenantId,
                invoiceId: id,
                amount: -round2(offset),
                kind: invoicePayments_1.OFFSET_KIND,
                paidAt: now,
                note: `Verrechnet mit ${original.invoiceNumber}`,
                createdById: actor.employeeId,
            },
        });
    }
    if (refundAmount <= 0.005) {
        await tx.invoice.update({ where: { id }, data: { status: 'PAID', paidAt: now } });
    }
    // Die Rechnung selbst: ist sie jetzt ausgeglichen?
    await (0, invoicePayments_1.settleInvoiceStatusWithin)(tx, { ...original, status: original.status }, now);
    await (0, documentGovernance_1.recordDocumentEvent)(tx, {
        tenantId,
        entityType: 'INVOICE',
        entityId: id,
        documentNumber: invoiceNumber,
        action: 'CREDIT_ISSUED',
        actorId: actor.employeeId,
        reason,
        snapshot: { kind: invoiceDrafts_1.CREDIT_KIND, amount: -amount, reverses: original.invoiceNumber, full: isFull, offset: round2(offset), refund: refundAmount },
        links: { projectId: original.projectId ?? null, salesOrderId: original.salesOrderId ?? null },
        ipAddress: actor.ip ?? null,
    });
    return {
        id, invoiceNumber, kind: invoiceDrafts_1.CREDIT_KIND, amount: -amount,
        reversesInvoiceId: original.id, reversesNumber: original.invoiceNumber, refundAmount,
    };
};
exports.creditInvoiceWithin = creditInvoiceWithin;
/** Einzelaufrufe aus der Buchhaltung — je eine eigene Transaktion. */
class InvoiceCreditUseCase {
    storno(invoiceId, tenantId, reason, actor) {
        return prisma_client_1.default.$transaction((tx) => (0, exports.stornoInvoiceWithin)(tx, { invoiceId, tenantId, reason, actor }), { timeout: 30000 });
    }
    credit(invoiceId, tenantId, amount, reason, actor) {
        return prisma_client_1.default.$transaction((tx) => (0, exports.creditInvoiceWithin)(tx, { invoiceId, tenantId, amount, reason, actor }), { timeout: 30000 });
    }
}
exports.InvoiceCreditUseCase = InvoiceCreditUseCase;
//# sourceMappingURL=InvoiceCreditUseCase.js.map