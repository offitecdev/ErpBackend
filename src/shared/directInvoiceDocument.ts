import { invoiceError } from '../application/use-cases/billing/invoiceErrors';

export interface DirectInvoiceDocumentOptions {
    language: 'de' | 'en' | 'tr';
    showQr: boolean;
    showFooter: boolean;
    vatEnabled: boolean;
    recipientFields?: { street: string; supplement: string; postalCode: string; city: string; country: string };
}

/** Stored alongside section flags in Invoice.sections; old invoices keep their defaults. */
export const normalizeDirectInvoiceDocument = (raw: unknown, vatRate: number): DirectInvoiceDocumentOptions => {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const language = value.language ?? 'de';
    if (!['de', 'en', 'tr'].includes(String(language))) throw invoiceError('DOCUMENT_INVALID', 'Ungültige PDF-Sprache.');
    for (const key of ['showQr', 'showFooter', 'vatEnabled']) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean') throw invoiceError('DOCUMENT_INVALID', 'Ungültige PDF-Einstellung.');
    }
    const fields = value.recipientFields;
    return {
        language: language as DirectInvoiceDocumentOptions['language'],
        showQr: value.showQr !== false,
        showFooter: value.showFooter !== false,
        vatEnabled: typeof value.vatEnabled === 'boolean' ? value.vatEnabled : vatRate > 0,
        ...(fields && typeof fields === 'object' ? {
            recipientFields: Object.fromEntries(['street', 'supplement', 'postalCode', 'city', 'country'].map(key =>
                [key, String((fields as Record<string, unknown>)[key] ?? '').trim().slice(0, 500)],
            )) as NonNullable<DirectInvoiceDocumentOptions['recipientFields']>,
        } : {}),
    };
};
