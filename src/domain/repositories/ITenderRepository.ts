import {Tender} from "../entities/Tender";

export interface ITenderFilter{
    tenantId?: string;
    customerId?: string;
    status?: 'Draft' | 'Approved' | 'Exported';
    search?: string;
    // Kolon bazlı filtreler (liste başlığı altındaki filtre satırı) — sunucuda daraltır.
    tenderNumber?: string;
    customerName?: string;
    creatorName?: string;
    // İki durumlu iş akışı: taslak (teklif) veya sipariş (projeye bağlı ya da
    // kaynağı satış siparişi olan kayıtlar). Ham `status` alanından türetilir.
    orderState?: 'draft' | 'order';
    // E-posta gönderim durumu filtresi (offerMailSentAt dolu / boş).
    mailSent?: 'yes' | 'no';
    sortBy?: 'tenderNumber' | 'customerName' | 'status' | 'createdAt';
    sortDirection?: 'asc' | 'desc';
    page?: number;
    pageSize?: number;
    // 'list' → yalnızca teklif listesi tablosunun çizdiği kolonlar döner
    // (TenderListRow). Varsayılan 'full', eski çağıranlar için tüm alanlar.
    fields?: 'list' | 'full';
}

export interface TenderListItem extends Tender {
    customerName?: string | null;
    positionCount?: number;
    grandTotal?: number;
}

// `fields=list` cevabı — teklif listesi tablosunun gerçekten okuduğu alanlar.
// Tam gövde 45 kolon taşır ve içinde coverLetter/closingNote/closingImages gibi
// LONGTEXT alanlar var (closingImages data-URI dizisi tutar); liste bunların
// hiçbirini çizmiyor.
export interface TenderListRow {
    id: string;
    tenderNumber: string;
    version: number;
    // Liste "sipariş / taslak" rozetini bu iki alandan türetir.
    projectId: string | null;
    sourceStatus: string | null;
    customerName: string | null;
    createdByEmployeeId: string;
    createdByName: string | null;
    createdByEmail: string | null;
    currency: string | null;
    createdAt: Date;
    offerMailSentAt: Date | null;
    positionCount: number;
    grandTotal: number;
}

export interface PaginatedResult<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface ITenderRepository{
    create(tender: Partial<Tender>): Promise<Tender>;
    // tenantId is required: tenant isolation is enforced in the query layer so a
    // forgotten controller check can no longer leak/mutate another tenant's data.
    findById(id:string, tenantId:string): Promise<Tender | null>;
    findAll(
        filter: ITenderFilter
    ): Promise<TenderListItem[] | PaginatedResult<TenderListItem> | TenderListRow[] | PaginatedResult<TenderListRow>>;
    updateStatus(id:string , status:'Draft' | 'Approved' | 'Exported', tenantId:string): Promise<Tender>;
    createNextVersion(tenderId:string , newCreatedBy:string, tenantId:string): Promise<Tender>;
    delete(id: string, tenantId: string): Promise<void>;
}
