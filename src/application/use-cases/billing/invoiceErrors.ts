/**
 * ── RECHNUNGSFEHLER MIT KENNUNG ──────────────────────────────────────────────
 *
 * Vorgabe Samet (16.09.2026): die Warnungen der Rechnung dürfen nicht nur
 * deutsch sein — TR und EN auch. Der Server kennt die Sprache des Nutzers
 * nicht; darum trägt jeder Fehler eine feste Kennung (`code`) und, wo nötig,
 * Werte (`params`). Die Oberfläche übersetzt die Kennung (`invoices.err.*`);
 * `message` bleibt als Rückfall für ältere Oberflächen stehen.
 */
export type InvoiceErrorCode =
    | 'NOT_FOUND'
    | 'ORDER_NOT_FOUND'
    | 'PROJECT_NOT_FOUND'
    | 'CUSTOMER_NOT_FOUND'
    | 'ONE_TARGET'
    | 'ORDER_CANCELLED'
    | 'PROJECT_CANCELLED'
    | 'NOTHING_TO_BILL'
    | 'FULLY_BILLED'
    | 'INVALID_KIND'
    | 'FULL_ONLY_FIRST'
    | 'INVALID_PERCENT'
    | 'MAX_PERCENT'
    | 'INVALID_STATUS'
    | 'CANCELLED_STAYS'
    | 'PAID_NOT_CANCELLABLE'
    | 'NEVER_DELETED'
    | 'NEED_RECIPIENT'
    | 'NEED_LINES'
    | 'LINE_NEEDS_TITLE'
    | 'LINE_INVALID'
    | 'AMOUNT_ZERO'
    | 'PLAN_INVALID'
    | 'DIRECT_ONLY'
    | 'PAID_LOCKED'
    | 'CANCELLED_LOCKED'
    | 'DATE_INVALID'
    | 'DUE_BEFORE_DATE'
    // Minderung (Nachtrag mit Minussumme, 16.09.2026)
    | 'ADDON_MINDERUNG_NOT_BILLABLE'
    // Eigenes Recht zum Stornieren (16.09.2026)
    | 'CANCEL_NOT_PERMITTED'
    // Entwürfe (Schritt 5)
    | 'NOT_DRAFT'
    | 'DRAFT_NOT_ISSUED'
    // Gegenbelege (Schritt 6)
    | 'CREDIT_REASON_REQUIRED'
    | 'CREDIT_DOCUMENT_FINAL'
    | 'CREDIT_NEEDS_PAID'
    | 'FULLY_CREDITED'
    | 'CREDIT_AMOUNT_INVALID'
    | 'CREDIT_AMOUNT_TOO_HIGH'
    | 'STORNO_REQUIRED'
    | 'PAYMENT_LOCKED_BY_CREDIT'
    | 'CREDIT_NOT_PERMITTED'
    // Zahlungseingänge (Schritt 7)
    | 'ALREADY_SETTLED'
    | 'PAYMENT_AMOUNT_INVALID'
    | 'PAYMENT_TOO_HIGH'
    | 'OFFSET_FINAL';

export type InvoiceError = Error & {
    code: InvoiceErrorCode;
    status: number;
    params?: Record<string, string | number> | undefined;
};

export const invoiceError = (
    code: InvoiceErrorCode,
    message: string,
    options: { status?: number; params?: Record<string, string | number> } = {},
): InvoiceError =>
    Object.assign(new Error(message), {
        code,
        status: options.status ?? 400,
        params: options.params,
    });

/** Antwortkörper eines Fehlers — Kennung und Werte reisen mit. */
export const invoiceErrorBody = (error: unknown) => {
    const e = error as Partial<InvoiceError> | null;
    return {
        error: e?.message || 'Error',
        ...(e?.code ? { code: e.code } : {}),
        ...(e?.params ? { params: e.params } : {}),
    };
};
