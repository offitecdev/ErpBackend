import {Location , StockBalance , StockMovement , PurchaseProposal} from "../entities/Inventory";
import { Article } from "../entities/Article";

export interface IInventoryRepository {

    createLocation(location: Partial<Location>): Promise<Location>;
    getLocations(tenantId:string) : Promise<Location[]>;
    ensureDefaultLocation(tenantId: string): Promise<Location>;
    getStockBalance(articleId: string, locationId: string): Promise<StockBalance | null>;
    getAllBalances(tenantId: string , locationId?: string): Promise<any[]>;

   processMovement(
        movementData: Partial<StockMovement>, 
        articleId: string,
        sourceLocationId: string | null,
        destLocationId: string | null,
        quantity: number
    ): Promise<StockMovement>;

    getMovements(articleId:string): Promise<StockMovement[]>;
    createPurchaseProposal(proposal: Partial<PurchaseProposal>): Promise<PurchaseProposal>;
    getPendingProposals(tenantId: string): Promise<PurchaseProposal[]>;
    resolveProposal(proposalId: string, status: 'APPROVED' | 'REJECTED', employeeId: string): Promise<void>;
    findArticleByBarcodeOrCode(tenantId: string, codeOrBarcode: string): Promise<Article | null>;
    getArticleStockSummary(tenantId: string, includeImages?: boolean): Promise<any[]>;
    // Tek bir ürünün yalın stok bilgisi (toplam adet + maliyet dökümü) — depo/lokasyon
    // ve görsel çekmeden, stok hareketi ekranındaki sayaç ve ortalama maliyet için.
    getArticleStockInfo(tenantId: string, articleId: string): Promise<any | null>;
    getArticleStockSummaryPaged(
        tenantId: string,
        options: {
            page?: number;
            pageSize?: number;
            search?: string | undefined;
            status?: string | undefined;
            itemType?: string | undefined;
        }
    ): Promise<{ items: any[]; total: number; page: number; pageSize: number }>;

}