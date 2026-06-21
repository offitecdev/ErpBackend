import { Invoice, InvoiceLineItem, InvoiceStatus } from "../entities/Invoice";

export interface IInvoiceFilter {
    tenantId: string;
    projectId?: string | undefined;
    salesOrderId?: string | undefined;
    customerId?: string | undefined;
    status?: InvoiceStatus | undefined;
}

export type InvoiceLineItemInput = Omit<InvoiceLineItem, "id" | "invoiceId">;

export interface IInvoiceRepository {
    createWithItems(invoice: Partial<Invoice>, items: InvoiceLineItemInput[]): Promise<Invoice>;
    updateWithItems(id: string, invoice: Partial<Invoice>, items: InvoiceLineItemInput[]): Promise<Invoice>;
    findById(id: string, tenantId: string): Promise<Invoice | null>;
    findActiveByOrder(salesOrderId: string, tenantId: string): Promise<Invoice | null>;
    findActiveByProject(projectId: string, tenantId: string): Promise<Invoice | null>;
    list(filter: IInvoiceFilter): Promise<Invoice[]>;
    countForTenant(tenantId: string): Promise<number>;
    sumBilledPercentForOrder(salesOrderId: string): Promise<number>;
    sumBilledPercentForProject(projectId: string): Promise<number>;
    updateStatus(id: string, tenantId: string, status: InvoiceStatus): Promise<Invoice>;
}
