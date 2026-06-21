"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateInvoiceStatusUseCase = void 0;
const ALLOWED = ["ISSUED", "PAID", "CANCELLED"];
class UpdateInvoiceStatusUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(id, tenantId, status) {
        if (!ALLOWED.includes(status)) {
            throw new Error("Geçersiz fatura durumu.");
        }
        return this.invoiceRepository.updateStatus(id, tenantId, status);
    }
}
exports.UpdateInvoiceStatusUseCase = UpdateInvoiceStatusUseCase;
//# sourceMappingURL=UpdateInvoiceStatusUseCase.js.map