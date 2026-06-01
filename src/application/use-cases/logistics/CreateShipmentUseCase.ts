
import { IShipmentRepository } from "../../../domain/repositories/IShipmentRepository";
import { Shipment } from "../../../domain/entities/Logistics";

export class CreateShipmentUseCase {
    constructor(private shipmentRepository: IShipmentRepository) {}

    async execute(data: Partial<Shipment>): Promise<Shipment> {
        if (!data.tenantId || !data.customerId) {
            throw new Error("Şirket (Tenant) ve Müşteri/Tedarikçi (Cari) bilgisi zorunludur.");
        }

        if (data.foNumber) {
            const existingFo = await this.shipmentRepository.findByDocumentNumber(data.tenantId, 'foNumber', data.foNumber);
            if (existingFo) throw new Error(`Bu FO Numarası (${data.foNumber}) zaten sistemde kayıtlı.`);
        }
        if (data.cmrNumber) {
            const existingCmr = await this.shipmentRepository.findByDocumentNumber(data.tenantId, 'cmrNumber', data.cmrNumber);
            if (existingCmr) throw new Error(`Bu CMR Numarası (${data.cmrNumber}) zaten sistemde kayıtlı.`);
        }
        if (data.awNumber) {
            const existingAw = await this.shipmentRepository.findByDocumentNumber(data.tenantId, 'awNumber', data.awNumber);
            if (existingAw) throw new Error(`Bu AW Numarası (${data.awNumber}) zaten sistemde kayıtlı.`);
        }

        if (data.status === 'PAID' && data.requireInvoiceForPaid !== false && !data.invoiceUrl) {
            throw new Error("[BLOCKED] Fatura (PDF/Görsel) yüklenmeden statü 'Ödendi' olarak işaretlenemez.");
        }

        return await this.shipmentRepository.create(data);
    }
}
