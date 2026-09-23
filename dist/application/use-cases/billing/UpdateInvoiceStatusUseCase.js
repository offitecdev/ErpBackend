"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateInvoiceStatusUseCase = void 0;
const invoiceErrors_1 = require("./invoiceErrors");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const documentGovernance_1 = require("../../../shared/documentGovernance");
const documentLifecycle_1 = require("../../../shared/documentLifecycle");
const invoicePayments_1 = require("../../../shared/invoicePayments");
const ALLOWED = ["ISSUED", "PAID", "CANCELLED"];
/**
 * ── WELCHE STATUSWECHSEL EINE GESTELLTE RECHNUNG KENNT (16.09.2026) ─────────
 *
 * Vorgabe Samet: eine Rechnung mit Nummer ist ein Beleg — sie verschwindet
 * nicht und kehrt aus dem Storno nicht zurück. Erlaubt sind nur:
 *
 *   offen    → bezahlt    Zahlungseingang erfassen
 *   bezahlt  → bezahlt    Zahlungsdatum korrigieren
 *   bezahlt  → offen      eine irrtümlich erfasste Zahlung zurücknehmen
 *   offen    → storniert  die Rechnung zurücknehmen
 *
 * Eine BEZAHLTE Rechnung wird nicht storniert (das Geld ist da — dafür kommt
 * die Gutschrift), und eine STORNIERTE bleibt storniert.
 */
class UpdateInvoiceStatusUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    /**
     * `paidAt` — der Zahlungseingang. Die Rechnungsliste schickt ihn beim
     * Markieren als bezahlt mit (voreingestellt heute, aenderbar); ein
     * unlesbares Datum wird still verworfen, damit ein Tippfehler im Feld die
     * Statusaenderung nicht scheitern laesst.
     */
    /**
     * `actor` (16.09.2026, Schritt 4): wer handelt. Stornieren verlangt das
     * eigene Recht `invoices.cancel`; jeder Wechsel steht danach im Verlauf.
     */
    async execute(id, tenantId, status, paidAt, actor) {
        if (!ALLOWED.includes(status)) {
            throw (0, invoiceErrors_1.invoiceError)('INVALID_STATUS', 'Geçersiz fatura durumu.');
        }
        const next = status;
        const invoice = await this.invoiceRepository.findById(id, tenantId);
        if (!invoice)
            throw (0, invoiceErrors_1.invoiceError)('NOT_FOUND', 'Fatura bulunamadı.', { status: 404 });
        // Ein Entwurf wird AUSGESTELLT (eigener Weg mit Nummer), nicht umgestellt.
        if (invoice.status === "DRAFT") {
            throw (0, invoiceErrors_1.invoiceError)('DRAFT_NOT_ISSUED', 'Ein Entwurf muss zuerst ausgestellt werden.', { status: 409 });
        }
        // Stornieren heisst seit Schritt 6: eine Storno-Rechnung ausstellen —
        // das ist ein eigener Weg (InvoiceCreditUseCase), kein Statuswechsel.
        if (next === "CANCELLED" && invoice.status !== "CANCELLED") {
            if (actor && !actor.canCancel) {
                throw (0, invoiceErrors_1.invoiceError)('CANCEL_NOT_PERMITTED', 'Ihrer Rolle fehlt das Recht, Rechnungen zu stornieren.', { status: 403 });
            }
            if (invoice.status === "PAID") {
                throw (0, invoiceErrors_1.invoiceError)('PAID_NOT_CANCELLABLE', 'Eine bezahlte Rechnung kann nicht storniert werden. Stellen Sie eine Gutschrift aus.', { status: 409 });
            }
            throw (0, invoiceErrors_1.invoiceError)('STORNO_REQUIRED', 'Eine Rechnung wird über eine Storno-Rechnung zurückgenommen.', { status: 409 });
        }
        const lifecycle = await (0, documentLifecycle_1.readInvoiceLifecycle)(prisma_client_1.default, invoice);
        if (invoice.kind === 'STORNO') {
            throw (0, invoiceErrors_1.invoiceError)('CREDIT_DOCUMENT_FINAL', 'Eine Storno-Rechnung wird nicht umgestellt.', { status: 409 });
        }
        if (invoice.status === "PAID" && next === "ISSUED" && !lifecycle.canUndoPayment) {
            throw (0, invoiceErrors_1.invoiceError)('PAYMENT_LOCKED_BY_CREDIT', 'Zu dieser Zahlung ist bereits eine Gutschrift ausgestellt — sie kann nicht zurückgenommen werden.', { status: 409 });
        }
        if (invoice.status === "CANCELLED") {
            throw (0, invoiceErrors_1.invoiceError)('CANCELLED_STAYS', 'Eine stornierte Rechnung bleibt storniert.', { status: 409 });
        }
        if (next === "CANCELLED" && actor && !actor.canCancel) {
            throw (0, invoiceErrors_1.invoiceError)('CANCEL_NOT_PERMITTED', 'Ihrer Rolle fehlt das Recht, Rechnungen zu stornieren.', { status: 403 });
        }
        if (invoice.status === "PAID" && next === "CANCELLED") {
            throw (0, invoiceErrors_1.invoiceError)('PAID_NOT_CANCELLABLE', 'Eine bezahlte Rechnung kann nicht storniert werden. Wurde die Zahlung irrtümlich erfasst, setzen Sie die Rechnung zuerst wieder auf offen.', { status: 409 });
        }
        /* Seit Schritt 7 (G19) ist «bezahlt» die Folge von ZAHLUNGSEINGÄNGEN:
           offen → bezahlt  = ein Eingang über den offenen Rest
           bezahlt → bezahlt = Datum des letzten Eingangs korrigieren
           bezahlt → offen  = die Eingänge zurücknehmen (ohne Gutschrift) */
        const actorRef = { employeeId: actor?.employeeId ?? invoice.issuedByEmployeeId, ip: actor?.ip ?? null };
        await prisma_client_1.default.$transaction(async (tx) => {
            if (next === "PAID" && invoice.status === "PAID") {
                await (0, invoicePayments_1.changePaidDateWithin)(tx, { invoiceId: id, tenantId, paidAt: paidAt ?? null });
            }
            else if (next === "PAID") {
                await (0, invoicePayments_1.recordPaymentWithin)(tx, { invoiceId: id, tenantId, amount: null, paidAt: paidAt ?? null, actor: actorRef });
            }
            else if (next === "ISSUED" && invoice.status === "PAID") {
                await (0, invoicePayments_1.removeAllPaymentsWithin)(tx, { invoiceId: id, tenantId });
            }
        });
        const updated = (await this.invoiceRepository.findById(id, tenantId));
        // Verlauf (D1). Der Eingang schreibt seinen eigenen Eintrag; hier stehen
        // die Rücknahme und die Datumskorrektur.
        if (actor && !(invoice.status === "ISSUED" && next === "PAID") && (invoice.status !== next || next === "PAID")) {
            await (0, documentGovernance_1.recordDocumentEvent)(prisma_client_1.default, {
                tenantId,
                entityType: 'INVOICE',
                entityId: id,
                documentNumber: invoice.invoiceNumber ?? null,
                action: next === "CANCELLED" ? 'CANCELLED' : 'STATUS_CHANGED',
                actorId: actor.employeeId,
                reason: actor.reason ?? null,
                snapshot: {
                    from: invoice.status,
                    to: next,
                    amount: Number(invoice.amount || 0),
                    paidAt: next === "PAID" ? (updated?.paidAt ?? null) : null,
                },
                links: {
                    projectId: invoice.projectId ?? null,
                    salesOrderId: invoice.salesOrderId ?? null,
                },
                ipAddress: actor.ip ?? null,
            }).catch((error) => console.error('[UpdateInvoiceStatus] Verlauf nicht geschrieben:', error?.message || error));
        }
        return updated;
    }
}
exports.UpdateInvoiceStatusUseCase = UpdateInvoiceStatusUseCase;
//# sourceMappingURL=UpdateInvoiceStatusUseCase.js.map