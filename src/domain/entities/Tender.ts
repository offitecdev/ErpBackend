export class Tender { 
    constructor(
        public id: string,
        public tenantId: string,
        public customerId: string | null,
        public tenderNumber: string,
        public version: number,
        public format : 'SIA451' | 'CRBX',
        public status : 'Draft' | 'Approved' | 'Exported',
        public createdByEmployeeId: string,
        public createdAt: Date,
        public projectId?: string | null,
        public validUntil?: Date | null,
        public offerMailSentAt?: Date | null,
        public offerAcceptedAt?: Date | null,
        public offerMailRecipient?: string | null,
        public offerAcceptanceToken?: string | null,
        public sourceCreatedAt?: Date | null,
        public orderDate?: Date | null,
        public billingAddress?: string | null,
        public deliveryAddress?: string | null,
        public internalDeliveryDate?: Date | null,
        public priceList?: string | null,
        public paymentTerms?: string | null,
        public commissionNumber?: string | null,
        public salespersonName?: string | null,
        public sourceStatus?: string | null,
        public sourceCompany?: string | null,
        public shippingTerms?: string | null,
        public shippingWeight?: number | null,
        public fiscalPosition?: string | null,
        public salesTeam?: string | null,
        public onlineSignature?: boolean | null,
        public onlinePayment?: boolean | null,
        public coverLetter?: string | null,
        public closingNote?: string | null,
        public closingImages?: string | null,
        public sourceTotal?: number | null,
        public sourceNetAmount?: number | null,
        public sourceTaxAmount?: number | null,
        public sourceRecurringTotal?: number | null,
        public sourceMargin?: number | null,
        public billingSameAsInstallation?: boolean | null,
        public installationAddress?: string | null,
        public directDiscount?: number | null,
        public currency?: string | null,
        public directDiscountLabel?: string | null,
        public extraDiscount?: number | null,
        public extraDiscountLabel?: string | null,
        /** JSON [{name, kind, value}] — belge düzeyi yığılmış iskontolar. */
        public totalDiscounts?: string | null,
        public paymentStages?: string | null,
        /** Kundenreferenz — "Referenz" on the offer PDF (customer-supplied). */
        public customerReference?: string | null,
        /**
         * AN-2026-10001 serisinden ÖNCEKİ kod (A-2026-4474, TKF-…, ya da CSV/XML
         * içe aktarımının dış referansı). Yalnızca arama ve içe aktarım
         * eşleşmesi için tutulur; ekranda gösterilen kod `tenderNumber`dır.
         */
        public legacyNumber?: string | null,
    ){}
}




