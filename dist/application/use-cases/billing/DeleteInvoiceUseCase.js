"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeleteInvoiceUseCase = void 0;
/**
 * Kalıcı silme YALNIZCA iptal edilmiş (CANCELLED) faturalar için: aktif bir
 * faturayı silmek faturalama yüzdesini sessizce geri açardı — düzeltme yolu
 * her zaman önce storno, sonra çöp kutusudur. Numara serisi geri almaz
 * (DocumentCounter yalnızca ileri gider), silinen numara boşlukta kalır.
 */
class DeleteInvoiceUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(id, tenantId) {
        const invoice = await this.invoiceRepository.findById(id, tenantId);
        if (!invoice)
            throw new Error("Fatura bulunamadı.");
        if (invoice.status !== "CANCELLED") {
            throw new Error("Yalnızca iptal edilmiş faturalar kalıcı olarak silinebilir.");
        }
        await this.invoiceRepository.delete(id, tenantId);
    }
}
exports.DeleteInvoiceUseCase = DeleteInvoiceUseCase;
//# sourceMappingURL=DeleteInvoiceUseCase.js.map