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
}
exports.ListInvoicesUseCase = ListInvoicesUseCase;
//# sourceMappingURL=ListInvoicesUseCase.js.map