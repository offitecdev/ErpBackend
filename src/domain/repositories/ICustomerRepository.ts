import { Customer } from "../entities/Customer";

export interface ICustomerFilter {
    tenantId: string;
    search?: string;
    segment?: string;
    status?: string;
    isActive?: boolean;
    // Kolon bazlı filtreler (liste başlığı altındaki filtre satırı) — sunucuda daraltır.
    companyName?: string;
    vatNumber?: string;
    email?: string;
    // Not: Customer modelinde createdAt yok — sıralama yalnızca bu kolonlara izinli.
    sortBy?: 'companyName' | 'vatNumber' | 'status';
    sortDirection?: 'asc' | 'desc';
    page?: number;
    pageSize?: number;
    // 'list' → yalnızca müşteri listesi tablosunun çizdiği kolonlar döner
    // (CustomerListRow). Varsayılan 'full', eski çağıranlar için tüm alanlar.
    fields?: 'list' | 'full';
}

// Müşteri listesi tablosunun gerçekten kullandığı alanlar. Tam Customer
// entity'si 24 kolon taşır; tablo bunların yedisini çiziyor.
export interface CustomerListRow {
    id: string;
    companyName: string;
    address: string | null;
    vatNumber: string | null;
    mainEmail: string | null;
    mainPhone: string | null;
    status: string;
}

export interface PaginatedResult<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

// Kennzahlen-Band der Kundenübersicht ("Allgemein"): Zeilen statt Karten.
export interface CustomerOverviewStats {
    tenderCount: number;
    projectCount: number;
    orderCount: number;
    orderTotal: number;
    // Summe der ausgestellten (nicht stornierten) Rechnungen dieses Kunden.
    invoicedTotal: number;
    // orderTotal − invoicedTotal, nie negativ.
    outstandingTotal: number;
}

export interface ICustomerRepository {
    createCustomer(customer: Partial<Customer>): Promise<Customer>;
    update(id: string, customer: Partial<Customer>): Promise<Customer>;
    delete(id: string, tenantId?: string): Promise<void>;
    findById(id: string): Promise<Customer | null>;
    findAll(
        filter: ICustomerFilter
    ): Promise<Customer[] | PaginatedResult<Customer> | CustomerListRow[] | PaginatedResult<CustomerListRow>>;
    getCustomerDashboard(id: string, tenantId?: string, summaryOnly?: boolean): Promise<any>;
    getOverviewStats(id: string, tenantId: string): Promise<CustomerOverviewStats>;
}
