export class Location{
    constructor(

        public id: string,
        public tenantId: string,
        public locationName: string,
        public locationType: 'MAIN_WAREHOUSE' | 'SUB_WAREHOUSE' | 'STATION_BUFFER' | 'PROJECT_RESERVE',
        public isActive: boolean,
        public parentLocationId?: string | null
    ){}
}

export class StockBalance{
    constructor(
        public id: string,
        public tenantId: string,
        public articleId: string,
        public locationId: string,
        public currentQuantity: number,
        public reservedQuantity: number,
        public updatedAt: Date  
    ){}
}

export class StockMovement{
    constructor(
        public id: string,
        public tenantId: string,
        public articleId: string,
        public movementType: 'IN' | 'OUT' | 'TRANSFER' | 'RETURN' | 'ADJUSTMENT',
        public quantity: number,
        public employeeId: string,
        public transactionDate: Date,
        public sourceLocationId?: string | null,
        public destinationLocationId?: string | null,
        public referenceId?: string | null,
        public description?: string | null
    ){}
}

export class PurchaseProposal{
    constructor(
        public id: string,
        public tenantId: string,
        public articleId: string,
        public proposedQuantity: number,
        public status: 'PENDING' | 'APPROVED' | 'CONVERTED' | 'REJECTED',
        public createdAt: Date,
        public supplierId?: string | null,
        public resolvedAt?: Date | null,
        public resolvedByEmployeeId?: string | null,
    ){}


}