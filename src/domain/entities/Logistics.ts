// ============================================================
// DOSYA: src/domain/entities/Logistics.ts
// ============================================================

export type ShipmentStatus = 'UNPAID' | 'PAID' | 'DELAYED' | 'CANCELLED';

export class Shipment {
    constructor(
        public id: string,
        public tenantId: string,
        public customerId: string,
        public status: ShipmentStatus,
        public foNumber?: string | null,
        public cmrNumber?: string | null,
        public awNumber?: string | null,
        public projectId?: string | null,
        public carrierCompany?: string | null,
        public productDescription?: string | null,
        public quantity?: number | null,
        public unit?: string | null,
        public grossWeight?: number | null,
        public netWeight?: number | null,
        public dimensions?: string | null,
        public extraNotes?: string | null,
        public shipmentDate?: Date | null,
        public eta?: Date | null,
        public invoiceUrl?: string | null,
        public autoMarkDelayed: boolean = false,
        public requireInvoiceForPaid: boolean = true,
        public createdAt?: Date,
        public updatedAt?: Date
    ) {}
}
