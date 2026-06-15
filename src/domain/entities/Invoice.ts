export type InvoiceBillingType = 'FULL' | 'PARTIAL';
export type InvoiceStatus = 'ISSUED' | 'PAID' | 'CANCELLED';
export type InvoiceLineSourceType = 'ORDER' | 'OVERTIME' | 'EXPENSE' | 'EXTRA_MATERIAL' | 'MANUAL';

export interface InvoiceLineItem {
    id: string;
    invoiceId: string;
    description: string;
    sourceType: InvoiceLineSourceType;
    sourceId?: string | null;
    quantity: number;
    unitAmount: number;
    lineTotal: number;
}

export interface Invoice {
    id: string;
    tenantId: string;
    customerId?: string | null;
    projectId?: string | null;
    salesOrderId?: string | null;
    invoiceNumber: string;
    billingType: InvoiceBillingType;
    billedPercent: number;
    baseAmount: number;
    amount: number;
    status: InvoiceStatus;
    notes?: string | null;
    issuedByEmployeeId: string;
    createdAt: Date;
    updatedAt: Date;
    lineItems?: InvoiceLineItem[];
}
