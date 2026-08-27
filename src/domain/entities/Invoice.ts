export type InvoiceBillingType = 'FULL' | 'PARTIAL';
// RECHNUNG = tam fatura (tüm pozisyonlar, %100) | AKONTO = avans faturası |
// ZWISCHEN = ara fatura | SCHLUSS = kalan yüzdeyi kapatan son fatura.
export type InvoiceKind = 'RECHNUNG' | 'AKONTO' | 'ZWISCHEN' | 'SCHLUSS';
export type InvoiceStatus = 'ISSUED' | 'PAID' | 'CANCELLED';
/**
 * Rechnungstyp der LISTE (30.08.2026) — nicht gespeichert, sondern aus dem
 * Beleg abgeleitet, an dem die Rechnung haengt:
 *  - PROJECT  = Projektauftrag (Auftrag mit Projekt bzw. PROJECT_*-Art, oder
 *               eine direkt auf ein Projekt gestellte Rechnung)
 *  - DELIVERY = Lieferauftrag (Auftragsart INVOICE/REGIE, ohne Projekt)
 *  - DIRECT   = Direktrechnung (weder Auftrag noch Projekt — selbst ausgefuellt)
 *
 * Abgeleitet statt gespeichert, weil der Typ eine EIGENSCHAFT DES AUFTRAGS ist:
 * wandert ein Auftrag ins Projekt, wandern seine Rechnungen mit, ohne dass ein
 * Nachtrag noetig waere.
 */
export type InvoiceCategory = 'PROJECT' | 'DELIVERY' | 'DIRECT';
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
    /** Mengeneinheit (Stk., Std., Pau.) — nur Direktrechnungen fuellen sie. */
    unit?: string | null;
    /** Platz auf dem Beleg. */
    sortOrder?: number;
}

export interface Invoice {
    id: string;
    tenantId: string;
    customerId?: string | null;
    projectId?: string | null;
    salesOrderId?: string | null;
    invoiceNumber: string;
    billingType: InvoiceBillingType;
    kind: InvoiceKind;
    invoiceDate?: Date | null;
    dueDate?: Date | null;
    salespersonName?: string | null;
    commissionNumber?: string | null;
    billedPercent: number;
    baseAmount: number;
    amount: number;
    status: InvoiceStatus;
    notes?: string | null;
    /** Direktrechnung: Empfaenger und Steuersatz stehen auf der Rechnung selbst. */
    recipientName?: string | null;
    recipientAddress?: string | null;
    introText?: string | null;
    vatRate?: number | null;
    issuedByEmployeeId: string;
    createdAt: Date;
    updatedAt: Date;
    lineItems?: InvoiceLineItem[];
}
