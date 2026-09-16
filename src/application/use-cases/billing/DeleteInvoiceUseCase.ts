import { IInvoiceRepository } from "../../../domain/repositories/IInvoiceRepository";
import { invoiceError } from './invoiceErrors';

/**
 * Eine gestellte Rechnung wird NICHT geloescht — auch nicht nach dem Storno
 * (Vorgabe Samet 16.09.2026). Sie traegt eine Nummer aus der lueckenlosen
 * RE-Serie; entfernt man sie, klafft dort ein Loch, das keine Revision
 * erklaeren kann. Die stornierte Rechnung bleibt als Beleg stehen.
 *
 * Der Endpunkt bleibt bestehen, damit aeltere Oberflaechen (zwischengespeicherte
 * PWA) eine klare Antwort bekommen statt eines 404.
 */
export class DeleteInvoiceUseCase {
    constructor(private invoiceRepository: IInvoiceRepository) {}

    async execute(id: string, tenantId: string) {
        const invoice = await this.invoiceRepository.findById(id, tenantId);
        if (!invoice) throw invoiceError('NOT_FOUND', 'Fatura bulunamadı.', { status: 404 });
        throw invoiceError('NEVER_DELETED', 'Eine gestellte Rechnung wird nicht gelöscht — sie bleibt als Beleg stehen.', { status: 409 });
    }
}
