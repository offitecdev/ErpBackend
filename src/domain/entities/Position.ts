export class Position{
    constructor(
        public id: string,
        public tenantId: string,
        public tenderId: string,
        public positionNumber: string,
        public shortDescription: string,
        public hierarchyLevel: number,
        public quantity: number=0,
        public parentPositionId?: string | null,
        public npkCode?: string | null,
        public longDescription?: string | null,
        public unit?: string | null,
    ){}
}


