"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateInvoiceStatusUseCase = void 0;
const invoiceErrors_1 = require("./invoiceErrors");
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
    async execute(id, tenantId, status, paidAt) {
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
        if (invoice.status === "PAID" && next === "CANCELLED") {
            throw (0, invoiceErrors_1.invoiceError)('PAID_NOT_CANCELLABLE', 'Eine bezahlte Rechnung kann nicht storniert werden. Wurde die Zahlung irrtümlich erfasst, setzen Sie die Rechnung zuerst wieder auf offen.', { status: 409 });
        }
        const paidDate = paidAt ? new Date(paidAt) : null;
        return this.invoiceRepository.updateStatus(id, tenantId, next, paidDate && !Number.isNaN(paidDate.getTime()) ? paidDate : null);
    }
}
exports.UpdateInvoiceStatusUseCase = UpdateInvoiceStatusUseCase;
//# sourceMappingURL=UpdateInvoiceStatusUseCase.js.map