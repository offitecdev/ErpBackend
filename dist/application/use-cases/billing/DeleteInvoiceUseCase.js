"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeleteInvoiceUseCase = void 0;
const invoiceErrors_1 = require("./invoiceErrors");
/**
 * Eine gestellte Rechnung wird NICHT geloescht — auch nicht nach dem Storno
 * (Vorgabe Samet 16.09.2026). Sie traegt eine Nummer aus der lueckenlosen
 * RE-Serie; entfernt man sie, klafft dort ein Loch, das keine Revision
 * erklaeren kann. Die stornierte Rechnung bleibt als Beleg stehen.
 *
 * Der Endpunkt bleibt bestehen, damit aeltere Oberflaechen (zwischengespeicherte
 * PWA) eine klare Antwort bekommen statt eines 404.
 */
class DeleteInvoiceUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(id, tenantId) {
        const invoice = await this.invoiceRepository.findById(id, tenantId);
        if (!invoice)
            throw (0, invoiceErrors_1.invoiceError)('NOT_FOUND', 'Fatura bulunamadı.', { status: 404 });
        throw (0, invoiceErrors_1.invoiceError)('NEVER_DELETED', 'Eine gestellte Rechnung wird nicht gelöscht — sie bleibt als Beleg stehen.', { status: 409 });
    }
}
exports.DeleteInvoiceUseCase = DeleteInvoiceUseCase;
//# sourceMappingURL=DeleteInvoiceUseCase.js.map