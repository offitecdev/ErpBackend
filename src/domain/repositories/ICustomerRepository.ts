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
}

export interface PaginatedResult<T> {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface ICustomerRepository {
    createCustomer(customer: Partial<Customer>): Promise<Customer>;
    update(id: string, customer: Partial<Customer>): Promise<Customer>;
    delete(id: string, tenantId?: string): Promise<void>;
    findById(id: string): Promise<Customer | null>;
    findAll(filter: ICustomerFilter): Promise<Customer[] | PaginatedResult<Customer>>;
    getCustomerDashboard(id: string, tenantId?: string, summaryOnly?: boolean): Promise<any>;
}
