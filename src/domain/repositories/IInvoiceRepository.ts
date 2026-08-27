import { Invoice, InvoiceCategory, InvoiceLineItem, InvoiceStatus } from "../entities/Invoice";

export interface IInvoiceFilter {
    tenantId: string;
    projectId?: string | undefined;
    salesOrderId?: string | undefined;
    customerId?: string | undefined;
    status?: InvoiceStatus | undefined;
    /**
     * Rechnungstyp der Liste (30.08.2026). Wird NICHT gespeichert, sondern im
     * SELECT aus dem hängenden Beleg abgeleitet — die Bedingung steht deshalb
     * in einem HAVING, nicht in der WHERE-Kette.
     */
    category?: InvoiceCategory | undefined;
}

export type InvoiceLineItemInput = Omit<InvoiceLineItem, "id" | "invoiceId">;

/**
 * Eine Zeile der Rechnungsliste: die Rechnung selbst, ihr abgeleiteter Typ und
 * die drei Namen, die die Tabelle zeigt (Kunde, Projekt, Auftrag). Sie kommen
 * aus DEMSELBEN SELECT wie die Rechnung — ein `include` je Beziehung wäre je
 * eine zusätzliche Abfragerunde (siehe `InvoiceRepository.list`).
 */
export interface InvoiceListItem extends Invoice {
    category: InvoiceCategory;
    /** Auftragsart des hängenden Auftrags (INVOICE / REGIE / PROJECT_*). */
    orderType?: string | null;
    customer?: { id: string; companyName: string } | null;
    project?: { id: string; projectNumber?: string | null; projectName: string } | null;
    salesOrder?: {
        id: string;
        orderNumber: string;
        orderType?: string | null;
        /** Offerte hinter dem Auftrag — die Gesamtrechnung druckt ihre Positionen. */
        tenderId?: string | null;
        /** Ratenplan des Auftrags als JSON-Zeichenkette (Zahlungsplan im PDF). */
        paymentStages?: string | null;
    } | null;
    issuedBy?: { id: string; firstName: string; lastName: string } | null;
}

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
    list(filter: IInvoiceFilter): Promise<InvoiceListItem[]>;
    listForOrders(tenantId: string, salesOrderIds: string[]): Promise<InvoiceSummaryRow[]>;
    countForTenant(tenantId: string): Promise<number>;
    sumBilledForOrder(salesOrderId: string): Promise<BilledSoFar>;
    sumBilledForProject(projectId: string): Promise<BilledSoFar>;
    updateStatus(id: string, tenantId: string, status: InvoiceStatus): Promise<Invoice>;
    /** Kalıcı silme — yalnızca kullanım senaryosu iptal edilmiş faturalar için çağırır. */
    delete(id: string, tenantId: string): Promise<void>;
}
