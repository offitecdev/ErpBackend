import { Customer } from "../entities/Customer";

export interface ICustomerFilter {
    tenantId: string;
    search?: string;
    segment?: string;
    status?: string;
    isActive?: boolean;
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
    getCustomerDashboard(id: string, tenantId?: string): Promise<any>;
}
