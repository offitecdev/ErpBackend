import { IInvoiceRepository } from "../../../domain/repositories/IInvoiceRepository";
import { InvoiceStatus } from "../../../domain/entities/Invoice";

const ALLOWED: InvoiceStatus[] = ["ISSUED", "PAID", "CANCELLED"];

export class UpdateInvoiceStatusUseCase {
    constructor(private invoiceRepository: IInvoiceRepository) {}

    async execute(id: string, tenantId: string, status: string) {
        if (!ALLOWED.includes(status as InvoiceStatus)) {
            throw new Error("Geçersiz fatura durumu.");
        }
        return this.invoiceRepository.updateStatus(id, tenantId, status as InvoiceStatus);
    }
}
