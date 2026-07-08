
export type ArticleStatus = 'ACTIVE' | 'INACTIVE' | 'IN_SUPPLY' | 'IN_PRODUCTION';

export class Article {
    constructor(
        public id: string,
        public tenantId: string,
        public articleCode: string,
        public name: string,
        public baseCost: number,
        public unit: string,
        public description?: string | null,
        public systemBarcode?: string | null,
        public supplierBarcode?: string | null,
        public imageUrl?: string | null,
        public category?: string | null,
        public status: ArticleStatus = 'ACTIVE',
        public isActive: boolean = true,
        public minStockLevel: number = 0,
        public criticalStockLevel: number = 0,
        public maxStockLevel?: number | null,
        public lastPurchaseDate?: Date | null,
        public salePrice: number = 0,
        public defaultSupplierId?: string | null,
        /** PRODUCT | MATERIAL — envanter kalemi tipi */
        public itemType: string = 'PRODUCT'
    ) {}
}


export class PositionArticleMapping {
    constructor(
        public id: string,
        public positionId: string,
        public articleId: string,
        public quantityMultiplier: number,
        public discount?: number | null,
        public article?: Article 
    ) {}
}
