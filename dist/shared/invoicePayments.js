"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.changePaidDateWithin = exports.removeAllPaymentsWithin = exports.removePaymentWithin = exports.recordPaymentWithin = exports.settleInvoiceStatusWithin = exports.readInvoiceBalance = exports.OFFSET_KIND = exports.PAYMENT_KIND = void 0;
const nanoid_1 = require("nanoid");
const documentGovernance_1 = require("./documentGovernance");
exports.PAYMENT_KIND = 'PAYMENT';
exports.OFFSET_KIND = 'OFFSET';
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const EPS = 0.005;
const failure = (code, message, status = 409, params) => Object.assign(new Error(message), { code, status, ...(params ? { params } : {}) });
/** Stand EINER Rechnung aus ihren Zeilen. */
const readInvoiceBalance = async (db, invoice) => {
    const amount = round2(Number(invoice.amount || 0));
    const isCredit = invoice.kind === 'GUTSCHRIFT' || invoice.kind === 'STORNO';
    const [payments, credits] = await Promise.all([
        db.invoicePayment.findMany({ where: { invoiceId: invoice.id }, select: { amount: true, kind: true } }),
        isCredit
            ? Promise.resolve(null)
            : db.invoice.aggregate({
                where: { tenantId: invoice.tenantId, reversesInvoiceId: invoice.id, kind: 'GUTSCHRIFT', NOT: { status: 'DRAFT' } },
                _sum: { amount: true },
            }),
    ]);
    const paid = round2(payments.reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const paidMoney = round2(payments
        .filter((row) => row.kind !== exports.OFFSET_KIND)
        .reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const credited = credits ? round2(Math.abs(Number(credits._sum?.amount || 0))) : 0;
    const open = Math.max(0, round2(Math.abs(amount) - Math.abs(paid) - credited));
    return { amount, paid, paidMoney, credited, open };
};
exports.readInvoiceBalance = readInvoiceBalance;
/**
 * Den Status nach einer Änderung an Zahlungen/Gutschriften nachziehen:
 * offen 0 → PAID (paidAt = `settledAt`), sonst ISSUED (paidAt leer).
 */
const settleInvoiceStatusWithin = async (tx, invoice, settledAt) => {
    if (invoice.status !== 'ISSUED' && invoice.status !== 'PAID')
        return invoice.status;
    const balance = await (0, exports.readInvoiceBalance)(tx, invoice);
    const next = balance.open <= EPS && (Math.abs(balance.paid) > EPS || balance.credited > EPS) ? 'PAID' : 'ISSUED';
    if (next !== invoice.status || next === 'PAID') {
        await tx.invoice.update({
            where: { id: invoice.id },
            data: next === 'PAID'
                ? { status: 'PAID', paidAt: invoice.status === 'PAID' ? undefined : settledAt }
                : { status: 'ISSUED', paidAt: null },
        });
    }
    return next;
};
exports.settleInvoiceStatusWithin = settleInvoiceStatusWithin;
const parseDay = (raw) => {
    if (!raw)
        return new Date();
    const text = String(raw).slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T12:00:00.000Z`) : new Date(String(raw));
    return Number.isNaN(date.getTime()) ? new Date() : date;
};
/**
 * EINEN EINGANG ERFASSEN. `amount` positiv; fehlt er, der ganze offene Rest.
 * Bei einer Gutschrift ist es die Rückzahlung (gespeichert negativ).
 */
const recordPaymentWithin = async (tx, opts) => {
    const invoice = await tx.invoice.findFirst({ where: { id: opts.invoiceId, tenantId: opts.tenantId } });
    if (!invoice)
        throw failure('NOT_FOUND', 'Rechnung nicht gefunden.', 404);
    if (invoice.status === 'DRAFT')
        throw failure('DRAFT_NOT_ISSUED', 'Ein Entwurf muss zuerst ausgestellt werden.');
    if (invoice.status === 'CANCELLED')
        throw failure('CANCELLED_STAYS', 'Eine stornierte Rechnung nimmt keine Zahlung an.');
    if (invoice.kind === 'STORNO')
        throw failure('CREDIT_DOCUMENT_FINAL', 'Eine Storno-Rechnung nimmt keine Zahlung an.');
    const balance = await (0, exports.readInvoiceBalance)(tx, invoice);
    if (balance.open <= EPS)
        throw failure('ALREADY_SETTLED', 'Diese Rechnung ist bereits ausgeglichen.');
    const requested = opts.amount == null || opts.amount === '' ? balance.open : round2(Math.abs(Number(opts.amount)));
    if (!Number.isFinite(requested) || requested <= 0)
        throw failure('PAYMENT_AMOUNT_INVALID', 'Der Betrag muss grösser als 0 sein.', 400);
    if (requested > balance.open + EPS) {
        throw failure('PAYMENT_TOO_HIGH', `Höchstens ${balance.open.toFixed(2)} sind offen.`, 409, { max: balance.open.toFixed(2) });
    }
    const sign = Number(invoice.amount) < 0 ? -1 : 1;
    const paidAt = parseDay(opts.paidAt);
    const payment = await tx.invoicePayment.create({
        data: {
            id: `pm${(0, nanoid_1.nanoid)(16)}`,
            tenantId: opts.tenantId,
            invoiceId: invoice.id,
            amount: sign * requested,
            kind: opts.kind ?? exports.PAYMENT_KIND,
            paidAt,
            note: opts.note ? String(opts.note).slice(0, 500) : null,
            createdById: opts.actor.employeeId,
        },
    });
    const status = await (0, exports.settleInvoiceStatusWithin)(tx, invoice, paidAt);
    await (0, documentGovernance_1.recordDocumentEvent)(tx, {
        tenantId: opts.tenantId,
        entityType: 'INVOICE',
        entityId: invoice.id,
        documentNumber: invoice.invoiceNumber,
        action: 'PAYMENT_RECORDED',
        actorId: opts.actor.employeeId,
        reason: opts.note ?? null,
        snapshot: { amount: sign * requested, paidAt, open: round2(balance.open - requested), status, kind: payment.kind },
        links: { projectId: invoice.projectId ?? null, salesOrderId: invoice.salesOrderId ?? null },
        ipAddress: opts.actor.ip ?? null,
    });
    return payment;
};
exports.recordPaymentWithin = recordPaymentWithin;
/** EINEN EINGANG ENTFERNEN (Fehlerfassung). Gesperrt, sobald eine Gutschrift daran hängt. */
const removePaymentWithin = async (tx, opts) => {
    const invoice = await tx.invoice.findFirst({ where: { id: opts.invoiceId, tenantId: opts.tenantId } });
    if (!invoice)
        throw failure('NOT_FOUND', 'Rechnung nicht gefunden.', 404);
    if (invoice.status === 'CANCELLED')
        throw failure('CANCELLED_STAYS', 'Eine stornierte Rechnung bleibt, wie sie ist.');
    const payment = await tx.invoicePayment.findFirst({ where: { id: opts.paymentId, invoiceId: invoice.id } });
    if (!payment)
        throw failure('NOT_FOUND', 'Zahlung nicht gefunden.', 404);
    if (payment.kind === exports.OFFSET_KIND)
        throw failure('OFFSET_FINAL', 'Eine Verrechnung wird nicht entfernt.');
    const balance = await (0, exports.readInvoiceBalance)(tx, invoice);
    if (balance.credited > EPS) {
        throw failure('PAYMENT_LOCKED_BY_CREDIT', 'Zu dieser Rechnung ist bereits eine Gutschrift ausgestellt — ihre Zahlungen bleiben.');
    }
    await tx.invoicePayment.delete({ where: { id: payment.id } });
    const status = await (0, exports.settleInvoiceStatusWithin)(tx, invoice, new Date());
    await (0, documentGovernance_1.recordDocumentEvent)(tx, {
        tenantId: opts.tenantId,
        entityType: 'INVOICE',
        entityId: invoice.id,
        documentNumber: invoice.invoiceNumber,
        action: 'PAYMENT_REMOVED',
        actorId: opts.actor.employeeId,
        snapshot: { amount: Number(payment.amount), paidAt: payment.paidAt, status },
        links: { projectId: invoice.projectId ?? null, salesOrderId: invoice.salesOrderId ?? null },
        ipAddress: opts.actor.ip ?? null,
    });
};
exports.removePaymentWithin = removePaymentWithin;
/** Alle Eingänge entfernen (der alte Weg «bezahlt → offen»). */
const removeAllPaymentsWithin = async (tx, opts) => {
    const invoice = await tx.invoice.findFirst({ where: { id: opts.invoiceId, tenantId: opts.tenantId } });
    if (!invoice)
        throw failure('NOT_FOUND', 'Rechnung nicht gefunden.', 404);
    const balance = await (0, exports.readInvoiceBalance)(tx, invoice);
    if (balance.credited > EPS) {
        throw failure('PAYMENT_LOCKED_BY_CREDIT', 'Zu dieser Zahlung ist bereits eine Gutschrift ausgestellt — sie kann nicht zurückgenommen werden.');
    }
    await tx.invoicePayment.deleteMany({ where: { invoiceId: invoice.id, kind: exports.PAYMENT_KIND } });
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'ISSUED', paidAt: null } });
};
exports.removeAllPaymentsWithin = removeAllPaymentsWithin;
/** Zahlungsdatum einer ausgeglichenen Rechnung korrigieren (letzter Eingang + paidAt). */
const changePaidDateWithin = async (tx, opts) => {
    const paidAt = parseDay(opts.paidAt);
    const last = await tx.invoicePayment.findFirst({
        where: { invoiceId: opts.invoiceId, kind: exports.PAYMENT_KIND },
        orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
    });
    if (last)
        await tx.invoicePayment.update({ where: { id: last.id }, data: { paidAt } });
    await tx.invoice.updateMany({ where: { id: opts.invoiceId, tenantId: opts.tenantId }, data: { paidAt } });
};
exports.changePaidDateWithin = changePaidDateWithin;
//# sourceMappingURL=invoicePayments.js.map