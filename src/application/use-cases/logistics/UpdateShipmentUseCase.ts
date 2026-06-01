
import { IShipmentRepository } from "../../../domain/repositories/IShipmentRepository";
import { Shipment } from "../../../domain/entities/Logistics";

export class UpdateShipmentUseCase {
    constructor(private shipmentRepository: IShipmentRepository) {}

    async execute(id: string, data: Partial<Shipment>, tenantId: string): Promise<Shipment> {
        const existing = await this.shipmentRepository.findById(id);
        if (!existing || existing.tenantId !== tenantId) {
            throw new Error("Sevkiyat kaydı bulunamadı.");
        }

        if (data.foNumber && data.foNumber !== existing.foNumber) {
            const conflict = await this.shipmentRepository.findByDocumentNumber(tenantId, 'foNumber', data.foNumber, id);
            if (conflict) throw new Error(`Bu FO Numarası (${data.foNumber}) zaten sistemde kayıtlı.`);
        }
        if (data.cmrNumber && data.cmrNumber !== existing.cmrNumber) {
            const conflict = await this.shipmentRepository.findByDocumentNumber(tenantId, 'cmrNumber', data.cmrNumber, id);
            if (conflict) throw new Error(`Bu CMR Numarası (${data.cmrNumber}) zaten sistemde kayıtlı.`);
        }
        if (data.awNumber && data.awNumber !== existing.awNumber) {
            const conflict = await this.shipmentRepository.findByDocumentNumber(tenantId, 'awNumber', data.awNumber, id);
            if (conflict) throw new Error(`Bu AW Numarası (${data.awNumber}) zaten sistemde kayıtlı.`);
        }

        const targetStatus = data.status !== undefined ? data.status : existing.status;
        const targetInvoiceUrl = data.invoiceUrl !== undefined ? data.invoiceUrl : existing.invoiceUrl;
        const shouldRequireInvoice = data.requireInvoiceForPaid !== undefined ? data.requireInvoiceForPaid : existing.requireInvoiceForPaid;

        if (targetStatus === 'PAID' && shouldRequireInvoice !== false && !targetInvoiceUrl) {
            throw new Error("[BLOCKED] Fatura belgesi yüklenmeden statü 'Ödendi' yapılamaz veya mevcut fatura silinemez.");
        }

        return await this.shipmentRepository.update(id, data);
    }
}
