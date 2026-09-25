"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeDirectInvoiceDocument = void 0;
const invoiceErrors_1 = require("../application/use-cases/billing/invoiceErrors");
/** Stored alongside section flags in Invoice.sections; old invoices keep their defaults. */
const normalizeDirectInvoiceDocument = (raw, vatRate) => {
    const value = raw && typeof raw === 'object' ? raw : {};
    const language = value.language ?? 'de';
    if (!['de', 'en', 'tr'].includes(String(language)))
        throw (0, invoiceErrors_1.invoiceError)('DOCUMENT_INVALID', 'Ungültige PDF-Sprache.');
    for (const key of ['showQr', 'showFooter', 'vatEnabled']) {
        if (value[key] !== undefined && typeof value[key] !== 'boolean')
            throw (0, invoiceErrors_1.invoiceError)('DOCUMENT_INVALID', 'Ungültige PDF-Einstellung.');
    }
    const fields = value.recipientFields;
    return {
        language: language,
        showQr: value.showQr !== false,
        showFooter: value.showFooter !== false,
        vatEnabled: typeof value.vatEnabled === 'boolean' ? value.vatEnabled : vatRate > 0,
        ...(fields && typeof fields === 'object' ? {
            recipientFields: Object.fromEntries(['street', 'supplement', 'postalCode', 'city', 'country'].map(key => [key, String(fields[key] ?? '').trim().slice(0, 500)])),
        } : {}),
    };
};
exports.normalizeDirectInvoiceDocument = normalizeDirectInvoiceDocument;
//# sourceMappingURL=directInvoiceDocument.js.map