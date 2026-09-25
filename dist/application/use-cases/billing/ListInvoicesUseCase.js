"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ListInvoicesUseCase = void 0;
class ListInvoicesUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(filter) {
        return this.invoiceRepository.list(filter);
    }
    /**
     * EINE Seite der Buchhaltungsliste (20 Zeilen), sortiert nach dem letzten
     * Vorgang — dazu die Gesamtzahl und die Zähler aller Reiter.
     */
    async executePage(filter) {
        return this.invoiceRepository.listPage(filter);
    }
}
exports.ListInvoicesUseCase = ListInvoicesUseCase;
//# sourceMappingURL=ListInvoicesUseCase.js.map