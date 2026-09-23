/**
 * ── FEHLER DES PRODUKTIONSMODULS MIT KENNUNG ─────────────────────────────────
 *
 * Wie die Rechnungsfehler (billing/invoiceErrors.ts): der Server kennt die
 * Sprache des Nutzers nicht, darum trägt jeder Fehler eine feste Kennung
 * (`code`), die Oberfläche übersetzt sie (`production.err.*`). `message` ist
 * der deutsche Rückfall; `details` trägt bei Zeilenfehlern die betroffenen
 * Zeilen mit.
 */
export type ProductionErrorCode =
    | 'NOT_FOUND'
    | 'MODULE_DISABLED'
    | 'PROJECT_REQUIRED'
    | 'PROJECT_NOT_FOUND'
    | 'PROJECT_INACTIVE'
    | 'ITEMS_REQUIRED'
    | 'ITEM_NOT_IN_PROJECT'
    | 'ITEM_INACTIVE'
    | 'LINE_UNASSIGNED'
    | 'LINE_FOREIGN_ITEM'
    | 'SOURCE_INVALID'
    | 'APPROVAL_FIELDS_MISSING';

export type ProductionError = Error & {
    code: ProductionErrorCode;
    status: number;
    params?: Record<string, string | number> | undefined;
    details?: unknown;
};

export const productionError = (
    code: ProductionErrorCode,
    message: string,
    options: { status?: number; params?: Record<string, string | number>; details?: unknown } = {},
): ProductionError =>
    Object.assign(new Error(message), {
        code,
        status: options.status ?? 400,
        params: options.params,
        details: options.details,
    });

export const isProductionError = (error: unknown): error is ProductionError =>
    Boolean(error) && typeof (error as ProductionError).code === 'string' && typeof (error as ProductionError).status === 'number';

/** Antwortkörper eines Fehlers — Kennung, Werte und Zeilen reisen mit. */
export const productionErrorBody = (error: unknown) => {
    const e = error as Partial<ProductionError> | null;
    return {
        error: e?.message || 'Error',
        ...(e?.code ? { code: e.code } : {}),
        ...(e?.params ? { params: e.params } : {}),
        ...(e?.details !== undefined ? { details: e.details } : {}),
    };
};
