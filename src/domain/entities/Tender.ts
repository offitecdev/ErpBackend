export class Tender { 
    constructor(
        public id: string,
        public tenantId: string,
        public customerId: string,
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
    ){}
}




