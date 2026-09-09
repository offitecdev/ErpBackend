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
    /**
     * ── WIE AUF DER OFFERTE ────────────────────────────────────────────────
     * Die Positionstabelle des Belegs IST die des Angebots, also traegt die
     * Zeile dieselben Felder: die Beschreibung unter der Bezeichnung und den
     * Zeilenrabatt (Stapel + abgeleiteter Prozentwert).
     */
    longDescription?: string | null;
    discounts?: string | null;
    discount?: number | null;
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
    /**
     * ── DIE DREI ABSCHNITTE DES BELEGS (05.09.2026) ────────────────────────
     * Positionen · Rabatt · Schlusstext. Jeder darf entfernt werden und ist
     * dann AUCH nicht mehr im PDF. Gespeichert als JSON-Objekt; NULL heisst
     * "alle drei" (so bleiben aeltere Rechnungen unveraendert).
     */
    sections?: string | null;
    /** Rabattstapel des Belegs — Form wie `Tender.totalDiscounts`. */
    discounts?: string | null;
    /** Absatz unter der Summe. Leer = der Satz aus den Firmeneinstellungen. */
    closingText?: string | null;
    /** Gedruckte Absenderzeile; der QR-Glaeubiger bleibt aus den Einstellungen. */
    senderAddress?: string | null;
    paymentStages?: string | null;
    /** Zahlungseingang — gesetzt beim Markieren als bezahlt. */
    paidAt?: Date | null;
    issuedByEmployeeId: string;
    createdAt: Date;
    updatedAt: Date;
    lineItems?: InvoiceLineItem[];
}
