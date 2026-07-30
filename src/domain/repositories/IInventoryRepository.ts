import {Location , StockBalance , StockMovement , PurchaseProposal} from "../entities/Inventory";
import { Article } from "../entities/Article";

export interface IInventoryRepository {

    createLocation(location: Partial<Location>): Promise<Location>;
    getLocations(tenantId:string) : Promise<Location[]>;
    ensureDefaultLocation(tenantId: string): Promise<Location>;
    getStockBalance(articleId: string, locationId: string): Promise<StockBalance | null>;
    getAllBalances(tenantId: string , locationId?: string): Promise<any[]>;
    /** Tek ürünün toplam stoğu — kritik seviye kontrolü tüm bakiyeleri çekmesin diye. */
    getArticleTotalQuantity(tenantId: string, articleId: string): Promise<number>;

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
    /** Ürünün bekleyen satın alma önerisi var mı — liste çekmeden. */
    hasPendingProposal(tenantId: string, articleId: string): Promise<boolean>;
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
            includeDescription?: boolean;
            // Teklif satırı seçicisi için yalın mod: yalnızca bir teklif satırını
            // dolduran alanlar döner (id, ad, açıklama, birim, fiyat). Kategori,
            // barkod, stok seviyeleri ve stok bakiyesi JOIN'i tamamen atlanır.
            lean?: boolean;
            // Kolon bazlı filtreler (ürün listesi tablosundaki filtre satırı) —
            // `search` genel aramadır, bunlar tek kolona daraltır.
            code?: string | undefined;
            name?: string | undefined;
            barcode?: string | undefined;
            sortBy?: string | undefined;
            sortDirection?: 'asc' | 'desc' | undefined;
        }
    ): Promise<{ items: any[]; total: number; page: number; pageSize: number }>;

}
