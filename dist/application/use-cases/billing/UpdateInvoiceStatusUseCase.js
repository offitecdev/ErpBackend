"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateInvoiceStatusUseCase = void 0;
const ALLOWED = ["ISSUED", "PAID", "CANCELLED"];
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
            throw new Error("Geçersiz fatura durumu.");
        }
        const paidDate = paidAt ? new Date(paidAt) : null;
        return this.invoiceRepository.updateStatus(id, tenantId, status, paidDate && !Number.isNaN(paidDate.getTime()) ? paidDate : null);
    }
}
exports.UpdateInvoiceStatusUseCase = UpdateInvoiceStatusUseCase;
//# sourceMappingURL=UpdateInvoiceStatusUseCase.js.map