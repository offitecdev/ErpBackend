import { IInvoiceFilter, IInvoiceRepository, InvoicePage } from "../../../domain/repositories/IInvoiceRepository";

export class ListInvoicesUseCase {
    constructor(private invoiceRepository: IInvoiceRepository) {}

    async execute(filter: IInvoiceFilter) {
        return this.invoiceRepository.list(filter);
    }

    /**
     * EINE Seite der Buchhaltungsliste (20 Zeilen), sortiert nach dem letzten
     * Vorgang — dazu die Gesamtzahl und die Zähler aller Reiter.
     */
    async executePage(filter: IInvoiceFilter): Promise<InvoicePage> {
        return this.invoiceRepository.listPage(filter);
    }
}
