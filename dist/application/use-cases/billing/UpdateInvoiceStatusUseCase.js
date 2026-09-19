"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateInvoiceStatusUseCase = void 0;
const invoiceErrors_1 = require("./invoiceErrors");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const documentGovernance_1 = require("../../../shared/documentGovernance");
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
        if (invoice.status === "CANCELLED") {
            throw (0, invoiceErrors_1.invoiceError)('CANCELLED_STAYS', 'Eine stornierte Rechnung bleibt storniert.', { status: 409 });
        }
        if (next === "CANCELLED" && actor && !actor.canCancel) {
            throw (0, invoiceErrors_1.invoiceError)('CANCEL_NOT_PERMITTED', 'Ihrer Rolle fehlt das Recht, Rechnungen zu stornieren.', { status: 403 });
        }
        if (invoice.status === "PAID" && next === "CANCELLED") {
            throw (0, invoiceErrors_1.invoiceError)('PAID_NOT_CANCELLABLE', 'Eine bezahlte Rechnung kann nicht storniert werden. Wurde die Zahlung irrtümlich erfasst, setzen Sie die Rechnung zuerst wieder auf offen.', { status: 409 });
        }
        const paidDate = paidAt ? new Date(paidAt) : null;
        const updated = await this.invoiceRepository.updateStatus(id, tenantId, next, paidDate && !Number.isNaN(paidDate.getTime()) ? paidDate : null);
        // Verlauf (D1). Das Repository schreibt ausserhalb einer Transaktion,
        // der Eintrag folgt unmittelbar; ein Fehler wird gemeldet, nicht verschluckt.
        if (actor && (invoice.status !== next || next === "PAID")) {
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