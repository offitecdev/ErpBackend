
export class WorkOrder {
    constructor(
        public id: string,
        public tenantId: string,
        public customerId: string,
        public orderNumber: string,
        public orderType: string,
        public totalAmount: number,
        public isBilled: boolean,
        public createdAt?: Date
    ) {}
}