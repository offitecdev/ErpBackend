export class Material {
    constructor(
        public id: string,
        public tenantId: string,
        public serialId: string,
        public name: string,
        public stockQuantity: number,
        public unitCost: number,
        public imageUrl: string | null,
        public isActive: boolean
    ) {}
}
