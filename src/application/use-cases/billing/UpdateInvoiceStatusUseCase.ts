import { IInvoiceRepository } from "../../../domain/repositories/IInvoiceRepository";
import { InvoiceStatus } from "../../../domain/entities/Invoice";

const ALLOWED: InvoiceStatus[] = ["ISSUED", "PAID", "CANCELLED"];

export class UpdateInvoiceStatusUseCase {
    constructor(private invoiceRepository: IInvoiceRepository) {}

    /**
     * `paidAt` — der Zahlungseingang. Die Rechnungsliste schickt ihn beim
     * Markieren als bezahlt mit (voreingestellt heute, aenderbar); ein
     * unlesbares Datum wird still verworfen, damit ein Tippfehler im Feld die
     * Statusaenderung nicht scheitern laesst.
     */
    async execute(id: string, tenantId: string, status: string, paidAt?: string | null) {
        if (!ALLOWED.includes(status as InvoiceStatus)) {
            throw new Error("Geçersiz fatura durumu.");
        }
        const paidDate = paidAt ? new Date(paidAt) : null;
        return this.invoiceRepository.updateStatus(
            id,
            tenantId,
            status as InvoiceStatus,
            paidDate && !Number.isNaN(paidDate.getTime()) ? paidDate : null,
        );
    }
}
