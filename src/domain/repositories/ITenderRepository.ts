import {Tender} from "../entities/Tender";

export interface ITenderFilter{
    tenantId?: string;
    customerId?: string;
    status?: 'Draft' | 'Approved' | 'Exported';
    search?: string;
    page?: number;
    pageSize?: number;
}

export interface TenderListItem extends Tender {
    customerName?: string;
    positionCount?: number;
    grandTotal?: number;
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
    findById(id:string): Promise<Tender | null>;
    findAll(filter: ITenderFilter): Promise<TenderListItem[] | PaginatedResult<TenderListItem>>;
    updateStatus(id:string , status:'Draft' | 'Approved' | 'Exported'): Promise<Tender>;
    createNextVersion(tenderId:string , newCreatedBy:string): Promise<Tender>;
    delete(id: string): Promise<void>;
}
