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
    /** Mandantengebundene Sammellöschung (Papierkorb) — gibt die Trefferzahl zurück. */
    softDeleteArticles(tenantId: string, ids: string[]): Promise<number>;
    /** Die ganze Produktliste einer Firma in den Papierkorb. */
    softDeleteAllArticles(tenantId: string): Promise<number>;
    findAllArticles(filter: IArticleFilter): Promise<Article[]>;
    findArticleById(id: string, options?: { includeImages?: boolean }): Promise<Article | null>;
    findArticleByCode(tenantId: string, codeOrBarcode: string): Promise<Article | null>;

    mapArticleToPosition(mapping: Partial<PositionArticleMapping>): Promise<PositionArticleMapping>;
    findMappingById(mappingId: string): Promise<PositionArticleMapping | null>;
    updateMapping(mappingId: string, patch: { quantityMultiplier?: number; discount?: number | null }): Promise<PositionArticleMapping>;
    getMappingsByPositionId(positionId: string): Promise<PositionArticleMapping[]>;
    removeMapping(mappingId: string): Promise<void>;
}
