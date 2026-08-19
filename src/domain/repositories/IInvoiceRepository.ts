import { Invoice, InvoiceLineItem, InvoiceStatus } from "../entities/Invoice";

export interface IInvoiceFilter {
    tenantId: string;
    projectId?: string | undefined;
    salesOrderId?: string | undefined;
    customerId?: string | undefined;
    status?: InvoiceStatus | undefined;
}

export type InvoiceLineItemInput = Omit<InvoiceLineItem, "id" | "invoiceId">;

/**
 * The only columns a billing summary is computed from. Deliberately narrower
 * than `Invoice`: the batch path runs over every order of a list endpoint, so
 * it must not drag line items and joined relations along.
 */
export type InvoiceSummaryRow = Pick<
    Invoice,
    "id" | "salesOrderId" | "invoiceNumber" | "billingType" | "kind" | "billedPercent" | "amount" | "status" | "createdAt"
>;

/**
 * Ne kadarının faturalandığı — hem yüzde hem FRANK. İkisi tek toplama
 * sorgusundan gelir: kapanış faturası kalan frankı kuruşu kuruşuna alabilsin
 * diye tutar toplamı da gerekir (bkz. `CreateInvoiceUseCase`).
 */
export interface BilledSoFar {
    percent: number;
    amount: number;
}

export interface IInvoiceRepository {
    createWithItems(invoice: Partial<Invoice>, items: InvoiceLineItemInput[]): Promise<Invoice>;
    updateWithItems(id: string, invoice: Partial<Invoice>, items: InvoiceLineItemInput[]): Promise<Invoice>;
    findById(id: string, tenantId: string): Promise<Invoice | null>;
    findActiveByOrder(salesOrderId: string, tenantId: string): Promise<Invoice | null>;
    findActiveByProject(projectId: string, tenantId: string): Promise<Invoice | null>;
    list(filter: IInvoiceFilter): Promise<Invoice[]>;
    listForOrders(tenantId: string, salesOrderIds: string[]): Promise<InvoiceSummaryRow[]>;
    countForTenant(tenantId: string): Promise<number>;
    sumBilledForOrder(salesOrderId: string): Promise<BilledSoFar>;
    sumBilledForProject(projectId: string): Promise<BilledSoFar>;
    updateStatus(id: string, tenantId: string, status: InvoiceStatus): Promise<Invoice>;
    /** Kalıcı silme — yalnızca kullanım senaryosu iptal edilmiş faturalar için çağırır. */
    delete(id: string, tenantId: string): Promise<void>;
}
