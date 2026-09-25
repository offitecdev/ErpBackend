import { Invoice, InvoiceCategory, InvoiceLineItem, InvoiceStatus } from "../entities/Invoice";
import type { DirectInvoiceNumberRequest } from '../../shared/directInvoiceNumber';

/**
 * ── DIE BUCHHALTUNGSLISTE KOMMT SEITENWEISE (22.09.2026) ───────────────────
 *
 * Der Stand einer Rechnung ist KEINE Spalte: «überfällig» ergibt sich aus der
 * Fälligkeit, «Gegenbeleg» aus der Art. Die Reiter der Liste heissen darum
 * hier genauso wie in der Oberfläche (pages/accounting/accountingShared.ts),
 * und der Server rechnet sie mit derselben Regel.
 */
export type InvoiceStateKey = "DRAFT" | "OPEN" | "OVERDUE" | "PAID" | "CANCELLED" | "CREDIT";

/** Wonach sortiert wird. `activity` (Vorgabe) = zuletzt ausgestellt, bezahlt oder geändert. */
export type InvoiceSort = "activity" | "invoiceDate" | "dueDate" | "amount" | "number";

export const INVOICE_STATE_KEYS: InvoiceStateKey[] = ["DRAFT", "OPEN", "OVERDUE", "PAID", "CANCELLED", "CREDIT"];
export const INVOICE_SORTS: InvoiceSort[] = ["activity", "invoiceDate", "dueDate", "amount", "number"];

/** Eine Seite der Liste: die Zeilen, wie viele es insgesamt sind, und die Zähler der Reiter. */
export interface InvoicePage {
    items: InvoiceListItem[];
    total: number;
    page: number;
    pageSize: number;
    counts: Record<"ALL" | InvoiceStateKey, number>;
}

export interface IInvoiceFilter {
    tenantId: string;
    /** Genau diese Rechnung (Detailseite der Buchhaltung). */
    id?: string | undefined;
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
    /** Reiter der Buchhaltungsliste. «Offen» schliesst «Überfällig» ein. */
    state?: InvoiceStateKey | undefined;
    /** Freitext — Nummer, Empfänger, Auftrag, Projekt, Verkäufer, Betrag. */
    search?: string | undefined;
    /** Kalendertag der Person; er entscheidet, was «überfällig» ist. */
    today?: string | undefined;
    /** Reihenfolge der Zeilen (Vorgabe: letzter Vorgang zuoberst). */
    sort?: InvoiceSort | undefined;
    /** Seite (1-basiert) und Seitengrösse — nur `listPage` liest sie. */
    page?: number | undefined;
    pageSize?: number | undefined;
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
    /** Letzter Vorgang am Beleg: Änderung oder Zahlungseingang (Sortierung der Liste). */
    activityAt?: Date | string | null;
    /** Zahlungsstand (Schritt 7). */
    paidAmount?: number;
    creditedAmount?: number;
    openAmount?: number;
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
    createWithItems(invoice: Partial<Invoice>, items: InvoiceLineItemInput[], numbering?: DirectInvoiceNumberRequest): Promise<Invoice>;
    updateWithItems(id: string, invoice: Partial<Invoice>, items: InvoiceLineItemInput[], numbering?: DirectInvoiceNumberRequest): Promise<Invoice>;
    findById(id: string, tenantId: string): Promise<Invoice | null>;
    findActiveByOrder(salesOrderId: string, tenantId: string): Promise<Invoice | null>;
    findActiveByProject(projectId: string, tenantId: string): Promise<Invoice | null>;
    list(filter: IInvoiceFilter): Promise<InvoiceListItem[]>;
    /** EINE Seite der Buchhaltungsliste — mit Gesamtzahl und Reiterzählern. */
    listPage(filter: IInvoiceFilter): Promise<InvoicePage>;
    listForOrders(tenantId: string, salesOrderIds: string[]): Promise<InvoiceSummaryRow[]>;
    countForTenant(tenantId: string): Promise<number>;
    sumBilledForOrder(salesOrderId: string): Promise<BilledSoFar>;
    sumBilledForProject(projectId: string): Promise<BilledSoFar>;
    /**
     * Statuswechsel. `paidAt` ist der ZAHLUNGSEINGANG und gilt nur fuer PAID —
     * jeder andere Status loescht ihn wieder.
     */
    updateStatus(id: string, tenantId: string, status: InvoiceStatus, paidAt?: Date | null): Promise<Invoice>;
    /** Einen ENTWURF entfernen — ausgestellte Rechnungen bleiben (liefert false). */
    deleteDraft(id: string, tenantId: string): Promise<boolean>;
    /** Rechnungsdatum + Fälligkeit korrigieren — Betrag, Nummer, Status bleiben. */
    updateDates(id: string, tenantId: string, invoiceDate: Date, dueDate: Date): Promise<Invoice>;
    // Kein `delete`: eine gestellte Rechnung wird nie entfernt (16.09.2026).
}
