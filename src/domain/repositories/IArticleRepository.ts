import { Article, PositionArticleMapping } from "../entities/Article";

export interface IArticleFilter {
    tenantId: string;
    search?: string;
    category?: string;
    status?: string;
    onlyActive?: boolean;
}

export interface IArticleRepository {
    createArticle(article: Partial<Article>): Promise<Article>;
    updateArticle(id: string, patch: Partial<Article>): Promise<Article>;
    deleteArticle(id: string): Promise<void>;
    findAllArticles(filter: IArticleFilter): Promise<Article[]>;
    findArticleById(id: string): Promise<Article | null>;
    findArticleByCode(tenantId: string, codeOrBarcode: string): Promise<Article | null>;

    mapArticleToPosition(mapping: Partial<PositionArticleMapping>): Promise<PositionArticleMapping>;
    findMappingById(mappingId: string): Promise<PositionArticleMapping | null>;
    updateMapping(mappingId: string, patch: { quantityMultiplier?: number; discount?: number | null }): Promise<PositionArticleMapping>;
    getMappingsByPositionId(positionId: string): Promise<PositionArticleMapping[]>;
    removeMapping(mappingId: string): Promise<void>;
}
