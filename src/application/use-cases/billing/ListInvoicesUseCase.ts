import { IInvoiceFilter, IInvoiceRepository } from "../../../domain/repositories/IInvoiceRepository";

export class ListInvoicesUseCase {
    constructor(private invoiceRepository: IInvoiceRepository) {}

    async execute(filter: IInvoiceFilter) {
        return this.invoiceRepository.list(filter);
    }
}
